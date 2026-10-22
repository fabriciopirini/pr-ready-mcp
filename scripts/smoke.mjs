// Checks a built server over stdio without GitHub access, on whatever Node runs it:
//   node scripts/smoke.mjs [path/to/dist/index.js]
// 1. the entry point starts and lists exactly pr_readiness;
// 2. the built decision path, fed a replayed fixture through evals/agent/server.mjs, answers
//    not_ready with the expected reasons.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect(args) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: "ignore" }));
  return client;
}

const entry = process.argv[2] ?? new URL("../dist/index.js", import.meta.url).pathname;
const server = await connect([entry]);
assert.deepEqual(
  (await server.listTools()).tools.map((t) => t.name),
  ["pr_readiness"],
);
await server.close();

const replay = await connect([
  new URL("../evals/agent/server.mjs", import.meta.url).pathname,
  "failing_and_review_required",
]);
const res = await replay.callTool({ name: "pr_readiness", arguments: { pr: "cli/cli#14716" } });
await replay.close();
const { verdict, reasons } = res.structuredContent;
assert.equal(verdict, "not_ready");
assert.deepEqual(
  reasons.map((r) => r.code),
  ["checks_failing", "review_required"],
);
console.log(`ok: ${entry} lists pr_readiness; replayed decision is ${verdict} (${reasons.map((r) => r.code)})`);
