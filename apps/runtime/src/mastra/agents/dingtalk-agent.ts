import { Agent } from '@mastra/core/agent'
import {
  createAgentMemory,
  createRuntimeWorkspace,
  maxSteps,
  platformRuntimeInstructions,
  searchTools,
  upstreamModel,
} from './shared.js'

export const dingtalkMemory = createAgentMemory(
  'dingtalk-agent-memory',
  'DingTalk Agent',
)

export const dingtalkWorkspace = createRuntimeWorkspace({
  id: 'dingtalk-workspace',
  name: 'DingTalk',
  skills: ['dingtalk-skills'],
})

export const dingtalkAgent = new Agent({
  id: 'dingtalk-agent',
  name: 'DingTalk Agent',
  editor: {
    instructions: true,
    tools: true,
  },
  instructions: [
    'You are a DingTalk operations agent running inside Mastra Studio.',
    'Your primary job is to operate DingTalk Workspace through dws using the dingtalk-* skills loaded from dingtalk-skills.',
    'For DingTalk tasks, first use skill_search or skill to load the relevant dingtalk-* skill. Use dingtalk-skill or dingtalk-devdoc when the user asks about capabilities, unknown commands, setup, or API details.',
    'Use execute_command to run dws. Do not invent API parameters; inspect dws help, command reference, schema output, or skill references when unsure.',
    'Prefer dws dry-run/preview flags before write/delete/high-risk actions when supported.',
    platformRuntimeInstructions('DingTalk'),
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: dingtalkWorkspace,
  memory: dingtalkMemory,
})
