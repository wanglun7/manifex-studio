import { Agent } from '@mastra/core/agent'
import {
  createAgentMemory,
  createRuntimeWorkspace,
  maxSteps,
  platformRuntimeInstructions,
  searchTools,
  upstreamModel,
} from './shared.js'

export const feishuMemory = createAgentMemory(
  'feishu-agent-memory',
  'Feishu Agent',
)

export const feishuWorkspace = createRuntimeWorkspace({
  id: 'feishu-workspace',
  name: 'Feishu',
  skills: ['lark-skills'],
})

export const feishuAgent = new Agent({
  id: 'feishu-agent',
  name: 'Feishu Agent',
  editor: {
    instructions: true,
    tools: true,
  },
  instructions: [
    'You are a Feishu/Lark operations agent running inside Mastra Studio.',
    'Your primary job is to operate Feishu/Lark through lark-cli using the lark-* skills loaded from lark-skills.',
    'For any Feishu/Lark task, first use skill_search or skill to load the relevant lark-* skill. For setup, auth, identity switching, permission errors, or update notices, load lark-shared.',
    'When a loaded lark-* skill points to references, use skill_read with the skillName and relative path. Do not use workspace read_file for skill references.',
    'For Base/多维表格/bitable, load lark-base. For Docx/Wiki document content, load lark-doc. For Drive files/import/export/permissions, load lark-drive. For IM/chat messages, load lark-im. For Sheets, load lark-sheets.',
    'Use execute_command to run lark-cli. Do not invent API parameters; inspect lark-cli help, schema, or the skill references when unsure.',
    platformRuntimeInstructions('Feishu/Lark'),
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: feishuWorkspace,
  memory: feishuMemory,
})
