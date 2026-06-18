import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mastra } from '@mastra/core/mastra'
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from '@mastra/core/request-context'
import { MastraEditor } from '@mastra/editor'
import { LibSQLStore } from '@mastra/libsql'
import { Observability, MastraStorageExporter } from '@mastra/observability'
import {
  feishuAgent,
  feishuWorkspace,
  fullAccessAgent,
  fullAccessWorkspace,
  resolveThreadWorkspacePathByKey,
  sanitizeSandboxId,
  threadSandboxManager,
} from './agents/full-access-agent.js'
import { searchMcpClient } from './mcp/search-mcp.js'

const here = dirname(fileURLToPath(import.meta.url))

function findProjectRoot(start: string) {
  let current = start
  for (let i = 0; i < 10; i += 1) {
    if (
      existsSync(resolve(current, 'package.json')) &&
      existsSync(resolve(current, 'src/mastra'))
    ) {
      return current
    }
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return resolve(start, '../..')
}

const projectRoot = findProjectRoot(here)
const artifactsRoot = resolve(projectRoot, 'artifacts')

mkdirSync(resolve(artifactsRoot, 'mastra-studio'), { recursive: true })

await fullAccessWorkspace.init()
await feishuWorkspace.init()
await threadSandboxManager.load()
threadSandboxManager.start()

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
  },
  mcpServers: {
    ...searchMcpClient.toMCPServerProxies(),
  },
  workspace: fullAccessWorkspace,
  storage: new LibSQLStore({
    id: 'mastra-studio-storage',
    url: `file:${resolve(artifactsRoot, 'mastra-studio/mastra.db')}`,
  }),
  editor: new MastraEditor({
    source: 'code',
    codePath: resolve(projectRoot, 'src/mastra/editor'),
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
