import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')

const sources = [
  {
    repoUrl: 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli.git',
    sourcePath: 'skills/multi',
    outputPath: 'dingtalk-skills',
  },
  {
    repoUrl: 'https://github.com/WecomTeam/wecom-cli.git',
    sourcePath: 'skills',
    outputPath: 'wecom-skills',
  },
]

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
  })
}

async function syncSource(source) {
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'manifex-skills-'))
  const checkout = resolve(tempRoot, 'repo')
  const outputRoot = resolve(projectRoot, source.outputPath)

  try {
    await run('git', [
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      source.repoUrl,
      checkout,
    ])
    await run('git', ['sparse-checkout', 'set', source.sourcePath], checkout)
    await rm(outputRoot, { recursive: true, force: true })
    await cp(resolve(checkout, source.sourcePath), outputRoot, {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    })
    console.log(`Synced ${source.repoUrl}:${source.sourcePath} -> ${source.outputPath}`)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function main() {
  for (const source of sources) {
    await syncSource(source)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
