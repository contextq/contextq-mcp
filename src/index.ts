#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SERVER_INSTRUCTIONS, getActiveTools, handleToolCall, setMcpClientInfo } from "./tools.js";

// ---------------------------------------------------------------------------
// MCP package version (read from package.json at runtime)
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return (pkg as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const MCP_VERSION = readPackageVersion();

// Minimum API version this MCP supports. Bump when the MCP depends on
// API-side features that did not exist in older server releases.
const MIN_API_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// SemVer helpers (no external dependency — Node 22 built-ins only)
// ---------------------------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(v: string): SemVer | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function semVerGte(a: SemVer, b: SemVer): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

// ---------------------------------------------------------------------------
// API version handshake
//
// On startup, probes the API's health endpoint to read its version and
// compares it against MIN_API_VERSION.  Mismatches or unreachable APIs
// produce a warning on stderr but never prevent startup — the tool surface
// can drift, and connecting an outdated MCP to a newer API (or vice versa)
// must still work from the MCP side.  The warning is the signal.
// ---------------------------------------------------------------------------

async function handshake(baseUrl: string): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  let reachable = false;
  let apiVersion: string | undefined;

  // Quick reachability probe via GET /health (always public, no DB hit).
  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    if (resp.ok) {
      reachable = true;
      // Some deployments may embed a version key on the simple endpoint.
      const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
      if (body && typeof body.version === "string") {
        apiVersion = body.version;
      }
    }
  } catch {
    // /health unreachable — try /health/deep below.
  }

  // Deep health returns a `version` field (git SHA in the current server,
  // may become a semver in future releases).
  if (!apiVersion) {
    try {
      const resp = await fetch(`${base}/health/deep`, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      if (resp.ok) {
        reachable = true;
        const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (body && typeof body.version === "string") {
          apiVersion = body.version;
        }
      }
    } catch {
      // Both endpoints unreachable or version-less.
    }
  }

  if (!reachable) {
    console.error(
      `[shared-context-mcp] WARNING: API at ${base} is unreachable. ` +
        `The MCP server has started but tools will return errors until the API becomes reachable.`,
    );
    return;
  }

  if (apiVersion) {
    const apiSemVer = parseSemVer(apiVersion);
    const minSemVer = parseSemVer(MIN_API_VERSION);

    if (apiSemVer && minSemVer) {
      if (!semVerGte(apiSemVer, minSemVer)) {
        console.error(
          `[shared-context-mcp] WARNING: API version ${apiVersion} is older ` +
            `than the minimum supported version ${MIN_API_VERSION}. ` +
            `The MCP server has started but some tools may behave differently.`,
        );
      } else {
        console.error(
          `[shared-context-mcp] API version ${apiVersion} satisfies min version ${MIN_API_VERSION}.`,
        );
      }
    } else {
      // Version field exists but is not a semver (e.g. a git SHA).
      // Skip the comparison — can't evaluate.
      console.error(
        `[shared-context-mcp] API reports version identifier: ${apiVersion} ` +
          `(not a semantic version — compatibility check skipped).`,
      );
    }
  } else {
    console.error(
      `[shared-context-mcp] WARNING: API at ${base} does not report a version. ` +
        `Compatibility with min ${MIN_API_VERSION} was not verified.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "contextq",
    version: MCP_VERSION,
  },
  {
    capabilities: {
      // T668: listChanged:true -- ctx_load_tool_group promotes a group into
      // the active profile at runtime and we notify via
      // notifications/tools/list_changed. Clients that ignore the
      // notification (or never subscribed) still work: handleToolCall
      // dispatches on tool name regardless of the last tools/list result.
      tools: { listChanged: true },
    },
    instructions: SERVER_INSTRUCTIONS,
  },
);

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // T668: default/extended tool-profile split -- see tools.ts's
  // getActiveTools()/TOOL_GROUPS doc comment. Starts at the default (or
  // full, via CONTEXT_MCP_TOOL_PROFILE=full) profile and grows as
  // ctx_load_tool_group is called.
  return { tools: getActiveTools() };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args, _meta } = req.params;
  // T558: `_meta` already exists on every `tools/call` request in the
  // current protocol -- forward it through so `handleToolCall` can pull out
  // `traceparent`/`tracestate`/`baggage` when a client sends them. Absent
  // on every request today; `handleToolCall`'s own extraction is the
  // silent no-op path.
  const result = await handleToolCall(name, (args ?? {}) as Record<string, unknown>, _meta);

  // T668: the active tool set just grew -- tell any client that negotiated
  // capabilities.tools.listChanged so it re-fetches tools/list. Best-effort:
  // a client that never subscribed, or a closed transport, must never fail
  // the tool call it rides on.
  if (name === "ctx_load_tool_group" && !result.isError) {
    server.sendToolListChanged().catch(() => {});
  }

  return result;
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiUrl = process.env.CONTEXT_API_URL ?? "http://localhost:38200";

  // Validate CONTEXT_API_URL before connecting. An invalid or non-HTTP URL
  // would cause every tool call to throw a cryptic fetch error; fail fast here.
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.error(
        `[shared-context-mcp] Fatal: CONTEXT_API_URL must use http: or https: protocol, ` +
          `got "${parsed.protocol}". Set CONTEXT_API_URL to a valid API base URL.`,
      );
      process.exit(1);
    }
  } catch {
    console.error(
      `[shared-context-mcp] Fatal: CONTEXT_API_URL "${apiUrl}" is not a valid URL. ` +
        `Set CONTEXT_API_URL to a valid API base URL (e.g. http://localhost:38200).`,
    );
    process.exit(1);
  }

  // T845: the host names itself in the `initialize` handshake, and that is
  // the only signal at this layer that survives how the host chose to launch
  // us -- `npm exec` rebuilds the environment, so CLAUDECODE and friends are
  // present for a direct `node <path>` spawn and absent for an `npm exec`
  // one. Set here rather than after connect(): `initialize` may land before
  // the await below resolves.
  server.oninitialized = () => {
    setMcpClientInfo(server.getClientVersion());
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const apiKey = process.env.CONTEXT_API_KEY;
  console.error(`[shared-context-mcp] Connected (v${MCP_VERSION}). API: ${apiUrl}, Auth: ${apiKey ? 'configured' : 'NONE'}`);

  // Non-fatal: warns on stderr but never blocks startup.
  await handshake(apiUrl);
}

main().catch((err) => {
  console.error("[shared-context-mcp] Fatal:", err);
  process.exit(1);
});
