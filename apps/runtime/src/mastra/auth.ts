import { SimpleAuth } from '@mastra/core/server'
import { StaticRBACProvider } from '@mastra/core/auth/ee'
import { loadUpstreamEnv, optionalEnv } from './env.js'

loadUpstreamEnv()

type ManifexRole = 'owner' | 'member'

type ManifexUser = {
  id: string
  name: string
  email: string
  role: ManifexRole
}

const rolePermissions: Record<ManifexRole | '_default', string[]> = {
  owner: ['*'],
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
    'observability:read',
  ],
  _default: [],
}

function parseMemberTokens() {
  const raw = optionalEnv('MANIFEX_AUTH_MEMBER_TOKENS') || 'member1=member-token'
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      const [rawId, ...tokenParts] = item.includes('=') ? item.split('=') : [`member${index + 1}`, item]
      const id = rawId.trim() || `member${index + 1}`
      const token = tokenParts.join('=').trim()

      return {
        id,
        name: id,
        email: `${id}@manifex.local`,
        role: 'member' as const,
        token,
      }
    })
    .filter((user) => user.token)
}

function buildTokens() {
  const users: Array<ManifexUser & { token: string }> = [
    {
      id: 'owner',
      name: 'Owner',
      email: 'owner@manifex.local',
      role: 'owner',
      token: optionalEnv('MANIFEX_AUTH_OWNER_TOKEN') || 'owner-token',
    },
    ...parseMemberTokens(),
  ]

  return Object.fromEntries(
    users.map(({ token, ...user }) => [token, user]),
  ) as Record<string, ManifexUser>
}

export const manifexAuth = new SimpleAuth<ManifexUser>({
  tokens: buildTokens(),
})

export const manifexRbac = new StaticRBACProvider<ManifexUser>({
  roleMapping: rolePermissions,
  getUserRoles: (user) => [user.role],
})
