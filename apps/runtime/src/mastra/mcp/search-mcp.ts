import { MCPClient } from '@mastra/mcp'

const searxngUrl = process.env.SEARXNG_URL || 'http://127.0.0.1:8888'
const searchProvider = process.env.SEARCH_MCP_PROVIDER || 'searxng'
const tavilyMcpUrl =
  process.env.TAVILY_MCP_URL ||
  (process.env.TAVILY_API_KEY
    ? `https://mcp.tavily.com/mcp/?tavilyApiKey=${encodeURIComponent(process.env.TAVILY_API_KEY)}`
    : undefined)

if (searchProvider === 'tavily' && !tavilyMcpUrl) {
  throw new Error('SEARCH_MCP_PROVIDER=tavily requires TAVILY_MCP_URL or TAVILY_API_KEY')
}

export const searchMcpClient = new MCPClient({
  servers:
    searchProvider === 'tavily'
      ? {
          tavily: {
            url: new URL(tavilyMcpUrl!),
          },
        }
      : {
          searxng: {
            command: 'npx',
            args: ['mcp-searxng'],
            env: {
              SEARXNG_URL: searxngUrl,
            },
            log: logMessage => {
              if (logMessage.level === 'error') {
                console.error(`[searxng-mcp] ${logMessage.message}`)
              }
            },
          },
        },
  timeout: 30_000,
})

export const searchProviderInstructions =
  searchProvider === 'tavily'
    ? [
        'You have Tavily web research tools: tavily_search, tavily_extract, tavily_map, tavily_crawl, and tavily_research.',
        'Use tavily_search for fast source discovery, tavily_extract to read specific URLs, and tavily_research only when the user asks for a synthesized multi-source research answer.',
        'For Tavily search, pass only documented fields such as query, max_results, search_depth, include_domains, exclude_domains, and include_raw_content.',
      ].join('\n')
    : [
        'You have web search tools backed by a local SearXNG MCP server. Use web search when current external information is needed.',
        'For web research, prefer official or primary sources, call web_url_read after finding a relevant result, and stop searching after two failed query refinements.',
        'When calling SearXNG search, pass only query, num_results, language, and response_format unless the user explicitly asks for a specific engine. Never use the engine name ddg.',
      ].join('\n')
