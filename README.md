# pr-ready-mcp

An MCP server for people who let coding agents open and look after pull requests. It has one read-only tool, `pr_readiness`, that checks an agent's "the PR is ready" against current GitHub data before the agent says it. It answers with a verdict pinned to a head commit and a time, every reason the PR is not verified ready, and whose move each reason is.

It is not GitHub's merge button, permission to merge, or a code review. Its rule is stricter than GitHub's merge eligibility, on purpose (see [the rule](#when-is-a-pr-ready)).

One call, end to end: the agent asks about a PR, the tool reads GitHub once, applies the rule, and answers with a verdict pinned to a commit and a time.

![Sequence diagram: a coding agent calls pr_readiness with a PR and, after a push, the commit it expects; the tool sends one read-only GraphQL query to GitHub, applies the rule to the snapshot, and returns a verdict with reasons, each naming an owner, plus head_sha and checked_at.](docs/how-it-works.svg)

How the verdict is decided: a wrong head is `not_ready` even on a merged or closed PR, merged and closed PRs are otherwise reported rather than judged, and an open PR is `ready` only when no reason applies.

![Flowchart: the head commit is compared with the expected sha; a mismatch is stale_head and the verdict is not_ready; a merged or closed PR with the right head is reported as merged or closed; an open PR collects every applicable reason about merge state, checks on the head commit, review and merge queue, each with an owner; ready only when no reason is listed.](docs/verdict.svg)

## Why

Agents say "green" too early. They read a check list before the last check finished. They read checks that belong to the previous push. They see 100 passing checks and miss the five failures listed after them. They report "CI passed" on a PR that still needs a review, or call an unknown merge state "fine". Each mistake is small. The person who trusted the claim finds out at merge time.

You can compose the right answer yourself from `gh pr view --json …` and `gh pr checks`. It takes about ten rules: pending is not passed; checks belong to one commit; GitHub's aggregate covers more checks than one page lists; `BEHIND` and `BLOCKED` mean something; some reviews block; `UNKNOWN` means ask again; no checks at all means no evidence. This tool applies those rules in one call and returns the result as data an agent can branch on.

A verdict that names the head sha and the time it was observed can be checked later. "The agent said it was green" cannot. Every reason carries a code and an owner (`author`, `reviewer`, `wait`, `unknown`), so an agent loop can tell "fix it", "ask someone", "wait" and "go and look" apart without parsing prose.

Whether this beats a well-instructed `gh` workflow is a claim, so it was measured. In a small paired run on six live public PRs, the agent using this tool gave the expected claim and hand-off in 6 of 6; the same agent using `gh` gave it in 3 of 6, with no false "ready" in either arm. That is a small sample, not a benchmark: the method, the raw counts and their limits are in [DECISIONS.md](DECISIONS.md).

## What it looks like

The same question, same model, same policy text, on cli/cli#14716 at 2026-10-22 15:38 UTC ([transcripts](evals/agent/transcripts/comparison/clean.json)):

> **With `gh`:** "I can't confirm yet that cli/cli#14716 is ready to merge. … the two allowed commands don't show whether the PR is in a merge queue."
>
> **With `pr_readiness`:** "Yes, cli/cli#14716 looks ready to merge. GitHub reported this at 2026-10-22 15:38 UTC for head commit `936921fa9e67cdbf78fb25abc6252afabafef056`: merge state CLEAN … The rollup is SUCCESS. Of 16 checks, 9 passed and 7 were skipped. … The PR is not in a merge queue."

The `gh` baseline was given a fixed field list without `isInMergeQueue`, which is why it could not finish; the tool reads that field.

## Install

Requires Node.js 20 or newer and a GitHub token (see [Auth](#auth)). The package is not on npm yet, so run it from a checkout:

```sh
git clone https://github.com/fabriciopirini/pr-ready-mcp.git
cd pr-ready-mcp
npm ci            # installs and builds dist/
```

Then point your client at `node /absolute/path/to/pr-ready-mcp/dist/index.js`. After the package is published, `npx -y pr-ready-mcp` replaces that command.

**Claude Code**

```sh
claude mcp add pr-ready -- node /absolute/path/to/pr-ready-mcp/dist/index.js
```

**Cursor**: `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{ "mcpServers": { "pr-ready": { "command": "node", "args": ["/absolute/path/to/pr-ready-mcp/dist/index.js"] } } }
```

**Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Desktop apps do not inherit your shell, so pass the token:

```json
{
  "mcpServers": {
    "pr-ready": {
      "command": "node",
      "args": ["/absolute/path/to/pr-ready-mcp/dist/index.js"],
      "env": { "GITHUB_TOKEN": "<token>" }
    }
  }
}
```

**Codex**: `~/.codex/config.toml`:

```toml
[mcp_servers.pr-ready]
command = "node"
args = ["/absolute/path/to/pr-ready-mcp/dist/index.js"]
```

**Any other stdio client**: command `node`, argument `/absolute/path/to/pr-ready-mcp/dist/index.js`, optional env `GITHUB_TOKEN`.

Which of these were exercised, and how, is listed in [DECISIONS.md](DECISIONS.md#release-evidence).

## Using it

Input: `{"pr": "owner/repo#42"}` or `{"pr": "https://github.com/owner/repo/pull/42"}`, plus `"expected_head_sha"` (the full 40-character `git rev-parse HEAD`) after a push. Call it before claiming ready, after every push, and again right before any final claim.

| Prompt                                                                | What happens                                                                       | Expected answer                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| "I just pushed. Is octo-org/widgets#42 ready?"                        | `pr_readiness` with `expected_head_sha`. The PR head is still the previous commit. | "Cannot verify yet: the PR head is `4f1c…`, not the commit you pushed. Check whether the push landed." |
| "CI is green on octo-org/widgets#42. Can I tell the team it's ready?" | Verdict `not_ready`, reason `review_required` (owner `reviewer`).                  | "Not ready: the required review is not satisfied. Ask a reviewer."                                     |
| "Is octo-org/widgets#42 ready?" right after a push                    | Verdict `not_ready`, reason `checks_missing` (owner `wait`).                       | "Cannot verify yet: no check has reported on this head. Ask again in a minute."                        |

Full schemas: [docs/tools.md](docs/tools.md). Machine-readable summary: [llms.txt](llms.txt).

### When is a PR ready?

> `ready` means: GitHub's aggregate for the head commit is `CLEAN`, the check rollup on that commit is `SUCCESS`, no review decision blocks, the PR is not queued, and the head is the one you expected. `not_ready` means **not verified ready**: its reason codes distinguish a known blocker from evidence that is not in yet, scope the tool does not cover, or the wrong head. `merged` and `closed` are reported, not judged.

A failing or still-running optional check does not stop GitHub's merge button, but this rule waits for it: until it finishes, the PR's colour is not final. `facts.merge_state` always carries GitHub's own aggregate, and each listed check carries `required`.

| Code                      | Owner         | Meaning                                                                                           |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `draft`                   | author        | The PR is a draft.                                                                                |
| `conflicts`               | author        | It conflicts with the base branch.                                                                |
| `behind_base`             | author        | GitHub reports the head as out of date with the base.                                             |
| `checks_failing`          | author        | A check failed, errored, was cancelled or timed out on the head.                                  |
| `checks_pending`          | wait          | A check is queued or running.                                                                     |
| `review_required`         | reviewer      | The review requirement is not satisfied.                                                          |
| `changes_requested`       | author        | A reviewer requested changes.                                                                     |
| `merge_queue`             | wait          | The PR is in the merge queue.                                                                     |
| `blocked_by_branch_rule`  | unknown       | GitHub blocks the merge for a rule the tool cannot read (signatures, code owners, deployments …). |
| `mergeable_unknown`       | wait          | _Cannot verify yet_: GitHub has not computed mergeability.                                        |
| `checks_missing`          | wait          | _Cannot verify yet_: no check has reported on the head.                                           |
| `stale_head`              | wait / author | _Cannot verify yet_: checks are for an older commit, or the head is not the commit you expected.  |
| `unsupported_merge_state` | unknown       | _Cannot verify_: `HAS_HOOKS`, an unexplained `UNSTABLE`, or a state the tool does not know.       |

`owner` is a hand-off hint: whose move it is. It is not permission to act, not a statement of who caused the problem, and not a claim that anything else is clear. A `fix` never contains a write command.

A merged or closed PR queried with a different `expected_head_sha` is `not_ready` with `stale_head`: it reached that state, but not with the commit you asked about.

### Errors

Failures return `isError: true` and JSON text, never a verdict:

```json
{
  "code": "rate_limited",
  "message": "GitHub rate limit reached; retry in 60s.",
  "retryable": true,
  "retry_after_seconds": 60
}
```

Codes: `invalid_input`, `auth_required`, `forbidden`, `not_found_or_inaccessible`, `rate_limited`, `upstream_error`, `invalid_response`. `retry_after_seconds` appears only when GitHub sent a reset time. Any GraphQL error, even beside partial data, is `invalid_response`: a missing field is never judged as a pass. Arguments that fail the input schema are rejected by the MCP SDK with its own plain-text error.

## Auth

The token is read on the first call: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Classic tokens and the `gh` token usually carry far more access than this tool needs. For public repositories, a fine-grained token with "Public repositories (read-only)" access should be enough; private repositories additionally need read access to pull requests, commit statuses and checks. Neither fine-grained setup has been exercised yet; see [DECISIONS.md](DECISIONS.md#limitations).

## Limitations

- GitHub.com only, one PR per call, PRs with CI. A repository without CI gets `checks_missing`, never `ready`.
- Check names are read for the first 100 checks. GitHub's rollup and per-state counts cover all of them, so the verdict does not depend on the cap; `facts.checks.details_complete` says when the name lists are a sample.
- Branch rules are not read. When GitHub says `BLOCKED` and nothing visible explains it, the tool says so (`blocked_by_branch_rule`) and points at the PR page.
- Every call is a fresh read. A verdict is an observation at `checked_at`, not a lock: a review, a rerun or a base change can alter it on the same head.
- The server only reads. It never merges, marks a draft ready, pushes, re-runs checks or writes any file.

## Development

```sh
npm ci
npm test              # contract tests, offline, no token
npm run typecheck
npm run lint
npm run docs          # regenerate docs/tools.md after changing the schema or description
node scripts/smoke.mjs   # start the built server and run a replayed decision over stdio
```

`test/fixtures/` holds recorded public PR responses (`node scripts/record-fixture.ts <pr> <name>`) and `scenarios.json`, one explicit override per failure mode with the reason it exists. `evals/agent/` holds the agent runs: `run.mjs` (Claude Code, adversarial or paired comparison), `score.mjs`, and the transcripts.

## License

[MIT](LICENSE)
