/**
 * T668 test helper: prints the number of tools getActiveTools() returns at
 * process start, so tools.profile.test.ts can exercise
 * CONTEXT_MCP_TOOL_PROFILE=full in a real fresh process rather than
 * mutating process.env after tools.ts has already resolved its module-level
 * initial-profile state (which only happens once, at import time).
 *
 * Not a general-purpose CLI -- prints one number and exits. Usage:
 *   CONTEXT_MCP_TOOL_PROFILE=full npx tsx mcp/scripts/print-active-tool-count.ts
 */

import { getActiveTools } from "../src/tools.js";

// process.stdout.write + an explicit string, not console.log(number) --
// console.log colorizes a bare number via util.inspect when the parent
// environment forces color (e.g. FORCE_COLOR=1), which corrupts the plain
// numeric output tools.profile.test.ts parses from this subprocess.
process.stdout.write(`${getActiveTools().length}\n`);
