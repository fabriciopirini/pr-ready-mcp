import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GitHub, type PrRef, parsePrRef } from "./github.ts";
import { lintBody } from "./lint.ts";
import { judge } from "./readiness.ts";
import { lintInput, lintOutput, readinessInput, readinessOutput } from "./schema.ts";

const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

function ref(pr: string): PrRef {
  const r = parsePrRef(pr);
  if (!r)
    throw new Error(`Not a pull request: "${pr}". Use "https://github.com/owner/repo/pull/123" or "owner/repo#123".`);
  return r;
}

function result<T extends object>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

/** Builds the MCP server. Thrown errors reach the client as tool results with isError set. */
export function createServer(github: GitHub): McpServer {
  const server = new McpServer({ name: "pr-ready-mcp", version: "0.1.0" });

  server.registerTool(
    "pr_readiness",
    {
      title: "PR readiness",
      description: `Decide whether a GitHub pull request is ready to merge, from live GitHub data. Call it before telling anyone a PR is ready, green or done.

Returns a verdict (ready / not_ready / merged / closed), the head sha the verdict is for, every blocking reason with a machine code and a fix, and the raw facts (draft, mergeable, review decision, checks by conclusion with failing and pending names, unsigned commits, requested reviewers, PR body lint hits).

A PR is not_ready when it is a draft, conflicts with its base, has failing or still-running checks, has commits without a verified signature, has body lint hits, or its checks are not for the current head. Review approval is reported in facts but does not block.

Pass expected_head_sha after a push so the verdict cannot describe an older commit.

Example: {"pr": "octo-org/widgets#42", "expected_head_sha": "4f1c2e7"}`,
      inputSchema: readinessInput,
      outputSchema: readinessOutput,
      annotations,
    },
    async ({ pr, expected_head_sha, ...lint }) =>
      result(judge(await github.pullRequest(ref(pr)), lint, expected_head_sha)),
  );

  server.registerTool(
    "pr_body_lint",
    {
      title: "PR body lint",
      description: `Check a pull request description for problems a reviewer would bounce: empty body, unchecked task boxes ("- [ ]"), TODO/FIXME/TBD/XXX markers, and (with require_linked_issue) no linked issue. Text in HTML comments and code is ignored.

Lint a published PR with pr, or a draft body before publishing with body. Each hit has a rule, a line number and a fix.

Examples: {"pr": "https://github.com/octo-org/widgets/pull/42"} or {"body": "Adds retries.\\n\\n- [ ] update docs", "require_linked_issue": true}`,
      inputSchema: lintInput,
      outputSchema: lintOutput,
      annotations,
    },
    async ({ pr, body, ...opts }) => {
      if ((pr === undefined) === (body === undefined)) throw new Error("Give exactly one of pr or body.");
      let target = "body";
      let hasLinkedIssue = false;
      if (pr !== undefined) {
        const p = await github.pullRequest(ref(pr));
        [target, body, hasLinkedIssue] = [p.url, p.body, p.closingIssuesReferences.totalCount > 0];
      }
      const hits = lintBody(body ?? "", { ...opts, has_linked_issue: hasLinkedIssue });
      return result({ target, clean: hits.length === 0, hits });
    },
  );

  return server;
}
