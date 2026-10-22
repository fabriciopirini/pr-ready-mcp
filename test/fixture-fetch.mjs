// Turns a scenario from test/fixtures/scenarios.json into createGitHub() options that answer from
// a recorded GitHub response plus the scenario's explicit overrides. Plain JavaScript so the
// eval-only server (evals/agent/server.mjs) can use it on the oldest supported Node.
import { readFileSync } from "node:fs";

const dir = new URL("fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

/** @type {Record<string, any>[]} */
export const scenarios = read("scenarios.json");

// "rollup." is shorthand for the head commit's statusCheckRollup; "list[state=X]" picks an array item.
function set(target, path, value) {
  const keys = path.replace(/^rollup(?=\.|$)/, "commits.nodes.0.commit.statusCheckRollup").split(".");
  const last = keys.pop();
  for (const key of keys) {
    const pick = key.match(/^(\w+)\[(\w+)=(\w+)\]$/);
    target = pick ? target[pick[1]].find((item) => item[pick[2]] === pick[3]) : target[key];
  }
  target[last] = value;
}

/** The scenario's PR reference and createGitHub() options. */
export function load(scenario) {
  const base = read(`${scenario.base ?? "clean"}.json`);
  const pr = base.response.data.repository.pullRequest;
  for (const [path, value] of Object.entries(scenario.set ?? {})) set(pr, path, value);
  const body = scenario.not_found
    ? {
        data: { repository: { pullRequest: null } },
        errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve" }],
      }
    : { ...base.response, ...(scenario.errors ? { errors: scenario.errors } : {}) };

  const fetch = async () => {
    if (scenario.throw) throw new DOMException("simulated", scenario.throw);
    const { status = 200, headers = {} } = scenario.http ?? {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  // No token: createGitHub() must answer auth_required without calling fetch.
  const token = async () => (scenario.no_token ? undefined : "fixture-token");
  return { pr: scenario.input?.pr ?? base.source, input: scenario.input ?? {}, options: { fetch, token } };
}
