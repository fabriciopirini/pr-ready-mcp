#!/usr/bin/env node
// Eval-only stdio server: the built server (dist/) answering every call from one scenario in
// test/fixtures/scenarios.json instead of GitHub. Not part of the published package.
//   node evals/agent/server.mjs <scenario-name>
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGitHub } from "../../dist/github.js";
import { createServer } from "../../dist/server.js";
import { load, scenarios } from "../../test/fixture-fetch.mjs";

const scenario = scenarios.find((s) => s.name === process.argv[2]);
if (!scenario) {
  console.error(`unknown scenario: ${process.argv[2]}`);
  process.exit(2);
}
console.error(`pr-ready-mcp replay: scenario ${scenario.name}`);
await createServer(createGitHub(load(scenario).options)).connect(new StdioServerTransport());
