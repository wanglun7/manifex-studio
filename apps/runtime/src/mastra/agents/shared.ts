import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  type RequestContext,
} from '@mastra/core/request-context'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import {
  LocalFilesystem,
  LocalSandbox,
  LocalSkillSource,
  Workspace,
} from '@mastra/core/workspace'
import { DockerSandbox } from '@mastra/docker'
import { createDashScopeEmbedder } from '../dashscope-embedder.js'
import { loadUpstreamEnv, optionalEnv, requiredEnv } from '../env.js'
import { searchMcpClient, searchProviderInstructions } from '../mcp/search-mcp.js'
import { artifactsRoot, mastraStudioArtifactsRoot, repoRoot, runtimeRoot } from '../paths.js'
import { createThreadSandboxManager } from '../sandbox/thread-sandbox-manager.js'

loadUpstreamEnv()

mkdirSync(mastraStudioArtifactsRoot, { recursive: true })

const dashScopeApiKey = optionalEnv('DASHSCOPE_API_KEY')
const embeddingModel = optionalEnv('EMBEDDING_MODEL') || 'text-embedding-v4'
const embedDim = Number(optionalEnv('EMBED_DIM') || 1024)
const observationMessageTokens = Number(optionalEnv('OBSERVATION_MESSAGE_TOKENS') || 100_000)
const reflectionObservationTokens = Number(optionalEnv('REFLECTION_OBSERVATION_TOKENS') || 120_000)
const observationBufferTokensRaw = optionalEnv('OBSERVATION_BUFFER_TOKENS')
const observationBufferTokens =
  !observationBufferTokensRaw || observationBufferTokensRaw === 'false'
    ? false
    : Number(observationBufferTokensRaw)
const observationBufferOnIdle = optionalEnv('OBSERVATION_BUFFER_ON_IDLE') === 'true'
const workspaceSandboxProvider = optionalEnv('WORKSPACE_SANDBOX_PROVIDER') || 'local'
const dockerImage = optionalEnv('WORKSPACE_DOCKER_IMAGE') || 'manifex-agent-runtime:latest'
const threadWorkspaceRoot = resolve(
  repoRoot,
  optionalEnv('WORKSPACE_THREAD_ROOT') || 'artifacts/docker-thread-workspaces',
)
const dockerMemoryBytes = Number(optionalEnv('WORKSPACE_DOCKER_MEMORY_BYTES') || 2 * 1024 * 1024 * 1024)
const dockerPidsLimit = Number(optionalEnv('WORKSPACE_DOCKER_PIDS_LIMIT') || 512)
const dockerTimeoutMs = Number(optionalEnv('WORKSPACE_DOCKER_TIMEOUT_MS') || 5 * 60_000)
const sandboxCleanupEnabled = optionalEnv('WORKSPACE_SANDBOX_CLEANUP_ENABLED') !== 'false'
const sandboxIdleStopMs = Number(optionalEnv('WORKSPACE_SANDBOX_IDLE_STOP_MS') || 60 * 60_000)
const sandboxIdleRemoveMs = Number(optionalEnv('WORKSPACE_SANDBOX_IDLE_REMOVE_MS') || 24 * 60 * 60_000)
const sandboxSweepIntervalMs = Number(optionalEnv('WORKSPACE_SANDBOX_SWEEP_INTERVAL_MS') || 5 * 60_000)
const semanticRecallEnabled = Boolean(dashScopeApiKey)

export const maxSteps = Number(optionalEnv('AGENT_MAX_STEPS') || 50)
export const useDockerSandbox = workspaceSandboxProvider === 'docker'
export const platformSearchInstructions = searchProviderInstructions
export const searchTools = await searchMcpClient.listTools()

export const upstreamModel = {
  providerId: 'custom',
  modelId: requiredEnv('UPSTREAM_OPENAI_MODEL'),
  url: requiredEnv('UPSTREAM_OPENAI_BASE_URL'),
  apiKey: requiredEnv('UPSTREAM_OPENAI_API_KEY'),
}

export function createAgentMemory(id: string, title: string) {
  return new Memory({
    storage: new LibSQLStore({
      id,
      url: `file:${resolve(artifactsRoot, `mastra-studio/${id}.db`)}`,
    }),
    ...(semanticRecallEnabled
      ? {
          vector: new LibSQLVector({
            id: `${id}-vector`,
            url: `file:${resolve(artifactsRoot, `mastra-studio/${id}.db`)}`,
          }),
          embedder: createDashScopeEmbedder({
            apiKey: dashScopeApiKey,
            baseUrl: optionalEnv('DASHSCOPE_BASE_URL'),
            model: embeddingModel,
            dimensions: Number.isFinite(embedDim) ? embedDim : 1024,
          }),
        }
      : {}),
    options: {
      lastMessages: 30,
      semanticRecall: semanticRecallEnabled
        ? {
            topK: 4,
            messageRange: {
              before: 1,
              after: 1,
            },
            scope: 'thread',
          }
        : false,
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: [
          `# ${title} Working Memory`,
          '- Current task:',
          '- Relevant files:',
          '- Commands run:',
          '- Decisions:',
          '- Next action:',
        ].join('\n'),
      },
      generateTitle: true,
      observationalMemory: {
        model: upstreamModel,
        scope: 'thread',
        activateAfterIdle: 'auto',
        activateOnProviderChange: true,
        observation: {
          messageTokens: Number.isFinite(observationMessageTokens)
            ? observationMessageTokens
            : 100_000,
          bufferTokens: observationBufferTokens,
          bufferActivation: 0.9,
          bufferOnIdle: observationBufferOnIdle,
        },
        reflection: {
          observationTokens: Number.isFinite(reflectionObservationTokens)
            ? reflectionObservationTokens
            : 120_000,
          activateAfterIdle: 'auto',
          activateOnProviderChange: true,
        },
      },
    },
  })
}

function getContextValue(requestContext: RequestContext, names: string[]) {
  for (const name of names) {
    const value = requestContext.get(name)
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export function sanitizeSandboxId(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'default'
}

function resolveThreadKey(requestContext: RequestContext) {
  return sanitizeSandboxId(
    getContextValue(requestContext, [
      MASTRA_THREAD_ID_KEY,
      'thread-id',
      'threadId',
      'thread_id',
      'conversation-id',
    ]) ||
      getContextValue(requestContext, [MASTRA_RESOURCE_ID_KEY, 'resourceId', 'resource-id']) ||
      'studio-default',
  )
}

function resolveResourceKey(requestContext: RequestContext) {
  return getContextValue(requestContext, [MASTRA_RESOURCE_ID_KEY, 'resourceId', 'resource-id'])
}

function getDirectoryFingerprint(path: string) {
  let fileCount = 0
  let latestMtimeMs = 0

  function visit(currentPath: string) {
    const stat = statSync(currentPath)
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs)
    if (!stat.isDirectory()) {
      fileCount += 1
      return
    }

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      visit(resolve(currentPath, entry.name))
    }
  }

  visit(path)
  return {
    fileCount,
    latestMtimeMs,
  }
}

function syncSkillRootsToWorkspace(hostPath: string, skillRoots: string[]) {
  if (!skillRoots.length) return

  const existingSkillRoots = skillRoots
    .map((name) => ({
      name,
      sourcePath: resolve(runtimeRoot, name),
    }))
    .filter(({ sourcePath }) => existsSync(sourcePath))

  if (!existingSkillRoots.length) return

  const targetBase = resolve(hostPath, '.manifex/skills')
  const manifestPath = resolve(targetBase, '.sync-manifest.json')
  const manifest = {
    version: 1,
    roots: existingSkillRoots.map(({ name, sourcePath }) => ({
      name,
      ...getDirectoryFingerprint(sourcePath),
    })),
  }
  const nextManifest = JSON.stringify(manifest, null, 2)

  if (existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') === nextManifest) {
    return
  }

  mkdirSync(targetBase, { recursive: true })
  for (const { name, sourcePath } of existingSkillRoots) {
    const targetPath = resolve(targetBase, name)
    rmSync(targetPath, { recursive: true, force: true })
    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
    })
  }
  writeFileSync(manifestPath, nextManifest)
}

export function resolveThreadWorkspacePathByKey(threadKey: string) {
  const hostPath = resolve(threadWorkspaceRoot, threadKey)
  mkdirSync(hostPath, { recursive: true })
  return hostPath
}

function resolveThreadWorkspacePath(requestContext: RequestContext, skillRoots: string[] = []) {
  const threadKey = resolveThreadKey(requestContext)
  const hostPath = resolveThreadWorkspacePathByKey(threadKey)
  threadSandboxManager.touch(threadKey, hostPath, resolveResourceKey(requestContext))
  syncSkillRootsToWorkspace(hostPath, skillRoots)
  return hostPath
}

export const threadSandboxManager = createThreadSandboxManager({
  artifactsRoot,
  enabled: useDockerSandbox && sandboxCleanupEnabled,
  stopAfterMs: Number.isFinite(sandboxIdleStopMs) ? sandboxIdleStopMs : 60 * 60_000,
  removeAfterMs: Number.isFinite(sandboxIdleRemoveMs) ? sandboxIdleRemoveMs : 24 * 60 * 60_000,
  sweepIntervalMs: Number.isFinite(sandboxSweepIntervalMs)
    ? sandboxSweepIntervalMs
    : 5 * 60_000,
})

function createDockerWorkspaceConfig(skillRoots: string[]) {
  return {
    filesystem: ({ requestContext }: { requestContext: RequestContext }) =>
      new LocalFilesystem({
        basePath: resolveThreadWorkspacePath(requestContext, skillRoots),
      }),
    sandbox: ({ requestContext }: { requestContext: RequestContext }) => {
      const threadKey = resolveThreadKey(requestContext)
      const hostPath = resolveThreadWorkspacePath(requestContext, skillRoots)
      return new DockerSandbox({
        id: `manifex-${threadKey}`,
        name: `manifex-${threadKey}`,
        image: dockerImage,
        volumes: {
          [hostPath]: '/workspace',
        },
        workingDir: '/workspace',
        timeout: Number.isFinite(dockerTimeoutMs) ? dockerTimeoutMs : 5 * 60_000,
        memory: Number.isFinite(dockerMemoryBytes) ? dockerMemoryBytes : 2 * 1024 * 1024 * 1024,
        pidsLimit: Number.isFinite(dockerPidsLimit) ? dockerPidsLimit : 512,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        labels: {
          'manifex.role': 'agent-thread-sandbox',
          'manifex.thread': threadKey,
        },
      })
    },
    sandboxCacheKey: ({ requestContext }: { requestContext: RequestContext }) =>
      resolveThreadKey(requestContext),
    instructions: {
      dynamicSandbox: ({ requestContext }: { requestContext: RequestContext }) =>
        [
          `Shell commands run in an isolated Docker sandbox for thread ${resolveThreadKey(
            requestContext,
          )}. The workspace is mounted at /workspace inside the container.`,
          skillRoots.length
            ? `Configured skills are mirrored inside this workspace at /workspace/.manifex/skills. Use skill_search/skill_read for instructions, and run any referenced local skill files from that mirrored path.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
    },
    lsp: false,
  }
}

function createLocalWorkspaceConfig() {
  return {
    filesystem: new LocalFilesystem({
      basePath: repoRoot,
    }),
    sandbox: new LocalSandbox({
      workingDirectory: repoRoot,
    }),
    lsp: true,
  }
}

export function createRuntimeWorkspace(config: {
  id: string
  name: string
  skills?: string[]
}) {
  const skillRoots = config.skills ?? []
  const skillConfig = config.skills?.length
    ? {
        skills: skillRoots,
        skillSource: new LocalSkillSource({
          basePath: runtimeRoot,
        }),
      }
    : {}

  return new Workspace({
    id: config.id,
    name: useDockerSandbox
      ? `${config.name} Docker Workspace`
      : `${config.name} Local Workspace`,
    ...(useDockerSandbox ? createDockerWorkspaceConfig(skillRoots) : createLocalWorkspaceConfig()),
    ...skillConfig,
    bm25: true,
    tools: {
      enabled: true,
      requireApproval: false,
    },
  })
}

export function platformRuntimeInstructions(platformName: string) {
  return [
    'You may use all configured workspace tools: filesystem, shell/process, search/index, Tavily web research, and skills when available.',
    useDockerSandbox
      ? `Shell commands run in a per-thread Docker sandbox mounted at /workspace. Treat /workspace as the current ${platformName} task workspace.`
      : 'Shell commands run on the local host workspace.',
    platformSearchInstructions,
    'Use tools when they are needed instead of guessing.',
    'Do not print secrets, app secrets, access tokens, refresh tokens, or private configuration.',
    'For write/delete/high-risk actions, prefer dry-run/preview first when the CLI supports it, then ask for confirmation if the operation is risky.',
    'Clearly report what you ran, what succeeded, and what still needs user authorization or confirmation.',
  ].join('\n')
}
