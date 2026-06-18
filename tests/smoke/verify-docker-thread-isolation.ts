import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { RequestContext } from '@mastra/core/request-context'
import { gracefulExit } from 'exit-hook'
import { fullAccessWorkspace } from '../../src/mastra/agents/full-access-agent.js'

const execFileAsync = promisify(execFile)
const resolvedThreads = new Set<string>()

async function command(threadId: string, commandText: string) {
  const requestContext = new RequestContext([['thread-id', threadId]])
  const sandbox = await fullAccessWorkspace.resolveSandbox({ requestContext })
  if (!sandbox?.executeCommand) {
    throw new Error('Workspace did not resolve an executable sandbox')
  }

  resolvedThreads.add(threadId)
  await sandbox.start?.()
  return sandbox.executeCommand('sh', ['-lc', commandText], { timeout: 60_000 })
}

function assertIncludes(label: string, text: string, expected: string) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}.\nActual:\n${text}`)
  }
}

const workspaceRoot = resolve(process.cwd(), 'artifacts/docker-thread-workspaces')
await mkdir(workspaceRoot, { recursive: true })

try {
  const a1 = await command(
    'verify-thread-a',
    [
      'set -e',
      'printf "thread-a-secret" > marker.txt',
      'printf "cwd="',
      'pwd',
      'printf "marker="',
      'cat marker.txt',
      'printf "\\nwhoami="',
      'whoami',
      'printf "\\nnode="',
      'node --version',
      'printf "\\nlark="',
      'command -v lark-cli >/dev/null && lark-cli --version || true',
    ].join('\n'),
  )

  const a2 = await command(
    'verify-thread-a',
    'set -e; printf "same-thread-marker="; cat marker.txt',
  )

  const b1 = await command(
    'verify-thread-b',
    'set -e; if [ -f marker.txt ]; then printf "leaked:"; cat marker.txt; exit 2; else printf "isolated"; fi',
  )

  const combinedA1 = `${a1.stdout ?? ''}${a1.stderr ?? ''}`
  const combinedA2 = `${a2.stdout ?? ''}${a2.stderr ?? ''}`
  const combinedB1 = `${b1.stdout ?? ''}${b1.stderr ?? ''}`

  assertIncludes('thread A first command', combinedA1, 'marker=thread-a-secret')
  assertIncludes('thread A second command', combinedA2, 'same-thread-marker=thread-a-secret')
  assertIncludes('thread B command', combinedB1, 'isolated')

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspaceRoot,
        threadA: {
          first: combinedA1.trim(),
          second: combinedA2.trim(),
        },
        threadB: combinedB1.trim(),
      },
      null,
      2,
    ),
  )
} finally {
  for (const threadId of resolvedThreads) {
    fullAccessWorkspace.clearSandboxCache(threadId)
    await execFileAsync('docker', ['rm', '-f', `manifex-${threadId}`]).catch(() => undefined)
  }
}

gracefulExit(0)
