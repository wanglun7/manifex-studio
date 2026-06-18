import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const candidateEnvPaths = [
  resolve(projectRoot, '.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../manifex-context/.env'),
  resolve(process.cwd(), '../collection-claude-code-source-code/clawspring/.env'),
  resolve(here, '../../../collection-claude-code-source-code/clawspring/.env'),
]

export function loadUpstreamEnv() {
  for (const envPath of candidateEnvPaths) {
    let raw: string
    try {
      raw = readFileSync(envPath, 'utf8')
    } catch {
      continue
    }

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!match) continue

      const [, key, value] = match
      const isLocalProjectEnv =
        envPath === resolve(projectRoot, '.env') || envPath === resolve(process.cwd(), '.env')
      const isAllowedFallbackKey =
        key.startsWith('UPSTREAM_OPENAI_') ||
        key.startsWith('DASHSCOPE_') ||
        key === 'EMBEDDING_MODEL' ||
        key === 'EMBED_DIM' ||
        key === 'RERANKER_MODEL'

      if (isLocalProjectEnv || isAllowedFallbackKey) {
        process.env[key] ||= value.replace(/^['"]|['"]$/g, '')
      }
    }
    return
  }
}

export function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

export function optionalEnv(name: string) {
  return process.env[name]
}
