import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const outputRoot = resolve(projectRoot, 'lark-skills')
const image = process.env.WORKSPACE_DOCKER_IMAGE || 'manifex-agent-runtime:latest'
const inContainer = process.env.IN_LARK_SKILL_SYNC_CONTAINER === '1'

async function larkCli(args) {
  const command = inContainer ? 'lark-cli' : 'docker'
  const commandArgs = inContainer
    ? args
    : [
        'run',
        '--rm',
        '-v',
        `${projectRoot}:/repo`,
        '-w',
        '/repo',
        '-e',
        'IN_LARK_SKILL_SYNC_CONTAINER=1',
        '--entrypoint',
        'node',
        image,
        'scripts/sync-lark-skills.mjs',
      ]

  const { stdout } = await execFileAsync(command, commandArgs, {
    maxBuffer: 50 * 1024 * 1024,
  })
  return stdout
}

function stripSkillPreamble(content) {
  const frontmatterStart = content.indexOf('---\n')
  if (frontmatterStart <= 0) return content
  return content.slice(frontmatterStart)
}

async function readSkillPath(path) {
  return larkCli(['skills', 'read', path])
}

async function listSkillPath(path) {
  const raw = await larkCli(['skills', 'list', path])
  return JSON.parse(raw)
}

async function writeOutput(path, content) {
  const destination = resolve(outputRoot, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content)
}

async function exportTree(skillName, path) {
  const listing = await listSkillPath(path)
  for (const entry of listing.entries ?? []) {
    if (entry.is_dir) {
      await exportTree(skillName, entry.path)
      continue
    }

    if (entry.path.endsWith('/SKILL.md')) continue
    const content = await readSkillPath(entry.path)
    const outputPath = relative(skillName, entry.path)
    await writeOutput(`${skillName}/${outputPath}`, content)
  }
}

async function main() {
  if (!inContainer) {
    process.stdout.write(await larkCli([]))
    return
  }

  const root = JSON.parse(await larkCli(['skills', 'list']))
  const skills = root.skills ?? []
  if (!skills.length) throw new Error('No lark skills found')

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })

  for (const skill of skills) {
    const skillContent = stripSkillPreamble(await readSkillPath(skill.name))
    await writeOutput(`${skill.name}/SKILL.md`, skillContent)
    await exportTree(skill.name, skill.name)
  }

  console.log(`Synced ${skills.length} lark skills into ${outputRoot}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
