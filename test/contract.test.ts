// Contract tests: each scenario in test/fixtures/scenarios.json (a recorded GitHub response plus an
// explicit override) goes through the real server via an MCP client, and the decision must match.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitHub } from "../src/github.ts";
import { readinessOutput } from "../src/schema.ts";
import { createServer } from "../src/server.ts";
import { load, scenarios } from "./fixture-fetch.mjs";

async function call(options: Parameters<typeof createGitHub>[0], args: Record<string, unknown>) {
  const client = new Client({ name: "contract", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(createGitHub(options)).connect(serverSide);
  await client.connect(clientSide);
  const res = await client.callTool({ name: "pr_readiness", arguments: args });
  await client.close();
  return { res, text: (res.content as { text: string }[])[0].text };
}

for (const s of scenarios) {
  test(`${s.name}: ${s.why}`, async () => {
    const { pr, input, options } = load(s);
    const { res, text } = await call(options, { pr, ...input });
    const want = s.expect;

    if (want.error) {
      // Errors are JSON text with no structured content, so the SDK client's output check cannot reject them.
      assert.equal(res.isError, true, text);
      assert.equal(res.structuredContent, undefined);
      const err = JSON.parse(text);
      assert.equal(err.code, want.error);
      assert.equal(err.retry_after_seconds, want.retry_after_seconds);
      assert.equal(err.retryable, ["rate_limited", "upstream_error"].includes(want.error));
      return;
    }

    assert.equal(res.isError, undefined, text);
    const out = readinessOutput.parse(JSON.parse(text));
    assert.deepEqual(res.structuredContent, out, "text and structured content must agree");
    assert.equal(out.verdict, want.verdict);
    assert.deepEqual(
      out.reasons.map((r) => `${r.code}/${r.owner}`),
      want.reasons,
    );
    if (want.state) assert.equal(out.facts.state, want.state);
    if (want.failing)
      assert.deepEqual(
        out.facts.checks.failing.map((c) => c.name),
        want.failing,
      );
    if (want.pending)
      assert.deepEqual(
        out.facts.checks.pending.map((c) => c.name),
        want.pending,
      );
    if (want.details_complete !== undefined) assert.equal(out.facts.checks.details_complete, want.details_complete);
    if (want.by_state) assert.deepEqual(out.facts.checks.by_state, want.by_state);
    // No reason text may vouch for anything else, and no fix may suggest a write.
    for (const r of out.reasons) {
      assert.doesNotMatch(`${r.detail} ${r.fix}`, /\b(clear|all other|green)\b|Ignore previous/i);
      assert.doesNotMatch(r.fix, /gh pr (merge|ready)|--force|push -f|rebase/);
    }
  });
}

test("required is a label: the same failure blocks whether or not the check is required", async () => {
  for (const name of ["required_check_failing", "optional_check_failing"]) {
    const { pr, options } = load(scenarios.find((s) => s.name === name));
    const out = readinessOutput.parse((await call(options, { pr })).res.structuredContent);
    assert.deepEqual(
      out.facts.checks.failing.map((c) => c.required),
      [name === "required_check_failing"],
    );
  }
});

test("every call reads GitHub again: a review or a rerun on the same head changes the answer", async () => {
  const clean = load(scenarios[0]).options.fetch;
  const review = load(scenarios.find((s) => s.name === "review_required_green_ci")).options.fetch;
  const answers = [review, clean, review];
  const options = { fetch: (async () => answers.shift()?.()) as typeof fetch, token: async () => "t" };
  const client = new Client({ name: "contract", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(createGitHub(options)).connect(serverSide);
  await client.connect(clientSide);
  const verdicts = [];
  for (let i = 0; i < 3; i++) {
    const out = readinessOutput.parse(
      (await client.callTool({ name: "pr_readiness", arguments: { pr: "cli/cli#14716" } })).structuredContent,
    );
    verdicts.push(`${out.head_sha.slice(0, 7)} ${out.verdict}`);
  }
  assert.deepEqual(verdicts, ["936921f not_ready", "936921f ready", "936921f not_ready"]);
});

test("the only request is one fixed read-only POST, whatever the input says", async () => {
  const requests: { url: string; method?: string; variables: unknown; query: string }[] = [];
  const recording = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push({ url, method: init.method, variables: body.variables, query: body.query });
    return load(scenarios.find((s) => s.name === "hostile_check_name")).options.fetch();
  }) as typeof fetch;
  const inputs = [
    "cli/cli#14716",
    "https://github.com/cli/cli/pull/14716",
    "https://github.com/cli/cli/pull/14716?merge=1",
    "cli/cli#14716; rm -rf /",
    "cli/cli#14716 && gh pr merge",
    "see https://github.com/cli/cli/pull/14716",
  ];
  for (const pr of inputs) await call({ fetch: recording, token: async () => "t" }, { pr });
  // The hostile check name reached the server in the response and changed nothing about what it sends.
  assert.equal(requests.length, 2, "only the two valid references reach GitHub");
  for (const r of requests) {
    assert.equal(r.url, "https://api.github.com/graphql");
    assert.equal(r.method, "POST");
    assert.deepEqual(r.variables, { owner: "cli", repo: "cli", number: 14716 });
    assert.match(r.query, /^query\(/);
    assert.doesNotMatch(r.query, /mutation/);
  }
});

test("the stdio entry point starts and lists exactly one tool", async () => {
  const client = new Client({ name: "contract", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../src/index.ts", import.meta.url).pathname],
    }),
  );
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["pr_readiness"],
  );
  await client.close();
});
