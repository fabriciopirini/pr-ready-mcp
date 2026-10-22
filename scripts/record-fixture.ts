// Records the live GitHub response for a public PR as a contract-test base:
//   node scripts/record-fixture.ts <owner/repo#n | PR URL> <name>
// Writes test/fixtures/<name>.json with the source and observation time. Reviewer logins are
// replaced because they never affect the decision. Not shipped in the package.
import { writeFileSync } from "node:fs";
import { createGitHub, parsePrRef } from "../src/github.ts";

const [input, name] = process.argv.slice(2);
const ref = input && parsePrRef(input);
if (!ref || !name) throw new Error("usage: node scripts/record-fixture.ts <owner/repo#n | PR URL> <name>");

let raw: { data: { repository: { pullRequest: { reviewRequests: { nodes: unknown[] } } } } } | undefined;
const github = createGitHub({
  fetch: async (url, init) => {
    const res = await fetch(url, init);
    raw = await res.clone().json();
    return res;
  },
});
await github.pullRequest(ref);
if (!raw) throw new Error("no response recorded");
const requests = raw.data.repository.pullRequest.reviewRequests;
requests.nodes = requests.nodes.map((_, i) => ({ requestedReviewer: { login: `reviewer-${i + 1}` } }));

const fixture = { source: input, observed_at: new Date().toISOString(), response: raw };
writeFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
