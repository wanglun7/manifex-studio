# Manifex Studio

Mastra-based enterprise agent runtime prototype.

Current formal chain:

- Mastra Studio on `127.0.0.1:4111`
- `full-access-agent` for general local debugging
- `feishu-agent` for Feishu/Lark operations
- Per-thread Docker workspace/sandbox isolation
- Tavily MCP web research tools
- DashScope embeddings for semantic recall
- Working memory and observational memory enabled
- 27 generated Feishu/Lark skills from `lark-cli`

## Layout

```text
src/mastra/                  Mastra runtime source
src/mastra/agents/           agent, workspace, memory, sandbox config
src/mastra/mcp/              MCP clients
src/mastra/sandbox/          thread sandbox lifecycle manager
docker/                      runtime image
scripts/                     local helper scripts
lark-skills/                 generated Feishu/Lark skills
tests/smoke/                 deterministic smoke checks
artifacts/                   local runtime state, ignored by git
```

Historical experiments and old POCs are intentionally kept out of git under
`_archive/`.

## Setup

```bash
cp .env.example .env
npm install
npm run docker:build-runtime
npm run dev
```

Required `.env` groups:

- `UPSTREAM_OPENAI_*` for the OpenAI-compatible model endpoint
- `DASHSCOPE_*` for embeddings
- `TAVILY_*` for search MCP
- `WORKSPACE_*` for Docker sandbox behavior

## Agents

### Full Access Agent

General local debugging agent. It has workspace file tools, shell/process tools,
Tavily tools, memory, and per-thread Docker isolation.

### Feishu Agent

Feishu/Lark operations agent. It has the same workspace/runtime tools plus all
generated `lark-*` skills.

Current skill count:

```text
27 Lark skills
```

Refresh skills from the installed `lark-cli`:

```bash
npm run skills:sync-lark
```

## Verification

```bash
npm run test:skills
npm run test:sandbox-lifecycle
npm run test:docker-thread-isolation
```

What these verify:

- all 27 Lark skills exist and have `SKILL.md`
- sandbox lifecycle stop/remove behavior works
- same thread reuses a workspace, different threads are isolated
- the Docker runtime contains `lark-cli`

## Runtime Notes

Docker sandboxing is thread-scoped. Each Studio thread maps to:

```text
artifacts/docker-thread-workspaces/<thread-id>
manifex-<thread-id>
```

The cleanup manager stops idle containers and removes old ones according to the
`WORKSPACE_SANDBOX_*` settings.

Generated files in `/workspace` are currently real files inside the thread
workspace. The next frontend task is to resolve `sandbox:/workspace/...` URLs to
served artifact URLs so images and attachments render correctly in Studio.
