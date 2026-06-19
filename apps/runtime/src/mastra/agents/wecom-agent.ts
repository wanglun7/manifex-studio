import { Agent } from '@mastra/core/agent'
import {
  createAgentMemory,
  createRuntimeWorkspace,
  maxSteps,
  platformRuntimeInstructions,
  searchTools,
  upstreamModel,
} from './shared.js'

export const wecomMemory = createAgentMemory(
  'wecom-agent-memory',
  'WeCom Agent',
)

export const wecomWorkspace = createRuntimeWorkspace({
  id: 'wecom-workspace',
  name: 'WeCom',
  skills: ['wecom-skills'],
})

export const wecomAgent = new Agent({
  id: 'wecom-agent',
  name: 'WeCom Agent',
  editor: {
    instructions: true,
    tools: true,
  },
  instructions: [
    'You are a WeCom/Enterprise WeChat operations agent running inside Mastra Studio.',
    'Your primary job is to operate Enterprise WeChat through wecom-cli using the wecomcli-* skills loaded from wecom-skills.',
    'For Enterprise WeChat tasks, first use skill_search or skill to load the relevant wecomcli-* skill.',
    'Use execute_command to run wecom-cli. Do not invent API parameters; inspect wecom-cli help, command reference, schema output, or skill references when unsure.',
    'For setup, authentication, bot credentials, or permission problems, inspect wecom-cli init/status/help output and explain the exact user/admin action needed.',
    platformRuntimeInstructions('WeCom'),
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: wecomWorkspace,
  memory: wecomMemory,
})
