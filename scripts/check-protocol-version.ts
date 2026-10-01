/**
 * T607: MCP protocol-version contract check.
 *
 * mcp/ and the repo root both pin `@modelcontextprotocol/sdk` at `^1.12.1`,
 * and npm has silently walked that range forward release to release (a real
 * drift already observed: installed 1.29.x/1.30.0 while the range was cut
 * against 1.12.1's protocol). The SDK's declared MCP protocol version is a
 * constant baked into its own published dist
 * (`LATEST_PROTOCOL_VERSION` in `@modelcontextprotocol/sdk/types.js`), not
 * something visible in package.json or the changelog, so a silent SDK bump
 * can carry a silent protocol-version bump with it and nothing before this
 * script would ever notice.
 *
 * This script reads that constant STRAIGHT FROM THE INSTALLED PACKAGE (never
 * from a changelog, never hand-copied) and compares it against the value
 * this repo has explicitly pinned in ../expected-protocol-version.json. A
 * mismatch in EITHER direction is a failure:
 *
 *   - installed > expected: the SDK moved to a newer protocol revision than
 *     this package has been built/tested against. Bumping
 *     expected-protocol-version.json is a deliberate act that belongs in the
 *     same commit as verifying (and, if needed, updating) how mcp/'s
 *     transport code speaks that newer protocol -- never a reflexive fix for
 *     this script going red.
 *   - installed < expected: the lockfile resolved to an SDK OLDER than what
 *     this repo claims to target -- almost always a lockfile/install
 *     problem, not a protocol problem.
 *
 * Usage:
 *   npm run check:protocol --prefix mcp
 *   npx tsx mcp/scripts/check-protocol-version.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LATEST_PROTOCOL_VERSION as installedProtocolVersion } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const expectedFilePath = join(__dirname, "..", "expected-protocol-version.json");

interface ExpectedProtocolVersionFile {
  protocolVersion: string;
}

function readExpectedProtocolVersion(): string {
  const raw = readFileSync(expectedFilePath, "utf-8");
  const parsed = JSON.parse(raw) as ExpectedProtocolVersionFile;
  if (typeof parsed.protocolVersion !== "string" || parsed.protocolVersion.length === 0) {
    throw new Error(
      `${expectedFilePath} is missing a non-empty "protocolVersion" string field`,
    );
  }
  return parsed.protocolVersion;
}

function main(): void {
  const expectedProtocolVersion = readExpectedProtocolVersion();

  console.log(`Installed @modelcontextprotocol/sdk protocol version: ${installedProtocolVersion}`);
  console.log(`Expected (pinned) protocol version:                  ${expectedProtocolVersion}`);

  if (installedProtocolVersion === expectedProtocolVersion) {
    console.log("OK: installed SDK protocol version matches the pinned expectation.");
    return;
  }

  console.error("");
  console.error("PROTOCOL VERSION MISMATCH");
  console.error("=========================");
  if (installedProtocolVersion > expectedProtocolVersion) {
    console.error(
      `The installed SDK declares a NEWER protocol version ("${installedProtocolVersion}") than ` +
        `this repo has pinned ("${expectedProtocolVersion}") in expected-protocol-version.json.`,
    );
    console.error(
      "This means @modelcontextprotocol/sdk moved forward (directly or via the ^ range) without " +
        "anyone deliberately reviewing the protocol bump.",
    );
    console.error(
      "Fix: review what changed between the two protocol revisions, confirm mcp/'s tool " +
        "definitions and transport code still behave correctly under the new revision, THEN " +
        "update expected-protocol-version.json in the same commit as that review -- do not bump " +
        "the file reflexively just to make this check pass.",
    );
  } else {
    console.error(
      `The installed SDK declares an OLDER protocol version ("${installedProtocolVersion}") than ` +
        `this repo expects ("${expectedProtocolVersion}").`,
    );
    console.error(
      "This usually means package-lock.json resolved to an SDK version older than intended -- " +
        "check mcp/package.json's @modelcontextprotocol/sdk range and mcp/package-lock.json, and " +
        "re-run `npm install` / `npm update` as appropriate.",
    );
  }
  console.error("");
  process.exitCode = 1;
}

main();
