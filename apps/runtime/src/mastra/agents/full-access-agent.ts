import { Agent } from '@mastra/core/agent'
import {
  createAgentMemory,
  createRuntimeWorkspace,
  maxSteps,
  platformRuntimeInstructions,
  searchTools,
  upstreamModel,
  useDockerSandbox,
} from './shared.js'

export const fullAccessMemory = createAgentMemory(
  'full-access-agent-memory',
  'Full Access Agent',
)

export const fullAccessWorkspace = createRuntimeWorkspace({
  id: 'full-access-workspace',
  name: 'Full Access',
})

export const fullAccessAgent = new Agent({
  id: 'full-access-agent',
  name: 'Full Access Agent',
  editor: {
    instructions: true,
    tools: true,
  },
  instructions: [
    'You are a local full-access debugging agent running inside Mastra Studio.',
    useDockerSandbox
      ? 'You may use all configured workspace tools: filesystem, shell/process, and search/index.'
      : 'You may use all configured workspace tools: filesystem, shell/process, search/index, and LSP inspection.',
    platformRuntimeInstructions('debugging'),
    'When editing files, inspect relevant files first and keep changes focused.',
    'This local workspace is for debugging; clearly report commands run and files changed.',
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: fullAccessWorkspace,
  memory: fullAccessMemory,
})
