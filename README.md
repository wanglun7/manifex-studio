# Manifex Studio

Unified repo for the Manifex enterprise agent prototype.

## Layout

```text
apps/runtime/  Mastra runtime, agents, skills, Docker sandbox, MCP, memory
apps/studio/   Forked Mastra Studio frontend with Manifex attachment/artifact UX
```

Local state is intentionally ignored:

- `apps/runtime/.env`
- `apps/runtime/artifacts/`
- `apps/runtime/.mastra/`
- `node_modules/`
- generated databases and build output

## Run

Install runtime dependencies:

```bash
npm --prefix apps/runtime install
```

Install Studio dependencies:

```bash
pnpm install
```

Start from the repo root:

```bash
npm run dev:runtime
npm run dev:studio
```

The runtime reads `apps/runtime/.env` first, then root `.env` as a fallback. Secrets stay local and are ignored by git.

Expected local URLs:

- Runtime: `http://127.0.0.1:4111`
- Studio frontend: Vite prints the selected port, usually `http://127.0.0.1:5177`

Useful checks:

```bash
npm --prefix apps/runtime run test:skills
npm --prefix apps/runtime run test:sandbox-lifecycle
npm run test:studio
```

## Current Chain

- Full-access local debugging agent
- Feishu/Lark agent with generated `lark-*` skills
- Tavily MCP web research tools
- Per-thread Docker workspace isolation
- Thread-scoped uploads mounted at `/workspace/uploads/...`
- Working memory, semantic recall, and observational memory
- Studio attachment cards that download artifacts while the model receives only sandbox file paths
