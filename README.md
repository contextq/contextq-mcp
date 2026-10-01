# @contextq/mcp

MCP server for ContextQ -- exposes the ContextQ knowledge-management API (89 tools: save, search, ingest, goal graphs, agent sessions, relays, and more) as Model Context Protocol tools. A curated ~24-tool default set loads at connection to keep the token cost of `tools/list` low; the rest load on demand or via `CONTEXT_MCP_TOOL_PROFILE=full` -- see below.

```bash
npx -y @contextq/mcp
```

## Client configuration

Two environment variables are required in every client:

| Variable | Description |
|---|---|
| `CONTEXT_API_URL` | Base URL of your ContextQ server (e.g. `https://ctx.example.com`) |
| `CONTEXT_API_KEY` | API key sent as `Authorization: Bearer` on every request |

Optional:

| Variable | Description |
|---|---|
| `CONTEXT_MCP_TOOL_PROFILE` | `default` (default if unset) loads a curated ~24-tool set at connection, well under most hosts' comfortable tool-list budget; `full` loads all ~89 tools from the start. On `default`, the rest stay reachable via the `ctx_tool_groups` (list) / `ctx_load_tool_group` (load) tools without reconnecting -- see `docs/mcp-tools.md` "Discoverability under ToolSearch deferral" |

**Setup paths**: Claude Code and Claude Desktop have automated setup via the `contextq init` CLI command. Cursor, Windsurf, and Cline require manual config file editing — see `docs/mcp-setup.md` for the full reference.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "contextq": {
      "command": "npx",
      "args": ["-y", "@contextq/mcp"],
      "env": {
        "CONTEXT_API_KEY": "sk_live_YOUR_API_KEY",
        "CONTEXT_API_URL": "https://ctx.example.com"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add contextq \
  -e CONTEXT_API_KEY=sk_live_YOUR_API_KEY \
  -e CONTEXT_API_URL=https://ctx.example.com \
  -- npx -y @contextq/mcp
```

### Cursor

Add to your Cursor MCP config (`.cursor/mcp.json` or Settings > MCP):

```json
{
  "mcpServers": {
    "contextq": {
      "command": "npx",
      "args": ["-y", "@contextq/mcp"],
      "env": {
        "CONTEXT_API_KEY": "sk_live_YOUR_API_KEY",
        "CONTEXT_API_URL": "https://ctx.example.com"
      }
    }
  }
}
```

### Windsurf

**STATUS (2026-06-02)**: Windsurf was rebranded as Devin Desktop and Cascade was end-of-lifed (2026-07-01). If you have an existing Windsurf install, the configuration below still applies, but new installations should use Devin Desktop instead. Devin Desktop uses the same MCP config format under `.devin/mcp.json`.

Add to your Windsurf MCP config (`.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "contextq": {
      "command": "npx",
      "args": ["-y", "@contextq/mcp"],
      "env": {
        "CONTEXT_API_KEY": "sk_live_YOUR_API_KEY",
        "CONTEXT_API_URL": "https://ctx.example.com"
      }
    }
  }
}
```

## What data is sent and tenant isolation

- **Only the requests your agent makes are sent.** The MCP server is a stateless proxy -- it forwards each tool call to the ContextQ API via `CONTEXT_API_URL` and returns the response. No telemetry, no background sync, no usage tracking beyond what your ContextQ server logs.
- **Tenant-scoped API keys.** Every ContextQ API key is bound to a single tenant. All `/api/*` endpoints enforce tenant isolation -- an API key can only access the tenant it was issued for. Cross-tenant data leaks are impossible at the API layer.
- **Per-request auth.** Your `CONTEXT_API_KEY` is sent as an `Authorization: Bearer` header on every call. It never appears in tool names, argument schemas, or responses returned to the LLM.

## Client timeout configuration

A handful of ContextQ tools run LLM calls, kNN scans, or bulk DB operations server-side and can legitimately take longer than a typical MCP client's default request timeout. If your client aborts before the server responds, you will see a timeout error that looks like a broken tool — it usually isn't. Configure a longer per-server timeout for this MCP server rather than assuming the tool is hung.

**Slow-class tools** (recommend a longer timeout, e.g. 120000-180000 ms depending on workspace size):

| Tool | Why it's slow |
|---|---|
| `ctx_dream` | Clusters a workspace's contexts via vector similarity, then runs one LLM synthesis call per cluster. |
| `ctx_evolve` | Runs LLM judging over up to 20 nearest-neighbor contexts to decide links/archival. |
| `ctx_ingest` | Fetches/parses a source and runs LLM claim extraction + kNN diffing. Large or URL-sourced ingests already return `{ jobId, statusUrl }` and expect polling via `ctx_ingest_status` — but small inline ingests still run synchronously and can take several seconds. |
| `ctx_regenerate_mocs` | Re-clusters all of a tenant's contexts and runs one LLM synthesis call per cluster (admin scope). |
| `ctx_memory_review_run` | Samples older contexts and asks the LLM to verdict each one (superadmin scope). |
| `ctx_bulk_update` | Applies a lifecycle/archive patch to up to 200 context ids in one call — bounded, but still slower than a single-row update. |
| `ctx_audit_cleanup_run` | Deletes up to 5000 `activity_logs` rows in one pass (superadmin scope). |
| `ctx_snapshot_create` / `ctx_fork_world` / `ctx_diff_world` | Clone or diff a workspace's full memory state (contexts, links, goal graph) — cost scales with workspace size. |

Everything else (`ctx_search`, `ctx_get`, `ctx_save`, `ctx_list`, `agent_*`, `goal_*`, `relay_*`, etc.) is ordinary CRUD/search and should complete well within a default client timeout.

These numbers are starting points, not guarantees — actual latency depends on your ContextQ server's hardware, workspace size, and configured LLM/embedding provider. Measure against your own deployment before tuning tighter.

### `.mcp.json` per-server `request_timeout_ms`

Most MCP clients that support `.mcp.json` (including Claude Code) accept a per-server `request_timeout_ms` to override the client's default request timeout for every tool call on that server:

```json
{
  "mcpServers": {
    "contextq": {
      "command": "npx",
      "args": ["-y", "@contextq/mcp"],
      "env": {
        "CONTEXT_API_KEY": "sk_live_YOUR_API_KEY",
        "CONTEXT_API_URL": "https://ctx.example.com"
      },
      "request_timeout_ms": 120000
    }
  }
}
```

`request_timeout_ms` applies per server, not per tool — if you regularly call slow-class tools, size it for the slowest one you expect to hit, not the average. Claude Code 2.1.206 fixed a bug where this field was silently ignored (a 60s default was applied regardless); confirm your Claude Code version is at least 2.1.206 if the setting doesn't seem to take effect.

### Claude Code idle timeout

Independently of `request_timeout_ms`, Claude Code (2.1.187+) also enforces `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` — an idle-abort timeout (default around 5 minutes) that fires if an MCP tool call produces no activity for that long. Set it in your shell environment (not `.mcp.json`) when calling slow-class tools against a large workspace:

```bash
export CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=300000   # milliseconds; raise if ctx_dream/ctx_ingest still time out
```

Treat both settings as recommendations, not guarantees, of how long any given call will take.

## API version compatibility

The 99-tool surface exposed by this MCP server is a direct projection of the ContextQ API (24 loaded by default, the rest via `CONTEXT_MCP_TOOL_PROFILE=full` or on-demand -- see "Client configuration" above). The tool count and signatures drift with the server. Pin compatible versions:

| MCP package | ContextQ server API |
|---|---|
| `@contextq/mcp@2.x` | ContextQ v2.x (99 tools) |

When upgrading your ContextQ server, check the [changelog](https://contextq.dev/changelog/) and bump the MCP package to the matching major version. A version mismatch may surface unknown tools or break call signatures.

## License

MIT
