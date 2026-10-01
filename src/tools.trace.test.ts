/**
 * T558: proves the stdio transport's `request()` helper (tools.ts) actually
 * forwards the W3C trace context onto the outgoing API call, driven through
 * the exported public surface (`handleToolCall`) rather than reaching into
 * module-private internals. `fetch` is monkey-patched for the duration of
 * each test so no real network/API server is needed.
 *
 * Run: npx tsx --test mcp/src/tools.trace.test.ts (from repo root), or
 * npx tsx --test src/tools.trace.test.ts (from mcp/).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "./tools.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface CapturedFetchCall {
  url: string;
  headers: Record<string, string>;
}

let originalFetch: typeof fetch;
let captured: CapturedFetchCall[];

beforeEach(() => {
  // Brain-state injection + auto-checkpoint/trace-event side calls are
  // irrelevant to this task and would otherwise add extra mocked-fetch
  // calls to count around -- disable both so each test's captured list is
  // exactly the one call `ctx_search` itself makes.
  process.env.CONTEXTQ_BRAIN_STATE_INJECT = "false";
  process.env.CONTEXTQ_AUTO_CHECKPOINT = "false";
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    captured.push({ url: String(input), headers });
    return new Response(JSON.stringify({ results: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CONTEXTQ_BRAIN_STATE_INJECT;
  delete process.env.CONTEXTQ_AUTO_CHECKPOINT;
});

test("a valid _meta.traceparent on ctx_search forwards traceparent/tracestate/baggage headers on the outgoing API call", async () => {
  const result = await handleToolCall(
    "ctx_search",
    { query: "test" },
    { traceparent: VALID_TRACEPARENT, tracestate: "congo=t61rcWkgMzE", baggage: "userId=alice" },
  );
  assert.equal(result.isError, undefined, `expected success, got: ${JSON.stringify(result)}`);

  assert.equal(captured.length, 1, "expected exactly one outgoing API call");
  assert.ok(captured[0].url.endsWith("/api/search"));
  assert.equal(captured[0].headers.traceparent, VALID_TRACEPARENT);
  assert.equal(captured[0].headers.tracestate, "congo=t61rcWkgMzE");
  assert.equal(captured[0].headers.baggage, "userId=alice");
});

test("a malformed _meta.traceparent is never forwarded as a header", async () => {
  const result = await handleToolCall("ctx_search", { query: "test" }, { traceparent: "not-a-real-traceparent" });
  assert.equal(result.isError, undefined);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.traceparent, undefined);
});

test("no _meta at all behaves exactly as before this task -- no trace headers on the outgoing call", async () => {
  const result = await handleToolCall("ctx_search", { query: "test" });
  assert.equal(result.isError, undefined);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.traceparent, undefined);
  assert.equal(captured[0].headers.tracestate, undefined);
  assert.equal(captured[0].headers.baggage, undefined);
});

test("trace context from one call never leaks into a later call with no _meta (ALS scope ends with the call)", async () => {
  await handleToolCall("ctx_search", { query: "first" }, { traceparent: VALID_TRACEPARENT });
  assert.equal(captured[0].headers.traceparent, VALID_TRACEPARENT);

  await handleToolCall("ctx_search", { query: "second" });
  assert.equal(captured.length, 2);
  assert.equal(captured[1].headers.traceparent, undefined, "second call must not inherit the first call's trace context");
});
