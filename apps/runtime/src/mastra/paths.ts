import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function findRuntimeRoot(start: string) {
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

function findRepoRoot(runtimeRoot: string) {
  let current = runtimeRoot
  for (let i = 0; i < 10; i += 1) {
    if (
      existsSync(resolve(current, '.git')) ||
      existsSync(resolve(current, 'apps/runtime/src/mastra'))
    ) {
      return current
    }

    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }

  return resolve(runtimeRoot, '../..')
}

export const runtimeRoot = findRuntimeRoot(here)
export const repoRoot = findRepoRoot(runtimeRoot)
export const artifactsRoot = resolve(repoRoot, 'artifacts')
export const mastraStudioArtifactsRoot = resolve(artifactsRoot, 'mastra-studio')
export const runtimeEnvPath = resolve(runtimeRoot, '.env')
export const repoEnvPath = resolve(repoRoot, '.env')
