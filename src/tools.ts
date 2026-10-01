import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { extractTraceContext, traceContextStorage } from "./trace-context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T845: which agent host is driving this stdio client.
//
// The host (Claude Code, opencode, cyberine, a bare MCP client) reports itself
// in the `initialize` handshake's `clientInfo`, and that is the only reliable
// signal at this layer: an env sniff is a coin flip here, because a server
// spawned as a direct `node <path>` process inherits CLAUDECODE while one
// spawned via `npm exec` does not. Recorded on the agent session row the API
// opens so a staged per-host rollout is measurable from our own data.
//
// Header names are duplicated from src/utils/mcp-client-info.ts rather than
// imported: `mcp/` is a distinct package with its own tsconfig and deps, the
// same reason src/plugins/mcp.ts does not import this file's tool definitions.
// ---------------------------------------------------------------------------

const MCP_CLIENT_NAME_HEADER = "x-mcp-client-name";
const MCP_CLIENT_VERSION_HEADER = "x-mcp-client-version";
const MCP_CLIENT_NAME_MAX = 128;
const MCP_CLIENT_VERSION_MAX = 64;

let clientInfo: { name?: string; version?: string } = {};

function boundedClientValue(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\p{Cc}]/gu, "").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

/** Called once from index.ts when the host finishes `initialize`. */
export function setMcpClientInfo(info: { name?: string; version?: string } | undefined): void {
  clientInfo = {
    name: boundedClientValue(info?.name, MCP_CLIENT_NAME_MAX),
    version: boundedClientValue(info?.version, MCP_CLIENT_VERSION_MAX),
  };
}

/** Test seam -- what the next outgoing request would send. */
export function getMcpClientInfo(): { name?: string; version?: string } {
  return { ...clientInfo };
}

function apiUrl(path: string): string {
  const base = process.env.CONTEXT_API_URL ?? "http://localhost:38200";
  return `${base.replace(/\/+$/, "")}${path}`;
}

function toQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, String(v));
    } else {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.CONTEXT_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  // T558: forward the validated W3C trace context (when the calling tool's
  // `_meta` carried one) as real HTTP headers on the outgoing API call --
  // ambient via AsyncLocalStorage (see trace-context.ts) rather than a new
  // parameter on all ~90 call sites of this function. Absent on every call
  // today (no known MCP client sends these `_meta` keys yet) -- the store
  // is null, these three lines never run, headers unchanged from before
  // this task.
  const traceContext = traceContextStorage.getStore();
  if (traceContext) {
    headers["traceparent"] = traceContext.traceparent;
    if (traceContext.tracestate) headers["tracestate"] = traceContext.tracestate;
    if (traceContext.baggage) headers["baggage"] = traceContext.baggage;
  }
  // T845: name the host on every call, so whichever one opens an agent
  // session gets recorded on its row. Absent until `initialize` has landed,
  // and absent entirely for a host that omits `clientInfo`.
  if (clientInfo.name) headers[MCP_CLIENT_NAME_HEADER] = clientInfo.name;
  if (clientInfo.version) headers[MCP_CLIENT_VERSION_HEADER] = clientInfo.version;
  const options: RequestInit = {
    method,
    headers,
    redirect: 'manual',
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), options);
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Unexpected redirect from API (${res.status}) for ${method} ${path}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${method} ${path} returned ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const CONTEXT_TYPE_ENUM = [
  "reference",
  "feedback",
  "project",
  "incident",
  "lesson",
  "user",
  "synthesis",
  "map",
  "moc",
] as const;

const CONTEXT_SCOPE_ENUM = ["personal", "workspace", "team"] as const;

// T344: memory taxonomy axis — episodic/semantic/procedural. Orthogonal to
// memoryClass (action/knowledge). Defaults to a write-time heuristic
// classification (by context type) on the server when omitted.
const MEMORY_KIND_ENUM = ["episodic", "semantic", "procedural"] as const;

const LIFECYCLE_ENUM = [
  "fleeting",
  "working",
  "evergreen",
  "archived",
] as const;

const LINK_TYPE_ENUM = [
  "supersedes",
  "contradicts",
  "implements",
  "derived_from",
  "related_to",
] as const;

const LINK_DIRECTION_ENUM = ["outbound", "inbound", "both"] as const;

// T618: Claude Code (2.1.222+) defers a server's tools behind ToolSearch once
// it exposes many of them -- the model sees tool NAMES only and must find
// tools by keyword search against name + description. `instructions` is the
// one channel guaranteed to render into the system prompt regardless of
// deferral (observable under "MCP Server Instructions" in any CC session
// connected to this server), so it carries the prefix map + the "load these
// together" guidance that a per-tool description cannot. Kept short --
// see docs/mcp-tools.md "Discoverability under ToolSearch deferral" for the
// keyword heuristic behind individual tool descriptions.
export const SERVER_INSTRUCTIONS =
  "ContextQ: persistent memory + goal graph for agents. Prefixes: ctx_* = " +
  "knowledge CRUD/search (save/search/get/list a context; use ctx_search to " +
  "recall or check for existing knowledge before re-saving it), agent_* = " +
  "agent session memory (boot/checkpoint/resume/lesson/handoff), goal_* = " +
  "shared goal graph (add/advance/frontier -- durable cross-session tasks), " +
  "relay_* = directed cross-role handoff (open/inbox/claim/advance). At the " +
  "start of tracked work, load ctx_search, ctx_save, and agent_boot together " +
  "in one ToolSearch select call rather than one at a time. T668: only a " +
  "small default tool set is loaded on connection (~24 tools) -- if the " +
  "tool you need isn't in your list, call ctx_tool_groups to see the rest " +
  "(code graph, admin, relay, world-model, saved searches, knowledge graph, " +
  "bulk ingest) and ctx_load_tool_group to load a group into this session.";

export const tools: Tool[] = [
  {
    name: "ctx_save",
    description:
      "Save a new context entry (reference doc, feedback, project note, incident report, lesson learned, or user profile). Use this when you want to persist knowledge for future retrieval. Optional lifecycle/valid_from/valid_to flag the note's maturity and bi-temporal validity. Response includes atomic, quality_score, and lifecycle once the backend judge has run. Trigger: user asks you to remember/save something (\"nhớ cái này\", \"lưu lại\", \"ghi nhớ giúp\", \"remember this\", \"save this\", \"note this down\") — call whenever work-relevant info should persist across sessions. Only call when the request is actually about tracked work/memory; ignore unrelated casual chat.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Short, descriptive title" },
        description: {
          type: "string",
          description: "One-line summary used for search ranking",
        },
        content: {
          type: "string",
          description: "Full content / body of the context entry",
        },
        type: {
          type: "string",
          enum: [...CONTEXT_TYPE_ENUM],
          description: "Category of the context entry",
        },
        scope: {
          type: "string",
          enum: [...CONTEXT_SCOPE_ENUM],
          description: "Visibility scope (defaults to personal)",
        },
        workspace: {
          type: "string",
          description: "Workspace identifier that owns this context",
        },
        project: {
          type: "string",
          description: "Optional project identifier within the workspace",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and filtering",
        },
        metadata: {
          type: "object",
          description: "Arbitrary key-value metadata",
        },
        lifecycle: {
          type: "string",
          enum: [...LIFECYCLE_ENUM],
          description:
            "Lifecycle state of the note. Omit to let the backend default to 'working'. Use 'fleeting' for transient captures, 'evergreen' for durable knowledge, 'archived' to retire from active surfacing.",
        },
        memoryKind: {
          type: "string",
          enum: [...MEMORY_KIND_ENUM],
          description:
            "Taxonomy override: 'episodic' (an event/interaction happened), 'semantic' (durable factual/reference knowledge), or 'procedural' (how-to / lesson that changes future behavior). Omit to let the backend classify it from the context type (a cheap heuristic, optionally refined by the atomicity judge).",
        },
        valid_from: {
          type: "string",
          description:
            "Bi-temporal: ISO 8601 timestamp when the fact this context describes started being true. Optional.",
        },
        valid_to: {
          type: "string",
          description:
            "Bi-temporal: ISO 8601 timestamp when the fact stopped being true. Optional; null means still valid.",
        },
      },
      required: ["name", "description", "content", "type", "workspace"],
    },
  },
  {
    name: "ctx_search",
    description:
      "Search / recall saved knowledge and memories using hybrid full-text + semantic search ranked by relevance — the default tool for 'what do I know about X' or 'did I already save this'. Use this when you need to find, remember, or look up existing knowledge by keyword or phrase. Set chunk_search=false to disable per-chunk passage matching, lifecycle_boost=false for legacy ranking, or include_archived=true to surface retired notes. Results may include lifecycle, quality_score, and matched_chunk per hit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (full-text + semantic)",
        },
        workspace: {
          type: "string",
          description: "Filter by workspace identifier",
        },
        project: {
          type: "string",
          description: "Filter by project identifier",
        },
        type: {
          type: "string",
          enum: [...CONTEXT_TYPE_ENUM],
          description: "Filter by context type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (all must match)",
        },
        scope: {
          type: "string",
          enum: [...CONTEXT_SCOPE_ENUM],
          description: "Filter by visibility scope",
        },
        subjectId: {
          type: "string",
          description:
            "Filter to memories scoped to a single end-user (Mem0-parity user_id axis). Matches the subjectId used when the memory was created via ctx_remember / POST /api/memory. Omit to search across all subjects.",
        },
        memoryKind: {
          type: "string",
          enum: [...MEMORY_KIND_ENUM],
          description:
            "Filter to a single taxonomy kind: 'episodic' (events/interactions), 'semantic' (durable reference knowledge), or 'procedural' (how-to / lessons). Omit to search across all kinds.",
        },
        epistemicMin: {
          type: "string",
          enum: ["observed", "told", "inferred", "assumed"],
          description:
            "Epistemic floor (T358): only return contexts at or above this confidence tier (weakest->strongest: assumed < inferred < told < observed). E.g. 'told' excludes 'assumed'/'inferred' rows. Omit to search across all tiers.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 20)",
        },
        offset: {
          type: "number",
          description: "Offset for pagination",
        },
        chunk_search: {
          type: "boolean",
          description:
            "When true (default), search at the chunk level so individual passages can match. When false, only whole-context fields are scored.",
        },
        lifecycle_boost: {
          type: "boolean",
          description:
            "When true (default), apply the evergreen/fleeting lifecycle multipliers to the ranking. Set false for legacy ts_rank * tagBoost * recencyBoost only.",
        },
        include_archived: {
          type: "boolean",
          description:
            "When true, include lifecycle='archived' rows. Default false — archived notes are excluded from regular searches.",
        },
        level: {
          type: "string",
          enum: ["full", "paragraph", "sentence"],
          description:
            "Layered representation level. 'full' (default) keeps the stored description; 'paragraph' replaces it with a ~120-word distill; 'sentence' replaces it with a ~25-word claim. Use 'sentence' for cheap high-density agent prompts where every token matters. Falls back to the stored description when the distill is not yet populated for a row.",
        },
        include_trace_events: {
          type: "boolean",
          description:
            "T375: when true, ALSO search episodic tool-call trace summaries ('what did I try before this worked?') and return them in a separate `traceEvents` field. Default false — this is fully additive and never changes `results` or its ranking. Combine with trace_session_id to scope to one session.",
        },
        trace_session_id: {
          type: "number",
          description: "Scope trace-event fusion to one agent session (omit to search across the tenant's trace events). Ignored unless include_trace_events is true.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ctx_explain_recall",
    description:
      "Explain WHY a search result was recalled by reconstructing the RRF (Reciprocal Rank Fusion) math for a captured retrieval trace: per-signal score breakdown (PG lexical rank + raw ts_rank, Elasticsearch BM25 rank + raw score, chunk cosine similarity, recency/tag/lifecycle/salience/confidence boost multipliers), the RRF-fused score, and the final rank -- for every result of that search, plus a human-readable narrative per result. Requires the server to have RETRIEVAL_TRACE_ENABLED=true and that this particular search was sampled in by RETRIEVAL_TRACE_SAMPLE_RATE -- this is a V1 observability surface with no listing endpoint yet, so trace ids come from direct DB inspection during this phase. Each certificate is optionally signed with the tenant's Ed25519 export key (T370 MIF); `signatureVerified` in the response reports whether the signature checks out against the tenant's published public key, making the certificate usable as tamper-evident evidence for an auditor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The retrieval_traces row id to explain.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_list",
    description:
      "List context entries with optional filters. Use this to browse existing contexts by workspace, project, type, or tag without a search query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: {
          type: "string",
          description: "Filter by workspace identifier",
        },
        project: {
          type: "string",
          description: "Filter by project identifier",
        },
        type: {
          type: "string",
          enum: [...CONTEXT_TYPE_ENUM],
          description: "Filter by context type",
        },
        tag: {
          type: "string",
          description: "Filter by a single tag",
        },
        scope: {
          type: "string",
          enum: [...CONTEXT_SCOPE_ENUM],
          description: "Filter by visibility scope",
        },
        memoryKind: {
          type: "string",
          enum: [...MEMORY_KIND_ENUM],
          description:
            "Filter to a single taxonomy kind: 'episodic', 'semantic', or 'procedural'.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 20)",
        },
        offset: {
          type: "number",
          description: "Offset for pagination",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_get",
    description:
      "Get a single context entry by its ID. Use this when you already know the exact context ID you want to read. Response includes lifecycle, atomic, quality_score, valid_from, and valid_to alongside the standard fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_update",
    description:
      "Update an existing context entry. Only the provided fields are changed; omitted fields remain unchanged. Use this to correct, append to, reclassify, or retire (archive) an existing entry. Optional lifecycle/valid_from/valid_to update note maturity and bi-temporal validity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to update",
        },
        name: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        content: { type: "string", description: "New content body" },
        type: {
          type: "string",
          enum: [...CONTEXT_TYPE_ENUM],
          description: "New context type",
        },
        scope: {
          type: "string",
          enum: [...CONTEXT_SCOPE_ENUM],
          description: "New visibility scope",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement set of tags",
        },
        metadata: {
          type: "object",
          description: "Replacement metadata object",
        },
        archivedAt: {
          type: ["string", "null"],
          description: "Set to null to unarchive, or ISO date string to archive",
        },
        lifecycle: {
          type: "string",
          enum: [...LIFECYCLE_ENUM],
          description:
            "New lifecycle state (fleeting/working/evergreen/archived).",
        },
        memoryKind: {
          type: "string",
          enum: [...MEMORY_KIND_ENUM],
          description:
            "Taxonomy override: 'episodic', 'semantic', or 'procedural'. Setting this locks the value against the fire-and-forget atomicity-judge LLM refinement on this write.",
        },
        valid_from: {
          type: "string",
          description:
            "Bi-temporal: ISO 8601 timestamp when the fact started being true.",
        },
        valid_to: {
          type: "string",
          description:
            "Bi-temporal: ISO 8601 timestamp when the fact stopped being true; null to keep open.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_delete",
    description:
      "Permanently delete a context entry by ID. This action cannot be undone. Use this only when you are sure the entry should be removed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_bulk_update",
    description:
      "Apply the same lifecycle move and/or archive flag to many contexts in a single call. Use this when you need to retire, mature, or reclassify a batch (capped at 200 ids per call). Tenant-scoped on the backend — ids belonging to other tenants are silently dropped and reported in the failed list. Returns { updated: number[], failed: { id, error }[] }.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Context IDs to update (max 200 per call)",
        },
        patch: {
          type: "object",
          description:
            "Fields to apply uniformly. Supply lifecycle, archive, or both. archive=true stamps archived_at to NOW().",
          properties: {
            lifecycle: {
              type: "string",
              enum: [...LIFECYCLE_ENUM],
              description: "New lifecycle state for every supplied id",
            },
            archive: {
              type: "boolean",
              description:
                "When true, stamp archived_at = NOW() on every supplied id (use to retire a batch).",
            },
          },
        },
      },
      required: ["ids", "patch"],
    },
  },
  {
    name: "ctx_undo_archive",
    description:
      "Undo a memory-evolution auto-archive within the configurable window (default 72h, env EVOLUTION_ARCHIVE_UNDO_WINDOW_HOURS). Only contexts archived by the memory-evolution feature qualify - manual PATCH lifecycle archives don't. Returns the restored context. Companion endpoint: ctx_undo_archive_info for eligibility check.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Context ID to undo archive on.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_undo_archive_info",
    description:
      "Check whether a context's auto-archive is still undo-able. Returns `{eligible: bool, archivedAt, expiresAt, archivedByFocalId, confidence, withinWindow}`. Use before ctx_undo_archive to surface a meaningful UX (button enabled/disabled, countdown to expiry) instead of round-tripping the undo attempt.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Context ID to inspect.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_import",
    description:
      "Bulk import context entries from an external source. Optionally filter by workspace and preview with a dry run before committing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: {
          type: "string",
          description: "Filter import to a specific workspace",
        },
        dryRun: {
          type: "boolean",
          description:
            "If true, validate and preview the import without persisting changes",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_stats",
    description:
      "Get aggregate statistics: total context count, breakdown by workspace, type, tag, recently updated entries, and orphan_rate (notes with no tags and no inbound references). Use this for an overview of what is stored and to spot disconnected knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ctx_dream",
    description:
      "Run memory consolidation (dream) on a workspace's context entries. Clusters related entries using vector similarity, synthesizes each cluster into a 'synthesis' entry via LLM, and writes a dream log. Use dryRun to preview clusters without persisting.\n\nT497: dream on a large workspace (more than DREAM_ASYNC_THRESHOLD contexts, default 100) runs async — the response is { jobId, statusUrl } and you must poll ctx_ingest_status (or GET /api/ingest-jobs/:id) until status='succeeded' or 'failed' to read the full result. Small workspaces still return the full result inline. Pass async=true/false to force a path explicitly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: {
          type: "string",
          description: "Workspace identifier to consolidate knowledge for",
        },
        project: {
          type: "string",
          description: "Optional project filter — consolidate only entries for this project",
        },
        dryRun: {
          type: "boolean",
          description: "If true, preview clusters without creating synthesis entries (default false)",
        },
        async: {
          type: "boolean",
          description:
            "Force the async path (true) or sync path (false). Omit to let the server auto-pick based on workspace size — async responses are { jobId, statusUrl }; sync responses are the full dream result.",
        },
      },
      required: ["workspace"],
    },
  },
  {
    name: "ctx_link",
    description:
      "Manually create a typed link from one context to another (supersedes/contradicts/implements/derived_from/related_to). The backend already auto-creates links during memory evolution; only call this tool when you want to assert a relationship the system missed or override it explicitly. The 'reason' arg is recorded as the link's created_by annotation for audit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source_id: {
          type: "number",
          description: "ID of the source context (the link's tail)",
        },
        target_id: {
          type: "number",
          description: "ID of the target context (the link's head)",
        },
        type: {
          type: "string",
          enum: [...LINK_TYPE_ENUM],
          description:
            "Link semantics: supersedes (replaces), contradicts (disagrees), implements (concrete impl of target spec), derived_from (extracted from target), related_to (generic association).",
        },
        confidence: {
          type: "number",
          description:
            "Optional confidence score in [0, 1]. Omit if not meaningful.",
        },
        reason: {
          type: "string",
          description:
            "Optional human-readable rationale; recorded as created_by annotation for audit.",
        },
      },
      required: ["source_id", "target_id", "type"],
    },
  },
  {
    name: "ctx_links",
    description:
      "List typed links for a context — incoming, outgoing, or both. Use this to discover how a context is connected (what it supersedes, what supersedes it, what implements it, etc.) before making decisions about updates or archival. The `created_by` field on each link indicates origin: `wikilink:<raw title>` marks edges auto-created from `[[Wiki Title]]` tokens in the source content, `memory-evolution` marks LLM-judged edges, and other values are manual.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID whose links you want to list",
        },
        direction: {
          type: "string",
          enum: [...LINK_DIRECTION_ENUM],
          description:
            "Which links to return: 'outbound' (this context links to others), 'inbound' (others link to this), or 'both' (default).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_evolve",
    description:
      "Re-run memory evolution for an existing context. Examines K=5 nearest neighbors and creates typed links / archives superseded notes via LLM judging. Use when you've updated a context substantially or want to recompute relationships. Pair with dry_run=true first to preview.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to re-run memory evolution for",
        },
        k_neighbors: {
          type: "number",
          description:
            "Override the default neighbor count (env EVOLUTION_K_NEIGHBORS or 5). Capped at 20.",
        },
        dry_run: {
          type: "boolean",
          description:
            "When true, run the LLM judgments but skip link creation, archival, and activity logging. Returns the proposals so you can preview before committing. Default false.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_chunks",
    description:
      "List the block-level chunks for a context, ordered by chunk_index. Each chunk includes its heading_path, content, and has_embedding flag (false while the embedding job is still pending). Use this to inspect how a context was split for chunked retrieval, debug per-passage matches surfaced by ctx_search, or check embedding coverage before relying on semantic ranking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID whose chunks you want to list",
        },
      },
      required: ["id"],
    },
  },
  // -------------------------------------------------------------------------
  // Code graph navigation (T315). Requires the repo to have been indexed with
  // the contextq indexer (T312/T314) so that code edges exist in context_links.
  // These tools answer questions from the stored graph — not grep, not file-read.
  // -------------------------------------------------------------------------
  {
    name: "ctx_code_refs",
    description:
      "Find every file that imports or calls a given source file. Returns the set of referencing files (with link type and callee-symbol hint) from the code graph stored in context_links. Use this instead of grep to answer 'what references X' — it reads from the pre-built graph rather than scanning the repo. `ref` can be a repo-relative file path (e.g. 'src/services/search.service.ts') or a numeric context id. Returns 404 when the file has not been indexed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: {
          type: "string",
          description:
            "Repo-relative file path (e.g. 'src/services/context.service.ts') or numeric context id. The path is matched against the indexed external_id suffix, so partial trailing paths work as long as they are unambiguous within the tenant.",
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "ctx_code_trace",
    description:
      "Trace the directional call chain FROM a given source file via BFS over CALLS edges in the code graph. Returns nodes and edges so you can reconstruct the call path. Use this to answer 'what does X call, and what do those files call' up to N levels deep — reads from the pre-built graph, not file content. `ref` can be a file path or numeric context id. `depth` controls BFS hops (default 2, max 3). Returns 404 when the file has not been indexed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: {
          type: "string",
          description:
            "Repo-relative file path (e.g. 'src/services/search.service.ts') or numeric context id to start the trace from.",
        },
        depth: {
          type: "number",
          description:
            "How many CALLS hops to follow. Default 2, max 3. The service clamps the value — passing 4 is treated as 3.",
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "ctx_provenance_get",
    description:
      "Walk the belief provenance chain backward from a context (T358): who/what produced it, and what it was derived from. BFS over context_provenance.source_context_ids, same traversal shape as ctx_code_trace. Returns { root: {id, name, epistemicStatus}, nodes: [{id, name, epistemicStatus}], edges: [{contextId, sourceContextId, transformType, producerId, modelId, promptHash, createdAt}], depth, truncated }. transformType is one of manual/agent_write/ingest/dream_synthesis/evolve. epistemicStatus is one of observed/told/inferred/assumed (weakest->strongest: assumed < inferred < told < observed) — use this to judge how much to trust a fact and its ancestors. Use this to answer 'where did this claim come from' or 'what fed into this dream synthesis'. Returns 404 when the context does not exist or isn't visible to the caller.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to walk provenance backward from",
        },
        depth: {
          type: "number",
          description:
            "How many hops to follow back through source_context_ids. Default 5, max 5.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_confidence_get",
    description:
      "Get a context's current belief confidence (T359): a continuously-recomputed [0,1] score, distinct from epistemicStatus (a coarse write-time tag) and context_links.confidence (a static per-edge score). This one moves over time — corroborating derived_from links raise it, contradicts/supersedes links against it lower it, weighted by the linking source context's own confidence, and it slowly decays toward the neutral 0.5 prior if the context goes stale without new evidence. Returns { contextId, confidence, confidenceUpdatedAt, evidenceCount }. Use this to judge how much to trust a specific fact right now, as opposed to ctx_belief_history which shows how that trust got here. Returns 404 when the context does not exist or isn't visible to the caller.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to look up confidence for",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_belief_history",
    description:
      "Get the append-only ledger of every confidence change applied to a context (T359): each entry records the triggering link, a human-readable reason, and the old/new confidence values. Use this to audit WHY a context's belief confidence is what it is right now (see ctx_confidence_get for the current value) — e.g. 'why do we no longer trust this note' or 'what corroborated this claim'. Returns { results: [{id, contextId, triggeringLinkId, reason, oldConfidence, newConfidence, createdAt}] }, newest first. Returns an empty results array when the context isn't visible to the caller or has no recorded events yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to fetch belief history for",
        },
        limit: {
          type: "number",
          description: "Max events to return, newest first. Default 50, max 200.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_blast_radius",
    description:
      "Compute the blast radius of a context BEFORE trusting a correction to it (T362): 'what breaks if this context turns out to be wrong'. Bounded BFS over context_links following derived_from/supersedes/implements edges downstream (same traversal shape as ctx_code_trace/ctx_provenance_get), plus a structural join against goal_nodes and a best-effort match against agent_lessons that reference the context. The exact same fan-out count gates whether the server's own automated supersede/archive/contradict decisions (memory-evolution, T352 contradicts links) auto-apply or are held for manual review — call this first when you're about to believe or act on a correction to a context with many dependents. Returns { contextId, contextName, totalFanOut, threshold, exceedsThreshold, depthReached, truncated, contextLinkCount, goalNodeCount, agentLessonCount, topNodes: [{id, name, kind, linkType, depth, fanOutScore}] }. `topNodes` is ranked highest-impact first. Returns 404 when the context does not exist or isn't visible to the caller.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The context entry ID to compute blast radius for",
        },
        depth: {
          type: "number",
          description: "Max BFS hops to follow downstream. Default/max 3.",
        },
        top: {
          type: "number",
          description: "Max number of top-impact nodes to return. Default 10, max 50.",
        },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // Entity knowledge graph (T339-T342). Requires ENTITY_GRAPH_ENABLED to have
  // been on for a while so entities/entity_edges are populated — otherwise
  // these return empty results, not errors.
  // -------------------------------------------------------------------------
  {
    name: "ctx_graph_search",
    description:
      "Entity-anchored fact search over the temporal knowledge graph. Resolves entities mentioned in the query (name/alias match, no LLM call), walks entity_edges 1-2 hops, and returns ranked facts with provenance (which context each fact came from) and validity (current vs. historical/invalidated). Use this to answer relationship questions ('who does X work for', 'what depends on Y') that plain text search can't reliably surface. Pass `as_of` for a point-in-time view of what was believed true at that date. Returns empty arrays (not an error) when no entities in the query resolve or the graph has no data yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Free-text query naming one or more entities and/or a relationship, e.g. 'who does Carol Vu work for'.",
        },
        as_of: {
          type: "string",
          description: "Optional ISO 8601 timestamp. Returns facts as they were believed true at this point in time, including facts since invalidated. Omit for the current state.",
        },
        limit: {
          type: "number",
          description: "Max provenance context ids to return, default 20, max 50.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ctx_entity_get",
    description:
      "Fetch an entity card from the knowledge graph: the entity's identity (name, aliases, type, summary), its current edges (facts currently believed true), and its full timeline (every fact ever extracted about it, including ones since invalidated/superseded, newest first). Use this to look up everything the graph knows about a specific entity id. Returns 404 when the entity does not exist under the authenticated tenant.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Numeric entity id (from an entities row, or the sourceEntityId/targetEntityId on a fact returned by ctx_graph_search).",
        },
        as_of: {
          type: "string",
          description: "Optional ISO 8601 timestamp. Scopes the 'edges' field (not the timeline, which always shows full history) to what was valid at this point in time.",
        },
      },
      required: ["id"],
    },
  },

  {
    name: "ctx_mocs",
    description:
      "List Maps of Content (MOCs) for the tenant. MOCs are curated index notes that summarize and link to clusters of related contexts, providing a navigation layer over the knowledge graph. Use this to discover existing high-level views before creating new synthesis notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Optional max results to return.",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_regenerate_mocs",
    description:
      "Regenerate Maps of Content by re-clustering the tenant's contexts and synthesizing one MOC per cluster via LLM. Expensive (runs an LLM call per cluster) — call sparingly, typically after a substantial batch of new contexts has been added. Requires admin scope.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ctx_maps",
    description:
      "List memory maps (Dream-generated multi-shape navigation TOCs) for the caller's tenant. Optionally filter by workspace / project slug. Each row carries `{id, shape, version, generatedAt, userEdited, scope}` - fetch the full map_payload via /api/maps/:id (not wrapped here yet to keep this surface small). Useful when listing or summarising available maps to an AI agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: {
          type: "string",
          description: "Filter by workspace slug (optional).",
        },
        project: {
          type: "string",
          description: "Filter by project slug (optional).",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_saved_searches_list",
    description:
      "List all saved searches visible to the caller (their own + tenant-shared). Saved searches are named, reusable retrieval views (Dataview-style) that bundle a query string with filters so agents/sessions can rerun them without re-typing the criteria.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ctx_saved_searches_create",
    description:
      "Create a new saved search. Supply a unique name (per owner within the tenant), an optional description, the search query string, and the filter blob. Set shared_with_tenant=true to let other users in the tenant see and run it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Unique name for the saved search (per owner within the tenant)",
        },
        description: {
          type: "string",
          description: "Optional one-line summary",
        },
        query: {
          type: "string",
          description:
            "Search query (full-text + semantic). May be empty for filter-only views.",
        },
        filters: {
          type: "object",
          description:
            "Filter blob — accepts the same fields as ctx_search (workspace, project, type, tags, scope, lifecycle, useMap, includeMaps, includeArchived, lifecycleBoost, chunkSearch, limit, offset). Unknown keys are stripped server-side.",
        },
        shared_with_tenant: {
          type: "boolean",
          description:
            "When true, other users in the tenant can read and run (but not delete) this saved search. Default false.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "ctx_saved_searches_get",
    description:
      "Fetch a single saved search by id. Returns 404 if it does not exist or the caller cannot see it (different tenant, or owned by another user and not shared).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The saved search id",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_saved_searches_update",
    description:
      "Update an existing saved search. Owner can update their own searches; admins/owners can also update tenant-shared searches owned by others. Only the provided fields are changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The saved search id",
        },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        query: { type: "string", description: "New query string" },
        filters: {
          type: "object",
          description: "Replacement filter blob (same shape as create)",
        },
        shared_with_tenant: {
          type: "boolean",
          description: "Toggle tenant-wide visibility",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_saved_searches_delete",
    description:
      "Delete a saved search by id. Owner only — even tenant-shared searches can only be deleted by their original owner.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The saved search id to delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_saved_searches_run",
    description:
      "Execute a saved search by id and return the same shape as ctx_search. Optional limit/offset/query overrides apply at run time without modifying the persisted view. Use this when you already know the saved search id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "The saved search id",
        },
        query: {
          type: "string",
          description:
            "Optional query override. If omitted, the persisted query is used.",
        },
        limit: {
          type: "number",
          description: "Optional limit override",
        },
        offset: {
          type: "number",
          description: "Optional offset override",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_run_saved_search",
    description:
      "Convenience: resolve a saved search by name (caller's own row preferred, falling back to a tenant-shared row with the same name) and execute it. Use this when an agent has the human-readable name but not the id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The saved search name to resolve and run",
        },
        query: {
          type: "string",
          description: "Optional query override",
        },
        limit: {
          type: "number",
          description: "Optional limit override",
        },
        offset: {
          type: "number",
          description: "Optional offset override",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "ctx_ingest",
    description:
      "Ingest raw material (URL or inline content) and turn it into atomic claims that get diff'd against the existing knowledge base. The server fetches/parses the source, extracts claims via LLM, runs kNN against the tenant + workspace scope, and decides create / update / archive per claim. Set dry_run=true to preview the plan without persisting any changes — recommended for the first call against a new source.\n\nWave 13b: large or URL-sourced ingests run async — the response is { jobId, statusUrl } and you must poll ctx_ingest_status (or GET /api/ingest-jobs/:id) until status='succeeded' or 'failed' to read the breakdown. Small inline ingests still return the full result inline. Pass async=true to force the async path explicitly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source: {
          type: "object",
          description:
            "Raw material to ingest. Provide either url (fetched server-side, capped at 2 MB / 15 s) OR content (inline text). 'label' is a short human-readable identifier recorded on the activity log (defaults to the URL or 'inline').",
          properties: {
            url: {
              type: "string",
              description:
                "HTTP(S) URL to fetch and parse. HTML is stripped to plain text; markdown / plain text / JSON are passed through.",
            },
            content: {
              type: "string",
              description:
                "Inline source content (markdown, plain text, transcript). Use when the agent already has the document in memory.",
            },
            label: {
              type: "string",
              description:
                "Optional short label (filename, doc title, ticket ID) recorded on the audit log.",
            },
          },
        },
        workspace: {
          type: "string",
          description:
            "Workspace identifier the ingested claims belong to. Required for tenant + workspace scoped diff.",
        },
        project: {
          type: "string",
          description: "Optional project identifier within the workspace.",
        },
        dry_run: {
          type: "boolean",
          description:
            "When true, run the full extract + diff pipeline but skip every DB write (no create / update / archive / activity log). The response still lists what *would* happen so the agent can preview before committing. Default false.",
        },
        max_claims: {
          type: "number",
          description:
            "Cap on claims extracted from the source. Default 10, hard max 25. Lower this for noisy sources where you only want the top few facts.",
        },
        async: {
          type: "boolean",
          description:
            "Force the async path (true) or sync path (false). Omit to let the server auto-pick — URL sources and inputs with max_claims > INGEST_ASYNC_THRESHOLD (default 5) run async; everything else runs inline. Async responses are { jobId, statusUrl }; sync responses are the full IngestResult.",
        },
      },
      required: ["source", "workspace"],
    },
  },
  {
    name: "ctx_ingest_status",
    description:
      "Fetch the current status of an async background job. Generic poller (T497) — use this for the job id returned by ctx_ingest, ctx_remember, OR ctx_dream when any of them took the async path, until status='succeeded' or 'failed'. Returns counters (total_items, processed_items, failed_items), timestamps (created_at, started_at, completed_at), and on success the full result_summary (shape depends on which tool started the job: ctx_ingest/ctx_remember's created/updated/archived/skipped arrays, or ctx_dream's dream result).",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "number",
          description:
            "The job id returned by ctx_ingest, ctx_remember, or ctx_dream when the async path was taken.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "ctx_remember",
    description:
      "Extract durable memories from a raw multi-turn conversation and save them as deduped atomic contexts. Turn-aware sibling of ctx_ingest: the server builds a speaker-attributed transcript, extracts only durable facts/preferences via LLM (skipping chit-chat), and runs the claims through the SAME kNN-dedup + diff + create/update/archive pipeline ctx_ingest uses. Pass subjectId to scope memories to a single end-user of your application (Mem0-parity user_id) — dedup then only considers that subject's own prior memories, and every created context is tagged with that subjectId so ctx_search (subjectId param) and GET /api/memory can retrieve it later. Set dryRun=true to preview without persisting.\n\nLong conversations run async — the response is { jobId, statusUrl } and you must poll ctx_ingest_status (or GET /api/ingest-jobs/:id) until status='succeeded' or 'failed'. Short conversations return the full result inline. Pass async=true/false to force a path explicitly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                description: "Speaker role, e.g. 'user', 'assistant', 'system'.",
              },
              content: { type: "string", description: "Turn content." },
              name: {
                type: "string",
                description: "Optional speaker identifier (e.g. a specific agent name in a multi-agent transcript).",
              },
            },
            required: ["role", "content"],
          },
          description: "Conversation turns in chronological order.",
        },
        subjectId: {
          type: "string",
          description:
            "End-user identity this conversation belongs to (Mem0-parity user_id). Scopes dedup and tags every created context so it can be retrieved later via ctx_search subjectId or GET /api/memory.",
        },
        agentSlug: {
          type: "string",
          description: "Optional identifier of the agent that produced/consumed this conversation. Recorded as metadata only.",
        },
        workspace: {
          type: "string",
          description: "Workspace identifier the extracted memories belong to. Falls back to the request's active scope when omitted.",
        },
        project: {
          type: "string",
          description: "Optional project identifier within the workspace.",
        },
        sessionId: {
          type: "string",
          description: "Optional conversation/session identifier. Recorded as metadata and on the audit row only.",
        },
        dryRun: {
          type: "boolean",
          description: "When true, run the full extract + diff pipeline but skip every DB write. Default false.",
        },
        maxClaims: {
          type: "number",
          description: "Cap on claims extracted from the conversation. Default 10, hard max 25.",
        },
        async: {
          type: "boolean",
          description:
            "Force the async path (true) or sync path (false). Omit to let the server auto-pick — conversations longer than MEMORY_ASYNC_THRESHOLD messages (default 8) run async.",
        },
      },
      required: ["messages"],
    },
  },
  {
    name: "ctx_events_recent",
    description:
      "List the most recent context events (created / updated / archived / linked) from the in-memory ring buffer. Tenant-scoped — only events for the caller's tenant are returned. Useful for downstream agents that want to react to writes; the ring is capped at 200 envelopes server-side. Note: streaming subscriptions are HTTP-only via GET /api/events (Server-Sent Events) — MCP does not expose a streaming variant.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          enum: [
            "context.created",
            "context.updated",
            "context.archived",
            "context.linked",
          ],
          description:
            "Optional single-topic filter. Omit to receive every topic.",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 50, max 200).",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_memory_review_logs",
    description:
      "List recent memory-review verdicts (keep / retag / merge / archive / contradict / error). Each row records one LLM-judged review of a context during the periodic review-for-correctness ritual; verdicts are advisory unless 'archive' was auto-applied. Use this to audit what the reviewer has flagged and triage retag/merge/contradict candidates by hand. Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tenant_id: {
          type: "number",
          description: "Optional tenant ID filter. Omit to list across all tenants.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 100, max 500).",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_contradictions_list",
    description:
      "List contradictions detected by the proactive contradiction hunter (T360) for the caller's tenant. Each row is a high-similarity context pair the LLM classifier judged as disagreeing, with severity, rationale, whether the T352 dispute flip actually applied or was held by the T362 blast-radius gate, and (when applied) the context_links id. Complements ctx_link (which disputes explicitly) -- this surfaces disagreements the hunter found on its own. Resolve via the existing POST /api/contexts/:id/resolve-contradiction route (ctx_get the disputed context id first if unclear which side is 'target').",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace slug filter. Omit to use the active scope, or list across all workspaces if none is set.",
        },
        status: {
          type: "string",
          enum: ["open", "resolved", "dismissed"],
          description: "Filter by queue status (default 'open').",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 50, max 200).",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_admin_rate_limit_get",
    description:
      "Inspect the in-memory per-tenant rate-limit buckets. Returns one row per tenant currently tracked by the limiter (tenant_id, tenant_slug, tokens remaining, capacity, refill_per_min). The bucket map lives in process memory, so the snapshot reflects only the API instance that handled the request. Useful for ops triage when a tenant is reporting 429s. Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ctx_admin_rate_limit_set",
    description:
      "Override the per-tenant rate limit. Patches `tenants.settings.rate_limit` with the provided fields and invalidates the cached bucket so the new config takes effect on the tenant's next request. Defaults are 600 capacity / 600 refill per minute. At least one of capacity or refill_per_min must be provided. Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tenant_id: {
          type: "number",
          description: "Tenant ID to override.",
        },
        capacity: {
          type: "number",
          description: "Maximum tokens the bucket can hold (positive integer).",
        },
        refill_per_min: {
          type: "number",
          description: "Tokens added back per minute (positive number).",
        },
      },
      required: ["tenant_id"],
    },
  },
  {
    name: "ctx_memory_review_run",
    description:
      "Manually trigger a one-shot memory review pass for a tenant. Samples a handful of older + well-connected contexts (default 5, env MEMORY_REVIEW_SAMPLE_SIZE), asks the LLM to verdict each, and persists results to memory_review_logs. Returns a summary with per-verdict counters and how many archives were auto-applied (only when LLM confidence > 0.8). Useful for ad-hoc audits without waiting for the scheduler. Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tenant_id: {
          type: ["number", "null"],
          description:
            "Tenant to review. Pass null to review tenant-less contexts. Omit to default to the caller's tenant.",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_audit_cleanup_run",
    description:
      "Manually trigger one pass of the audit log retention cleaner. Deletes rows from activity_logs whose created_at is older than retention_days (capped at the AUDIT_LOG_RETENTION_DAYS env default when omitted; floor of 7 days is always enforced server-side to prevent nuking recent history). Single call deletes at most 5000 rows; rerun if more remain. Returns { deleted, retention_days }. Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        retention_days: {
          type: "number",
          description:
            "Override the env-configured retention window for this single run. Server enforces a minimum of 7 days. Omit to use AUDIT_LOG_RETENTION_DAYS (default 90).",
        },
      },
      required: [],
    },
  },
  {
    name: "ctx_health",
    description:
      "Run the deep health probe and return the full report. Probes DB, Elasticsearch, embedding provider, LLM provider, and scheduler states. 30-second in-memory cache on the server. Returns `{status, components, schedulers, queue}` - status is `ok|degraded|fail`. Useful for ad-hoc prod health checks from MCP clients.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ctx_audit_chain_status",
    description:
      "Verify the per-row sha256 chain of activity_logs. Returns `{ok: true, total_checked}` when intact, or `{ok: false, broken_at_id, total_checked}` when a row's prev_hash mismatches the previous row's row_hash. Accepts `prev_hash=''` as valid chain-restart genesis (see migration 0029 + PR #157). Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ctx_admin_queue_stats",
    description:
      "Inspect the in-process LLM job queue. Returns `{pending, running, completed, failed, rejected, capacity:{concurrency, maxPending}, enabled}`. Counters reflect a single API instance because the queue is in-process. Use after a burst of writes or 429s from a provider to confirm the queue is not saturated. Superadmin scope only.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  // -------------------------------------------------------------------------
  // Agent Memory Layer (runtime continuity). Call agent_boot at startup, then
  // checkpoint/tick/lesson as you work, then agent_handoff at the end. This is
  // the "A-Z non-stop, never forget" loop. See docs/design/agent-memory-layer.md
  // -------------------------------------------------------------------------
  {
    name: "agent_boot",
    description:
      "Boot an autonomous agent: ONE token-budgeted call returning everything needed to start or resume work. Call this FIRST in any agent run. Returns {agent, session:{...,role}, resume:{checkpoint_summary, open_tasks}, handoff:{tldr, source}, lessons:[], facts:[], brief, skills:[], skills_full, repo_map, siblings:[], budget:{limit, used, dropped}, client}. If a non-terminal session exists for this agent (or session_id is given), `resume` tells you exactly where you left off; `handoff` is the best-ranked latest handoff (a hand-written wrap SEED first). `goal` drives the facts, lessons AND skills retrieval. `skills` are parametrized procedures distilled from verified past runs matching the goal ({context_id, name, description, success_count, similarity}) -- check them BEFORE re-deriving a solution. On a session's later boots `skills` holds only new or changed entries and `skills_full` is false (empty then means nothing new, not no skills); pass `full:true` for the complete set. With `project_id` you also get a goal-graph `brief` {north_star, role, lane, next, blocked_on, blocking, done} and the session role is inferred from the matched goal node. With `include_repo_map:true` on a code-indexed workspace, `repo_map` carries top-ranked file signatures to answer \"where is X handled\" without grepping. `siblings` lists other active sessions in this workspace (last ~60 min, max 5) so you can coordinate via relay_* before touching shared resources. Slots fill resume > handoff > lessons > facts > brief; overflow is reported in budget.dropped. Trigger: resume or catch up on tracked work (\"hôm trước tới đâu\", \"tiếp gì\", \"tóm lại đang làm gì\", \"what's next\", \"resume\", \"where did we leave off\", \"catch me up\"). Skip for unrelated casual questions.",
    _meta: { "anthropic/alwaysLoad": true },
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Stable agent slug (handle the agent boots with every run, e.g. 'claude-code')" },
        agent_name: { type: "string", description: "Human-readable name; used only when the agent is first created" },
        goal: { type: "string", description: "The objective for this run — drives relevant-facts + lessons retrieval AND goal-node role inference" },
        workspace: { type: "string", description: "Workspace slug to scope handoff + facts to" },
        project_id: { type: "number", description: "Project id to scope the goal-graph situation brief + role inference to (omit = no brief, classic pack)" },
        token_budget: { type: "number", description: "Max tokens for the assembled pack (default 4000)" },
        session_id: { type: "number", description: "Resume a specific session by id (otherwise the latest active/paused session for this agent)" },
        include_repo_map: { type: "boolean", description: "When true, include a token-budgeted repo map (entries with path+signatures) from code-indexed contexts. Only useful for workspaces indexed with contextq index. Default false." },
        repo_map_token_budget: { type: "number", description: "Token cap for the repo map slot (default ~2000, range 100-16000). Ignored when include_repo_map is false." },
        epistemic_min: { type: "string", enum: ["observed", "told", "inferred", "assumed"], description: "Epistemic floor (T358) for the FACTS slot: only surface facts at or above this confidence tier (weakest->strongest: assumed < inferred < told < observed). Omit for no floor." },
        full: { type: "boolean", description: "T506: bypass the skills diff-since-last-boot behavior and always return the full current skills match set. Default false (repeat boots of the same session return only new/changed skills)." },
      },
      required: ["agent"],
    },
  },
  {
    name: "agent_session_start",
    description:
      "Start a new agent session (a run with a goal). Returns the created session including its id. Use when beginning a fresh task that you want to track and resume. Pass parent_session_id to chain a resumed run to its predecessor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Stable agent slug" },
        agent_name: { type: "string", description: "Human-readable name (used only on first creation)" },
        goal: { type: "string", description: "The A-Z objective for this run" },
        workspace: { type: "string", description: "Workspace slug this run operates in" },
        project: { type: "string", description: "Optional project slug within the workspace" },
        role: { type: "string", description: "Optional role this session plays (frontend, backend, design, ...). Usually inferred at boot from the matched goal node instead." },
        parent_session_id: { type: "number", description: "Id of the session this one resumes/continues" },
        metadata: { type: "object", description: "Arbitrary run metadata" },
      },
      required: ["agent"],
    },
  },
  {
    name: "agent_session_end",
    description:
      "End or update an agent session's status. Use status='completed' when the goal is met, 'paused' to suspend (resume later from the checkpoint), 'stalled' when the vibe-loop stall detector trips, or 'abandoned' to drop the run. Setting completed/abandoned stamps ended_at.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session id to update" },
        status: { type: "string", enum: ["active", "paused", "completed", "stalled", "abandoned"], description: "New session status" },
        goal: { type: "string", description: "Optionally revise the goal" },
        metadata: { type: "object", description: "Metadata to merge into the session" },
      },
      required: ["session_id", "status"],
    },
  },
  {
    name: "agent_checkpoint",
    description:
      "Snapshot the agent's working state so a restart/crash can resume from exactly here. `state` is an arbitrary JSON scratchpad (cursor, partial results, plan, open files). `summary` is a 1-line 'where I am'. Returns the checkpoint with its monotonic seq. Call periodically after each chunk of progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session id to checkpoint" },
        state: { type: "object", description: "Working-state scratchpad (arbitrary JSON)" },
        summary: { type: "string", description: "One-line human-readable 'where I am'" },
        token_estimate: { type: "number", description: "Optional explicit token size of the state (auto-estimated if omitted)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agent_context_pressure",
    description:
      "Advisory check: compares your estimated_tokens (and optionally turn_count) for this session against a server-side threshold and returns {should_checkpoint, reason, threshold}. Purely advisory — no server-side token accounting is kept, nothing is persisted. When should_checkpoint is true, call agent_checkpoint next to snapshot your working state before continuing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session id to evaluate" },
        estimated_tokens: { type: "number", description: "Your own estimate of accumulated context tokens for this run" },
        turn_count: { type: "number", description: "Optional: number of turns/steps taken so far this run" },
      },
      required: ["session_id", "estimated_tokens"],
    },
  },
  {
    name: "agent_resume",
    description:
      "Read the resume bundle for a session WITHOUT booting fresh: latest checkpoint, open tasks (pending/in_progress/blocked), and goal-relevant lessons. Use when you already know the session_id and just need to reload where you left off.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session id to resume" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agent_task_upsert",
    description:
      "Create or update one checklist item in a session's task tree. Omit task_id to create; pass task_id to update. `verify_cmd` names HOW the item is proven done (the agent must run it before ticking). Use parent_task_id for subtasks. This productizes the vibe goal-file checklist. Trigger: call at the START of a tracked piece of work to record a checklist item (session-scoped — for a task meant to persist across sessions use goal_add on the board instead). Only call when the work is actually being tracked; ignore unrelated casual chat.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session that owns this task" },
        task_id: { type: "number", description: "Existing task id to update (omit to create)" },
        parent_task_id: { type: "number", description: "Parent task id for a subtask" },
        title: { type: "string", description: "Task title (required when creating)" },
        status: { type: "string", enum: ["pending", "in_progress", "verified", "blocked", "skipped"], description: "Task status" },
        verify_cmd: { type: "string", description: "Command/observation that proves this task done" },
        order_index: { type: "number", description: "Ordering within the session" },
        context_id: { type: "number", description: "Optional id of the durable context this task produced" },
        goal_node_id: { type: "number", description: "Optional goal-graph node this task rolls up to (links session work to the project goal)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agent_task_tick",
    description:
      "Flip a task's status. Setting status='verified' REQUIRES non-empty `evidence` (real observed output: test result, HTTP status, exit code) — the no-self-certification rule. Returns 400 if you try to verify without evidence. Use this as each checklist item is proven. Trigger: user reports finishing a piece of tracked work (\"xong rồi\", \"xong X\", \"done X\", \"done\", \"mark done\", \"finished X\") — tick the matching session-scoped checklist item here (use goal_advance instead for a board-level task). Only call when it maps to a tracked item; ignore unrelated casual chatter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number", description: "Task id to tick" },
        status: { type: "string", enum: ["pending", "in_progress", "verified", "blocked", "skipped"], description: "New status" },
        evidence: { type: "string", description: "Real observed output proving the task (required to set 'verified')" },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "agent_lesson_add",
    description:
      "Record a lesson learned during a run so the agent doesn't repeat the failure. Embedded for goal-relevant recall at the next agent_boot. Mirrors the vibe-loop '## Lessons' log. scope controls breadth: 'session' (this run), 'agent' (this agent always), or 'workspace'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session this lesson came from" },
        what_failed: { type: "string", description: "What was attempted that failed" },
        why: { type: "string", description: "Why it failed" },
        try_instead: { type: "string", description: "What to do differently next time" },
        scope: { type: "string", enum: ["session", "agent", "workspace"], description: "How broadly the lesson applies (default 'session')" },
      },
      required: ["session_id", "what_failed"],
    },
  },
  {
    name: "agent_handoff",
    description:
      "Generate a handoff document for the session's workspace at run end (wraps the dream handoff generator — LLM-synthesized TL;DR + in-progress + next-steps + open-questions). Links the handoff context back to the session. Pass complete=true to also mark the session completed. Requires an LLM provider configured on the server.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session to generate a handoff for" },
        workspace: { type: "string", description: "Workspace slug (falls back to the session's workspace)" },
        project: { type: "string", description: "Optional project slug to narrow the handoff" },
        since_days: { type: "number", description: "Look-back window in days (default 7)" },
        dry_run: { type: "boolean", description: "Generate without persisting the handoff context" },
        complete: { type: "boolean", description: "Also set the session status to 'completed'" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agent_handoff_save",
    description:
      "Save a handoff note you wrote yourself, keyed on external_id so re-running UPDATES the same entry instead of forking a duplicate. Unlike agent_handoff this needs no LLM provider and no agent session — use it when the handoff text already exists and must be persisted verbatim. Trigger: \"wrap up\", \"save the handoff\", \"chốt session\", \"ghi handoff\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        external_id: {
          type: "string",
          description: "Stable identifier for this handoff; re-using it updates the same entry",
        },
        title: { type: "string", description: "Short title, e.g. \"handoff: <repo> <date>\"" },
        body: {
          type: "string",
          description: "Full handoff text: decisions, in-progress work, next steps",
        },
        description: { type: "string", description: "One-line summary used for search ranking" },
        workspace: {
          type: "string",
          description: "Workspace slug to write into; defaults to the active scope, then GLOBAL",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and filtering",
        },
        metadata: { type: "object", description: "Arbitrary key-value metadata" },
        project: {
          type: "string",
          description:
            "Project identifier this handoff belongs to. Sets the indexed `project` column that ctx_list and ctx_search filter on -- pass it, or the row is only findable by full-corpus search.",
        },
        memoryKind: {
          type: "string",
          enum: [...MEMORY_KIND_ENUM],
          description:
            "Taxonomy override. Omit to let the backend classify it from the 'handoff' type.",
        },
      },
      required: ["external_id", "title", "body"],
    },
  },
  {
    name: "agent_replay",
    description:
      "Reconstruct the ordered tool-call sequence for a session (T375 episodic trace). Every tool call this MCP bridge makes is logged fire-and-forget with a one-line LLM-compressed summary; agent_replay returns them in order (seq, tool_name, args, result, duration_ms, summary), optionally bounded to [from_seq, to_seq]. Use this to answer 'what did I actually do in this session' — checkpoints and lessons are lossy summaries, this is the full record. Also feeds ctx_search when include_trace_events is set on a search request ('what did I try before this worked?').",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session id to replay" },
        from_seq: { type: "number", description: "First seq to include (default 1)" },
        to_seq: { type: "number", description: "Last seq to include (default: latest)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agent_skill_suggest",
    description:
      "Find already-distilled, parametrized procedures matching a goal (T376). A scheduled job clusters repeated, independently-verified agent_task successes (by goal similarity + tool-call-sequence shingling) into type='procedure' contexts with literal args lifted to {{placeholders}} and lineage back to their source sessions/tasks. Returns {suggestions:[{context_id, name, description, success_count, similarity}]} — fetch the full procedure with ctx_get(context_id) before starting work on a matching goal, instead of re-deriving a solution from scratch. `similarity` is null when no embedding provider is configured (fallback ranks by success_count/recency instead of semantic match). Also surfaced proactively in agent_boot's `skills` slot — call this directly when you want to re-check mid-run or narrow to a specific workspace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        goal: { type: "string", description: "The objective to find a matching distilled procedure for" },
        workspace: { type: "string", description: "Optional workspace slug to scope suggestions to" },
        limit: { type: "number", description: "Max suggestions to return (default 3, max 10)" },
      },
      required: ["goal"],
    },
  },
  {
    name: "agent_identity_attest",
    description:
      "Record a model-upgrade for an agent's durable identity (T373). Call this whenever the model backing an agent is swapped (e.g. moving to a newer Claude release) so continuity is provable: appends one hash-chained transition to identity_transitions, linked to the previous transition's row_hash (or '' for the first-ever transition on this identity). Also snapshots a sha256 hash of the REAL agent_boot payload immediately before and after the swap (bootpack_hash_before/after) — an unchanged hash proves memory survived the swap intact. Returns {identity, transition}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Stable agent slug whose identity is being attested" },
        agent_name: { type: "string", description: "Human-readable name; used only when the agent is first created" },
        workspace: { type: "string", description: "Workspace slug used to assemble the before/after boot-pack snapshot" },
        new_model_id: { type: "string", description: "The model id now running this agent (e.g. 'claude-sonnet-5-...')" },
      },
      required: ["agent", "new_model_id"],
    },
  },
  {
    name: "agent_identity_verify",
    description:
      "Walk an agent's identity_transitions chain from genesis (seq=1) to the latest transition, verifying every prev_hash links to the previous row's row_hash AND every row_hash matches a fresh recompute from current content. Returns {ok:true, total_checked, last_seq} when intact, or {ok:false, broken_at_seq, total_checked, last_seq, reason:'chain_broken'|'row_hash_mismatch'} on the first failure. Use this to prove an agent's identity continuity across any number of model swaps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Stable agent slug whose identity chain to verify" },
      },
      required: ["agent"],
    },
  },
  {
    name: "agent_intention_set",
    description:
      "Set a prospective memory intention (T374) — 'remember to remember'. Stores a future trigger paired with a payload context to resurface once it fires. trigger_type='event' fires when a matching action/resource is logged (synchronously, off every activity_logs write); 'condition' is evaluated on a periodic poll (currently supports kind='context_count_gte'); 'time' fires at/after a timestamp. When the trigger matches, the payload context surfaces in the NEXT matching agent_boot's push slot with reason='prospective_trigger' — a guaranteed delivery, not a relevance-gated suggestion. Pass agent to scope delivery to one agent's boots only (omit for any agent in the tenant). Pass expires_at so a stale intention never fires past its window. Returns the created intention row.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Scope delivery to one agent's boots only (omit = any agent in the tenant)" },
        trigger_type: { type: "string", enum: ["event", "condition", "time"], description: "How this intention fires" },
        trigger_spec: {
          type: "object",
          description:
            "Trigger definition; shape depends on trigger_type. event: {action?, actionPrefix?, resourceContains?} (at least one of action/actionPrefix required) — matched (AND semantics) against every logged activity's action/resource. condition: {kind:'context_count_gte', workspace?, count} — polled periodically. time: {fireAt: ISO datetime string} — fires at/after this timestamp.",
        },
        payload_context_id: { type: "number", description: "The context id to resurface once the trigger fires" },
        reason: { type: "string", description: "Why this intention exists (human-readable, shown in the audit trail)" },
        expires_at: { type: "string", description: "ISO datetime after which this intention never fires (optional)" },
      },
      required: ["trigger_type", "trigger_spec", "payload_context_id"],
    },
  },
  {
    name: "agent_intention_list",
    description:
      "List prospective memory intentions for this tenant, optionally filtered by agent slug (scope) or status (active|fired|delivered|expired|cancelled).",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Filter to intentions scoped to this agent slug" },
        status: { type: "string", enum: ["active", "fired", "delivered", "expired", "cancelled"], description: "Filter by status" },
      },
      required: [],
    },
  },
  {
    name: "agent_intention_cancel",
    description:
      "Cancel a prospective memory intention before it fires. Only succeeds while the intention is still 'active' — returns 404 if it doesn't exist or has already fired/delivered/expired/been cancelled.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intention_id: { type: "number", description: "Intention id to cancel" },
      },
      required: ["intention_id"],
    },
  },

  // -------------------------------------------------------------------------
  // Session working scope (team-mode Phase 1). Select the active workspace +
  // project once, then subsequent reads default to it and writes resolve their
  // target from it. Clearing scope (workspace=null) returns to ALL workspaces.
  // -------------------------------------------------------------------------
  {
    name: "ctx_use",
    description:
      "Select the active working scope (workspace + optional project) for this session/key. Subsequent reads default to this scope; writes resolve their target from it. Pass workspace=null (or omit) to clear back to ALL workspaces. Returns the resolved {workspace, project, persisted}. This is 'select the project/context to work with'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: { type: "string", description: "Workspace slug to scope to. Omit or null = ALL workspaces." },
        project: { type: "string", description: "Optional project slug within the workspace." },
      },
      required: [],
    },
  },
  {
    name: "ctx_scope",
    description:
      "Show the current active working scope (workspace + project) for this session/key, or 'ALL workspaces' when nothing is selected. Returns {workspace, project}.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  // --- Goal graph (team-mode Phase 2) ---
  {
    name: "goal_set_objective",
    description:
      "Set (or fetch) the north-star objective for a project — the root of the goal graph everything hangs off. Returns the kind='objective' node, which carries an `objective_run_id` — a run id lazily assigned once and then shared by every subsequent goal_add/goal_advance/goal_link_dep/goal_decompose/goal_import/goal_sync mutation under this objective. Query activity_logs (or goal_list/goal_frontier with objective_run_id) by that value to reconstruct this objective's whole activity story, the same way Claude Code's workflow.run_id reconstructs one workflow run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "number", description: "Project id the goal graph belongs to (optional — omit for a workspace-level graph)" },
        title: { type: "string", description: "The objective / north-star statement" },
        why: { type: "string", description: "Optional rationale (stored as the node's context)" },
      },
      required: ["title"],
    },
  },
  {
    name: "goal_add",
    description:
      "Add a node to the goal graph. Progressive elaboration: only title is required -- omit parent_id to create a root node (a vague node is created status='draft'); fill the rest as reality reveals it. kind: objective|milestone|goal|work_item|relay. owner_role/status/origin are free strings. Trigger: when a user (including a non-technical one) asks you to remember or hand off a piece of work for later (\"thêm việc\", \"thêm task\", \"todo\", \"add a task\", \"add to the board\"), create a node here with a valid status (draft is fine if details are vague) — this is how a casual request becomes a durable tracked task. Only call when the request is genuinely about work to track; ignore unrelated casual questions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "number", description: "Project id (optional)" },
        parent_id: { type: "number", description: "Parent node id (containment tree; null/omit for a root)" },
        title: { type: "string", description: "Node title (the only hard requirement)" },
        kind: { type: "string", description: "objective|milestone|goal|work_item|relay (default work_item)" },
        owner_role: { type: "string", description: "Role that owns this node (e.g. frontend, backend, design)" },
        status: { type: "string", description: "draft|not_started|ready|in_progress|blocked|done|superseded" },
        origin: { type: "string", description: "greenfield|leverage|migrate|unknown" },
        size: { type: "string", description: "S|M|L|XL" },
        effort_weeks: { type: "number", description: "Estimated effort in weeks" },
        target_weeks: { type: "number", description: "Milestone target (weeks)" },
        verify_cmd: { type: "string", description: "How a leaf is proven done" },
        external_ref: { type: "object", description: "External tracker ref, e.g. {jira: 'FIP-123'}" },
        content: { type: "string", description: "Long description (creates a searchable contexts row)" },
        do: { type: "string", description: "One-sentence work order (stored as payload.do)" },
        session_id: { type: "number", description: "Your agent session id, recorded on the node's history row" },
        brief: {
          type: "object",
          description: "Cold-executor brief: all six keys or omit (a partial brief is rejected). A work_item added without one gets a `hint` with the template.",
          properties: {
            intent: { type: "string" },
            decisions: { type: "string" },
            pointers: { type: "string" },
            rejected: { type: "string" },
            doneWhen: { type: "string" },
            gotchas: { type: "string" },
          },
          required: ["intent", "decisions", "pointers", "rejected", "doneWhen", "gotchas"],
        },
      },
      required: ["title"],
    },
  },
  {
    name: "goal_link_dep",
    description:
      "Create a dependency edge between two goal nodes (the DAG that cuts across the containment tree). kind='blocks' (from blocks to) or 'informs'. Rejected with a cycle error if it would make the graph cyclic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from_node_id: { type: "number", description: "Source node id" },
        to_node_id: { type: "number", description: "Target node id" },
        kind: { type: "string", description: "blocks|informs (default blocks)" },
      },
      required: ["from_node_id", "to_node_id"],
    },
  },
  {
    name: "goal_advance",
    description:
      "Advance a node's status. A leaf moving to 'done' REQUIRES non-empty evidence (real observed output) — the no-self-certification rule. Parent status rolls up automatically from children. Trigger: when the user reports finishing a tracked piece of work (\"xong rồi\", \"xong X\", \"done X\", \"done\", \"mark done\", \"finished X\"), advance the matching board node's status here. Only call when the report maps to a tracked board item; ignore unrelated casual chatter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_id: { type: "number", description: "Node id to advance" },
        status: { type: "string", description: "New status (draft|not_started|ready|in_progress|blocked|done|superseded). Always required: to edit a field below WITHOUT a status change, pass the node's CURRENT status." },
        evidence: { type: "string", description: "Real observed output proving the node (required for a leaf -> done)" },
        title: { type: "string", description: "Rename the node (manifest task title)" },
        verify_cmd: { type: "string", description: "Replace the node's done-when text (manifest `done-when:`). Whole-value replace, max 2000 chars." },
        payload: { type: "object", description: "Shallow-merged into the node's payload; `{\"do\": \"<text>\"}` is the manifest `do:` line. Keys not named here survive." },
        external_ref: { type: "object", description: "Shallow-merged into the node's externalRef. Never trusted as a security predicate." },
        order_index: { type: "number", description: "Manifest position" },
        note: {
          type: "object",
          description: "Named annotation kept under payload.notes, e.g. {name: \"rechecked-2026-09-27\", text: \"...\"}",
          properties: { name: { type: "string" }, text: { type: "string" } },
          required: ["name", "text"],
        },
        session_id: { type: "number", description: "Your agent session id, recorded on the node's history row" },
      },
      required: ["node_id", "status"],
    },
  },
  {
    name: "agent_run_start",
    description:
      "Open a fan-out RUN and mint the id every agent in it shares. The ORCHESTRATOR calls this once before spawning, then pastes the returned run_id into each agent's prompt alongside the other pinned contracts. Registering the run is what lets an empty findings read mean \"nobody has found anything yet\" instead of \"you were left out\". Idempotent: re-opening the same id returns the existing record.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string", description: "Reuse a specific id. Omit to have one minted." },
        label: { type: "string", description: "What this fan-out is doing, for a human reading the runs later" },
        session_id: { type: "number", description: "The orchestrator's own session id, recorded as the opener" },
      },
      required: [],
    },
  },
  {
    name: "agent_finding_add",
    description:
      "Record something you learned so the OTHER agents in this fan-out can use it before you finish. Use it the moment you discover a non-obvious behaviour, a wrong turn you ruled out, or a gotcha that cost you time -- not at the end, which is what the handoff is for. A finding is one claim plus the evidence for it, never a session summary. Check `run_known` in the response: false means the run id you were given was never opened, so nobody will read this -- say so rather than continuing quietly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string", description: "The run every agent in this fan-out shares, as given in your prompt" },
        session_id: { type: "number", description: "Your agent session id" },
        title: { type: "string", description: "The claim, in one line" },
        body: { type: "string", description: "What you actually observed, and where" },
        workspace: { type: "string", description: "Workspace slug to write into (required -- findings must not default into GLOBAL)" },
      },
      required: ["run_id", "session_id", "title", "body", "workspace"],
    },
  },
  {
    name: "agent_finding_list",
    description:
      "Read what your SIBLING agents have learned so far in this run, newest first. Call it before starting a sub-task and after any surprise, so you do not re-discover what another agent already paid for. Reads exactly, not by search, so a finding written seconds ago is already visible. Pass your own session_id as exclude_session_id to drop the echo of your own writes. An empty list means two different things and `run_known` tells them apart: true = nobody has found anything yet, carry on; false = the run id you hold was never opened, so your own findings reach no one -- report that instead of working on silently.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string", description: "The run to read" },
        exclude_session_id: { type: "number", description: "Your own session id, to see only what siblings found" },
        limit: { type: "number", description: "Max findings to return (default 20, max 100)" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "goal_claim",
    description:
      "Atomically claim a work-item node for your session, so two agents on DIFFERENT MACHINES cannot pick up the same task. Losing is a normal answer, not an error: the response is {claimed:false, heldBy:<session id>} naming who holds it — act on that, do not retry. Use before starting work on a node from goal_frontier when other agents may be running. Release with goal_release when you stop.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Node id to claim" },
        session_id: { type: "number", description: "Your agent session id (from agent_boot / agent_session_start)" },
      },
      required: ["id", "session_id"],
    },
  },
  {
    name: "goal_release",
    description:
      "Release a claim your session holds on a node, freeing it for another agent. Conditional on you being the holder: releasing a node you do not hold reports {released:false} rather than failing, and never takes someone else's claim away. Call it when you stop work on a node you did not finish.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Node id to release" },
        session_id: { type: "number", description: "Your agent session id — must be the one holding the claim" },
      },
      required: ["id", "session_id"],
    },
  },
  {
    name: "goal_import",
    description:
      "Bulk-import an existing backlog (CSV, e.g. a Jira export) into a living goal tree: parses to nodes, builds the containment tree from epic/phase columns, maps roles from issue type/assignee, and INFERS implicit cross-role dependencies (e.g. an FE task that needs a BE task). Tolerates messy data. Returns {created, deps, nodes}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "number", description: "Project id to import into (optional)" },
        csv: { type: "string", description: "Raw CSV content" },
        role_map: { type: "object", description: "Assignee -> role map, e.g. {Nghia:'frontend', Nguyen:'backend'}" },
      },
      required: ["csv"],
    },
  },
  {
    name: "goal_decompose",
    description:
      "LLM-expand a goal node into child nodes + dependencies, self-checked by a judge before writing (no garbage on fail). `size` is an ADVISORY granularity hint for the LLM only (small=coarse/fewer children, medium=default/today's behavior, large=fine-grained/more children) — never a hard count enforced by the judge, since decomposition quality beats an exact node count. Returns {proposed, applied, reason, objective_run_id} — applied children share the parent objective's run id (lazily assigned on first decompose if the objective predates run-id tagging). If no LLM is configured returns applied=false, reason='llm_not_configured' (never errors).",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_id: { type: "number", description: "Node to decompose" },
        available_roles: { type: "array", items: { type: "string" }, description: "Roles the plan may assign work to" },
        size: { type: "string", description: "Advisory decomposition granularity: small|medium|large (default medium)" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "goal_list",
    description:
      "List goal nodes, filtered. Use to read the graph (your lane, a status column, all milestones, or one objective's whole run via objective_run_id). Returns a COMPACT view by default (id, title, status, kind, externalRef.local_id/priority, blocked, depsIn/depsOut) and omits done nodes unless include_done is true or a status filter is given; call goal_get for one node's full payload, or pass view=\"full\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "number", description: "Filter by project" },
        owner_role: { type: "string", description: "Filter by owning role" },
        status: { type: "string", description: "Filter by status" },
        kind: { type: "string", description: "Filter by kind" },
        objective_run_id: { type: "string", description: "Filter to nodes stamped with one objective's run id (from goal_set_objective/goal_get/goal_decompose)" },
        view: { type: "string", enum: ["compact", "full"], description: "compact (default) drops payload and brief; full returns every field" },
        include_done: { type: "boolean", description: "Include done nodes (default false)" },
      },
      required: [],
    },
  },
  {
    name: "goal_get",
    description:
      "Get one goal node with its why-path (walk up to the objective) and its in/out dependency edges. Returns {node, why_path, deps_in, deps_out, duplicates} — `duplicates` lists tombstones merged into this node (externalRef.duplicate_of = its local_id); `node.objective_run_id` (and the objective's own entry in why_path) identifies the run whose activity_logs tell this node's whole objective story.",
    inputSchema: {
      type: "object" as const,
      properties: { node_id: { type: "number", description: "Node id" } },
      required: ["node_id"],
    },
  },
  {
    name: "goal_frontier",
    description:
      "The ready-frontier: nodes (optionally for a role, or scoped to one objective_run_id) whose ALL blocking dependencies are done and that aren't done yet — i.e. 'what can I start NOW'. Returns GoalNode[] with depsIn/depsOut ([{nodeId, kind}]). A node whose externalRef.blocker is set is waiting on a person or an external event, not on a dependency: treat it as not runnable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "number", description: "Filter by project" },
        objective_run_id: { type: "string", description: "Scope to one objective's run id" },
        owner_role: { type: "string", description: "Filter to a role's ready work" },
      },
      required: [],
    },
  },
  // --- Directed relays (team-mode Phase 2) ---
  {
    name: "relay_open",
    description:
      "Open a directed relay (a baton from one role to another, e.g. FE -> BE for an API contract). Built-in kinds: api_contract (frontend->backend), design_handoff (design->frontend); or pass from_role/to_role explicitly. Any role/agent name works immediately, no prior registration or setup call needed -- an unseen role is addressable on its very first relay_open. Born status='open', unclaimed. If your runtime supports cross-session messaging (e.g. Claude Code's ListAgents/SendMessage), consider pinging a plausibly-matching local session right after opening -- relay_inbox stays the source of truth, the ping is just a real-time nudge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        relay_kind: { type: "string", description: "api_contract | design_handoff (fills from/to role)" },
        from_role: { type: "string", description: "Originating role (overrides relay_kind)" },
        to_role: { type: "string", description: "Addressed role (overrides relay_kind)" },
        title: { type: "string", description: "What's being handed off" },
        project_id: { type: "number", description: "Project id (optional)" },
        parent_id: { type: "number", description: "The work item this relay hangs off (optional)" },
        payload: { type: "object", description: "Structured handoff payload per the kind's schema" },
      },
      required: ["title"],
    },
  },
  {
    name: "relay_inbox",
    description:
      "List relays addressed to a role (your inbox). status='open' by default; include_all=true also shows claimed relays (in progress by another session). Returns GoalNode[] (kind='relay').",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: { type: "string", description: "The to_role whose inbox to read" },
        project_id: { type: "number", description: "Filter by project" },
        include_all: { type: "boolean", description: "Also include claimed relays (default false)" },
      },
      required: ["role"],
    },
  },
  {
    name: "relay_get",
    description:
      "Fetch one directed cross-role relay/handoff (a baton passed between roles, e.g. frontend to backend) by id. Returns the kind='relay' GoalNode with its status, payload, and claim state. Use once you already have a relay id from relay_open or relay_inbox and want its full detail.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "number", description: "Relay id" } },
      required: ["id"],
    },
  },
  {
    name: "relay_claim",
    description:
      "Claim a relay (atomic, first-write-wins). If already claimed, returns claimed=false with heldBy=<session id> so you skip it (no double-work). Returns {relay, claimed, heldBy}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Relay id to claim" },
        session_id: { type: "number", description: "Your session id (the current baton holder)" },
      },
      required: ["id", "session_id"],
    },
  },
  {
    name: "relay_advance",
    description:
      "Advance a relay's lifecycle: open -> claimed -> delivered -> verified -> closed (delivered -> claimed = kickback). 'verified' REQUIRES evidence. Illegal transitions are rejected. Pass session_id to enable the identity-reuse guard: if a DIFFERENT attested agent identity now holds this session than the one that claimed the relay, the advance is flagged (default, response + audit log) or rejected with a retarget error (RELAY_IDENTITY_GUARD_MODE=strict). Omit session_id to skip the guard entirely.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Relay id" },
        status: { type: "string", description: "Target status" },
        evidence: { type: "string", description: "Real observed output (required for -> verified)" },
        session_id: {
          type: "number",
          description: "Your session id -- enables the identity-reuse guard against the identity that claimed this relay",
        },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "relay_nudge",
    description:
      "Nudge a stuck 'claimed' relay to wake the holder (only 'claimed' relays can be nudged). Increments a per-relay nudge count; once it reaches the tenant's threshold (default 3), the same call auto-releases the claim back to status='open' so another session can pick it up. Returns {relay, released, nudgeCount, threshold}. If your runtime supports cross-session messaging and the holder's session is locally reachable, send it a native ping alongside this call for a real-time wake instead of waiting on its next poll.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Relay id to nudge" },
        session_id: { type: "number", description: "Your session id (recorded as the nudger, optional)" },
        reason: { type: "string", description: "Why you're nudging it (optional, for the audit trail)" },
      },
      required: ["id"],
    },
  },
  {
    name: "ctx_web_search",
    description:
      "Search the web through a configured provider (Tavily, Brave, or Serper). Use this when you need to look up current information online, find documentation for a live service, or search the internet for facts not in your training data. Tenant-scoped and gated behind WEB_SEARCH_ENABLED plus an active search credential. Optionally pipe results through ctx_ingest to persist them as knowledge base entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query string (1-2000 chars)" },
        maxResults: {
          type: "number",
          description: "Max results to return (1-20, default 5)",
        },
        ingest: {
          type: "boolean",
          description: "If true, pipe each result through the ingest pipeline to persist as knowledge base entries (best-effort, default false)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ctx_feedback",
    description:
      "Record a helpful/unhelpful verdict on a context that was returned by ctx_search (or POST /api/retrieve), closing the recall loop back into ranking. Pass the retrieval trace id from ctx_explain_recall (or from a search response's trace metadata) to join the verdict to the exact score breakdown it is about -- omit it if you don't have one, the verdict still records. Verdicts accumulate into a per-context, per-tenant adjustment (bounded by a small cap so no single client can reshape ranking) that folds into the T345 salience/reinforcement term the next time this context is retrieved. Tenant-scoped: a contextId or retrievalTraceId belonging to another tenant is silently dropped rather than accepted.",
    inputSchema: {
      type: "object" as const,
      properties: {
        contextId: { type: "number", description: "The context id this verdict is about" },
        used: { type: "boolean", description: "true = the recalled context was actually useful/relevant; false = it was returned but not helpful" },
        retrievalTraceId: {
          type: "number",
          description: "Optional -- the retrieval_traces row id (from ctx_explain_recall or a search trace, NOT the 32-hex trace_id sidecar) this verdict is joined to.",
        },
        sessionId: { type: "number", description: "Optional agent session id, for forensic correlation" },
        source: { type: "string", description: "Optional harness tag (e.g. 'agent-boot', 'manual', 'eval'), max 32 chars" },
      },
      required: ["contextId", "used"],
    },
  },
  // --- World-model snapshots + forkable sandboxes (T378) ---
  {
    name: "ctx_snapshot_create",
    description:
      "Take a content-addressed snapshot of a workspace's memory state (contexts, context_links, and its goal graph) at this moment. Returns {id, manifestHash, sourceWorkspaceId, ...} -- the snapshot id feeds ctx_fork_world for counterfactual replay or safe memory-surgery testing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: { type: "string", description: "Workspace slug to snapshot" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "ctx_fork_world",
    description:
      "Fork a throwaway SANDBOX workspace cloned from a snapshot (or a fresh snapshot of `workspace` taken on the fly). Mutate memory inside the sandbox freely -- production rows are never touched. Sandboxes are quota-capped per tenant and auto-expire after ttl_minutes (default from WORLD_SANDBOX_TTL_MINUTES). Returns {sandboxWorkspaceSlug, snapshotId, expiresAt, clonedCounts}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        snapshot_id: { type: "number", description: "Fork from an existing snapshot id" },
        workspace: { type: "string", description: "Or: take a fresh snapshot of this workspace slug and fork it" },
        ttl_minutes: { type: "number", description: "Sandbox lifetime in minutes (0 = no expiry; default from WORLD_SANDBOX_TTL_MINUTES)" },
      },
      required: [],
    },
  },
  {
    name: "ctx_diff_world",
    description:
      "Diff a sandbox workspace's CURRENT rows against the snapshot it was forked from -- added/modified/removed/unchanged contexts, plus coarse counts for context_links and the goal graph. Use before deciding whether to apply a sandbox experiment's changes back to production (there is no auto-merge -- replay the accepted changes yourself, then ctx_discard_sandbox).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sandbox_workspace: { type: "string", description: "Sandbox workspace slug (returned by ctx_fork_world)" },
      },
      required: ["sandbox_workspace"],
    },
  },
  {
    name: "ctx_discard_sandbox",
    description:
      "Hard-delete a sandbox workspace and everything in it (contexts, links, cloned goal nodes/deps). Irreversible. Sandboxes past their TTL are also swept automatically by a background job.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sandbox_workspace: { type: "string", description: "Sandbox workspace slug to discard" },
      },
      required: ["sandbox_workspace"],
    },
  },
  // --- T668: tool-profile discovery (always present, in every profile) ---
  {
    name: "ctx_tool_groups",
    description:
      "List additional groups of ContextQ tools not loaded in this session by default -- code-graph lookup, admin/audit, relay handoff, world-model snapshots, saved searches, knowledge-graph traversal, bulk import/ingest, and more. Search here first if a ContextQ tool you expect (a saved search, a relay, a snapshot, a code reference) is missing from your current tool list. Returns each group's name, one-line purpose, member tool names, and how many of them are already loaded, plus how to load a group with ctx_load_tool_group.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ctx_load_tool_group",
    description:
      "Load one additional group of ContextQ tools into this session (group names come from ctx_tool_groups) so they become callable without reconnecting. Pass \"all\" to load every remaining ContextQ tool at once. Some MCP clients need to refresh their tool list to actually see newly loaded tools in the model's context -- if a loaded tool still doesn't show up, call it directly by name anyway (ContextQ accepts a tool call for any known tool name regardless of what tools/list currently returns), or restart this server with the environment variable CONTEXT_MCP_TOOL_PROFILE=full to get every tool from the start.",
    inputSchema: {
      type: "object" as const,
      properties: {
        group: {
          type: "string",
          description:
            "Group name from ctx_tool_groups (e.g. \"pkm\", \"admin\", \"relay\", \"knowledge-graph\"), or \"all\" to load every remaining ContextQ tool.",
        },
      },
      required: ["group"],
      additionalProperties: false,
    },
  },
  {
    name: "ctx_workspace_list",
    description:
      "List the workspaces this credential can write to (id, slug, name, context count, archived flag). Call this before ctx_workspace_ensure to check whether this project already has a workspace. Trigger: \"which workspaces do I have\", \"list workspaces\", \"set up ContextQ here\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        includeArchived: {
          type: "boolean",
          description: "Include archived workspaces in the result (default false)",
        },
      },
    },
  },
  {
    name: "ctx_workspace_ensure",
    description:
      "Idempotently get-or-create a workspace for this tenant: returns the existing one (created=false) or creates it (created=true). Safe to call repeatedly. The returned `slug` MAY DIFFER from the one you asked for — workspace slugs are globally unique, so a taken base gets a random suffix. Always persist the slug from the response and use THAT for every later call. Trigger: first-time project setup, \"set up ContextQ for this repo\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Display name for the workspace, e.g. the repository name",
        },
        slug: {
          type: "string",
          description:
            "Preferred slug, used only to look up an already-existing workspace. A newly created workspace derives its slug from `name`, so it can come back different.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "ctx_project_ensure",
    description:
      "Idempotently get-or-create a project inside a workspace, matched on (workspace, slug). Returns the existing project or a new one. Call after ctx_workspace_ensure, passing the slug that call returned. Trigger: first-time project setup.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: { type: "string", description: "Slug of the workspace that owns the project" },
        name: { type: "string", description: "Display name (defaults to the workspace slug)" },
        slug: {
          type: "string",
          description: "Project slug; defaults to the slugified name, then to the workspace slug",
        },
      },
      required: ["workspace"],
    },
  },
];

// ---------------------------------------------------------------------------
// T668: default/extended tool-profile split for the stdio transport.
//
// docs/product/mcp-host-capability-survey.md (T608) measured the full
// tools/list payload at ~19,844 chars/4-heuristic tokens for the (then) 87
// tools -- above the audit script's own 15,000-token budget -- and found
// that only Claude Code is insulated from that cost (client-side ToolSearch
// deferral); codex, opencode, goose, gemini-cli, and Cursor pay the full
// amount on every connection with no client-side mitigation documented.
// This mirrors the pattern already proven on the Streamable HTTP transport
// (MCP_HTTP_TOOL_PROFILE in src/plugins/mcp.ts): a small, always-loaded
// DEFAULT profile, plus the long tail organized into named TOOL_GROUPS that
// stay reachable via ctx_load_tool_group, or in full via
// CONTEXT_MCP_TOOL_PROFILE=full.
//
// `tools/call` (handleToolCall below) dispatches on the `handlers` map by
// name and never checks the active profile -- ANY known tool is callable
// regardless of what tools/list last returned, so a host that doesn't
// refresh its tool list after notifications/tools/list_changed (or doesn't
// support that notification at all) still works once the model is told the
// tool's exact name, e.g. by ctx_tool_groups.
// ---------------------------------------------------------------------------

export interface ToolGroup {
  description: string;
  tools: string[];
}

// Every tool NOT in DEFAULT_PROFILE_TOOL_NAMES must appear in exactly one
// group here -- enforced by an exhaustiveness check in
// tools.profile.test.ts, so a newly added tool can't silently fall out of
// both the default profile and every group's reach.
export const TOOL_GROUPS: Record<string, ToolGroup> = {
  "search-advanced": {
    description: "Explainable-recall score breakdowns, live web search, and recall-loop feedback beyond the default ctx_search.",
    tools: ["ctx_explain_recall", "ctx_web_search", "ctx_feedback"],
  },
  "crud-advanced": {
    description: "Bulk updates, archive-undo, and per-entry usage/scope tracking beyond the default single-entry CRUD.",
    tools: ["ctx_bulk_update", "ctx_undo_archive", "ctx_undo_archive_info", "ctx_use", "ctx_scope"],
  },
  ingest: {
    description: "Bulk document/URL import and raw ingest-job status.",
    tools: ["ctx_import", "ctx_ingest", "ctx_ingest_status"],
  },
  pkm: {
    description: "Personal-knowledge-management synthesis: dream runs, context linking, evolution, chunk inspection, and maps-of-content.",
    tools: ["ctx_dream", "ctx_link", "ctx_links", "ctx_evolve", "ctx_chunks", "ctx_mocs", "ctx_regenerate_mocs", "ctx_maps"],
  },
  code: {
    description: "Code-graph reference lookup and call-trace queries for code-indexed contexts.",
    tools: ["ctx_code_refs", "ctx_code_trace"],
  },
  "knowledge-graph": {
    description: "Provenance, confidence, belief history, blast-radius, entity, and contradiction traversal over the knowledge graph.",
    tools: [
      "ctx_provenance_get",
      "ctx_confidence_get",
      "ctx_belief_history",
      "ctx_blast_radius",
      "ctx_graph_search",
      "ctx_entity_get",
      "ctx_contradictions_list",
    ],
  },
  "saved-searches": {
    description: "CRUD and manual/scheduled run of saved/recurring searches.",
    tools: [
      "ctx_saved_searches_list",
      "ctx_saved_searches_create",
      "ctx_saved_searches_get",
      "ctx_saved_searches_update",
      "ctx_saved_searches_delete",
      "ctx_saved_searches_run",
      "ctx_run_saved_search",
    ],
  },
  admin: {
    description: "Operational/admin tools: recent-events feed, memory-review logs and runs, rate limits, audit cleanup/chain status, queue stats.",
    tools: [
      "ctx_events_recent",
      "ctx_memory_review_logs",
      "ctx_admin_rate_limit_get",
      "ctx_admin_rate_limit_set",
      "ctx_memory_review_run",
      "ctx_audit_cleanup_run",
      "ctx_audit_chain_status",
      "ctx_admin_queue_stats",
    ],
  },
  "agent-advanced": {
    description: "Context-pressure checks, episodic tool-call replay, procedural skill suggestions, identity attestation, intention tracking, the mid-run findings channel, and LLM-free verbatim handoff upsert beyond the default agent session loop.",
    tools: [
      "agent_handoff_save",
      "agent_run_start",
      "agent_finding_add",
      "agent_finding_list",
      "agent_context_pressure",
      "agent_replay",
      "agent_skill_suggest",
      "agent_identity_attest",
      "agent_identity_verify",
      "agent_intention_set",
      "agent_intention_list",
      "agent_intention_cancel",
    ],
  },
  "goal-advanced": {
    description: "Objective setup, dependency links, import, decomposition, single-node reads, and the cross-machine claim/release pair, beyond the default add/advance/list/frontier.",
    tools: [
      "goal_set_objective",
      "goal_link_dep",
      "goal_import",
      "goal_decompose",
      "goal_get",
      "goal_claim",
      "goal_release",
    ],
  },
  relay: {
    description: "Directed cross-role handoff: open, inbox, get, claim, advance, nudge.",
    tools: ["relay_open", "relay_inbox", "relay_get", "relay_claim", "relay_advance", "relay_nudge"],
  },
  "world-model": {
    description: "Content-addressed workspace snapshots and forkable sandboxes for counterfactual memory experiments.",
    tools: ["ctx_snapshot_create", "ctx_fork_world", "ctx_diff_world", "ctx_discard_sandbox"],
  },
  workspace: {
    description: "One-time project provisioning: list workspaces, and idempotently get-or-create a workspace or a project inside one.",
    tools: ["ctx_workspace_list", "ctx_workspace_ensure", "ctx_project_ensure"],
  },
};

// The default profile: session lifecycle (boot/start/end/checkpoint/resume),
// the core search+CRUD loop, task + lesson tracking, goal-graph basics, and
// the two tool-discovery tools themselves. Deliberately excludes every tool
// listed in TOOL_GROUPS above.
export const DEFAULT_PROFILE_TOOL_NAMES = new Set<string>([
  "agent_boot",
  "agent_session_start",
  "agent_session_end",
  "agent_checkpoint",
  "agent_resume",
  "agent_task_upsert",
  "agent_task_tick",
  "agent_lesson_add",
  "agent_handoff",
  "ctx_search",
  "ctx_save",
  "ctx_get",
  "ctx_list",
  "ctx_update",
  "ctx_delete",
  "ctx_remember",
  "ctx_stats",
  "ctx_health",
  "goal_add",
  "goal_advance",
  "goal_list",
  "goal_frontier",
  "ctx_tool_groups",
  "ctx_load_tool_group",
]);

export type ToolProfile = "default" | "full";

function resolveInitialToolProfile(): ToolProfile {
  const raw = (process.env.CONTEXT_MCP_TOOL_PROFILE ?? "").trim().toLowerCase();
  return raw === "full" ? "full" : "default";
}

// Mutable -- ctx_load_tool_group grows this at runtime so a session that
// started on the default profile can still reach the full surface without
// reconnecting. One MCP stdio process = one client session, same lifetime
// assumption `currentSessionId`/`brainStateInjected` below already rely on.
const activeToolNames: Set<string> =
  resolveInitialToolProfile() === "full" ? new Set(tools.map((t) => t.name)) : new Set(DEFAULT_PROFILE_TOOL_NAMES);

export function getActiveTools(): Tool[] {
  return tools.filter((t) => activeToolNames.has(t.name));
}

// Promotes a group's tools into the active set. Returns which names were
// newly added (already-active ones are skipped) and whether `group` matched
// nothing, so the caller can report both cases without duplicating the
// lookup. index.ts uses the return value to decide whether to emit
// notifications/tools/list_changed.
export function loadToolGroup(group: string): { added: string[]; unknownGroup: boolean } {
  const key = group.trim().toLowerCase();
  const names = key === "all" ? tools.map((t) => t.name) : TOOL_GROUPS[key]?.tools;
  if (!names) return { added: [], unknownGroup: true };
  const added: string[] = [];
  for (const name of names) {
    if (!activeToolNames.has(name)) {
      activeToolNames.add(name);
      added.push(name);
    }
  }
  return { added, unknownGroup: false };
}

// ---------------------------------------------------------------------------
// Handler dispatch
// ---------------------------------------------------------------------------

type ToolInput = Record<string, unknown>;

const handlers: Record<string, (input: ToolInput) => Promise<unknown>> = {
  async ctx_save(input) {
    return request("POST", "/api/contexts", input);
  },

  async ctx_search(input) {
    return request("POST", "/api/search", input);
  },

  async ctx_explain_recall(input) {
    const { id } = input as { id: number };
    return request("GET", `/api/search/traces/${id}/explain`);
  },

  async ctx_web_search(input) {
    return request("POST", "/api/search/web", input);
  },

  async ctx_feedback(input) {
    return request("POST", "/api/memory-push/feedback", input);
  },

  async ctx_list(input) {
    const qs = toQueryString(input);
    return request("GET", `/api/contexts${qs}`);
  },

  async ctx_get(input) {
    return request("GET", `/api/contexts/${input.id}`);
  },

  async ctx_update(input) {
    const { id, ...body } = input;
    return request("PUT", `/api/contexts/${id}`, body);
  },

  async ctx_delete(input) {
    return request("DELETE", `/api/contexts/${input.id}`);
  },

  async ctx_bulk_update(input) {
    return request("POST", "/api/contexts/bulk", input);
  },

  async ctx_undo_archive(input) {
    const { id } = input as { id: number };
    return request("POST", `/api/contexts/${id}/undo-archive`, {});
  },

  async ctx_undo_archive_info(input) {
    const { id } = input as { id: number };
    return request("GET", `/api/contexts/${id}/undo-archive-info`);
  },

  async ctx_import(input) {
    return request("POST", "/api/import", input);
  },

  async ctx_stats() {
    return request("GET", "/api/stats");
  },

  async ctx_dream(input) {
    return request("POST", "/api/dream", input);
  },

  async ctx_link(input) {
    const { source_id, target_id, type, confidence, reason } = input as {
      source_id: number;
      target_id: number;
      type: string;
      confidence?: number;
      reason?: string;
    };
    const body: Record<string, unknown> = { target_id, type };
    if (confidence !== undefined) body.confidence = confidence;
    // The API persists the rationale via the `created_by` annotation column.
    if (reason !== undefined) body.created_by = reason;
    return request("POST", `/api/contexts/${source_id}/links`, body);
  },

  async ctx_links(input) {
    const { id, direction } = input as { id: number; direction?: string };
    const qs = toQueryString({ direction: direction ?? "both" });
    return request("GET", `/api/contexts/${id}/links${qs}`);
  },

  async ctx_evolve(input) {
    const { id, k_neighbors, dry_run } = input as {
      id: number;
      k_neighbors?: number;
      dry_run?: boolean;
    };
    const body: Record<string, unknown> = {};
    if (k_neighbors !== undefined) body.k_neighbors = k_neighbors;
    if (dry_run !== undefined) body.dry_run = dry_run;
    return request("POST", `/api/contexts/${id}/evolve`, body);
  },

  async ctx_chunks(input) {
    return request("GET", `/api/contexts/${input.id}/chunks`);
  },

  async ctx_code_refs(input) {
    const { ref } = input as { ref: string };
    return request("GET", `/api/code/refs${toQueryString({ ref })}`);
  },

  async ctx_code_trace(input) {
    const { ref, depth } = input as { ref: string; depth?: number };
    return request("GET", `/api/code/trace${toQueryString({ ref, depth })}`);
  },

  async ctx_provenance_get(input) {
    const { id, depth } = input as { id: number; depth?: number };
    return request("GET", `/api/contexts/${id}/provenance${toQueryString({ depth })}`);
  },

  async ctx_confidence_get(input) {
    const { id } = input as { id: number };
    return request("GET", `/api/contexts/${id}/confidence`);
  },

  async ctx_belief_history(input) {
    const { id, limit } = input as { id: number; limit?: number };
    return request("GET", `/api/contexts/${id}/belief-events${toQueryString({ limit })}`);
  },

  async ctx_blast_radius(input) {
    const { id, depth, top } = input as { id: number; depth?: number; top?: number };
    return request("GET", `/api/contexts/${id}/blast-radius${toQueryString({ depth, top })}`);
  },

  async ctx_graph_search(input) {
    const { query, as_of, limit } = input as {
      query: string;
      as_of?: string;
      limit?: number;
    };
    const body: Record<string, unknown> = { query };
    if (as_of !== undefined) body.asOf = as_of;
    if (limit !== undefined) body.limit = limit;
    return request("POST", "/api/graph/search", body);
  },

  async ctx_entity_get(input) {
    const { id, as_of } = input as { id: number; as_of?: string };
    return request("GET", `/api/graph/entities/${id}${toQueryString({ asOf: as_of })}`);
  },

  async ctx_mocs(input) {
    const qs = toQueryString(input);
    return request("GET", `/api/mocs${qs}`);
  },

  async ctx_regenerate_mocs() {
    return request("POST", "/api/mocs/regenerate", {});
  },

  async ctx_maps(input) {
    const qs = toQueryString(input);
    return request("GET", `/api/maps${qs}`);
  },

  async ctx_saved_searches_list() {
    return request("GET", "/api/saved-searches");
  },

  async ctx_saved_searches_create(input) {
    return request("POST", "/api/saved-searches", input);
  },

  async ctx_saved_searches_get(input) {
    return request("GET", `/api/saved-searches/${input.id}`);
  },

  async ctx_saved_searches_update(input) {
    const { id, ...body } = input;
    return request("PUT", `/api/saved-searches/${id}`, body);
  },

  async ctx_saved_searches_delete(input) {
    return request("DELETE", `/api/saved-searches/${input.id}`);
  },

  async ctx_saved_searches_run(input) {
    const { id, ...body } = input;
    return request("POST", `/api/saved-searches/${id}/run`, body);
  },

  async ctx_run_saved_search(input) {
    return request("POST", "/api/saved-searches/run-by-name", input);
  },

  async ctx_ingest(input) {
    return request("POST", "/api/ingest", input);
  },

  async ctx_ingest_status(input) {
    const { job_id } = input as { job_id: number };
    return request("GET", `/api/ingest-jobs/${job_id}`);
  },

  async ctx_remember(input) {
    return request("POST", "/api/memory", input);
  },

  async ctx_events_recent(input) {
    const qs = toQueryString(input);
    return request("GET", `/api/events/recent${qs}`);
  },

  async ctx_memory_review_logs(input) {
    const qs = toQueryString(input);
    return request("GET", `/api/admin/memory-review-logs${qs}`);
  },

  async ctx_memory_review_run(input) {
    const body: Record<string, unknown> = {};
    if ("tenant_id" in input) body.tenant_id = input.tenant_id;
    return request("POST", "/api/admin/memory-review/run", body);
  },

  async ctx_contradictions_list(input) {
    const qs = toQueryString(input);
    return request("GET", `/api/contradictions${qs}`);
  },

  async ctx_audit_cleanup_run(input) {
    const body: Record<string, unknown> = {};
    if (input.retention_days !== undefined) {
      body.retention_days = input.retention_days;
    }
    return request("POST", "/api/admin/audit-cleanup/run", body);
  },

  async ctx_admin_rate_limit_get() {
    return request("GET", "/api/admin/rate-limit/buckets");
  },

  async ctx_admin_rate_limit_set(input) {
    const { tenant_id, ...body } = input as {
      tenant_id: number;
      capacity?: number;
      refill_per_min?: number;
    };
    return request("PUT", `/api/admin/tenants/${tenant_id}/rate-limit`, body);
  },

  async ctx_health() {
    return request("GET", "/health/deep");
  },

  async ctx_audit_chain_status() {
    return request("GET", "/api/admin/audit-logs/verify-chain");
  },

  async ctx_admin_queue_stats() {
    return request("GET", "/api/admin/queue-stats");
  },

  // --- Agent Memory Layer ---

  async agent_boot(input) {
    return request("POST", "/api/agent/boot", input);
  },

  async agent_session_start(input) {
    return request("POST", "/api/agent/sessions", input);
  },

  async agent_session_end(input) {
    const { session_id, ...body } = input as { session_id: number };
    return request("PATCH", `/api/agent/sessions/${session_id}`, body);
  },

  async agent_checkpoint(input) {
    const { session_id, ...body } = input as { session_id: number };
    return request("POST", `/api/agent/sessions/${session_id}/checkpoint`, body);
  },

  async agent_context_pressure(input) {
    const { session_id, ...body } = input as { session_id: number };
    return request("POST", `/api/agent/sessions/${session_id}/context-pressure`, body);
  },

  async agent_resume(input) {
    const { session_id } = input as { session_id: number };
    return request("GET", `/api/agent/sessions/${session_id}/resume`);
  },

  async agent_task_upsert(input) {
    const { session_id, ...body } = input as { session_id: number };
    return request("POST", `/api/agent/sessions/${session_id}/tasks`, body);
  },

  async agent_task_tick(input) {
    const { task_id, ...body } = input as { task_id: number };
    return request("PATCH", `/api/agent/tasks/${task_id}`, body);
  },

  async agent_lesson_add(input) {
    const { session_id, ...body } = input as { session_id: number };
    return request("POST", `/api/agent/sessions/${session_id}/lessons`, body);
  },

  async agent_handoff(input) {
    const { session_id, ...body } = input as { session_id: number };
    return request("POST", `/api/agent/sessions/${session_id}/handoff`, body);
  },

  async agent_handoff_save(input) {
    const { external_id, workspace, ...item } = input as {
      external_id: string;
      workspace?: string;
    };
    return request("POST", "/api/contexts/bulk-upsert", {
      workspace,
      contexts: [{ externalId: external_id, type: "handoff", ...item }],
    });
  },

  async agent_replay(input) {
    const { session_id, ...qs } = input as { session_id: number; from_seq?: number; to_seq?: number };
    return request("GET", `/api/agent/sessions/${session_id}/trace-events${toQueryString(qs)}`);
  },

  async agent_skill_suggest(input) {
    return request("GET", `/api/agent/skills/suggest${toQueryString(input)}`);
  },

  async agent_identity_attest(input) {
    return request("POST", "/api/agent/identity/attest", input);
  },

  async agent_identity_verify(input) {
    const { agent } = input as { agent: string };
    return request("GET", `/api/agent/identity/verify${toQueryString({ agent })}`);
  },

  async agent_intention_set(input) {
    return request("POST", "/api/agent/intentions", input);
  },

  async agent_intention_list(input) {
    const { agent, status } = input as { agent?: string; status?: string };
    return request("GET", `/api/agent/intentions${toQueryString({ agent, status })}`);
  },

  async agent_intention_cancel(input) {
    const { intention_id } = input as { intention_id: number };
    return request("POST", `/api/agent/intentions/${intention_id}/cancel`, {});
  },

  // --- Session working scope ---

  async ctx_use(input) {
    return request("POST", "/api/session/scope", input);
  },

  async ctx_scope() {
    return request("GET", "/api/session/scope");
  },

  // --- Goal graph (team-mode Phase 2) ---
  async goal_set_objective(input) {
    return request("POST", "/api/goal/objective", input);
  },
  async goal_add(input) {
    return request("POST", "/api/goal/nodes", input);
  },
  async goal_link_dep(input) {
    return request("POST", "/api/goal/deps", input);
  },
  async goal_advance(input) {
    const { node_id, ...body } = input as { node_id: number };
    return request("PATCH", `/api/goal/nodes/${node_id}/advance`, body);
  },
  async agent_run_start(input) {
    return request("POST", "/api/agent/runs", input ?? {});
  },
  async agent_finding_add(input) {
    return request("POST", "/api/agent/findings", input);
  },
  async agent_finding_list(input) {
    return request("GET", `/api/agent/findings${toQueryString(input)}`);
  },
  async goal_claim(input) {
    return request("POST", "/api/goal/nodes/claim", input);
  },
  async goal_release(input) {
    return request("POST", "/api/goal/nodes/release", input);
  },
  async goal_import(input) {
    return request("POST", "/api/goal/import", input);
  },
  async goal_decompose(input) {
    return request("POST", "/api/goal/decompose", input);
  },
  async goal_list(input) {
    const { view, include_done, ...filters } = input as { view?: string; include_done?: boolean };
    return request(
      "GET",
      `/api/goal/nodes${toQueryString({ ...filters, view: view ?? "compact", include_done: include_done ?? false })}`,
    );
  },
  async goal_get(input) {
    const { node_id } = input as { node_id: number };
    return request("GET", `/api/goal/nodes/${node_id}`);
  },
  async goal_frontier(input) {
    return request("GET", `/api/goal/frontier${toQueryString(input)}`);
  },

  // --- Directed relays (team-mode Phase 2) ---
  async relay_open(input) {
    return request("POST", "/api/relay", input);
  },
  async relay_inbox(input) {
    return request("GET", `/api/relay/inbox${toQueryString(input)}`);
  },
  async relay_get(input) {
    const { id } = input as { id: number };
    return request("GET", `/api/relay/${id}`);
  },
  async relay_claim(input) {
    const { id, ...body } = input as { id: number };
    return request("POST", `/api/relay/${id}/claim`, body);
  },
  async relay_advance(input) {
    const { id, ...body } = input as { id: number };
    return request("PATCH", `/api/relay/${id}/advance`, body);
  },
  async relay_nudge(input) {
    const { id, ...body } = input as { id: number };
    return request("POST", `/api/relay/${id}/nudge`, body);
  },

  // --- World-model snapshots + forkable sandboxes (T378) ---
  async ctx_snapshot_create(input) {
    return request("POST", "/api/world/snapshots", input);
  },
  async ctx_fork_world(input) {
    return request("POST", "/api/world/fork", input);
  },
  async ctx_diff_world(input) {
    const { sandbox_workspace } = input as { sandbox_workspace: string };
    return request("GET", `/api/world/sandboxes/${encodeURIComponent(sandbox_workspace)}/diff`);
  },
  async ctx_discard_sandbox(input) {
    const { sandbox_workspace } = input as { sandbox_workspace: string };
    return request("DELETE", `/api/world/sandboxes/${encodeURIComponent(sandbox_workspace)}`);
  },

  // --- T668: tool-profile discovery -- see TOOL_GROUPS/loadToolGroup above.
  // Local-only: neither handler makes an HTTP call to the API. ---
  async ctx_tool_groups() {
    const groups = Object.entries(TOOL_GROUPS).map(([key, group]) => ({
      group: key,
      description: group.description,
      tool_count: group.tools.length,
      loaded: group.tools.every((name) => activeToolNames.has(name)),
      tools: group.tools,
    }));
    return {
      loaded_tool_count: activeToolNames.size,
      total_tool_count: tools.length,
      groups,
      how_to_load:
        'Call ctx_load_tool_group with { group: "<name>" } (or "all") to add a group\'s tools to this session. If your tool list does not refresh automatically, call the newly loaded tool directly by name anyway -- ContextQ accepts a call for any known tool name regardless of what tools/list currently returns -- or reconnect with the environment variable CONTEXT_MCP_TOOL_PROFILE=full to start with every tool loaded.',
    };
  },

  async ctx_load_tool_group(input) {
    const { group } = input as { group?: unknown };
    if (typeof group !== "string" || group.trim() === "") {
      return { error: 'group is required -- call ctx_tool_groups to see valid group names, or pass "all".' };
    }
    const { added, unknownGroup } = loadToolGroup(group);
    if (unknownGroup) {
      return { error: `Unknown group "${group}". Call ctx_tool_groups to see valid group names.` };
    }
    return {
      group: group.trim().toLowerCase(),
      added_tools: added,
      already_loaded: added.length === 0,
      note: "These tools are now callable. If they do not appear in your tool list yet, call them directly by name -- ContextQ accepts a call for any known tool name regardless of what tools/list currently shows.",
    };
  },

  async ctx_workspace_list(input) {
    return request("GET", `/api/workspaces${toQueryString(input)}`);
  },

  async ctx_workspace_ensure(input) {
    return request("POST", "/api/workspaces/ensure", input);
  },

  async ctx_project_ensure(input) {
    return request("POST", "/api/projects", input);
  },
};

// ---------------------------------------------------------------------------
// T375: episodic tool-call trace — fire-and-forget logging of EVERY tool
// invocation via POST /api/agent/sessions/:id/trace-events.
//
// The MCP process is long-lived (one process per client session), so the
// "current" agent session id is tracked in module state: adopted whenever a
// tool call's args carry `session_id` (most agent_*/goal_*/relay_* tools
// already require or accept one) or from the id returned by
// `agent_session_start`. Tool calls made before any session is known are
// simply not traced — there is nothing to attribute them to yet, and this
// never affects the tool's own result either way.
//
// `traceToolCall` is invoked WITHOUT `await` from `handleToolCall` below and
// swallows every error internally — a slow, failing, or misconfigured trace
// endpoint can NEVER block or fail the tool path it is describing.
// ---------------------------------------------------------------------------

let currentSessionId: number | null = null;

// ---------------------------------------------------------------------------
// T446: first-call brain-state injection -- see
// docs/tech/brain-state-injection.md "Injection mechanics / stdio transport".
// One MCP stdio process = one guard: `brainStateInjected` is the ENTIRE
// dedupe store for this transport, no map/session-id bookkeeping needed.
// Fetch failure (endpoint down, no key, network error) must never break the
// tool call it rides on -- `buildBrainStateBlock` swallows every error and
// returns null, which the caller treats as "nothing to inject".
// ---------------------------------------------------------------------------

let brainStateInjected = false; // module-scope: one MCP stdio process = one guard

function brainStateInjectionEnabled(): boolean {
  return process.env.CONTEXTQ_BRAIN_STATE_INJECT !== "false";
}

// ---------------------------------------------------------------------------
// T447: auto-checkpoint after a successful write tool -- see
// docs/tech/brain-state-injection.md ("no end-of-chat signal on
// Desktop/Cowork" is the same gap this closes incrementally instead of
// relying on a session-end hook). Reuses the same endpoint `agent_checkpoint`
// already calls (POST /api/agent/sessions/:id/checkpoint) so there is no new
// server-side surface.
//
// Fire-and-forget, coalesced to at most one auto-checkpoint per minute
// (module-scope timestamp guard), and every failure mode (no session, no
// key, network error) is swallowed -- an auto-checkpoint must never affect
// the tool result it rides on, mirroring `traceToolCall`'s contract above.
// ---------------------------------------------------------------------------

const AUTO_CHECKPOINT_COALESCE_MS = 60_000;
let lastAutoCheckpointAt = 0;

// Write tools = anything that mutates server-side state. Read/query tools
// (ctx_search, ctx_list, agent_boot, agent_resume, goal_list, ...) and the
// purely advisory agent_context_pressure are deliberately excluded.
// agent_checkpoint itself is excluded too -- it IS a checkpoint, chaining an
// auto-checkpoint off of it would just be a redundant duplicate call.
const WRITE_TOOLS = new Set<string>([
  "ctx_save",
  "ctx_update",
  "ctx_delete",
  "ctx_bulk_update",
  "ctx_undo_archive",
  "ctx_import",
  "ctx_dream",
  "ctx_link",
  "ctx_evolve",
  "ctx_regenerate_mocs",
  "ctx_saved_searches_create",
  "ctx_saved_searches_update",
  "ctx_saved_searches_delete",
  "ctx_saved_searches_run",
  "ctx_run_saved_search",
  "ctx_ingest",
  "ctx_remember",
  "ctx_memory_review_run",
  "ctx_audit_cleanup_run",
  "ctx_admin_rate_limit_set",
  "ctx_use",
  "agent_session_start",
  "agent_session_end",
  "agent_task_upsert",
  "agent_task_tick",
  "agent_lesson_add",
  "agent_handoff",
  "agent_handoff_save",
  "agent_identity_attest",
  "agent_intention_set",
  "agent_intention_cancel",
  "goal_set_objective",
  "goal_add",
  "goal_link_dep",
  "agent_run_start",
  "agent_finding_add",
  "goal_advance",
  "goal_claim",
  "goal_release",
  "goal_import",
  "goal_decompose",
  "relay_open",
  "relay_claim",
  "relay_advance",
  "relay_nudge",
  "ctx_snapshot_create",
  "ctx_fork_world",
  "ctx_discard_sandbox",
  "ctx_workspace_ensure",
  "ctx_project_ensure",
]);

function autoCheckpointEnabled(): boolean {
  return process.env.CONTEXTQ_AUTO_CHECKPOINT !== "false";
}

// Not awaited by the caller -- kicked off and immediately forgotten so it
// never adds latency to the write tool's own response.
function autoCheckpoint(sessionId: number, toolName: string): void {
  const now = Date.now();
  if (now - lastAutoCheckpointAt < AUTO_CHECKPOINT_COALESCE_MS) return;
  lastAutoCheckpointAt = now;

  request("POST", `/api/agent/sessions/${sessionId}/checkpoint`, {
    summary: `auto-checkpoint after ${toolName}`,
  }).catch(() => {
    // Network error, missing session, missing API key, etc. -- never
    // surface to the tool caller. Roll back the timestamp guard so a
    // transient failure doesn't silently disable auto-checkpoint for a
    // full minute.
    lastAutoCheckpointAt = 0;
  });
}

async function buildBrainStateBlock(): Promise<string | null> {
  try {
    const result = await request("GET", "/api/agent/brain-state");
    if (!result || typeof result !== "object") return null;
    const block = (result as { block?: unknown }).block;
    return typeof block === "string" ? block : null;
  } catch {
    // Endpoint unreachable, no API key configured, malformed response, etc.
    // Injection is a nice-to-have -- never let it surface as a tool error.
    return null;
  }
}

function extractSessionId(args: ToolInput): number | null {
  const v = args?.session_id;
  return typeof v === "number" ? v : null;
}

function extractSessionIdFromResult(result: unknown): number | null {
  if (result && typeof result === "object" && "id" in (result as Record<string, unknown>)) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === "number") return id;
  }
  return null;
}

function traceToolCall(
  sessionId: number,
  toolName: string,
  args: ToolInput,
  outcome: unknown,
  isError: boolean,
  durationMs: number,
): void {
  // Deliberately not awaited by the caller — see the module doc-comment
  // above. `.catch` here is the last line of defense; `request()` already
  // rejects cleanly on non-2xx/network errors, never throws synchronously.
  request("POST", `/api/agent/sessions/${sessionId}/trace-events`, {
    tool_name: toolName,
    args,
    result: isError ? { error: String(outcome) } : outcome,
    duration_ms: durationMs,
  }).catch(() => {
    // Trace writes must never surface to the tool caller — swallow silently.
  });
}

export async function handleToolCall(
  name: string,
  args: ToolInput,
  // T558: the incoming `tools/call` request's `_meta` envelope, passed
  // through by index.ts's request handler. Optional + untyped here on
  // purpose -- `extractTraceContext` already validates + narrows it.
  meta?: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Adopt an explicit session_id from the incoming args BEFORE the call, so
  // this trace attributes to the session THIS call belongs to (matters when
  // a client interleaves calls across multiple sessions).
  const argSessionId = extractSessionId(args);
  if (argSessionId !== null) currentSessionId = argSessionId;

  // T558: scope the trace context to EXACTLY this tool invocation's
  // `handler(args)` call below -- not the trace-event/auto-checkpoint side
  // calls further down, which are separate requests, not "this call's
  // underlying /api/* request".
  const traceContext = extractTraceContext(meta);

  const startedAt = Date.now();

  try {
    const result = await traceContextStorage.run(traceContext, () => handler(args));
    const durationMs = Date.now() - startedAt;

    if (name === "agent_session_start") {
      const newId = extractSessionIdFromResult(result);
      if (newId !== null) currentSessionId = newId;
    }

    if (currentSessionId !== null) {
      traceToolCall(currentSessionId, name, args, result, false, durationMs);

      if (WRITE_TOOLS.has(name) && autoCheckpointEnabled()) {
        autoCheckpoint(currentSessionId, name);
      }
    }

    const response: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
      content: [
        {
          type: "text",
          text: result !== null ? JSON.stringify(result, null, 2) : "OK",
        },
      ],
    };

    // First successful tool call this process: try to append the brain-state
    // block. Set the guard unconditionally BEFORE the eligibility checks so
    // an `agent_boot` call (which already returns rich context) or a
    // disabled/failed fetch still consumes the one-shot -- never retried
    // later in the same process.
    if (!brainStateInjected) {
      brainStateInjected = true;
      if (name !== "agent_boot" && brainStateInjectionEnabled()) {
        const block = await buildBrainStateBlock();
        if (block) {
          response.content.push({ type: "text", text: block });
        }
      }
    }

    return response;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    if (currentSessionId !== null) {
      traceToolCall(currentSessionId, name, args, message, true, durationMs);
    }

    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
