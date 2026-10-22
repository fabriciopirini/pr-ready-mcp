import type { PullRequest } from "./github.ts";
import { type LintOptions, lintBody } from "./lint.ts";
import type { Readiness, ReasonCode } from "./schema.ts";

const PASSED: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };
const PENDING: Record<string, true> = {
  PENDING: true,
  EXPECTED: true,
  QUEUED: true,
  IN_PROGRESS: true,
  WAITING: true,
  REQUESTED: true,
};

/**
 * Judges a pull request. Merged and closed PRs are reported, not judged.
 * `expectedHead` is the commit the caller believes is the PR head (e.g. what it just pushed);
 * a mismatch makes the verdict `not_ready` with `stale_head`.
 */
export function judge(pr: PullRequest, lint: LintOptions = {}, expectedHead?: string): Readiness {
  const head = pr.headCommit.nodes[0]?.commit;
  const contexts = head?.statusCheckRollup?.contexts ?? { totalCount: 0, nodes: [] };
  const checks: Readiness["facts"]["checks"] = {
    total: contexts.totalCount,
    by_conclusion: {},
    failing: [],
    pending: [],
  };
  for (const c of contexts.nodes) {
    // A check run has no conclusion until it completes; a commit status only has a state.
    const [name, result] = c.__typename === "CheckRun" ? [c.name, c.conclusion ?? c.status] : [c.context, c.state];
    checks.by_conclusion[result] = (checks.by_conclusion[result] ?? 0) + 1;
    if (PENDING[result]) checks.pending.push(name);
    else if (!PASSED[result]) checks.failing.push(name);
  }
  const unsigned = pr.commits.nodes.filter((n) => !n.commit.signature?.isValid).length;
  const lintHits = lintBody(pr.body, { ...lint, has_linked_issue: pr.closingIssuesReferences.totalCount > 0 });

  const reasons: Readiness["reasons"] = [];
  const add = (code: ReasonCode, detail: string, fix: string) => reasons.push({ code, detail, fix });
  if (pr.isDraft) add("draft", "The PR is a draft.", `Mark it ready for review: \`gh pr ready ${pr.url}\`.`);
  if (pr.mergeable === "CONFLICTING")
    add(
      "conflicts",
      "The PR conflicts with its base branch.",
      "Merge or rebase onto the base branch, resolve the conflicts, push.",
    );
  if (pr.mergeable === "UNKNOWN")
    add("mergeable_unknown", "GitHub has not computed mergeability yet.", "Call pr_readiness again in a few seconds.");
  if (checks.failing.length)
    add(
      "checks_failing",
      `Failing checks: ${checks.failing.join(", ")}.`,
      `Read the failing check logs (\`gh pr checks ${pr.url}\`), fix the cause, push.`,
    );
  if (checks.pending.length)
    add(
      "checks_pending",
      `Checks still running: ${checks.pending.join(", ")}.`,
      "Wait for the checks to finish, then call pr_readiness again.",
    );
  if (unsigned)
    add(
      "unsigned_commits",
      `${unsigned} commit(s) without a verified signature.`,
      "Configure commit signing, re-sign the commits (`git rebase --exec 'git commit --amend --no-edit -S' <base>`), force-push.",
    );
  if (head?.oid !== pr.headRefOid)
    add(
      "stale_head",
      `Check results are for ${head?.oid ?? "no commit"}, not the head ${pr.headRefOid}.`,
      "Call pr_readiness again in a few seconds.",
    );
  else if (expectedHead && !pr.headRefOid.startsWith(expectedHead))
    add(
      "stale_head",
      `The PR head is ${pr.headRefOid}, not the expected ${expectedHead}.`,
      "Push your latest commit, then call pr_readiness again with its sha.",
    );
  if (lintHits.length)
    add(
      "body_lint",
      `${lintHits.length} PR body problem(s): ${[...new Set(lintHits.map((h) => h.rule))].join(", ")}.`,
      "Fix the PR body; facts.lint_hits lists each problem with a fix.",
    );
  // ponytail: one page of commits and checks; paginate if PRs this large need a verdict.
  if (pr.commits.totalCount > pr.commits.nodes.length || contexts.totalCount > contexts.nodes.length)
    add(
      "too_large_to_verify",
      "More than 100 commits or checks; only the first 100 were read.",
      `Verify the rest by hand with \`gh pr checks ${pr.url}\` and \`gh pr view ${pr.url} --json commits\`.`,
    );

  return {
    pr: pr.url,
    verdict:
      pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : reasons.length ? "not_ready" : "ready",
    head_sha: pr.headRefOid,
    reasons: pr.state === "OPEN" ? reasons : [],
    facts: {
      state: pr.state,
      draft: pr.isDraft,
      mergeable: pr.mergeable,
      review_decision: pr.reviewDecision,
      checks,
      unsigned_commits: unsigned,
      requested_reviewers: pr.reviewRequests.nodes.flatMap(
        (n) => n.requestedReviewer?.login ?? n.requestedReviewer?.combinedSlug ?? [],
      ),
      lint_hits: lintHits,
    },
  };
}
