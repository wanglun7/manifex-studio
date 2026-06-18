# Manifex Agent Runtime

Build the local Docker sandbox image used by Mastra `DockerSandbox`:

```bash
docker build -f docker/agent-runtime.Dockerfile -t manifex-agent-runtime:latest .
```

The image intentionally contains the common employee-agent runtime tools but no model or business-system secrets:

- Node 22 and npm
- Python 3 with document/data packages: `python-docx`, `openpyxl`, `pypdf`, `pdfplumber`, `pandas`, `requests`
- CLI/debug tools: `git`, `curl`, `jq`, `ripgrep`, `fd`, `unzip`, `zip`, `file`, `procps`
- Feishu/Lark CLI: `lark-cli`

Business credentials should be exposed through MCP servers with RBAC/audit, not baked into the runtime image.
