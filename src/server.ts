import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GitHub, parsePrRef, ToolError } from "./github.ts";
import { judge } from "./readiness.ts";
import { readinessInput, readinessOutput } from "./schema.ts";

const DESCRIPTION = `Check whether a GitHub pull request is verified ready to merge, from live GitHub data.

Call it before you say a PR is ready, green, mergeable or done; after every push; and again immediately before any final claim. Pass expected_head_sha = the full sha from \`git rev-parse HEAD\` after your push.

verdict: ready | not_ready | merged | closed. ready means GitHub's merge state is CLEAN, every check on the head passed, no review decision blocks, the PR is not queued, and the head is the one you expected. Stricter than the merge button: an optional failing or running check also blocks. not_ready means not verified ready; reasons say why.

Each reason has a code, an owner, a detail and a fix. The codes mergeable_unknown, checks_missing, stale_head and unsupported_merge_state mean "cannot verify yet": report them as that, not as a defect. Every other code is a known obstacle, checks_pending and blocked_by_branch_rule included. owner (author | reviewer | wait | unknown) says whose move it is; it is not permission to act and not a claim that anything else is clear.

This tool reads; it never merges, publishes a draft, pushes or rewrites history, and its verdict does not authorise you to. Ready, green, merged and done are different words: use the one the verdict supports, with head_sha and checked_at.

Errors come back as isError with JSON text {code, message, retryable, retry_after_seconds?}.

Example: {"pr": "octo-org/widgets#42", "expected_head_sha": "4f1c2e7a9b0d3c6e8f1a2b4c5d6e7f8091a2b3c4"}`;

function errorResult(e: unknown) {
  const err = e instanceof ToolError ? e : new ToolError("upstream_error", "Unexpected failure while reading GitHub.");
  const body = {
    code: err.code,
    message: err.message,
    retryable: err.retryable,
    ...(err.retryAfterSeconds === undefined ? {} : { retry_after_seconds: err.retryAfterSeconds }),
  };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

/** Builds the MCP server with its one tool. */
export function createServer(github: GitHub): McpServer {
  const server = new McpServer({ name: "pr-ready-mcp", version: "0.1.0" });

  server.registerTool(
    "pr_readiness",
    {
      title: "PR readiness",
      description: DESCRIPTION,
      inputSchema: readinessInput,
      outputSchema: readinessOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ pr, expected_head_sha }) => {
      try {
        const ref = parsePrRef(pr);
        if (!ref)
          throw new ToolError(
            "invalid_input",
            'pr must be "owner/repo#123" or "https://github.com/owner/repo/pull/123".',
          );
        const result = judge(await github.pullRequest(ref), expected_head_sha);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
