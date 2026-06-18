import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type ThreadSandboxRecord = {
  threadId: string
  resourceId?: string
  containerName: string
  workspacePath: string
  lastUsedAt: number
  activeRuns: number
  lastStartedAt?: number
  lastStoppedAt?: number
  lastRemovedAt?: number
}

type DockerContainerInspect = {
  Name?: string
  Created?: string
  Mounts?: Array<{
    Destination?: string
    Source?: string
  }>
  State?: {
    Running?: boolean
    Status?: string
  }
  Config?: {
    Labels?: Record<string, string>
  }
}

type ThreadSandboxManagerOptions = {
  enabled: boolean
  ledgerPath: string
  stopAfterMs: number
  removeAfterMs: number
  sweepIntervalMs: number
  roleLabel: string
  containerPrefix: string
}

type SandboxInvalidationReason = 'stopped' | 'removed'
type SandboxInvalidationHandler = (
  threadId: string,
  reason: SandboxInvalidationReason,
) => void

function now() {
  return Date.now()
}

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0
}

export class ThreadSandboxManager {
  private records = new Map<string, ThreadSandboxRecord>()
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private persistQueue = Promise.resolve()
  private invalidationHandlers = new Set<SandboxInvalidationHandler>()

  constructor(private readonly options: ThreadSandboxManagerOptions) {}

  get enabled() {
    return this.options.enabled
  }

  onInvalidate(handler: SandboxInvalidationHandler) {
    this.invalidationHandlers.add(handler)
    return () => {
      this.invalidationHandlers.delete(handler)
    }
  }

  async load() {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      try {
        const raw = await readFile(this.options.ledgerPath, 'utf8')
        const parsed = JSON.parse(raw) as ThreadSandboxRecord[]
        for (const record of parsed) {
          if (record.threadId) this.records.set(record.threadId, record)
        }
      } catch {
        // Missing or corrupt lifecycle state should not block agent startup.
      } finally {
        this.loaded = true
        this.loadPromise = undefined
      }
    })()

    return this.loadPromise
  }

  start() {
    if (!this.options.enabled || this.timer) return
    void this.load()
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => {
        console.warn('[sandbox-manager] cleanup sweep failed:', error)
      })
    }, this.options.sweepIntervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  beginRequest(threadId: string, workspacePath: string, resourceId?: string) {
    this.upsert(threadId, workspacePath, resourceId, 1)
  }

  endRequest(threadId: string) {
    const record = this.records.get(threadId)
    if (!record) return
    record.activeRuns = Math.max(0, record.activeRuns - 1)
    record.lastUsedAt = now()
    void this.persist()
  }

  touch(threadId: string, workspacePath: string, resourceId?: string) {
    this.upsert(threadId, workspacePath, resourceId, 0)
  }

  async sweep() {
    if (!this.options.enabled) return
    await this.load()

    const containers = await this.listManagedContainers()
    const timestamp = now()

    for (const container of containers) {
      const labels = container.Config?.Labels ?? {}
      const threadId = labels['manifex.thread']
      const name = (container.Name ?? '').replace(/^\//, '')
      if (!threadId || !name) continue

      let record = this.records.get(threadId)
      const parsedCreatedAt = Date.parse(container.Created ?? '')
      if (!record) {
        record = {
          threadId,
          containerName: name,
          workspacePath:
            container.Mounts?.find((mount) => mount.Destination === '/workspace')?.Source ?? '',
          lastUsedAt: timestamp,
          activeRuns: 0,
          lastStartedAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : timestamp,
        }
        this.records.set(threadId, record)
      }

      const lastUsedAt = record.lastUsedAt
      const activeRuns = record.activeRuns
      const idleMs = timestamp - lastUsedAt

      if (activeRuns > 0) continue

      if (isPositiveFinite(this.options.removeAfterMs) && idleMs >= this.options.removeAfterMs) {
        await this.removeContainer(name)
        this.markRemoved(threadId, timestamp)
        this.invalidate(threadId, 'removed')
        continue
      }

      if (
        isPositiveFinite(this.options.stopAfterMs) &&
        idleMs >= this.options.stopAfterMs &&
        container.State?.Running
      ) {
        await this.stopContainer(name)
        this.markStopped(threadId, timestamp)
        this.invalidate(threadId, 'stopped')
      }
    }

    await this.persist()
  }

  private upsert(
    threadId: string,
    workspacePath: string,
    resourceId: string | undefined,
    activeRunDelta: number,
  ) {
    const existing = this.records.get(threadId)
    const record: ThreadSandboxRecord = {
      threadId,
      resourceId: resourceId ?? existing?.resourceId,
      containerName: `${this.options.containerPrefix}${threadId}`,
      workspacePath,
      lastUsedAt: now(),
      activeRuns: Math.max(0, (existing?.activeRuns ?? 0) + activeRunDelta),
      lastStartedAt: existing?.lastStartedAt ?? now(),
      lastStoppedAt: existing?.lastStoppedAt,
      lastRemovedAt: existing?.lastRemovedAt,
    }

    this.records.set(threadId, record)
    void this.persist()
  }

  private markStopped(threadId: string, timestamp: number) {
    const record = this.records.get(threadId)
    if (!record) return
    record.lastStoppedAt = timestamp
  }

  private markRemoved(threadId: string, timestamp: number) {
    const record = this.records.get(threadId)
    if (!record) return
    record.lastRemovedAt = timestamp
  }

  private invalidate(threadId: string, reason: SandboxInvalidationReason) {
    for (const handler of this.invalidationHandlers) {
      try {
        handler(threadId, reason)
      } catch (error) {
        console.warn('[sandbox-manager] cache invalidation failed:', error)
      }
    }
  }

  private async persist() {
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        mkdirSync(dirname(this.options.ledgerPath), { recursive: true })
        const tmpPath = `${this.options.ledgerPath}.tmp`
        const records = [...this.records.values()].sort((a, b) =>
          a.threadId.localeCompare(b.threadId),
        )
        await writeFile(tmpPath, `${JSON.stringify(records, null, 2)}\n`)
        await rename(tmpPath, this.options.ledgerPath)
      })
    await this.persistQueue
  }

  private async listManagedContainers() {
    const { stdout } = await execFileAsync('docker', [
      'ps',
      '-a',
      '--filter',
      `label=manifex.role=${this.options.roleLabel}`,
      '--format',
      '{{.Names}}',
    ])
    const names = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const containers: DockerContainerInspect[] = []

    for (const name of names) {
      const { stdout: raw } = await execFileAsync('docker', ['inspect', name])
      const [inspect] = JSON.parse(raw) as DockerContainerInspect[]
      if (inspect) containers.push(inspect)
    }

    return containers
  }

  private async stopContainer(name: string) {
    await execFileAsync('docker', ['stop', name]).catch(() => undefined)
  }

  private async removeContainer(name: string) {
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => undefined)
  }
}

export function createThreadSandboxManager(options: {
  artifactsRoot: string
  enabled: boolean
  stopAfterMs: number
  removeAfterMs: number
  sweepIntervalMs: number
}) {
  const ledgerPath = resolve(options.artifactsRoot, 'sandbox-lifecycle/threads.json')
  if (!existsSync(dirname(ledgerPath))) {
    mkdirSync(dirname(ledgerPath), { recursive: true })
  }

  return new ThreadSandboxManager({
    enabled: options.enabled,
    ledgerPath,
    stopAfterMs: options.stopAfterMs,
    removeAfterMs: options.removeAfterMs,
    sweepIntervalMs: options.sweepIntervalMs,
    roleLabel: 'agent-thread-sandbox',
    containerPrefix: 'manifex-',
  })
}
