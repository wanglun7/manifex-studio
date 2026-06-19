import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Mastra } from '@mastra/core/mastra'
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from '@mastra/core/request-context'
import { MastraCompositeStore } from '@mastra/core/storage'
import { DuckDBStore } from '@mastra/duckdb'
import { MastraEditor } from '@mastra/editor'
import { LibSQLStore } from '@mastra/libsql'
import { Observability, MastraStorageExporter } from '@mastra/observability'
import { manifexAuth, manifexRbac } from './auth.js'
import {
  fullAccessAgent,
  fullAccessWorkspace,
} from './agents/full-access-agent.js'
import {
  feishuAgent,
  feishuWorkspace,
} from './agents/feishu-agent.js'
import {
  dingtalkAgent,
  dingtalkWorkspace,
} from './agents/dingtalk-agent.js'
import {
  wecomAgent,
  wecomWorkspace,
} from './agents/wecom-agent.js'
import {
  wpsAgent,
  wpsWorkspace,
} from './agents/wps-agent.js'
import {
  resolveThreadWorkspacePathByKey,
  sanitizeSandboxId,
  threadSandboxManager,
} from './agents/shared.js'
import { manifexArtifactRoutes } from './manifex-artifacts.js'
import { searchMcpClient } from './mcp/search-mcp.js'
import { artifactsRoot, mastraStudioArtifactsRoot } from './paths.js'

mkdirSync(mastraStudioArtifactsRoot, { recursive: true })

await fullAccessWorkspace.init()
await feishuWorkspace.init()
await dingtalkWorkspace.init()
await wecomWorkspace.init()
await wpsWorkspace.init()
await threadSandboxManager.load()
threadSandboxManager.start()

const workspaces = [
  fullAccessWorkspace,
  feishuWorkspace,
  dingtalkWorkspace,
  wecomWorkspace,
  wpsWorkspace,
]

threadSandboxManager.onInvalidate((threadId) => {
  for (const workspace of workspaces) {
    workspace.clearSandboxCache(threadId)
  }
})

function valueToId(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value
  if (
    value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.trim()
  ) {
    return value.id
  }
  return undefined
}

async function readJsonBody(request: Request) {
  try {
    return (await request.clone().json()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export const mastra = new Mastra({
  agents: {
    fullAccessAgent,
    feishuAgent,
    dingtalkAgent,
    wecomAgent,
    wpsAgent,
  },
  mcpServers: {
    ...searchMcpClient.toMCPServerProxies(),
  },
  storage: new MastraCompositeStore({
    id: 'manifex-storage',
    default: new LibSQLStore({
      id: 'mastra-studio-storage',
      url: `file:${resolve(artifactsRoot, 'mastra-studio/mastra.db')}`,
    }),
    domains: {
      observability: await new DuckDBStore({
        id: 'manifex-observability-storage',
        path: resolve(mastraStudioArtifactsRoot, 'observability.duckdb'),
      }).getStore('observability'),
    },
  }),
  editor: new MastraEditor({
    source: 'db',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra-sandbox-research',
        sampling: { type: 'always' },
        exporters: [new MastraStorageExporter()],
        logging: {
          enabled: true,
          level: 'info',
        },
      },
    },
  }),
  server: {
    port: Number(process.env.MASTRA_PORT || 4111),
    host: '127.0.0.1',
    auth: manifexAuth,
    rbac: manifexRbac,
    apiRoutes: manifexArtifactRoutes,
    middleware: [
      {
        path: '/api/agents/*',
        handler: async (c, next) => {
          const requestContext = c.get('requestContext')
          const body = await readJsonBody(c.req.raw)
          const memory = body?.memory && typeof body.memory === 'object'
            ? (body.memory as Record<string, unknown>)
            : undefined

          const threadId =
            valueToId(memory?.thread) ||
            valueToId(body?.threadId) ||
            valueToId(body?.thread)
          const resourceId =
            valueToId(memory?.resource) ||
            valueToId(body?.resourceId) ||
            valueToId(body?.resource)

          if (threadId) requestContext.set(MASTRA_THREAD_ID_KEY, threadId)
          if (resourceId) requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceId)

          const threadKey = threadId ? sanitizeSandboxId(threadId) : undefined
          if (threadKey) {
            threadSandboxManager.beginRequest(
              threadKey,
              resolveThreadWorkspacePathByKey(threadKey),
              resourceId,
            )
          }

          try {
            await next()
          } finally {
            if (threadKey) threadSandboxManager.endRequest(threadKey)
          }
        },
      },
    ],
  },
})
