// Offline evals: every recorded GitHub response in test/fixtures goes through the real MCP server
// via a scripted MCP client, and the answer must match the fixture's expected verdict.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitHub } from "../src/github.ts";
import { lintOutput, REASON_CODES, readinessOutput } from "../src/schema.ts";
import { createServer } from "../src/server.ts";

type Fixture = {
  description: string;
  input: { pr: string; [k: string]: unknown };
  expected: { verdict: string; reasons: string[] };
  response: { data: { repository: { pullRequest: { url: string; headRefOid: string } } } };
};

const dir = new URL("fixtures/", import.meta.url);
const fixtures: Record<string, Fixture> = Object.fromEntries(
  readdirSync(dir).map((f) => [f.replace(".json", ""), JSON.parse(readFileSync(new URL(f, dir), "utf8"))]),
);

// Answers GraphQL requests from the fixtures, keyed by the PR the query asks for.
const fakeFetch = (async (_url: string, init: { body: string }) => {
  const { owner, repo, number } = JSON.parse(init.body).variables;
  const hit = Object.values(fixtures).find((f) => f.input.pr === `${owner}/${repo}#${number}`);
  return Response.json(
    hit?.response ?? {
      data: { repository: { pullRequest: null } },
      errors: [{ message: `Could not resolve to a PullRequest with the number of ${number}.` }],
    },
  );
}) as unknown as typeof fetch;

const client = new Client({ name: "eval", version: "0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createServer(createGitHub({ fetch: fakeFetch, token: async () => "test" })).connect(serverSide);
await client.connect(clientSide);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { res, text };
}

for (const [name, fx] of Object.entries(fixtures)) {
  test(`pr_readiness: ${name} (${fx.description})`, async () => {
    const { res, text } = await call("pr_readiness", fx.input);
    assert.equal(res.isError, undefined, text);
    // An agent reads either the text or the structured content: both must be the same valid object.
    const out = readinessOutput.parse(JSON.parse(text));
    assert.deepEqual(res.structuredContent, out);
    assert.equal(out.verdict, fx.expected.verdict);
    assert.deepEqual(
      out.reasons.map((r) => r.code),
      fx.expected.reasons,
    );
    assert.equal(out.head_sha, fx.response.data.repository.pullRequest.headRefOid);
    for (const r of out.reasons) {
      assert.ok(REASON_CODES.includes(r.code));
      assert.ok(r.detail.length > 10 && r.fix.length > 10, `reason ${r.code} needs a detail and a fix`);
    }
  });
}

test("pr_readiness: names failing and pending checks so the agent knows what to open", async () => {
  const failing = readinessOutput.parse(
    (await call("pr_readiness", fixtures.failing_check.input)).res.structuredContent,
  );
  assert.deepEqual(failing.facts.checks.failing, ["test (22)", "ci/lint"]);
  const pending = readinessOutput.parse(
    (await call("pr_readiness", fixtures.pending_check.input)).res.structuredContent,
  );
  assert.deepEqual(pending.facts.checks.pending, ["test (22)"]);
});

test("pr_body_lint: reports each hit with its line, skipping comments and code", async () => {
  const fx = fixtures.lint_hits;
  const out = lintOutput.parse((await call("pr_body_lint", fx.input)).res.structuredContent);
  assert.equal(out.target, fx.response.data.repository.pullRequest.url);
  assert.deepEqual(
    out.hits.map((h) => [h.rule, h.line]),
    [
      ["unchecked_box", 6],
      ["todo_marker", 8],
      ["missing_linked_issue", 1],
    ],
  );
});

test("pr_body_lint: lints a draft body and honours ignore_rules", async () => {
  const body = "- [ ] docs\n\n```\n// TODO in code is fine\n```";
  const all = lintOutput.parse((await call("pr_body_lint", { body })).res.structuredContent);
  assert.deepEqual(
    all.hits.map((h) => h.rule),
    ["unchecked_box"],
  );
  const some = lintOutput.parse(
    (await call("pr_body_lint", { body, ignore_rules: ["unchecked_box"] })).res.structuredContent,
  );
  assert.equal(some.clean, true);
  const empty = lintOutput.parse(
    (await call("pr_body_lint", { body: "<!-- describe the change -->\n" })).res.structuredContent,
  );
  assert.deepEqual(
    empty.hits.map((h) => h.rule),
    ["empty_body"],
  );
});

test("errors come back as tool errors an agent can act on", async () => {
  const bad = await call("pr_readiness", { pr: "not a pr" });
  assert.equal(bad.res.isError, true);
  assert.match(bad.text, /owner\/repo#123/);
  const missing = await call("pr_readiness", { pr: "octo-org/widgets#999" });
  assert.equal(missing.res.isError, true);
  assert.match(missing.text, /octo-org\/widgets#999.*Could not resolve/);
  const both = await call("pr_body_lint", { pr: "octo-org/widgets#41", body: "x" });
  assert.equal(both.res.isError, true);
});

test("the stdio entry point starts and lists both tools", async () => {
  const stdio = new Client({ name: "eval", version: "0" });
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../src/index.ts", import.meta.url).pathname],
    }),
  );
  const { tools } = await stdio.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["pr_readiness", "pr_body_lint"],
  );
  await stdio.close();
});

test.after(() => client.close());
