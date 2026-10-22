#!/usr/bin/env node
// Runs Claude Code against the tasks in tasks.json and saves each transcript under transcripts/.
//   node evals/agent/run.mjs adversarial [repeats]   tool arm only, replayed fixtures, no GitHub access
//   node evals/agent/run.mjs comparison               gh arm vs tool arm, live public PRs, needs a token
// Needs `npm run build` and a signed-in `claude`. Score with `node evals/agent/score.mjs`.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitHub, parsePrRef } from "../../dist/github.js";
import { judge } from "../../dist/readiness.js";

const MODEL = process.env.EVAL_MODEL ?? "sonnet";
const CONCURRENCY = 3;
const here = new URL(".", import.meta.url).pathname;
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));
const [mode, repeats = "3"] = process.argv.slice(2);
const out = join(here, "transcripts", mode);
mkdirSync(out, { recursive: true });

async function claude(arm, ask, server) {
  const dir = mkdtempSync(join(tmpdir(), "pr-ready-eval-"));
  const mcp = join(dir, "mcp.json");
  const servers = arm === "tool" ? { "pr-ready": { command: process.execPath, args: server } } : {};
  writeFileSync(mcp, JSON.stringify({ mcpServers: servers }));
  const prompt = [ask, tasks.policy, tasks.arms[arm], tasks.answer_format].join("\n\n");
  const toolArgs =
    arm === "tool"
      ? ["--tools", "", "--allowedTools", "mcp__pr-ready__pr_readiness"]
      : ["--tools", "Bash", "--allowedTools", "Bash(gh pr view:*)", "Bash(gh pr checks:*)"];
  const started_at = new Date().toISOString();
  // Isolated from the user's settings, hooks, skills and MCP servers: only the arm's tool is available.
  const args = ["-p", prompt, "--model", MODEL, "--output-format", "stream-json", "--verbose"];
  args.push("--strict-mcp-config", "--mcp-config", mcp, "--setting-sources", "project", "--disable-slash-commands");
  const { stdout } = await promisify(execFile)("claude", [...args, ...toolArgs], {
    cwd: dir,
    maxBuffer: 64 << 20,
    timeout: 300_000,
  }).catch((e) => ({ stdout: e.stdout ?? "" }));
  // Keep the conversation, not the local session metadata (paths, plugins, socket names).
  const all = stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l.replaceAll(homedir(), "~")));
  const system = all.find((e) => e.type === "system") ?? {};
  const result = all.find((e) => e.type === "result") ?? {};
  return {
    arm,
    prompt,
    started_at,
    finished_at: new Date().toISOString(),
    model: system.model,
    claude_code_version: system.claude_code_version,
    tools: system.tools,
    final: result.result ?? "",
    num_turns: result.num_turns,
    duration_ms: result.duration_ms,
    cost_usd: result.total_cost_usd,
    events: all.filter((e) => e.type === "assistant" || e.type === "user"),
  };
}

// The decision-relevant facts at one moment, for the drift check between a pair's two runs.
async function snapshot(pr, expected) {
  const r = judge(await createGitHub().pullRequest(parsePrRef(pr)), expected);
  const { state, draft, merge_state, mergeable, review_decision, in_merge_queue, checks } = r.facts;
  return {
    observed_at: r.checked_at,
    head_sha: r.head_sha,
    verdict: r.verdict,
    reasons: r.reasons.map((x) => `${x.code}/${x.owner}`),
    facts: { state, draft, merge_state, mergeable, review_decision, in_merge_queue, rollup: checks.rollup },
    by_state: checks.by_state,
  };
}

const jobs = [];
if (mode === "adversarial") {
  const entry = join(here, "server.mjs");
  for (const t of tasks.adversarial)
    for (let i = 1; i <= Number(repeats); i++)
      jobs.push(async () => {
        const run = await claude("tool", t.ask, [entry, t.scenario]);
        return [`${t.name}-${i}`, { task: t, replay: `scenario ${t.scenario}`, ...run }];
      });
} else if (mode === "comparison") {
  const entry = join(here, "..", "..", "dist", "index.js");
  for (const [i, t] of tasks.comparison.entries())
    jobs.push(async () => {
      const arms = i % 2 ? ["tool", "gh"] : ["gh", "tool"];
      const before = await snapshot(t.pr, t.expected_head_sha);
      const runs = [];
      for (const arm of arms) runs.push(await claude(arm, t.ask, [entry]));
      const after = await snapshot(t.pr, t.expected_head_sha);
      return [t.name, { task: t, order: arms, before, after, runs }];
    });
} else {
  throw new Error("usage: node evals/agent/run.mjs adversarial [repeats] | comparison");
}

const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [name, record] = await job();
      writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
      console.log(`${mode} ${name} done`);
    }
  }),
);
