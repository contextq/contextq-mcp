/**
 * MCP tool-definition token-footprint audit.
 *
 * Estimates how many tokens a `tools/list` response costs an MCP client on
 * every session, since the tool list is sent verbatim on connection and
 * typically kept in the model's context window (unless deferred, as Claude
 * Code's ToolSearch does).
 *
 * Token estimation method: chars/4 heuristic (no tokenizer dependency).
 * This is an APPROXIMATION, not an exact tokenizer count — it does not model
 * BPE merges, punctuation/whitespace boundaries, or model-specific vocab.
 * It is good enough to rank tools by relative weight and to flag when the
 * aggregate footprint is large enough to warrant a real tokenizer pass.
 * mcp/package.json intentionally has no tokenizer dependency; do not add one
 * here — if precise counts are ever needed, run the same JSON payloads
 * through the actual model tokenizer out-of-band.
 *
 * T668: `--profile full` (default, for back-compat with prior invocations
 * and docs/product/mcp-host-capability-survey.md's original measurement)
 * audits every tool the stdio transport CAN serve; `--profile default`
 * audits only what a fresh connection sees before ctx_load_tool_group or
 * CONTEXT_MCP_TOOL_PROFILE=full widen it — see tools.ts's
 * DEFAULT_PROFILE_TOOL_NAMES/TOOL_GROUPS doc comment for the split itself.
 *
 * Usage:
 *   npx tsx mcp/scripts/audit-tool-tokens.ts [--budget 15000] [--profile default|full]
 *   npm run audit-tokens --prefix mcp -- --budget 20000 --profile default
 */

import { tools, DEFAULT_PROFILE_TOOL_NAMES } from "../src/tools.js";

interface ToolFootprint {
  name: string;
  descriptionWordCount: number;
  tokenEstimate: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function parseBudget(argv: string[]): number {
  const flagIndex = argv.indexOf("--budget");
  if (flagIndex === -1 || flagIndex === argv.length - 1) {
    return 15000;
  }
  const value = Number(argv[flagIndex + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --budget value: ${argv[flagIndex + 1]}`);
  }
  return value;
}

function parseProfile(argv: string[]): "default" | "full" {
  const flagIndex = argv.indexOf("--profile");
  if (flagIndex === -1 || flagIndex === argv.length - 1) {
    return "full";
  }
  const value = argv[flagIndex + 1];
  if (value !== "default" && value !== "full") {
    throw new Error(`Invalid --profile value: ${value} (expected "default" or "full")`);
  }
  return value;
}

function formatTable(rows: ToolFootprint[]): string {
  const header = ["name", "tokens", "desc words"];
  const widths = [
    Math.max(header[0].length, ...rows.map((r) => r.name.length)),
    Math.max(header[1].length, ...rows.map((r) => String(r.tokenEstimate).length)),
    Math.max(header[2].length, ...rows.map((r) => String(r.descriptionWordCount).length)),
  ];

  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i])).join("  ");

  const lines = [
    formatRow(header),
    formatRow(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) =>
      formatRow([r.name, String(r.tokenEstimate), String(r.descriptionWordCount)]),
    ),
  ];
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const budget = parseBudget(argv);
  const profile = parseProfile(argv);
  const toolSet = profile === "default" ? tools.filter((t) => DEFAULT_PROFILE_TOOL_NAMES.has(t.name)) : tools;

  const footprints: ToolFootprint[] = toolSet.map((tool) => {
    const wireShape = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    const serialized = JSON.stringify(wireShape);
    return {
      name: tool.name,
      descriptionWordCount: wordCount(tool.description ?? ""),
      tokenEstimate: estimateTokens(serialized),
    };
  });

  footprints.sort((a, b) => b.tokenEstimate - a.tokenEstimate);

  const total = footprints.reduce((sum, f) => sum + f.tokenEstimate, 0);
  const mean = total / footprints.length;
  const top10 = footprints.slice(0, 10);

  console.log("MCP tool-definition token-footprint audit");
  console.log("Method: chars/4 heuristic on JSON.stringify({ name, description, inputSchema }) per tool (approximation, not a real tokenizer)");
  console.log(`Profile:         ${profile}`);
  console.log("");
  console.log(`Tool count:      ${footprints.length}`);
  console.log(`Total tokens:    ${total}`);
  console.log(`Mean per tool:   ${mean.toFixed(1)}`);
  console.log(`Budget:          ${budget}`);
  console.log("");
  console.log("Top 10 heaviest tools:");
  console.log(formatTable(top10));

  if (total > budget) {
    console.log("");
    console.log(
      `Recommendation: total tool-definition footprint (${total}) exceeds the budget (${budget}). ` +
        "A core-plus-extended split behind a discovery tool (e.g. a small always-loaded core set " +
        "plus an on-demand ctx_discover_tools/ctx_load_tool_group tool for the rest) would be the next step.",
    );
  }
}

main();
