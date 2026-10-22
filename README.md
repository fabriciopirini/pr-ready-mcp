# pr-ready-mcp

An [MCP](https://modelcontextprotocol.io) server that tells an agent whether a GitHub pull request is ready to merge, and what to fix when it is not.

Agents are quick to say "the PR is ready". `pr_readiness` checks that claim against live GitHub data and answers with a verdict, the head commit the verdict is for, and one machine-readable reason per blocker, each with a concrete fix:

```json
{
  "pr": "https://github.com/octo-org/widgets/pull/44",
  "verdict": "not_ready",
  "head_sha": "9f4c2e71b3a8d6f0e5c4b2a19876543210fedcba",
  "reasons": [
    {
      "code": "checks_failing",
      "detail": "Failing checks: test (22), ci/lint.",
      "fix": "Read the failing check logs (`gh pr checks https://github.com/octo-org/widgets/pull/44`), fix the cause, push."
    }
  ],
  "facts": {
    "state": "OPEN",
    "draft": false,
    "mergeable": "MERGEABLE",
    "review_decision": "APPROVED",
    "checks": {
      "total": 3,
      "by_conclusion": { "SUCCESS": 1, "FAILURE": 1, "ERROR": 1 },
      "failing": ["test (22)", "ci/lint"],
      "pending": []
    },
    "unsigned_commits": 0,
    "requested_reviewers": [],
    "lint_hits": []
  }
}
```

## Tools

| Tool           | What it answers                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr_readiness` | Is this PR ready? Verdict `ready` / `not_ready` / `merged` / `closed`, blocking reasons with fixes, and the raw facts.                                                     |
| `pr_body_lint` | Does this PR description have an empty body, unchecked task boxes, TODO markers, or (when the repo requires one) no linked issue? Works on a published PR or a draft body. |

Both tools are read-only. Full input and output schemas: [docs/tools.md](docs/tools.md).

### When is a PR `ready`?

An open PR is `ready` only when none of these hold:

| Reason code           | Condition                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `draft`               | The PR is a draft.                                                                         |
| `conflicts`           | It conflicts with its base branch.                                                         |
| `mergeable_unknown`   | GitHub has not computed mergeability yet.                                                  |
| `checks_failing`      | A check run or commit status failed, errored, was cancelled or timed out.                  |
| `checks_pending`      | A check is queued or still running.                                                        |
| `unsigned_commits`    | A commit has no verified signature.                                                        |
| `stale_head`          | The checks are for an older commit, or the head is not the `expected_head_sha` you passed. |
| `body_lint`           | `pr_body_lint` finds problems in the description.                                          |
| `too_large_to_verify` | More than 100 commits or checks: the rest were not read.                                   |

Review decision and requested reviewers are reported in `facts` but never block: the author cannot clear them alone. Merged and closed PRs are reported, not judged.

### Example prompts

- "I just pushed `4f1c2e7` to octo-org/widgets#42. Is it ready?" → `pr_readiness` with `expected_head_sha`, so the answer cannot describe the previous push.
- "Check my PR description before I open it." → `pr_body_lint` with `body`.
- "Why is https://github.com/octo-org/widgets/pull/42 not mergeable?" → `pr_readiness`, then follow each reason's `fix`.

## Install

Requires Node.js 20 or newer and a GitHub token. The server reads `GITHUB_TOKEN` (or `GH_TOKEN`), and falls back to `gh auth token` when the [GitHub CLI](https://cli.github.com) is signed in. The token only needs read access to the repositories you ask about.

Run it with `npx -y pr-ready-mcp`. Until the package is on npm, use `npx -y github:fabriciopirini/pr-ready-mcp` in the configs below instead.

GUI clients such as Claude Desktop do not inherit your shell, so give them the token in `env` rather than relying on `gh`.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "pr-ready": {
      "command": "npx",
      "args": ["-y", "pr-ready-mcp"],
      "env": { "GITHUB_TOKEN": "<your token>" }
    }
  }
}
```

### Claude Code

```sh
claude mcp add pr-ready -- npx -y pr-ready-mcp
```

### Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "pr-ready": { "command": "npx", "args": ["-y", "pr-ready-mcp"] }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.pr-ready]
command = "npx"
args = ["-y", "pr-ready-mcp"]
```

### omp

`~/.omp/agent/mcp.json`, or `.omp/mcp.json` in a project:

```json
{
  "mcpServers": {
    "pr-ready": { "type": "stdio", "command": "npx", "args": ["-y", "pr-ready-mcp"] }
  }
}
```

## Development

```sh
npm install      # also builds dist/
npm test         # offline evals, no network or token needed
npm run typecheck
npm run lint
npm run docs     # regenerate docs/tools.md after changing a schema or description
```

`npm test` runs two kinds of evals against the real server through an MCP client:
- **Verdict evals.** Each file in [`test/fixtures/`](test/fixtures) is a GitHub GraphQL response with the input and the expected verdict and reason codes: clean, draft, conflicting, failing check, pending check, unsigned commit, stale head, lint hits, merged and closed. The fixtures use a synthetic `octo-org/widgets` repository.
- **Agent-facing evals.** The scripted client checks that every answer parses against the advertised output schema, that the text and structured content agree, that every reason has a known code and a fix, that bad input comes back as an actionable tool error, and that the stdio entry point starts.

To add a case, add a fixture with a new PR number and its `expected` block; the eval picks it up.

## License

[MIT](LICENSE)
