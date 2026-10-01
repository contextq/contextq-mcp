/**
 * T668: default/extended tool-profile split for the stdio transport.
 *
 * Asserts the shape docs/product/mcp-host-capability-survey.md (T608)
 * recommended: a small default profile under its own 15,000-token budget
 * (same chars/4 heuristic as mcp/scripts/audit-tool-tokens.ts), a strict
 * partition of the full tool set into that default plus named groups (no
 * tool silently falls out of both), and CONTEXT_MCP_TOOL_PROFILE=full still
 * reaching every tool.
 *
 * Run: npx tsx --test mcp/src/tools.profile.test.ts (from repo root), or
 * npx tsx --test src/tools.profile.test.ts (from mcp/).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { tools, TOOL_GROUPS, DEFAULT_PROFILE_TOOL_NAMES, getActiveTools, loadToolGroup } from "./tools.js";

const HEURISTIC_BUDGET = 15000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function footprint(name: string): number {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" not found in the full tool list`);
  return estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

test("default profile is a non-empty strict subset of the full tool list", () => {
  const allNames = new Set(tools.map((t) => t.name));
  assert.ok(DEFAULT_PROFILE_TOOL_NAMES.size > 0);
  assert.ok(DEFAULT_PROFILE_TOOL_NAMES.size < tools.length, "default profile must be smaller than the full list -- that is the entire point of T668");
  for (const name of DEFAULT_PROFILE_TOOL_NAMES) {
    assert.ok(allNames.has(name), `default profile lists unknown tool "${name}"`);
  }
});

test("every TOOL_GROUPS entry lists only real, non-empty, deduped tool names", () => {
  const allNames = new Set(tools.map((t) => t.name));
  for (const [key, group] of Object.entries(TOOL_GROUPS)) {
    assert.ok(group.tools.length > 0, `group "${key}" is empty`);
    assert.ok(group.description.trim().length > 0, `group "${key}" has no description`);
    const seen = new Set<string>();
    for (const name of group.tools) {
      assert.ok(allNames.has(name), `group "${key}" lists unknown tool "${name}"`);
      assert.ok(!seen.has(name), `group "${key}" lists "${name}" twice`);
      seen.add(name);
    }
  }
});

test("every tool is in the default profile or in exactly one group -- no gaps, no overlap", () => {
  const grouped = new Map<string, string>(); // tool name -> group key
  for (const [key, group] of Object.entries(TOOL_GROUPS)) {
    for (const name of group.tools) {
      const existing = grouped.get(name);
      assert.ok(!existing, `"${name}" appears in both group "${existing}" and group "${key}"`);
      grouped.set(name, key);
    }
  }

  for (const name of DEFAULT_PROFILE_TOOL_NAMES) {
    assert.ok(!grouped.has(name), `"${name}" is in both the default profile and group "${grouped.get(name)}"`);
  }

  const covered = new Set([...grouped.keys(), ...DEFAULT_PROFILE_TOOL_NAMES]);
  const uncovered = tools.map((t) => t.name).filter((name) => !covered.has(name));
  assert.deepEqual(uncovered, [], "tool(s) reachable from neither the default profile nor any group");
});

test("default profile contains the core recall/memory loop", () => {
  // The exact set the task brief and docs/product/mcp-host-capability-survey.md
  // named as load-bearing for the "start or resume tracked work" path.
  for (const name of ["agent_boot", "agent_session_start", "agent_checkpoint", "ctx_search", "ctx_save", "ctx_remember"]) {
    assert.ok(DEFAULT_PROFILE_TOOL_NAMES.has(name), `core loop tool "${name}" missing from the default profile`);
  }
});

test("the two discovery tools are always in the default profile", () => {
  assert.ok(DEFAULT_PROFILE_TOOL_NAMES.has("ctx_tool_groups"));
  assert.ok(DEFAULT_PROFILE_TOOL_NAMES.has("ctx_load_tool_group"));
});

test("default profile's chars/4 token footprint is under the survey's 15,000 budget", () => {
  const total = [...DEFAULT_PROFILE_TOOL_NAMES].reduce((sum, name) => sum + footprint(name), 0);
  assert.ok(total < HEURISTIC_BUDGET, `default profile footprint ${total} is not under budget ${HEURISTIC_BUDGET}`);
});

test("getActiveTools() starts at the default profile when CONTEXT_MCP_TOOL_PROFILE is unset", () => {
  // tools.ts resolves the initial profile once at module load (matching the
  // one-process-per-stdio-session lifetime), so this only re-asserts the
  // module's actual startup state rather than re-triggering resolution --
  // this test suite intentionally does not set the env var before import.
  const active = getActiveTools();
  const activeNames = new Set(active.map((t) => t.name));
  assert.deepEqual(activeNames, DEFAULT_PROFILE_TOOL_NAMES, "getActiveTools() must equal DEFAULT_PROFILE_TOOL_NAMES when the process started without CONTEXT_MCP_TOOL_PROFILE=full");
});

test("loadToolGroup() promotes an unloaded group's tools into the active set exactly once", () => {
  const before = new Set(getActiveTools().map((t) => t.name));
  const targetGroup = Object.entries(TOOL_GROUPS).find(([, g]) => !g.tools.every((n) => before.has(n)));
  assert.ok(targetGroup, "no group left to promote -- a prior test in this file already loaded everything (test order changed?)");
  const [key, group] = targetGroup!;

  const first = loadToolGroup(key);
  assert.equal(first.unknownGroup, false);
  assert.deepEqual([...first.added].sort(), [...group.tools].sort());

  const afterNames = new Set(getActiveTools().map((t) => t.name));
  for (const name of group.tools) assert.ok(afterNames.has(name), `"${name}" not active after loading group "${key}"`);

  // Idempotent: loading the same group again adds nothing new.
  const second = loadToolGroup(key);
  assert.deepEqual(second.added, []);
});

test("loadToolGroup(\"all\") reaches every tool, and an unknown group name is reported, not silently ignored", () => {
  const beforeCount = getActiveTools().length;
  const result = loadToolGroup("all");
  assert.equal(result.unknownGroup, false);
  assert.equal(getActiveTools().length, tools.length, "\"all\" must activate every tool in the full list");
  assert.ok(getActiveTools().length >= beforeCount);

  const bogus = loadToolGroup("not-a-real-group");
  assert.equal(bogus.unknownGroup, true);
  assert.deepEqual(bogus.added, []);
});

test("CONTEXT_MCP_TOOL_PROFILE=full activates every tool from process start (spawned subprocess, not env-mutation-in-place)", async () => {
  // Module-level state in tools.ts is resolved once at import time, so this
  // cannot be exercised by mutating process.env in this same process after
  // import -- spawn a fresh tsx process with the env var set instead, and
  // assert on its actual tools/list-equivalent output via a tiny inline
  // driver script (no MCP transport needed, same pattern as
  // mcp/scripts/audit-tool-tokens.ts's own standalone invocation).
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const driver = join(__dirname, "..", "scripts", "print-active-tool-count.ts");

  const childEnv: NodeJS.ProcessEnv = { ...process.env, CONTEXT_MCP_TOOL_PROFILE: "full" };
  delete childEnv.FORCE_COLOR; // keep the driver's plain-number stdout uncolorized regardless of the parent shell's setting
  const out = execFileSync(process.execPath, ["--import", "tsx/esm", driver], {
    cwd: join(__dirname, ".."),
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(out.trim(), String(tools.length), `expected all ${tools.length} tools active under CONTEXT_MCP_TOOL_PROFILE=full`);
});
