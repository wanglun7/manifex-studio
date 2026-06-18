import type { MastraLegacyEmbeddingModel } from '@mastra/core/vector'

type DashScopeEmbeddingResponse = {
  data?: Array<{
    embedding?: number[]
    index?: number
  }>
  usage?: {
    total_tokens?: number
    prompt_tokens?: number
  }
  error?: {
    message?: string
  }
}

type DashScopeEmbedderConfig = {
  apiKey: string
  baseUrl?: string
  model: string
  dimensions?: number
}

function normalizeBaseUrl(baseUrl: string | undefined) {
  const raw = (baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    .trim()
    .replace(/\/+$/, '')

  if (raw.endsWith('/compatible-mode/v1')) return raw
  if (raw.endsWith('/api/v1')) return raw.replace(/\/api\/v1$/, '/compatible-mode/v1')

  return raw
}

export function createDashScopeEmbedder({
  apiKey,
  baseUrl,
  model,
  dimensions,
}: DashScopeEmbedderConfig): MastraLegacyEmbeddingModel<string> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  return {
    specificationVersion: 'v1',
    provider: 'dashscope',
    modelId: model,
    maxEmbeddingsPerCall: 10,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal }) {
      const response = await fetch(`${normalizedBaseUrl}/embeddings`, {
        method: 'POST',
        signal: abortSignal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: values,
          encoding_format: 'float',
          ...(dimensions ? { dimensions } : {}),
        }),
      })

      const payload = (await response.json().catch(() => ({}))) as DashScopeEmbeddingResponse

      if (!response.ok) {
        const message = payload.error?.message || response.statusText
        throw new Error(`DashScope embedding failed (${response.status}): ${message}`)
      }

      const embeddings = (payload.data || [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => item.embedding)

      if (embeddings.length !== values.length || embeddings.some((embedding) => !embedding?.length)) {
        throw new Error(
          `DashScope embedding returned ${embeddings.length} vectors for ${values.length} inputs`,
        )
      }

      return {
        embeddings: embeddings as number[][],
        usage: {
          tokens: payload.usage?.total_tokens || payload.usage?.prompt_tokens || 0,
        },
      }
    },
  }
}
