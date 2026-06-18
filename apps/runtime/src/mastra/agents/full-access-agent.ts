import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Agent } from '@mastra/core/agent'
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  type RequestContext,
} from '@mastra/core/request-context'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import {
  LocalFilesystem,
  LocalSkillSource,
  LocalSandbox,
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
const maxSteps = Number(optionalEnv('AGENT_MAX_STEPS') || 50)
const observationMessageTokens = Number(optionalEnv('OBSERVATION_MESSAGE_TOKENS') || 100_000)
const reflectionObservationTokens = Number(optionalEnv('REFLECTION_OBSERVATION_TOKENS') || 120_000)
const observationBufferTokensRaw = optionalEnv('OBSERVATION_BUFFER_TOKENS')
const observationBufferTokens =
  !observationBufferTokensRaw || observationBufferTokensRaw === 'false'
    ? false
    : Number(observationBufferTokensRaw)
const observationBufferOnIdle = optionalEnv('OBSERVATION_BUFFER_ON_IDLE') === 'true'
const workspaceSandboxProvider = optionalEnv('WORKSPACE_SANDBOX_PROVIDER') || 'local'
const useDockerSandbox = workspaceSandboxProvider === 'docker'
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
const upstreamModel = {
  providerId: 'custom',
  modelId: requiredEnv('UPSTREAM_OPENAI_MODEL'),
  url: requiredEnv('UPSTREAM_OPENAI_BASE_URL'),
  apiKey: requiredEnv('UPSTREAM_OPENAI_API_KEY'),
}

function createAgentMemory(id: string, title: string) {
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

export const fullAccessMemory = createAgentMemory(
  'full-access-agent-memory',
  'Full Access Agent',
)

export const feishuMemory = createAgentMemory(
  'feishu-agent-memory',
  'Feishu Agent',
)

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

export function resolveThreadWorkspacePathByKey(threadKey: string) {
  const hostPath = resolve(threadWorkspaceRoot, threadKey)
  mkdirSync(hostPath, { recursive: true })
  return hostPath
}

function resolveThreadWorkspacePath(requestContext: RequestContext) {
  const threadKey = resolveThreadKey(requestContext)
  const hostPath = resolveThreadWorkspacePathByKey(threadKey)
  threadSandboxManager.touch(threadKey, hostPath, resolveResourceKey(requestContext))
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

const dockerWorkspaceConfig = {
  filesystem: ({ requestContext }: { requestContext: RequestContext }) =>
    new LocalFilesystem({
      basePath: resolveThreadWorkspacePath(requestContext),
    }),
  sandbox: ({ requestContext }: { requestContext: RequestContext }) => {
    const threadKey = resolveThreadKey(requestContext)
    const hostPath = resolveThreadWorkspacePath(requestContext)
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
      `Shell commands run in an isolated Docker sandbox for thread ${resolveThreadKey(
        requestContext,
      )}. The workspace is mounted at /workspace inside the container.`,
  },
  lsp: false,
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

function createWorkspace(config: {
  id: string
  name: string
  skills?: string[]
}) {
  const skillConfig = config.skills?.length
    ? {
        skills: config.skills,
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
    ...(useDockerSandbox ? dockerWorkspaceConfig : createLocalWorkspaceConfig()),
    ...skillConfig,
    bm25: true,
    tools: {
      enabled: true,
      requireApproval: false,
    },
  })
}

export const fullAccessWorkspace = createWorkspace({
  id: 'full-access-workspace',
  name: 'Full Access',
})

export const feishuWorkspace = createWorkspace({
  id: 'feishu-workspace',
  name: 'Feishu',
  skills: ['lark-skills'],
})

threadSandboxManager.onInvalidate((threadId) => {
  fullAccessWorkspace.clearSandboxCache(threadId)
  feishuWorkspace.clearSandboxCache(threadId)
})

const searchTools = await searchMcpClient.listTools()

export const fullAccessAgent = new Agent({
  id: 'full-access-agent',
  name: 'Full Access Agent',
  instructions: [
    'You are a local full-access debugging agent running inside Mastra Studio.',
    useDockerSandbox
      ? 'You may use all configured workspace tools: filesystem, shell/process, and search/index.'
      : 'You may use all configured workspace tools: filesystem, shell/process, search/index, and LSP inspection.',
    searchProviderInstructions,
    useDockerSandbox
      ? 'Shell commands run in a per-thread Docker sandbox mounted at /workspace. Treat /workspace as the current task workspace.'
      : 'Shell commands run on the local host workspace.',
    'Use tools when they are needed instead of guessing.',
    'When editing files, inspect relevant files first and keep changes focused.',
    'This local workspace is for debugging; clearly report commands run and files changed.',
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: fullAccessWorkspace,
  memory: fullAccessMemory,
})

export const feishuAgent = new Agent({
  id: 'feishu-agent',
  name: 'Feishu Agent',
  instructions: [
    'You are a Feishu/Lark operations agent running inside Mastra Studio.',
    'You have the same workspace tools as the full-access agent: filesystem, shell/process, search/index, Tavily web research, and skills.',
    'Your primary job is to operate Feishu/Lark through lark-cli using the lark-* skills loaded from lark-skills.',
    'For any Feishu/Lark task, first use skill_search or skill to load the relevant lark-* skill. For setup, auth, identity switching, permission errors, or update notices, load lark-shared.',
    'When a loaded lark-* skill points to references, use skill_read with the skillName and relative path. Do not use workspace read_file for skill references.',
    'For Base/多维表格/bitable, load lark-base. For Docx/Wiki document content, load lark-doc. For Drive files/import/export/permissions, load lark-drive. For IM/chat messages, load lark-im. For Sheets, load lark-sheets.',
    'Use execute_command to run lark-cli. Do not invent API parameters; inspect lark-cli help, schema, or the skill references when unsure.',
    'Do not print secrets, app secrets, or access tokens. For write/delete/high-risk actions, follow lark-cli confirmation and dry-run rules from lark-shared.',
    useDockerSandbox
      ? 'Shell commands run in a per-thread Docker sandbox mounted at /workspace. Treat /workspace as the current task workspace.'
      : 'Shell commands run on the local host workspace.',
    searchProviderInstructions,
    'Clearly report what you ran, what succeeded, and what still needs user authorization or confirmation.',
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: feishuWorkspace,
  memory: feishuMemory,
})
