/**
 * Tests for T558's stdio-transport trace-context module.
 * Run: npx tsx --test mcp/src/trace-context.test.ts (from repo root), or
 * npx tsx --test src/trace-context.test.ts (from mcp/).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidTraceparent, extractTraceContext, traceContextStorage } from "./trace-context.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const VALID_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

test("isValidTraceparent accepts a well-formed W3C traceparent", () => {
  assert.equal(isValidTraceparent(VALID_TRACEPARENT), true);
});

test("isValidTraceparent rejects malformed values rather than throwing", () => {
  assert.equal(isValidTraceparent(undefined), false);
  assert.equal(isValidTraceparent(null), false);
  assert.equal(isValidTraceparent(123), false);
  assert.equal(isValidTraceparent(""), false);
  assert.equal(isValidTraceparent("garbage"), false);
  // Reserved-invalid version.
  assert.equal(isValidTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"), false);
  // All-zero trace-id / parent-id sentinels.
  assert.equal(isValidTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"), false);
  assert.equal(isValidTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"), false);
  // Uppercase hex rejected.
  assert.equal(isValidTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"), false);
  // Wrong field length.
  assert.equal(isValidTraceparent("00-abcd-00f067aa0ba902b7-01"), false);
});

test("extractTraceContext returns null for absent or non-object _meta", () => {
  assert.equal(extractTraceContext(undefined), null);
  assert.equal(extractTraceContext(null), null);
  assert.equal(extractTraceContext("not-an-object"), null);
  assert.equal(extractTraceContext({}), null);
});

test("extractTraceContext returns null when traceparent is malformed, even with tracestate/baggage present", () => {
  const result = extractTraceContext({
    traceparent: "not-valid",
    tracestate: "vendor=1",
    baggage: "userId=1",
  });
  assert.equal(result, null);
});

test("extractTraceContext returns the parsed context for a valid traceparent, with optional tracestate/baggage", () => {
  const result = extractTraceContext({
    traceparent: VALID_TRACEPARENT,
    tracestate: "congo=t61rcWkgMzE",
    baggage: "userId=alice",
  });
  assert.deepEqual(result, {
    traceId: VALID_TRACE_ID,
    traceparent: VALID_TRACEPARENT,
    tracestate: "congo=t61rcWkgMzE",
    baggage: "userId=alice",
  });
});

test("extractTraceContext defaults tracestate/baggage to null when absent, without failing the whole extraction", () => {
  const result = extractTraceContext({ traceparent: VALID_TRACEPARENT });
  assert.deepEqual(result, {
    traceId: VALID_TRACE_ID,
    traceparent: VALID_TRACEPARENT,
    tracestate: null,
    baggage: null,
  });
});

test("traceContextStorage.run isolates the store across overlapping async calls", async () => {
  const ctxA = extractTraceContext({ traceparent: VALID_TRACEPARENT });
  const ctxB = extractTraceContext({
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
  });

  const seenA: Array<string | undefined> = [];
  const seenB: Array<string | undefined> = [];

  const runA = traceContextStorage.run(ctxA, async () => {
    seenA.push(traceContextStorage.getStore()?.traceId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    seenA.push(traceContextStorage.getStore()?.traceId);
  });
  const runB = traceContextStorage.run(ctxB, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seenB.push(traceContextStorage.getStore()?.traceId);
  });

  await Promise.all([runA, runB]);

  assert.deepEqual(seenA, [VALID_TRACE_ID, VALID_TRACE_ID]);
  assert.deepEqual(seenB, ["11111111111111111111111111111111"]);
});
