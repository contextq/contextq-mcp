import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// T558: W3C Trace Context propagation, stdio-transport half.
//
// The MCP spec's 2026-07-28 revision (changelog "minor change 2") documents
// OpenTelemetry trace-context propagation conventions for `_meta` keys:
// `traceparent`, `tracestate`, `baggage`. `_meta` already exists in the
// current protocol (2025-11-25) -- this just standardizes key NAMES inside
// an existing envelope, so it is implementable today.
//
// This file duplicates the validation logic in
// `src/plugins/mcp-trace.ts` rather than importing it -- `mcp/` is a
// separate package with its own tsconfig/deps (see CLAUDE.md "MCP Client";
// the same reason `src/plugins/mcp.ts`'s own doc-comment gives for not
// importing `mcp/src/tools.ts`'s tool definitions the other way around).
// Keep the two validators' rules in sync if the W3C spec is ever revised.
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-f]+$/;
const MAX_TRACEPARENT_LENGTH = 256;
const MAX_TRACESTATE_LENGTH = 512; // W3C tracestate spec: combined value <= 512 chars
const MAX_BAGGAGE_LENGTH = 8192; // W3C baggage spec: recommended header-size cap

export interface TraceContext {
  /** The 32-hex trace-id segment of `traceparent` -- the value that joins
   * everything one MCP call touched into a single distributed trace. */
  traceId: string;
  /** The full validated `traceparent` value, forwarded verbatim alongside. */
  traceparent: string;
  tracestate: string | null;
  baggage: string | null;
}

/**
 * Validate a `traceparent` value per the W3C Trace Context spec
 * (https://www.w3.org/TR/trace-context/#traceparent-header-field-values):
 *   version(2 hex) "-" trace-id(32 hex) "-" parent-id(16 hex) "-" flags(2 hex)
 *
 * `traceparent` is caller-supplied and would otherwise be forwarded
 * verbatim as an outbound HTTP header -- it must never be trusted without
 * validation. Rejects: wrong field lengths, uppercase/non-hex characters,
 * version "ff" (explicitly reserved invalid), or an all-zero
 * trace-id/parent-id (the spec's explicit "no trace" sentinel values).
 * Version "00" must have EXACTLY four fields; other versions may carry
 * additional trailing fields per spec (not needed here, so simply not
 * matched by the checks below). Never throws -- a malformed value just
 * fails the check.
 */
export function isValidTraceparent(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TRACEPARENT_LENGTH) return false;
  const parts = raw.split("-");
  if (parts.length < 4) return false;
  const [version, traceId, parentId, flags] = parts;
  if (version.length !== 2 || !HEX_RE.test(version) || version === "ff") return false;
  if (traceId.length !== 32 || !HEX_RE.test(traceId) || /^0+$/.test(traceId)) return false;
  if (parentId.length !== 16 || !HEX_RE.test(parentId) || /^0+$/.test(parentId)) return false;
  if (flags.length !== 2 || !HEX_RE.test(flags)) return false;
  if (version === "00" && parts.length !== 4) return false;
  return true;
}

/**
 * Extract + validate W3C trace context off an MCP `tools/call` request's
 * `_meta` envelope. Returns null for absent/malformed input -- the silent
 * no-op path, which is every tool call today (no known MCP client sends
 * these `_meta` keys yet).
 */
export function extractTraceContext(meta: unknown): TraceContext | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const traceparent = m.traceparent;
  if (!isValidTraceparent(traceparent)) return null;
  const tracestateRaw = m.tracestate;
  const tracestate =
    typeof tracestateRaw === "string" && tracestateRaw.length > 0 && tracestateRaw.length <= MAX_TRACESTATE_LENGTH
      ? tracestateRaw
      : null;
  const baggageRaw = m.baggage;
  const baggage =
    typeof baggageRaw === "string" && baggageRaw.length > 0 && baggageRaw.length <= MAX_BAGGAGE_LENGTH
      ? baggageRaw
      : null;
  return { traceId: traceparent.split("-")[1], traceparent, tracestate, baggage };
}

/**
 * Per-tool-call trace context, threaded to `request()` (tools.ts) via
 * AsyncLocalStorage rather than as an extra parameter on all ~90
 * `request()` call sites across tools.ts -- `handleToolCall` wraps each
 * dispatch in `traceContextStorage.run(ctx, () => handler(args))`, and
 * `request()` reads the ambient store to attach headers. Null on every
 * call today (no known MCP client sends `_meta.traceparent` yet) -- the
 * store is empty, so `request()`'s header-building is byte-for-byte
 * unchanged from before this task.
 */
export const traceContextStorage = new AsyncLocalStorage<TraceContext | null>();
