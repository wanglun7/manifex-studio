import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

function readEnvPort() {
  if (!existsSync('.env')) return undefined

  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^MASTRA_PORT=(.+)$/)
    if (match) return match[1].replace(/^['"]|['"]$/g, '')
  }
}

const port = process.env.MASTRA_PORT || readEnvPort() || '4111'

function collectPids(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/)
      .filter(Boolean)
  } catch {
    return []
  }
}

const cwd = process.cwd()
const pids = [
  ...collectPids('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']),
  ...collectPids('pgrep', ['-f', cwd + '/node_modules/.bin/mastra dev']),
  ...collectPids('pgrep', ['-f', cwd + '/.mastra/output/index.mjs']),
]
  .filter(pid => pid !== String(process.pid) && pid !== String(process.ppid))

const uniquePids = [...new Set(pids)]

if (uniquePids.length) {
  execFileSync('kill', uniquePids, { stdio: 'ignore' })
  console.log(`cleaned Mastra dev on port ${port}: ${uniquePids.join(', ')}`)
}
