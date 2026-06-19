import { timingSafeEqual, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { createClient, type Client } from '@libsql/client'
import { MastraAuthProvider, type Session } from '@mastra/core/server'
import { loadUpstreamEnv, optionalEnv } from './env.js'
import { artifactsRoot } from './paths.js'

loadUpstreamEnv()

const scrypt = promisify(scryptCallback)

export type ManifexRole = 'owner' | 'admin' | 'operator' | 'member'

export type ManifexUser = {
  id: string
  orgId: string
  email: string
  name: string
  role: ManifexRole
  status: 'active' | 'disabled'
  avatarUrl?: string
}

export type ManifexAccess = {
  roles: ManifexRole[]
  permissions: string[]
  agentIds: string[]
  resourceId: string
}

type StoredSession = Session & {
  orgId: string
}

type AgentAssignmentRow = {
  agent_id: string
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

type ThreadRow = {
  id: string
  org_id: string
  user_id: string
  agent_id: string
  resource_id: string
}

const SESSION_COOKIE = 'manifex_session'
const SESSION_TTL_MS = Number(optionalEnv('MANIFEX_SESSION_TTL_MS') || 7 * 24 * 60 * 60 * 1000)
const PASSWORD_KEY_BYTES = 64
const DEFAULT_ORG_ID = optionalEnv('MANIFEX_DEFAULT_ORG_ID') || 'default'
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod'

const ROLE_PERMISSIONS: Record<ManifexRole, string[]> = {
  owner: ['*'],
  admin: [
    'auth:read',
    'users:read',
    'users:write',
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
    'memory:read',
    'memory:write',
    'artifacts:read',
    'artifacts:write',
  ],
}

const DEFAULT_MEMBER_AGENTS = [
  'feishu-agent',
  'dingtalk-agent',
  'wecom-agent',
  'wps-agent',
  'full-access-agent',
]

const AGENT_ID_ALIASES: Record<string, string> = {
  feishuAgent: 'feishu-agent',
  dingtalkAgent: 'dingtalk-agent',
  wecomAgent: 'wecom-agent',
  wpsAgent: 'wps-agent',
}

function nowIso() {
  return new Date().toISOString()
}

function resourceIdFor(user: Pick<ManifexUser, 'orgId' | 'id'>) {
  return `org:${user.orgId}:user:${user.id}`
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
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

function parseCsvEnv(name: string, fallback: string[]) {
  const raw = optionalEnv(name)
  if (!raw) return fallback
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function hasPermission(grants: string[], required: string) {
  if (grants.includes('*')) return true

  const [requiredResource, requiredAction, requiredId] = required.split(':')
  return grants.some(grant => {
    const [grantResource, grantAction, grantId] = grant.split(':')
    if (!grantResource || !grantAction) return grant === required
    if (grantResource !== '*' && grantResource !== requiredResource) return false
    if (grantAction !== '*' && grantAction !== requiredAction) return false
    if (!grantId) return true
    return grantId === requiredId
  })
}

function normalizeAgentId(agentId: string) {
  return AGENT_ID_ALIASES[agentId] || agentId
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

function dbValue(value: unknown) {
  return value === undefined ? null : value
}

function webRequestFrom(value: unknown): Request | undefined {
  if (value instanceof Request) return value
  if (value && typeof value === 'object' && 'raw' in value && value.raw instanceof Request) {
    return value.raw
  }
  return undefined
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

function pathWithoutApiPrefix(request?: Request) {
  if (!request) return '/'
  const pathname = new URL(request.url).pathname
  return pathname.startsWith('/api') ? pathname.slice('/api'.length) || '/' : pathname
}

function agentIdFromPath(path: string) {
  if (path === '/agents/providers' || path.startsWith('/agents/providers/')) return undefined
  const match = path.match(/^\/agents\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function isAgentCollectionPath(path: string) {
  return path === '/agents'
}

function threadIdFromPath(path: string) {
  const match = path.match(/^\/memory\/(?:network\/)?threads\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function isMemoryThreadCollectionPath(path: string) {
  return path === '/memory/threads' || path === '/memory/network/threads'
}

function queryParam(request: Request | undefined, name: string) {
  if (!request) return undefined
  return new URL(request.url).searchParams.get(name) || undefined
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

function agentIdFromMemoryRequest(request: Request | undefined, body?: Record<string, unknown>) {
  return queryParam(request, 'agentId') || valueToId(body?.agentId)
}

function resourceIdFromMemoryRequest(request: Request | undefined, body?: Record<string, unknown>) {
  return queryParam(request, 'resourceId') || resourceIdFromBody(body)
}

class ManifexAuthStore {
  constructor(private readonly db: Client) {}

  static async create() {
    mkdirSync(artifactsRoot, { recursive: true })
    const url = optionalEnv('MANIFEX_AUTH_DB_URL') || `file:${artifactsRoot}/manifex-auth.db`
    const store = new ManifexAuthStore(createClient({ url }))
    await store.migrate()
    await store.seed()
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
      `CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        provider_union_id TEXT,
        email TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (org_id, provider, provider_user_id)
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

    const ownerEmail = normalizeEmail(optionalEnv('MANIFEX_BOOTSTRAP_OWNER_EMAIL') || 'owner@manifex.local')
    const ownerPassword =
      optionalEnv('MANIFEX_BOOTSTRAP_OWNER_PASSWORD') ||
      optionalEnv('MANIFEX_AUTH_OWNER_TOKEN') ||
      (IS_PRODUCTION ? '' : 'owner-token')

    if (!ownerPassword || (IS_PRODUCTION && ownerPassword === 'owner-token')) {
      throw new Error('MANIFEX_BOOTSTRAP_OWNER_PASSWORD must be set to a non-default value in production')
    }

    const owner = await this.ensureUser({
      orgId: DEFAULT_ORG_ID,
      email: ownerEmail,
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
        await this.syncAgentAssignments(member, parseCsvEnv('MANIFEX_MEMBER_AGENT_IDS', DEFAULT_MEMBER_AGENTS))
      }
    } else if (!IS_PRODUCTION) {
      const member = await this.ensureUser({
        orgId: DEFAULT_ORG_ID,
        email: 'member@manifex.local',
        name: 'Member',
        role: 'member',
        password: optionalEnv('MANIFEX_DEV_MEMBER_PASSWORD') || 'member-token',
      })
      await this.syncAgentAssignments(member, parseCsvEnv('MANIFEX_MEMBER_AGENT_IDS', DEFAULT_MEMBER_AGENTS))
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

  normalizeAgentAssignments(agentIds: string[]) {
    return Array.from(new Set(agentIds.map(normalizeAgentId).filter(Boolean)))
  }

  async ensureAgentAssignments(user: ManifexUser, agentIds: string[]) {
    for (const agentId of this.normalizeAgentAssignments(agentIds)) {
      await this.db.execute({
        sql: `INSERT OR IGNORE INTO agent_assignments (org_id, user_id, agent_id, created_at)
          VALUES (?, ?, ?, ?)`,
        args: [user.orgId, user.id, agentId, nowIso()],
      })
    }
  }

  async syncAgentAssignments(user: ManifexUser, agentIds: string[]) {
    const normalizedAgentIds = this.normalizeAgentAssignments(agentIds)

    if (!normalizedAgentIds.length) {
      await this.db.execute({
        sql: 'DELETE FROM agent_assignments WHERE org_id = ? AND user_id = ?',
        args: [user.orgId, user.id],
      })
      return
    }

    if (!normalizedAgentIds.includes('*')) {
      await this.db.execute({
        sql: `DELETE FROM agent_assignments
          WHERE org_id = ? AND user_id = ? AND agent_id NOT IN (${normalizedAgentIds.map(() => '?').join(', ')})`,
        args: [user.orgId, user.id, ...normalizedAgentIds],
      })
    }

    await this.ensureAgentAssignments(user, normalizedAgentIds)
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
    if (user.role === 'owner' || user.role === 'admin') return ['*']

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
    await this.db.execute({
      sql: `INSERT INTO threads (id, org_id, user_id, agent_id, resource_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      args: [
        input.threadId,
        input.user.orgId,
        input.user.id,
        input.agentId,
        input.resourceId,
        nowIso(),
        nowIso(),
      ],
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
    await this.db.execute({
      sql: `INSERT INTO artifacts (id, org_id, user_id, thread_id, path, name, mime_type, size, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
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
  }
}

export class ManifexAuthz {
  constructor(private readonly store: ManifexAuthStore) {}

  resourceIdFor(user: ManifexUser) {
    return resourceIdFor(user)
  }

  async getAccess(user: ManifexUser): Promise<ManifexAccess> {
    return {
      roles: [user.role],
      permissions: ROLE_PERMISSIONS[user.role],
      agentIds: await this.store.getAssignedAgentIds(user),
      resourceId: this.resourceIdFor(user),
    }
  }

  async can(user: ManifexUser, permission: string) {
    return hasPermission(ROLE_PERMISSIONS[user.role], permission)
  }

  async require(user: ManifexUser | null | undefined, permission: string) {
    if (!user || !(await this.can(user, permission))) {
      throw new Error('Forbidden')
    }
  }

  async canUseAgent(user: ManifexUser, agentId: string) {
    if (!(await this.can(user, 'agents:execute')) && !(await this.can(user, 'agents:read'))) return false
    const agentIds = await this.store.getAssignedAgentIds(user)
    return agentIds.includes('*') || agentIds.includes(agentId)
  }

  async requireAgent(user: ManifexUser, agentId: string) {
    if (!(await this.canUseAgent(user, agentId))) {
      throw new Error('Forbidden')
    }
  }

  async ensureThreadAccess(user: ManifexUser, threadId: string, agentId?: string) {
    const thread = await this.store.getThread(threadId)
    if (!thread) {
      if (!agentId) throw new Error('Unknown thread')
      await this.requireAgent(user, agentId)
      await this.store.upsertThread({
        threadId,
        user,
        agentId,
        resourceId: this.resourceIdFor(user),
      })
      return
    }

    if (thread.org_id !== user.orgId || thread.user_id !== user.id) {
      throw new Error('Forbidden')
    }

    if (agentId && thread.agent_id !== agentId) {
      throw new Error('Forbidden')
    }
  }

  async recordThread(user: ManifexUser, threadId: string, agentId: string) {
    await this.requireAgent(user, agentId)
    await this.store.upsertThread({
      threadId,
      user,
      agentId,
      resourceId: this.resourceIdFor(user),
    })
  }

  async recordArtifact(
    user: ManifexUser,
    input: { threadId: string; path: string; name: string; mimeType?: string; size?: number; sha256?: string },
  ) {
    await this.ensureThreadAccess(user, input.threadId)
    await this.store.recordArtifact({
      orgId: user.orgId,
      userId: user.id,
      ...input,
    })
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
    return this.store.getUserById(session.userId)
  }

  async authorizeUser(user: ManifexUser, request: unknown) {
    if (user.status !== 'active') return false

    const webRequest = webRequestFrom(request)
    const path = pathWithoutApiPrefix(webRequest)
    const body = await readJsonBody(webRequest)

    try {
      if (path.startsWith('/auth/')) return true
      if (path.startsWith('/manifex/auth/')) return true

      if (path.startsWith('/logs')) {
        await this.authz.require(user, 'logs:read')
        return true
      }

      if (path.startsWith('/traces') || path.startsWith('/metrics')) {
        await this.authz.require(user, 'observability:read')
        return true
      }

      if (path.startsWith('/workspaces')) {
        await this.authz.require(user, 'workspaces:read')
        return true
      }

      if (isMemoryThreadCollectionPath(path)) {
        const method = webRequest?.method || 'GET'
        await this.authz.require(user, method === 'GET' ? 'memory:read' : 'memory:write')

        const currentResourceId = this.authz.resourceIdFor(user)
        const requestedResourceId = resourceIdFromMemoryRequest(webRequest, body)
        if (!requestedResourceId || requestedResourceId !== currentResourceId) return false

        const memoryAgentId = agentIdFromMemoryRequest(webRequest, body)
        if (memoryAgentId) await this.authz.requireAgent(user, memoryAgentId)

        const threadId = threadIdFromBody(body) || valueToId(body?.id)
        if (method !== 'GET' && threadId && memoryAgentId) {
          await this.authz.recordThread(user, threadId, memoryAgentId)
        }

        return true
      }

      const memoryThreadId = threadIdFromPath(path)
      if (memoryThreadId) {
        await this.authz.ensureThreadAccess(user, memoryThreadId, agentIdFromMemoryRequest(webRequest, body))
        return true
      }

      if (path === '/memory/save-messages' || path === '/memory/network/save-messages') {
        const messages = Array.isArray(body?.messages) ? body.messages : []
        const messageThreadId = messages
          .map(message => (message && typeof message === 'object' ? valueToId((message as Record<string, unknown>).threadId) : undefined))
          .find(Boolean)
        if (messageThreadId) await this.authz.ensureThreadAccess(user, messageThreadId)
        return true
      }

      if (isAgentCollectionPath(path)) {
        const access = await this.authz.getAccess(user)
        if (!access.agentIds.includes('*')) return false
        await this.authz.require(user, 'agents:read')
        return true
      }

      const agentId = agentIdFromPath(path)
      if (agentId) {
        await this.authz.requireAgent(user, agentId)

        const bodyResourceId = resourceIdFromBody(body)
        if (bodyResourceId && bodyResourceId !== this.authz.resourceIdFor(user)) return false

        const threadId = threadIdFromBody(body)
        if (threadId) await this.authz.recordThread(user, threadId, agentId)
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
    return this.store.getUserById(session.userId)
  }

  async getUser(userId: string) {
    return this.store.getUserById(userId)
  }

  async getUsers(userIds: string[]) {
    return this.store.getUsers(userIds)
  }

  async signIn(email: string, password: string, request: Request) {
    const user = await this.store.validateCredentials(email, password)
    if (!user) throw new Error('Invalid credentials')
    const session = await this.createSession(user.id, {
      orgId: user.orgId,
      userAgent: request.headers.get('user-agent') || undefined,
    })

    return {
      user,
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

  getSessionHeaders(session: Session) {
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

  private sessionCookie(session: Session) {
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
  return { auth, authz }
}
