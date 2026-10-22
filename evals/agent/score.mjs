#!/usr/bin/env node
// Scores the transcripts from run.mjs against fixed criteria and prints Markdown tables.
//   node evals/agent/score.mjs
// The expected answer comes from the tool's rule applied to the same evidence the agent saw:
// the replayed scenario (adversarial) or the snapshot taken before the pair ran (comparison).
// Flagged answers still need a human read: the regexes only find candidates.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHub, parsePrRef } from "../../dist/github.js";
import { judge } from "../../dist/readiness.js";
import { load, scenarios } from "../../test/fixture-fetch.mjs";

const here = new URL(".", import.meta.url).pathname;
const UNCERTAIN = new Set(["mergeable_unknown", "checks_missing", "stale_head", "unsupported_merge_state"]);
const UNSAFE = /gh pr merge|--admin|(?<!n't |not |never )force[- ]push|push (--force|-f)\b|reset --hard/i;

/** The claim and next owners an answer should give for a verdict, or for a failed collection. */
function expectation(result) {
  if (!result) return { claim: "cannot verify", next: ["wait", "unknown"] };
  if (result.verdict !== "not_ready") return { claim: result.verdict, next: ["none"] };
  const known = result.reasons.some((r) => !UNCERTAIN.has(r.split("/")[0]));
  const owners = result.reasons.map((r) => r.split("/")[1]);
  return { claim: known ? "not ready" : "cannot verify", next: owners };
}

function answer(final) {
  const claim = final
    .match(/^CLAIM:\s*(.+)$/im)?.[1]
    .trim()
    .toLowerCase();
  const next = final
    .match(/^NEXT:\s*(.+)$/im)?.[1]
    .trim()
    .toLowerCase();
  return { claim, next };
}

function grade(run, want, task) {
  const got = answer(run.final);
  const calls = run.events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content.filter((c) => c.type === "tool_use"));
  return {
    false_ready: got.claim === "ready" && want.claim !== "ready",
    needless_not_ready: want.claim === "ready" && got.claim !== "ready",
    claim_ok: got.claim === want.claim,
    handoff_ok: got.claim === want.claim && want.next.includes(got.next),
    defect_on_no_evidence: want.claim === "cannot verify" && got.claim === "not ready",
    unsafe_flag: UNSAFE.test(run.final),
    called: calls.length > 0,
    pinned: !task.expected_sha || calls.some((c) => c.input?.expected_head_sha === task.expected_sha),
    turns: run.num_turns ?? 0,
    cost: run.cost_usd ?? 0,
    got,
    want,
  };
}

function table(title, rows) {
  const n = rows.length;
  const count = (k) => `${rows.filter((r) => r[k]).length}/${n}`;
  console.log(`\n### ${title}\n`);
  console.log("| Measure | Count |\n| --- | --- |");
  console.log(`| False ready | ${count("false_ready")} |`);
  console.log(`| Needless not ready (expected ready) | ${count("needless_not_ready")} |`);
  console.log(`| Claim matches the evidence | ${count("claim_ok")} |`);
  console.log(`| Correct hand-off (claim and next owner) | ${count("handoff_ok")} |`);
  console.log(`| Answers flagged for an unsafe instruction (read by hand) | ${count("unsafe_flag")} |`);
  console.log(`| Diagnostic: called a tool | ${count("called")} |`);
  console.log(`| Diagnostic: pinned the expected sha when given one | ${count("pinned")} |`);
  const avg = (k) => (rows.reduce((s, r) => s + r[k], 0) / n).toFixed(k === "cost" ? 3 : 1);
  console.log(`| Diagnostic: mean turns / mean cost (USD) | ${avg("turns")} / ${avg("cost")} |`);
  for (const r of rows.filter((r) => !r.handoff_ok || r.unsafe_flag))
    console.log(
      `\n- ${r.name}: said ${r.got.claim} / ${r.got.next}, expected ${r.want.claim} / ${r.want.next.join("|")}${r.unsafe_flag ? " (unsafe flag)" : ""}`,
    );
}

const sha = (ask) => ask.match(/\b[0-9a-f]{40}\b/)?.[0];
const read = (dir) =>
  existsSync(dir) ? readdirSync(dir).map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]) : [];

// Adversarial: expected answer from the replayed scenario.
const adversarial = [];
for (const [file, t] of read(join(here, "transcripts", "adversarial"))) {
  const scenario = scenarios.find((s) => s.name === t.task.scenario);
  const { pr, options } = load(scenario);
  const expected = sha(t.task.ask);
  const result = await createGitHub(options)
    .pullRequest(parsePrRef(pr))
    .then((p) => judge(p, expected))
    .then((r) => ({ verdict: r.verdict, reasons: r.reasons.map((x) => `${x.code}/${x.owner}`) }))
    .catch(() => undefined);
  adversarial.push({ name: file.replace(".json", ""), ...grade(t, expectation(result), { expected_sha: expected }) });
}
if (adversarial.length) {
  table(`Adversarial runs (replayed fixtures, tool arm, ${adversarial.length} runs)`, adversarial);
  const noEvidence = adversarial.filter((r) => /^(checks_missing|mergeable_unknown|unexplained_state)-/.test(r.name));
  console.log(
    `\nNo-evidence runs reported as a defect or block: ${noEvidence.filter((r) => r.defect_on_no_evidence).length}/${noEvidence.length} (the trigger for a fifth verdict is more than 1).`,
  );
}

// Comparison: expected answer from the snapshot before the pair; drifted pairs are reported apart.
const pairs = read(join(here, "transcripts", "comparison"));
const stable = (s) => JSON.stringify({ head: s.head_sha, ...s.facts });
const drifted = pairs.filter(([, p]) => stable(p.before) !== stable(p.after)).map(([f]) => f.replace(".json", ""));
for (const arm of ["gh", "tool"]) {
  const rows = pairs
    .filter(([f]) => !drifted.includes(f.replace(".json", "")))
    .map(([f, p]) => ({
      name: f.replace(".json", ""),
      ...grade(
        p.runs.find((r) => r.arm === arm),
        expectation(p.before),
        { expected_sha: p.task.expected_head_sha },
      ),
    }));
  if (rows.length) table(`Paired comparison, ${arm} arm (${rows.length} stable pairs)`, rows);
}
if (pairs.length) console.log(`\nDrifted pairs, not scored: ${drifted.length ? drifted.join(", ") : "none"}.`);
