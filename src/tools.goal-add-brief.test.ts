import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { handleToolCall, tools } from "./tools.js";

const BRIEF = { intent: "i", decisions: "d", pointers: "p", rejected: "r", doneWhen: "w", gotchas: "g" };

let originalFetch: typeof fetch;
let sentBodies: unknown[];
let serverResponse: Record<string, unknown>;

beforeEach(() => {
  process.env.CONTEXTQ_BRAIN_STATE_INJECT = "false";
  process.env.CONTEXTQ_AUTO_CHECKPOINT = "false";
  sentBodies = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify(serverResponse), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CONTEXTQ_BRAIN_STATE_INJECT;
  delete process.env.CONTEXTQ_AUTO_CHECKPOINT;
});

test("stdio goal_add declares do and a six-key brief", () => {
  const goalAdd = tools.find((t) => t.name === "goal_add");
  assert.ok(goalAdd);
  const props = goalAdd.inputSchema.properties as Record<string, { required?: string[] }>;
  assert.ok(props.do, "goal_add declares `do`");
  assert.deepEqual(props.brief.required, ["intent", "decisions", "pointers", "rejected", "doneWhen", "gotchas"]);
  assert.deepEqual(goalAdd.inputSchema.required, ["title"]);
});

test("stdio goal_add forwards do + brief verbatim and surfaces the server's hint to the model", async () => {
  serverResponse = { id: 1, title: "t", payload: {}, hint: { message: "all six or omit", sections: [] } };
  const bare = await handleToolCall("goal_add", { title: "t" });
  assert.equal(bare.isError, undefined);
  assert.deepEqual(sentBodies[0], { title: "t" });
  assert.match(bare.content[0].text, /"hint"/);

  serverResponse = { id: 2, title: "t2", payload: { do: "x", brief: BRIEF } };
  const briefed = await handleToolCall("goal_add", { title: "t2", do: "x", brief: BRIEF });
  assert.equal(briefed.isError, undefined);
  assert.deepEqual(sentBodies[1], { title: "t2", do: "x", brief: BRIEF });
});
