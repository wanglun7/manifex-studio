import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = process.cwd()
const skillsRoot = resolve(projectRoot, 'lark-skills')

const expectedSkills = [
  'lark-approval',
  'lark-apps',
  'lark-attendance',
  'lark-base',
  'lark-calendar',
  'lark-contact',
  'lark-doc',
  'lark-drive',
  'lark-event',
  'lark-im',
  'lark-mail',
  'lark-markdown',
  'lark-minutes',
  'lark-note',
  'lark-okr',
  'lark-openapi-explorer',
  'lark-shared',
  'lark-sheets',
  'lark-skill-maker',
  'lark-slides',
  'lark-task',
  'lark-vc',
  'lark-vc-agent',
  'lark-whiteboard',
  'lark-wiki',
  'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
]

async function main() {
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const actualSkills = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  const missing = expectedSkills.filter(skill => !actualSkills.includes(skill))
  const unexpected = actualSkills.filter(skill => !expectedSkills.includes(skill))

  if (missing.length || unexpected.length) {
    throw new Error(
      [
        'Lark skill set mismatch.',
        `missing=${missing.join(', ') || 'none'}`,
        `unexpected=${unexpected.join(', ') || 'none'}`,
      ].join('\n'),
    )
  }

  for (const skillName of expectedSkills) {
    const skillPath = resolve(skillsRoot, skillName, 'SKILL.md')
    const info = await stat(skillPath)
    const content = await readFile(skillPath, 'utf8')
    if (!info.isFile() || !content.trim()) {
      throw new Error(`${skillName}/SKILL.md is missing or empty`)
    }
  }

  console.log(`verified ${expectedSkills.length} Lark skills`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
