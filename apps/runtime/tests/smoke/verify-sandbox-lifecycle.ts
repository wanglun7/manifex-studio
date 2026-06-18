import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { ThreadSandboxManager } from '../../src/mastra/sandbox/thread-sandbox-manager.js'

const execFileAsync = promisify(execFile)
const projectRoot = process.cwd()
const artifactsRoot = resolve(projectRoot, 'artifacts/sandbox-lifecycle')
const workspacePath = resolve(projectRoot, 'artifacts/lifecycle-test-workspace')
const threadId = `lifecycle-test-${Date.now()}`
const containerName = `manifex-${threadId}`
const roleLabel = 'lifecycle-test'
const ledgerPath = resolve(artifactsRoot, 'test-threads.json')

async function docker(args: string[]) {
  return execFileAsync('docker', args)
}

async function sleep(ms: number) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function containerStatus(name: string) {
  try {
    const { stdout } = await docker(['inspect', '-f', '{{.State.Status}}', name])
    return stdout.trim()
  } catch {
    return 'missing'
  }
}

async function assertStatus(name: string, expected: string) {
  const actual = await containerStatus(name)
  if (actual !== expected) {
    throw new Error(`expected ${name} to be ${expected}, got ${actual}`)
  }
}

async function main() {
  await mkdir(artifactsRoot, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await rm(ledgerPath, { force: true })
  await docker(['rm', '-f', containerName]).catch(() => undefined)

  await docker([
    'run',
    '-d',
    '--name',
    containerName,
    '--label',
    `manifex.role=${roleLabel}`,
    '--label',
    `manifex.thread=${threadId}`,
    '--label',
    `mastra.sandbox.id=${containerName}`,
    'manifex-agent-runtime:latest',
    'sleep',
    'infinity',
  ])

  const manager = new ThreadSandboxManager({
    enabled: true,
    ledgerPath,
    stopAfterMs: 100,
    removeAfterMs: 350,
    sweepIntervalMs: 60_000,
    roleLabel,
    containerPrefix: 'manifex-',
  })

  await manager.load()
  await sleep(150)
  await manager.sweep()
  await assertStatus(containerName, 'running')

  manager.touch(threadId, workspacePath, 'lifecycle-test-resource')

  await sleep(150)
  await manager.sweep()
  await assertStatus(containerName, 'exited')

  await sleep(250)
  await manager.sweep()
  await assertStatus(containerName, 'missing')

  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Array<{
    threadId: string
    lastStoppedAt?: number
    lastRemovedAt?: number
  }>
  const record = ledger.find((item) => item.threadId === threadId)
  if (!record?.lastStoppedAt || !record?.lastRemovedAt) {
    throw new Error('lifecycle ledger did not record stop/remove timestamps')
  }

  console.log('sandbox lifecycle verified')
}

main()
  .catch(async (error) => {
    await docker(['rm', '-f', containerName]).catch(() => undefined)
    console.error(error)
    process.exit(1)
  })
