import { timingSafeEqual, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { createClient, type Client } from '@libsql/client'
import {
  ClientWriteRequestOnDuplicateWrites,
  ClientWriteRequestOnMissingDeletes,
  CredentialsMethod,
  OpenFgaClient,
} from '@openfga/sdk'
import { MastraAuthProvider } from '@mastra/core/server'
import { loadUpstreamEnv, optionalEnv } from './env.js'
import { artifactsRoot } from './paths.js'

loadUpstreamEnv()

const scrypt = promisify(scryptCallback)

export type ManifexRole = 'owner' | 'operator' | 'member'

export type ManifexUser = {
  id: string
  orgId: string
  email: string
  name: string
  role: ManifexRole
  status: 'active' | 'disabled'
  avatarUrl?: string
  agentIds?: string[]
}

export type ManifexAccess = {
  roles: ManifexRole[]
  agentIds: string[]
  permissions: string[]
  resourceId: string
}

type StoredSession = {
  id: string
  userId: string
  orgId: string
  createdAt: Date
  expiresAt: Date
  metadata?: Record<string, unknown>
}

type UserRow = {
  id: string
  org_id: string
  email: string
  name: string
  role: ManifexRole
  status: 'active' | 'disabled'
  password_hash: string | null
  avatar_url: string | null
}

type SessionRow = {
  id: string
  user_id: string
  org_id: string
  expires_at: string
  created_at: string
  metadata: string | null
}

type AgentAssignmentRow = {
  agent_id: string
}

type ThreadRow = {
  id: string
  org_id: string
  user_id: string
  agent_id: string
  resource_id: string
}

type TupleKey = {
  user: string
  relation: string
  object: string
}

const SESSION_COOKIE = 'manifex_session'
export const MANIFEX_INTERNAL_AUTH_HEADER = 'x-manifex-internal-auth'
export const MANIFEX_INTERNAL_AUTH_SECRET = randomBytes(32).toString('hex')
const SESSION_TTL_MS = Number(optionalEnv('MANIFEX_SESSION_TTL_MS') || 7 * 24 * 60 * 60 * 1000)
const PASSWORD_KEY_BYTES = 64
const DEFAULT_ORG_ID = optionalEnv('MANIFEX_DEFAULT_ORG_ID') || 'default'
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod'

const DEFAULT_MEMBER_AGENTS = [
  'full-access-agent',
  'feishu-agent',
  'dingtalk-agent',
  'wecom-agent',
  'wps-agent',
]

const ROLE_PERMISSIONS: Record<ManifexRole, string[]> = {
  owner: ['*'],
  operator: [
    'auth:read',
    'system:read',
    'agents:read',
    'agents:execute',
    'tools:read',
    'tools:execute',
    'mcp:read',
    'mcp:execute',
    'workspaces:read',
    'memory:read',
    'memory:write',
    'artifacts:read',
    'artifacts:write',
    'observability:read',
    'logs:read',
  ],
  member: [
    'auth:read',
    'system:read',
    'agents:read',
    'agents:execute',
    'tools:read',
    'tools:execute',
    'mcp:read',
    'mcp:execute',
    'workspaces:read',
    'memory:read',
    'memory:write',
    'artifacts:read',
    'artifacts:write',
    'observability:read',
  ],
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function parseCsvEnv(name: string, fallback: string[]) {
  const raw = optionalEnv(name)
  if (!raw) return fallback
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function dbValue(value: unknown) {
  return value === undefined ? null : value
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withBusyRetry<T>(operation: () => Promise<T>, attempts = 20): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('SQLITE_BUSY') && !message.includes('database is locked')) {
        throw error
      }
      await sleep(150 + attempt * 100)
    }
  }
  throw lastError
}

function resourceIdFor(user: Pick<ManifexUser, 'orgId' | 'id'>) {
  return `org:${user.orgId}:user:${user.id}`
}

export function memoryResourceIdFor(user: Pick<ManifexUser, 'orgId' | 'id'>, agentId: string) {
  return `org:${user.orgId}:user:${user.id}:agent:${agentId}`
}

function fgaSafeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function fgaUser(user: Pick<ManifexUser, 'id'>) {
  return `user:${fgaSafeId(user.id)}`
}

function fgaOrg(orgId: string) {
  return `org:${fgaSafeId(orgId)}`
}

function fgaAgent(agentId: string) {
  return `agent:${fgaSafeId(agentId)}`
}

function fgaThread(threadId: string) {
  return `thread:${fgaSafeId(threadId)}`
}

function fgaMemoryResource(memoryResourceId: string) {
  return `memory_resource:${fgaSafeId(memoryResourceId)}`
}

function fgaArtifact(artifactId: string) {
  return `artifact:${fgaSafeId(artifactId)}`
}

function fgaSandbox(sandboxId: string) {
  return `sandbox:${fgaSafeId(sandboxId)}`
}

function cookieFromRequest(request: Request, name: string) {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null

  for (const part of cookie.split(';')) {
    const [rawKey, ...valueParts] = part.trim().split('=')
    if (rawKey === name) return decodeURIComponent(valueParts.join('='))
  }

  return null
}

function bearerFromRequest(request: Request) {
  const header = request.headers.get('authorization')
  if (!header) return null
  return header.startsWith('Bearer ') ? header.slice(7) : header
}

function hasInternalAuth(request?: Request) {
  return request?.headers.get(MANIFEX_INTERNAL_AUTH_HEADER) === MANIFEX_INTERNAL_AUTH_SECRET
}

function webRequestFrom(value: unknown): Request | undefined {
  if (value instanceof Request) return value
  if (value && typeof value === 'object' && 'raw' in value && value.raw instanceof Request) {
    return value.raw
  }
  return undefined
}

function pathWithoutApiPrefix(request?: Request) {
  if (!request) return '/'
  const pathname = new URL(request.url).pathname
  return pathname.startsWith('/api') ? pathname.slice('/api'.length) || '/' : pathname
}

function queryValue(request: Request | undefined, name: string) {
  if (!request) return undefined
  const value = new URL(request.url).searchParams.get(name)
  return value?.trim() || undefined
}

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

async function readJsonBody(request?: Request) {
  if (!request) return undefined
  try {
    return (await request.clone().json()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function agentIdFromPath(path: string) {
  if (path === '/agents/providers' || path.startsWith('/agents/providers/')) return undefined
  const match = path.match(/^\/agents\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function threadIdFromPath(path: string) {
  const match = path.match(/^\/memory\/(?:network\/)?threads\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function isWorkingMemoryThreadPath(path: string) {
  return /^\/memory\/(?:network\/)?threads\/[^/]+\/working-memory$/.test(path)
}

function scopedTraceAgentId(request: Request | undefined) {
  const rootEntityType = queryValue(request, 'rootEntityType')?.toLowerCase()
  if (rootEntityType === 'agent') return queryValue(request, 'filterEntityId')

  const entityType = queryValue(request, 'entityType')?.toLowerCase()
  if (entityType === 'agent') return queryValue(request, 'entityId')

  return undefined
}

function scopedTraceResourceId(request: Request | undefined) {
  return queryValue(request, 'resourceId') || queryValue(request, 'filterResourceId')
}

function bodyFilterResourceId(body?: Record<string, unknown>) {
  const filters = body?.filters && typeof body.filters === 'object'
    ? (body.filters as Record<string, unknown>)
    : undefined
  return valueToId(filters?.resourceId) || valueToId(body?.resourceId)
}

function requestResourceScope(request: Request | undefined, body?: Record<string, unknown>) {
  if (request?.method === 'GET') return scopedTraceResourceId(request)
  return bodyFilterResourceId(body)
}

function threadIdFromBody(body?: Record<string, unknown>) {
  const memory = body?.memory && typeof body.memory === 'object'
    ? (body.memory as Record<string, unknown>)
    : undefined

  return (
    valueToId(memory?.thread) ||
    valueToId(body?.threadId) ||
    valueToId(body?.thread)
  )
}

function resourceIdFromBody(body?: Record<string, unknown>) {
  const memory = body?.memory && typeof body.memory === 'object'
    ? (body.memory as Record<string, unknown>)
    : undefined

  return (
    valueToId(memory?.resource) ||
    valueToId(body?.resourceId) ||
    valueToId(body?.resource)
  )
}

function hasPermission(grants: string[], required: string) {
  if (grants.includes('*')) return true

  const [requiredResource, requiredAction] = required.split(':')
  return grants.some(grant => {
    const [grantResource, grantAction] = grant.split(':')
    if (!grantResource || !grantAction) return grant === required
    if (grantResource !== '*' && grantResource !== requiredResource) return false
    return grantAction === '*' || grantAction === requiredAction
  })
}

function isAllowedClientResourceId(clientResourceId: string | undefined, enforcedResourceId: string | undefined, agentId: string | undefined) {
  if (!clientResourceId) return true
  if (enforcedResourceId && clientResourceId === enforcedResourceId) return true
  return Boolean(agentId && clientResourceId === agentId)
}

function isOwnerOperator(user: Pick<ManifexUser, 'role'> | null | undefined) {
  return user?.role === 'owner' || user?.role === 'operator'
}

function isStudioDeveloperRoute(path: string) {
  return (
    path.startsWith('/stored/') ||
    path.startsWith('/agent-builder') ||
    path.startsWith('/editor/') ||
    path.startsWith('/datasets') ||
    path.startsWith('/experiments') ||
    path.startsWith('/scores') ||
    path.startsWith('/workflows') ||
    path.startsWith('/channels') ||
    path.startsWith('/processor-providers') ||
    path.startsWith('/processors') ||
    path.startsWith('/tool-providers')
  )
}

const WORKSPACE_AGENT_IDS = new Map([
  ['full-access-workspace', 'full-access-agent'],
  ['feishu-workspace', 'feishu-agent'],
  ['dingtalk-workspace', 'dingtalk-agent'],
  ['wecom-workspace', 'wecom-agent'],
  ['wps-workspace', 'wps-agent'],
])

function workspaceIdFromPath(path: string) {
  const match = path.match(/^\/workspaces\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function workspaceAgentIdFromPath(path: string) {
  const workspaceId = workspaceIdFromPath(path)
  return workspaceId ? WORKSPACE_AGENT_IDS.get(workspaceId) : undefined
}

function isToolsRoute(path: string) {
  return path === '/tools' || path.startsWith('/tools/')
}

function isMcpRoute(path: string) {
  return path === '/mcp' || path.startsWith('/mcp/')
}

function isAgentConfigRoute(path: string) {
  return (
    /^\/agents\/[^/]+\/clone$/.test(path) ||
    /^\/agents\/[^/]+\/model(?:\/.*)?$/.test(path) ||
    /^\/agents\/[^/]+\/models(?:\/.*)?$/.test(path) ||
    /^\/agents\/[^/]+\/instructions\/enhance$/.test(path)
  )
}

function isDirectAgentToolExecuteRoute(path: string) {
  return /^\/agents\/[^/]+\/tools\/[^/]+\/execute$/.test(path)
}

function isLegacyRunOnlyAgentRoute(path: string) {
  return (
    /^\/agents\/[^/]+\/(?:approve-tool-call|decline-tool-call|approve-tool-call-generate|decline-tool-call-generate|approve-network-tool-call|decline-network-tool-call)$/.test(path) ||
    /^\/agents\/[^/]+\/(?:signals|send-message|queue-message|resume-stream|resume-stream-until-idle)$/.test(path)
  )
}

function bodyRunId(body?: Record<string, unknown>) {
  return valueToId(body?.runId) || valueToId(body?.run)
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const derived = (await scrypt(password, salt, PASSWORD_KEY_BYTES)) as Buffer
  return `scrypt$${salt}$${derived.toString('hex')}`
}

async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false
  const [scheme, salt, digest] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !digest) return false

  const expected = Buffer.from(digest, 'hex')
  const actual = (await scrypt(password, salt, expected.length)) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

class ManifexAuthStore {
  constructor(private readonly db: Client) {}

  static async create() {
    mkdirSync(artifactsRoot, { recursive: true })
    const url = optionalEnv('MANIFEX_AUTH_DB_URL') || `file:${artifactsRoot}/manifex-auth.db`
    const store = new ManifexAuthStore(createClient({ url }))
    await withBusyRetry(() => store.migrate())
    await withBusyRetry(() => store.seed())
    return store
  }

  async migrate() {
    await this.db.batch([
      `CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        password_hash TEXT,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, email)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS agent_assignments (
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (org_id, user_id, agent_id)
      )`,
      `CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        sha256 TEXT,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_users_org_email ON users (org_id, email)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)',
      'CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads (org_id, user_id)',
      'CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts (org_id, thread_id)',
    ], 'write')
  }

  async seed() {
    await this.db.execute({
      sql: 'INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)',
      args: [DEFAULT_ORG_ID, optionalEnv('MANIFEX_DEFAULT_ORG_NAME') || 'Manifex', nowIso()],
    })

    const ownerPassword =
      optionalEnv('MANIFEX_BOOTSTRAP_OWNER_PASSWORD') ||
      optionalEnv('MANIFEX_AUTH_OWNER_TOKEN') ||
      (IS_PRODUCTION ? '' : 'owner-token')

    if (!ownerPassword || (IS_PRODUCTION && ownerPassword === 'owner-token')) {
      throw new Error('MANIFEX_BOOTSTRAP_OWNER_PASSWORD must be set to a non-default value in production')
    }

    const owner = await this.ensureUser({
      orgId: DEFAULT_ORG_ID,
      email: normalizeEmail(optionalEnv('MANIFEX_BOOTSTRAP_OWNER_EMAIL') || 'owner@manifex.local'),
      name: optionalEnv('MANIFEX_BOOTSTRAP_OWNER_NAME') || 'Owner',
      role: 'owner',
      password: ownerPassword,
    })
    await this.ensureAgentAssignments(owner, parseCsvEnv('MANIFEX_OWNER_AGENT_IDS', ['*']))

    const memberSeed = optionalEnv('MANIFEX_BOOTSTRAP_MEMBERS')
    if (memberSeed) {
      for (const item of memberSeed.split(',').map(value => value.trim()).filter(Boolean)) {
        const [email, password, name] = item.split(':').map(value => value?.trim())
        if (!email || !password) continue
        const member = await this.ensureUser({
          orgId: DEFAULT_ORG_ID,
          email: normalizeEmail(email),
          name: name || email,
          role: 'member',
          password,
        })
        await this.ensureAgentAssignments(member, parseCsvEnv('MANIFEX_MEMBER_AGENT_IDS', DEFAULT_MEMBER_AGENTS))
      }
    } else if (!IS_PRODUCTION) {
      const member = await this.ensureUser({
        orgId: DEFAULT_ORG_ID,
        email: 'member@manifex.local',
        name: 'Member',
        role: 'member',
        password: optionalEnv('MANIFEX_DEV_MEMBER_PASSWORD') || 'member-token',
      })
      await this.ensureAgentAssignments(member, parseCsvEnv('MANIFEX_MEMBER_AGENT_IDS', DEFAULT_MEMBER_AGENTS))
    }
  }

  async ensureUser(input: {
    orgId: string
    email: string
    name: string
    role: ManifexRole
    password: string
  }) {
    const existing = await this.getUserByEmail(input.orgId, input.email)
    if (existing) return existing

    const user: ManifexUser = {
      id: randomUUID(),
      orgId: input.orgId,
      email: normalizeEmail(input.email),
      name: input.name,
      role: input.role,
      status: 'active',
    }

    await this.db.execute({
      sql: `INSERT INTO users (
        id, org_id, email, name, role, status, password_hash, avatar_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        user.id,
        user.orgId,
        user.email,
        user.name,
        user.role,
        user.status,
        await hashPassword(input.password),
        null,
        nowIso(),
        nowIso(),
      ],
    })

    return user
  }

  async ensureAgentAssignments(user: ManifexUser, agentIds: string[]) {
    for (const agentId of agentIds) {
      await this.db.execute({
        sql: `INSERT OR IGNORE INTO agent_assignments (org_id, user_id, agent_id, created_at)
          VALUES (?, ?, ?, ?)`,
        args: [user.orgId, user.id, agentId, nowIso()],
      })
    }
  }

  toUser(row: UserRow): ManifexUser {
    return {
      id: row.id,
      orgId: row.org_id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      avatarUrl: row.avatar_url || undefined,
    }
  }

  async hydrateUser(user: ManifexUser | null) {
    if (!user) return null
    return { ...user, agentIds: await this.getAssignedAgentIds(user) }
  }

  async getUserByEmail(orgId: string, email: string) {
    const result = await this.db.execute({
      sql: 'SELECT * FROM users WHERE org_id = ? AND email = ? LIMIT 1',
      args: [orgId, normalizeEmail(email)],
    })
    const row = result.rows[0] as unknown as UserRow | undefined
    return row ? this.toUser(row) : null
  }

  async getUserById(userId: string) {
    const result = await this.db.execute({
      sql: 'SELECT * FROM users WHERE id = ? LIMIT 1',
      args: [userId],
    })
    const row = result.rows[0] as unknown as UserRow | undefined
    return row ? this.toUser(row) : null
  }

  async getUsers(userIds: string[]) {
    return Promise.all(userIds.map(userId => this.getUserById(userId)))
  }

  async validateCredentials(email: string, password: string) {
    const result = await this.db.execute({
      sql: 'SELECT * FROM users WHERE org_id = ? AND email = ? LIMIT 1',
      args: [DEFAULT_ORG_ID, normalizeEmail(email)],
    })
    const row = result.rows[0] as unknown as UserRow | undefined
    if (!row || row.status !== 'active') return null
    if (!(await verifyPassword(password, row.password_hash))) return null
    return this.toUser(row)
  }

  async createSession(userId: string, orgId: string, metadata?: Record<string, unknown>) {
    const createdAt = new Date()
    const session: StoredSession = {
      id: randomUUID(),
      userId,
      orgId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS),
      metadata,
    }

    await this.db.execute({
      sql: `INSERT INTO sessions (id, user_id, org_id, expires_at, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        session.id,
        session.userId,
        session.orgId,
        session.expiresAt.toISOString(),
        session.createdAt.toISOString(),
        safeJson(metadata),
      ],
    })

    return session
  }

  async getSession(sessionId: string) {
    const result = await this.db.execute({
      sql: 'SELECT * FROM sessions WHERE id = ? LIMIT 1',
      args: [sessionId],
    })
    const row = result.rows[0] as unknown as SessionRow | undefined
    if (!row) return null

    const expiresAt = new Date(row.expires_at)
    if (expiresAt.getTime() <= Date.now()) {
      await this.destroySession(sessionId)
      return null
    }

    return {
      id: row.id,
      userId: row.user_id,
      orgId: row.org_id,
      expiresAt,
      createdAt: new Date(row.created_at),
      metadata: parseJsonObject(row.metadata),
    } satisfies StoredSession
  }

  async destroySession(sessionId: string) {
    await this.db.execute({
      sql: 'DELETE FROM sessions WHERE id = ?',
      args: [sessionId],
    })
  }

  async refreshSession(sessionId: string) {
    const session = await this.getSession(sessionId)
    if (!session) return null

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await this.db.execute({
      sql: 'UPDATE sessions SET expires_at = ? WHERE id = ?',
      args: [expiresAt.toISOString(), sessionId],
    })

    return { ...session, expiresAt }
  }

  async getAssignedAgentIds(user: ManifexUser) {
    if (user.role === 'owner' || user.role === 'operator') return ['*']

    const result = await this.db.execute({
      sql: 'SELECT agent_id FROM agent_assignments WHERE org_id = ? AND user_id = ?',
      args: [user.orgId, user.id],
    })
    return (result.rows as unknown as AgentAssignmentRow[]).map(row => row.agent_id)
  }

  async getThread(threadId: string) {
    const result = await this.db.execute({
      sql: 'SELECT * FROM threads WHERE id = ? LIMIT 1',
      args: [threadId],
    })
    return result.rows[0] as unknown as ThreadRow | undefined
  }

  async upsertThread(input: {
    threadId: string
    user: ManifexUser
    agentId: string
    resourceId: string
  }) {
    const existing = await this.getThread(input.threadId)
    if (existing && (existing.org_id !== input.user.orgId || existing.user_id !== input.user.id)) {
      throw new Error('Thread belongs to a different user')
    }

    if (existing) {
      if (existing.agent_id !== input.agentId || existing.resource_id !== input.resourceId) {
        throw new Error('Thread belongs to a different agent or resource')
      }

      await this.db.execute({
        sql: 'UPDATE threads SET updated_at = ? WHERE id = ?',
        args: [nowIso(), input.threadId],
      })
      return
    }

    await this.db.execute({
      sql: 'INSERT INTO threads (id, org_id, user_id, agent_id, resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [input.threadId, input.user.orgId, input.user.id, input.agentId, input.resourceId, nowIso(), nowIso()],
    })
  }

  async recordArtifact(input: {
    orgId: string
    userId: string
    threadId: string
    path: string
    name: string
    mimeType?: string
    size?: number
    sha256?: string
  }) {
    const id = randomUUID()
    await this.db.execute({
      sql: `INSERT INTO artifacts (id, org_id, user_id, thread_id, path, name, mime_type, size, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.orgId,
        input.userId,
        input.threadId,
        input.path,
        input.name,
        dbValue(input.mimeType),
        dbValue(input.size),
        dbValue(input.sha256),
        nowIso(),
      ],
    })
    return id
  }
}

class OpenFgaAuthorizer {
  private readonly client?: OpenFgaClient
  private readonly modelId?: string

  constructor() {
    const apiUrl = optionalEnv('OPENFGA_API_URL') || optionalEnv('FGA_API_URL')
    const storeId = optionalEnv('OPENFGA_STORE_ID') || optionalEnv('FGA_STORE_ID')
    this.modelId = optionalEnv('OPENFGA_AUTHORIZATION_MODEL_ID') || optionalEnv('FGA_MODEL_ID')

    if (!apiUrl || !storeId) return

    const token = optionalEnv('OPENFGA_API_TOKEN') || optionalEnv('FGA_API_TOKEN')
    const clientCredentialsId = optionalEnv('OPENFGA_CLIENT_ID') || optionalEnv('FGA_CLIENT_ID')
    const clientCredentialsSecret = optionalEnv('OPENFGA_CLIENT_SECRET') || optionalEnv('FGA_CLIENT_SECRET')

    const options: Record<string, unknown> = {
      apiUrl,
      storeId,
      authorizationModelId: this.modelId,
    }

    if (token) {
      options.credentials = {
        method: CredentialsMethod.ApiToken,
        config: { token },
      }
    } else if (clientCredentialsId && clientCredentialsSecret) {
      options.credentials = {
        method: CredentialsMethod.ClientCredentials,
        config: {
          apiTokenIssuer: optionalEnv('OPENFGA_API_TOKEN_ISSUER') || optionalEnv('FGA_API_TOKEN_ISSUER'),
          apiAudience: optionalEnv('OPENFGA_API_AUDIENCE') || optionalEnv('FGA_API_AUDIENCE'),
          clientId: clientCredentialsId,
          clientSecret: clientCredentialsSecret,
        },
      }
    }

    this.client = new OpenFgaClient(options as never)
  }

  get enabled() {
    return Boolean(this.client)
  }

  async check(tuple: TupleKey) {
    if (!this.client) return undefined
    const result = await this.client.check(tuple, this.modelId ? { authorizationModelId: this.modelId } : undefined)
    return Boolean(result.allowed)
  }

  async listAgentIds(user: ManifexUser) {
    if (!this.client) return undefined
    const response = await this.client.listObjects(
      {
        user: fgaUser(user),
        relation: 'viewer',
        type: 'agent',
      },
      this.modelId ? { authorizationModelId: this.modelId } : undefined,
    )
    return response.objects.map(object => object.replace(/^agent:/, ''))
  }

  async writeTuples(writes: TupleKey[]) {
    if (!this.client || !writes.length) return
    await this.client.write(
      { writes },
      {
        ...(this.modelId ? { authorizationModelId: this.modelId } : {}),
        conflict: {
          onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore,
          onMissingDeletes: ClientWriteRequestOnMissingDeletes.Ignore,
        },
      },
    )
  }
}

export class ManifexAuthz {
  private readonly openfga = new OpenFgaAuthorizer()

  constructor(private readonly store: ManifexAuthStore) {}

  resourceIdFor(user: ManifexUser) {
    return resourceIdFor(user)
  }

  async getAccess(user: ManifexUser): Promise<ManifexAccess> {
    return {
      roles: [user.role],
      permissions: ROLE_PERMISSIONS[user.role],
      agentIds: await this.getAssignedAgentIds(user),
      resourceId: this.resourceIdFor(user),
    }
  }

  async getAssignedAgentIds(user: ManifexUser) {
    if (user.role === 'owner' || user.role === 'operator') return ['*']
    return (await this.openfga.listAgentIds(user)) ?? this.store.getAssignedAgentIds(user)
  }

  async can(user: ManifexUser, permission: string) {
    return hasPermission(ROLE_PERMISSIONS[user.role], permission)
  }

  async require(user: ManifexUser | null | undefined, permission: string) {
    if (!user || !(await this.can(user, permission))) {
      throw new Error('Forbidden')
    }
  }

  async canUseAgent(user: ManifexUser, agentId: string, relation: 'viewer' | 'executor' = 'executor') {
    if (user.role === 'owner' || user.role === 'operator') return true
    const allowedByFga = await this.openfga.check({
      user: fgaUser(user),
      relation,
      object: fgaAgent(agentId),
    })
    if (allowedByFga !== undefined) return allowedByFga

    const agentIds = await this.store.getAssignedAgentIds(user)
    return agentIds.includes('*') || agentIds.includes(agentId)
  }

  async requireAgent(user: ManifexUser, agentId: string, relation: 'viewer' | 'executor' = 'executor') {
    if (!(await this.canUseAgent(user, agentId, relation))) {
      throw new Error('Forbidden')
    }
  }

  async ensureThreadAccess(user: ManifexUser, threadId: string, agentId?: string) {
    const thread = await this.store.getThread(threadId)
    if (!thread) {
      if (!agentId) throw new Error('Unknown thread')
      await this.recordThread(user, threadId, agentId)
      return
    }

    if (thread.org_id !== user.orgId || thread.user_id !== user.id) {
      throw new Error('Forbidden')
    }

    if (agentId && thread.agent_id !== agentId) {
      throw new Error('Forbidden')
    }

    const allowedByFga = await this.openfga.check({
      user: fgaUser(user),
      relation: 'viewer',
      object: fgaThread(threadId),
    })
    if (allowedByFga === false) throw new Error('Forbidden')
  }

  async threadSandboxKey(user: ManifexUser, threadId: string) {
    const thread = await this.store.getThread(threadId)
    if (!thread) throw new Error('Unknown thread')
    if (thread.org_id !== user.orgId || thread.user_id !== user.id) {
      throw new Error('Forbidden')
    }
    return `${thread.resource_id}:${thread.agent_id}:${thread.id}`
  }

  async recordThread(user: ManifexUser, threadId: string, agentId: string) {
    await this.requireAgent(user, agentId, 'executor')
    const resourceId = this.resourceIdFor(user)
    const memoryResourceId = memoryResourceIdFor(user, agentId)
    const sandboxId = `${resourceId}:${agentId}:${threadId}`
    await this.store.upsertThread({
      threadId,
      user,
      agentId,
      resourceId,
    })
    await this.openfga.writeTuples([
      { user: fgaOrg(user.orgId), relation: 'org', object: fgaAgent(agentId) },
      { user: fgaUser(user), relation: 'owner', object: fgaMemoryResource(memoryResourceId) },
      { user: fgaAgent(agentId), relation: 'agent', object: fgaMemoryResource(memoryResourceId) },
      { user: fgaUser(user), relation: 'owner', object: fgaThread(threadId) },
      { user: fgaAgent(agentId), relation: 'agent', object: fgaThread(threadId) },
      { user: fgaMemoryResource(memoryResourceId), relation: 'memory_resource', object: fgaThread(threadId) },
      { user: fgaUser(user), relation: 'owner', object: fgaSandbox(sandboxId) },
      { user: fgaThread(threadId), relation: 'thread', object: fgaSandbox(sandboxId) },
    ])
  }

  async recordAgentAssignment(user: ManifexUser, agentId: string) {
    await this.openfga.writeTuples([
      { user: fgaOrg(user.orgId), relation: 'org', object: fgaAgent(agentId) },
      { user: fgaUser(user), relation: 'assignee', object: fgaAgent(agentId) },
    ])
  }

  async recordArtifact(
    user: ManifexUser,
    input: { threadId: string; path: string; name: string; mimeType?: string; size?: number; sha256?: string },
  ) {
    await this.ensureThreadAccess(user, input.threadId)
    const artifactId = await this.store.recordArtifact({
      orgId: user.orgId,
      userId: user.id,
      ...input,
    })
    await this.openfga.writeTuples([
      { user: fgaUser(user), relation: 'owner', object: fgaArtifact(artifactId) },
      { user: fgaThread(input.threadId), relation: 'thread', object: fgaArtifact(artifactId) },
    ])
  }
}

export class ManifexAuthProvider extends MastraAuthProvider<ManifexUser> {
  constructor(
    private readonly store: ManifexAuthStore,
    private readonly authz: ManifexAuthz,
  ) {
    super({
      name: 'manifex-auth',
      mapUserToResourceId: user => resourceIdFor(user),
    })
  }

  async authenticateToken(token: string, request: Request) {
    const sessionId = token || bearerFromRequest(request) || cookieFromRequest(request, SESSION_COOKIE)
    if (!sessionId) return null
    const session = await this.store.getSession(sessionId)
    if (!session) return null
    return this.store.hydrateUser(await this.store.getUserById(session.userId))
  }

  async authorizeUser(user: ManifexUser, request: unknown) {
    if (user.status !== 'active') return false

    const webRequest = webRequestFrom(request)
    const path = pathWithoutApiPrefix(webRequest)
    const body = await readJsonBody(webRequest)

    try {
      if (path.startsWith('/auth/')) return true
      if (path.startsWith('/manifex/auth/')) return true

      if (path.startsWith('/observability/discovery/')) {
        await this.authz.require(user, 'observability:read')
        return true
      }

      if (path.startsWith('/observability/traces') || path.startsWith('/observability/branches') || path.startsWith('/traces')) {
        const traceAgentId = scopedTraceAgentId(webRequest)
        if (traceAgentId) {
          await this.authz.require(user, 'observability:read')
          await this.authz.requireAgent(user, traceAgentId, 'viewer')
          if (!isOwnerOperator(user) && scopedTraceResourceId(webRequest) !== this.authz.resourceIdFor(user)) {
            return false
          }
          return true
        }

        await this.authz.require(user, 'observability:read')
        if (!isOwnerOperator(user) && requestResourceScope(webRequest, body) !== this.authz.resourceIdFor(user)) return false
        return true
      }

      if (path.startsWith('/observability/metrics') || path.startsWith('/metrics')) {
        await this.authz.require(user, 'observability:read')
        if (!isOwnerOperator(user) && requestResourceScope(webRequest, body) !== this.authz.resourceIdFor(user)) return false
        return true
      }

      if (path.startsWith('/logs') || path.startsWith('/observability')) {
        if (!isOwnerOperator(user)) return false
        await this.authz.require(user, 'observability:read')
        return true
      }

      if (isToolsRoute(path)) {
        await this.authz.require(user, webRequest?.method === 'GET' ? 'tools:read' : 'tools:execute')
        return true
      }

      if (isMcpRoute(path)) {
        await this.authz.require(user, webRequest?.method === 'GET' ? 'mcp:read' : 'mcp:execute')
        return true
      }

      if (path === '/system/packages') {
        await this.authz.require(user, 'system:read')
        return true
      }

      if (path.startsWith('/system/')) {
        return isOwnerOperator(user)
      }

      if (path === '/workspaces') {
        await this.authz.require(user, 'workspaces:read')
        return true
      }

      if (path.startsWith('/workspaces/')) {
        await this.authz.require(user, 'workspaces:read')
        if (isOwnerOperator(user)) return true

        const workspaceAgentId = workspaceAgentIdFromPath(path)
        if (!workspaceAgentId) return false
        await this.authz.requireAgent(user, workspaceAgentId, 'viewer')
        return true
      }

      if (isStudioDeveloperRoute(path)) {
        return isOwnerOperator(user)
      }

      const queryAgentId = queryValue(webRequest, 'agentId')
      if (queryAgentId) {
        await this.authz.requireAgent(user, queryAgentId, 'viewer')
      }

      if (path === '/memory/status' || path === '/memory/network/status' || path === '/memory/config') {
        await this.authz.require(user, 'memory:read')
        return true
      }

      const memoryThreadId = threadIdFromPath(path)
      if (memoryThreadId && !['new', 'undefined', 'null'].includes(memoryThreadId)) {
        const agentId = queryValue(webRequest, 'agentId')
        if (isWorkingMemoryThreadPath(path) && agentId) {
          await this.authz.ensureThreadAccess(user, memoryThreadId, agentId)
        } else {
          await this.authz.ensureThreadAccess(user, memoryThreadId)
        }
        return true
      }

      if (path === '/memory/save-messages' || path === '/memory/network/save-messages') {
        const messages = Array.isArray(body?.messages) ? body.messages : []
        const messageThreadId = messages
          .map(message =>
            message && typeof message === 'object'
              ? valueToId((message as Record<string, unknown>).threadId)
              : undefined,
          )
          .find(Boolean)
        if (messageThreadId) await this.authz.ensureThreadAccess(user, messageThreadId, queryValue(webRequest, 'agentId'))
        return true
      }

      if (path.startsWith('/memory/')) {
        await this.authz.require(user, 'memory:read')
        return true
      }

      if (path === '/agents') {
        await this.authz.require(user, 'agents:read')
        return user.role === 'owner' || user.role === 'operator' || hasInternalAuth(webRequest)
      }

      const agentId = agentIdFromPath(path)
      if (agentId) {
        await this.authz.requireAgent(user, agentId)

        if (!isOwnerOperator(user) && (isAgentConfigRoute(path) || isDirectAgentToolExecuteRoute(path))) return false

        const bodyResourceId = resourceIdFromBody(body)
        if (!isAllowedClientResourceId(bodyResourceId, this.authz.resourceIdFor(user), agentId)) return false

        const threadId = threadIdFromBody(body)
        if (!isOwnerOperator(user) && isLegacyRunOnlyAgentRoute(path) && bodyRunId(body) && !threadId) return false

        if (threadId && !['new', 'undefined', 'null'].includes(threadId)) {
          await this.authz.recordThread(user, threadId, agentId)
        }
      }

      return true
    } catch {
      return false
    }
  }

  async getCurrentUser(request: Request) {
    const sessionId = this.getSessionIdFromRequest(request)
    if (!sessionId) return null
    const session = await this.store.getSession(sessionId)
    if (!session) return null
    return this.store.hydrateUser(await this.store.getUserById(session.userId))
  }

  async getUser(userId: string) {
    return this.store.hydrateUser(await this.store.getUserById(userId))
  }

  async getUsers(userIds: string[]) {
    const users = await this.store.getUsers(userIds)
    return Promise.all(users.map(user => this.store.hydrateUser(user)))
  }

  async getAccess(user: ManifexUser) {
    return this.authz.getAccess(user)
  }

  async signIn(email: string, password: string, request: Request) {
    const user = await this.store.validateCredentials(email, password)
    if (!user) throw new Error('Invalid credentials')
    const session = await this.createSession(user.id, {
      orgId: user.orgId,
      userAgent: request.headers.get('user-agent') || undefined,
    })

    return {
      user: await this.store.hydrateUser(user),
      token: session.id,
      cookies: [this.sessionCookie(session)],
    }
  }

  async signUp() {
    throw new Error('Sign up is disabled. Users must be provisioned by an owner.')
  }

  isSignUpEnabled() {
    return false
  }

  async createSession(userId: string, metadata?: Record<string, unknown>) {
    const user = await this.store.getUserById(userId)
    if (!user) throw new Error('Unknown user')
    return this.store.createSession(userId, user.orgId, metadata)
  }

  async validateSession(sessionId: string) {
    return this.store.getSession(sessionId)
  }

  async destroySession(sessionId: string) {
    await this.store.destroySession(sessionId)
  }

  async refreshSession(sessionId: string) {
    return this.store.refreshSession(sessionId)
  }

  getSessionIdFromRequest(request: Request) {
    return bearerFromRequest(request) || cookieFromRequest(request, SESSION_COOKIE)
  }

  getSessionHeaders(session: StoredSession) {
    return {
      'Set-Cookie': this.sessionCookie(session),
    }
  }

  getClearSessionHeaders() {
    return {
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    }
  }

  async getAccess(user: ManifexUser) {
    return this.authz.getAccess(user)
  }

  async recordThreadForUser(user: unknown, threadId: string, agentId: string) {
    const manifexUser = getManifexUser(user)
    if (!manifexUser || !threadId || !agentId) return
    await this.authz.recordThread(manifexUser, threadId, agentId)
  }

  private sessionCookie(session: StoredSession) {
    const secure = IS_PRODUCTION ? '; Secure' : ''
    const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))
    return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  }
}

export function getManifexUser(value: unknown): ManifexUser | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ManifexUser>
  if (
    typeof candidate.id === 'string' &&
    typeof candidate.orgId === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.role === 'string'
  ) {
    return candidate as ManifexUser
  }
  return null
}

export async function createManifexSecurity() {
  const store = await ManifexAuthStore.create()
  const authz = new ManifexAuthz(store)
  const auth = new ManifexAuthProvider(store, authz)

  const owner = await store.getUserByEmail(DEFAULT_ORG_ID, normalizeEmail(optionalEnv('MANIFEX_BOOTSTRAP_OWNER_EMAIL') || 'owner@manifex.local'))
  if (owner) {
    for (const agentId of await store.getAssignedAgentIds(owner)) {
      if (agentId !== '*') await authz.recordAgentAssignment(owner, agentId)
    }
  }

  return { auth, authz }
}
