import { Agent } from '@mastra/core/agent'
import {
  createAgentMemory,
  createRuntimeWorkspace,
  maxSteps,
  platformRuntimeInstructions,
  searchTools,
  upstreamModel,
} from './shared.js'

export const wpsMemory = createAgentMemory(
  'wps-agent-memory',
  'WPS 365 Agent',
)

export const wpsWorkspace = createRuntimeWorkspace({
  id: 'wps-workspace',
  name: 'WPS 365',
})

export const wpsAgent = new Agent({
  id: 'wps-agent',
  name: 'WPS 365 Agent',
  editor: {
    instructions: true,
    tools: true,
  },
  instructions: [
    'You are a WPS 365 operations agent running inside Mastra Studio.',
    'Your primary job is to operate WPS 365 through wps365-cli. WPS official CLI currently provides command help and OpenAPI fallback rather than a bundled skill tree.',
    'Use execute_command to inspect wps365-cli help before taking action. Do not invent API parameters.',
    'For cloud docs, sheets, mail, contacts, calendar, IM, meetings, and multidimensional tables, prefer semantic wps365-cli subcommands first, and use wps365-cli api get/post only when a semantic command is missing.',
    'For setup or authentication, guide the user through wps365-cli auth setup/login/status and explain required OAuth scopes.',
    platformRuntimeInstructions('WPS 365'),
  ].join('\n'),
  model: upstreamModel,
  defaultOptions: {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : 50,
  },
  tools: searchTools,
  workspace: wpsWorkspace,
  memory: wpsMemory,
})
