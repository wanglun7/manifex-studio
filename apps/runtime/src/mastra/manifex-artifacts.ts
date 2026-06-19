import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import type { ApiRoute } from '@mastra/core/server'
import { sanitizeSandboxId, resolveThreadWorkspacePathByKey } from './agents/shared.js'
import { getManifexUser, type ManifexAuthz, type ManifexUser } from './auth.js'

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

function resolveWorkspaceFile(threadId: string, rawPath: string) {
  const threadKey = sanitizeSandboxId(threadId)
  const workspacePath = resolveThreadWorkspacePathByKey(threadKey)
  const sandboxPath = rawPath
    .replace(/^sandbox:/, '')
    .replace(/^\/workspace\/?/, '')
    .replace(/^workspace\/?/, '')
  const absolutePath = resolve(workspacePath, sandboxPath || '.')
  if (absolutePath !== workspacePath && !absolutePath.startsWith(`${workspacePath}${sep}`)) {
    throw new Error('Path escapes thread workspace')
  }
  return { threadKey, workspacePath, absolutePath }
}

function contentTypeFor(path: string) {
  return MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream'
}

async function uploadAttachments(authz: ManifexAuthz, user: ManifexUser, threadId: string, formData: FormData) {
  await authz.ensureThreadAccess(user, threadId)

  const { workspacePath } = resolveWorkspaceFile(threadId, '/workspace')
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
    attachments.push({
      id,
      name: originalName,
      storedName,
      mimeType: file.type || contentTypeFor(originalName),
      size: bytes.byteLength,
      sha256,
      sandboxPath,
      artifactUrl: `/manifex/threads/${encodeURIComponent(
        sanitizeSandboxId(threadId),
      )}/artifacts?path=${encodeURIComponent(sandboxPath)}`,
    })

    await authz.recordArtifact(user, {
      threadId,
      path: sandboxPath,
      name: originalName,
      mimeType: file.type || contentTypeFor(originalName),
      size: bytes.byteLength,
      sha256,
    })
  }

  return attachments
}

function currentUser(c: any) {
  return getManifexUser(c.get('requestContext')?.get('user'))
}

function forbidden() {
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  })
}

export function createManifexArtifactRoutes(authz: ManifexAuthz): ApiRoute[] {
  return [
  {
    path: '/manifex/threads/:threadId/attachments',
    method: 'POST',
    requiresAuth: true,
    handler: async c => {
      const user = currentUser(c)
      if (!user) return forbidden()

      const threadId = c.req.param('threadId')
      const formData = await c.req.raw.formData()
      const attachments = await uploadAttachments(authz, user, threadId, formData)
      return c.json({ attachments })
    },
  },
  {
    path: '/manifex/threads/:threadId/artifacts',
    method: 'GET',
    requiresAuth: true,
    handler: async c => {
      const user = currentUser(c)
      if (!user) return forbidden()

      const threadId = c.req.param('threadId')
      const rawPath = c.req.query('path')
      if (!rawPath) return c.json({ error: 'Missing path' }, 400)

      try {
        await authz.ensureThreadAccess(user, threadId)
        const { absolutePath } = resolveWorkspaceFile(threadId, rawPath)
        const stat = statSync(absolutePath)
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
