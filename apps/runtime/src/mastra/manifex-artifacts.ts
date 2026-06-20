import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import type { ApiRoute } from '@mastra/core/server'
import type { ManifexAuthz } from './auth.js'
import { getManifexUser } from './auth.js'
import { sanitizeSandboxId, resolveThreadWorkspacePathByKey } from './agents/shared.js'

const MAX_UPLOAD_BYTES = Number(process.env.MANIFEX_MAX_UPLOAD_BYTES || 200 * 1024 * 1024)

const MIME_BY_EXT: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
}

function safeFilename(name: string) {
  const cleaned = basename(name || 'upload.bin')
    .replace(/[^\w.\-() \u4e00-\u9fa5]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'upload.bin'
}

function contentTypeFor(path: string) {
  return MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream'
}

function resolveWorkspaceFile(threadKey: string, rawPath: string) {
  const workspacePath = resolveThreadWorkspacePathByKey(threadKey)
  const sandboxPath = rawPath
    .replace(/^sandbox:/, '')
    .replace(/^\/workspace\/?/, '')
    .replace(/^workspace\/?/, '')
  const absolutePath = resolve(workspacePath, sandboxPath || '.')
  if (absolutePath !== workspacePath && !absolutePath.startsWith(`${workspacePath}${sep}`)) {
    throw new Error('Path escapes thread workspace')
  }
  return { workspacePath, absolutePath }
}

function currentUser(c: any) {
  return getManifexUser(c.get('requestContext')?.get('user'))
}

function forbiddenResponse(message = 'Forbidden') {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  })
}

async function uploadAttachments(authz: ManifexAuthz, user: NonNullable<ReturnType<typeof getManifexUser>>, threadId: string, formData: FormData) {
  const threadKey = sanitizeSandboxId(await authz.threadSandboxKey(user, threadId))
  const { workspacePath } = resolveWorkspaceFile(threadKey, '/workspace')
  const uploadsDir = resolve(workspacePath, 'uploads')
  mkdirSync(uploadsDir, { recursive: true })

  const files = formData.getAll('files')
  const attachments = []

  for (const value of files) {
    if (
      !value ||
      typeof value !== 'object' ||
      !('arrayBuffer' in value) ||
      typeof value.arrayBuffer !== 'function'
    ) {
      continue
    }

    const file = value as File
    const originalName = safeFilename(file.name)
    const arrayBuffer = await file.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`File ${originalName} exceeds upload limit`)
    }

    const bytes = Buffer.from(arrayBuffer)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const id = randomUUID()
    const ext = extname(originalName)
    const stem = originalName.slice(0, originalName.length - ext.length)
    const storedName = `${stem || 'upload'}-${id.slice(0, 8)}${ext}`
    const absolutePath = resolve(uploadsDir, storedName)
    await writeFile(absolutePath, bytes)

    const sandboxPath = `/workspace/uploads/${storedName}`
    await authz.recordArtifact(user, {
      threadId,
      path: sandboxPath,
      name: originalName,
      mimeType: file.type || contentTypeFor(originalName),
      size: bytes.byteLength,
      sha256,
    })

    attachments.push({
      id,
      name: originalName,
      storedName,
      mimeType: file.type || contentTypeFor(originalName),
      size: bytes.byteLength,
      sha256,
      sandboxPath,
      artifactUrl: `/manifex/threads/${encodeURIComponent(threadId)}/artifacts?path=${encodeURIComponent(sandboxPath)}`,
    })
  }

  return attachments
}

export function createManifexArtifactRoutes(authz: ManifexAuthz): ApiRoute[] {
  return [
    {
      path: '/manifex/threads/:threadId/attachments',
      method: 'POST',
      requiresAuth: true,
      handler: async c => {
        const user = currentUser(c)
        if (!user) return forbiddenResponse()

        const threadId = c.req.param('threadId')
        const agentId = c.req.query('agentId')
        try {
          await authz.ensureThreadAccess(user, threadId, agentId)
          const formData = await c.req.raw.formData()
          const attachments = await uploadAttachments(authz, user, threadId, formData)
          return c.json({ attachments })
        } catch (error) {
          return forbiddenResponse(error instanceof Error ? error.message : 'Forbidden')
        }
      },
    },
    {
      path: '/manifex/threads/:threadId/artifacts',
      method: 'GET',
      requiresAuth: true,
      handler: async c => {
        const user = currentUser(c)
        if (!user) return forbiddenResponse()

        const threadId = c.req.param('threadId')
        const rawPath = c.req.query('path')
        if (!rawPath) return c.json({ error: 'Missing path' }, 400)

        try {
          await authz.ensureThreadAccess(user, threadId)
          const threadKey = sanitizeSandboxId(await authz.threadSandboxKey(user, threadId))
          let { absolutePath } = resolveWorkspaceFile(threadKey, rawPath)
          let stat: ReturnType<typeof statSync>
          try {
            stat = statSync(absolutePath)
          } catch (error) {
            const legacyThreadKey = sanitizeSandboxId(threadKey)
            if (legacyThreadKey === threadKey) throw error
            const legacyFile = resolveWorkspaceFile(legacyThreadKey, rawPath)
            absolutePath = legacyFile.absolutePath
            stat = statSync(absolutePath)
          }
          if (!stat.isFile()) return c.json({ error: 'Not a file' }, 404)

          const body = await readFile(absolutePath)
          return new Response(body, {
            headers: {
              'content-type': contentTypeFor(absolutePath),
              'cache-control': 'private, max-age=30',
            },
          })
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : 'Artifact not found' },
            404,
          )
        }
      },
    },
  ]
}
