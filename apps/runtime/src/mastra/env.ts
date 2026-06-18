import { readFileSync } from 'node:fs'
import { repoEnvPath, runtimeEnvPath } from './paths.js'

const candidateEnvPaths = [runtimeEnvPath, repoEnvPath]

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
      process.env[key] ||= value.replace(/^['"]|['"]$/g, '')
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
