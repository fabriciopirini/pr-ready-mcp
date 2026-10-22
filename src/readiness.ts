import type { PullRequest } from "./github.ts";
import type { Readiness, Reason } from "./schema.ts";

const PASSED: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };
const PENDING: Record<string, true> = {
  PENDING: true,
  EXPECTED: true,
  QUEUED: true,
  IN_PROGRESS: true,
  WAITING: true,
  REQUESTED: true,
};
const MERGE_STATES: Record<string, true> = {
  CLEAN: true,
  BLOCKED: true,
  BEHIND: true,
  DIRTY: true,
  UNSTABLE: true,
  HAS_HOOKS: true,
  UNKNOWN: true,
};

/**
 * Judges a pull request (README, "When is a PR ready?"). Merged and closed PRs are reported, not
 * judged, unless `expectedHead` names a different commit: then the requested identity was not verified.
 */
export function judge(pr: PullRequest, expectedHead?: string, checkedAt = new Date()): Readiness {
  const commit = pr.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup ?? null;
  const contexts = rollup?.contexts;

  // Complete per-state counts come from GitHub's aggregates; names only from the first 100 contexts.
  const byState: Record<string, number> = {};
  for (const { state, count } of [
    ...(contexts?.checkRunCountsByState ?? []),
    ...(contexts?.statusContextCountsByState ?? []),
  ])
    if (count) byState[state] = (byState[state] ?? 0) + count;
  const sum = (keep: (state: string) => boolean) =>
    Object.entries(byState).reduce((n, [state, count]) => (keep(state) ? n + count : n), 0);
  const failingCount = sum((s) => !PASSED[s] && !PENDING[s]);
  const pendingCount = sum((s) => !!PENDING[s]);

  const checks: Readiness["facts"]["checks"] = {
    rollup: rollup?.state ?? null,
    total: contexts?.totalCount ?? 0,
    listed: contexts?.nodes.length ?? 0,
    details_complete: (contexts?.nodes.length ?? 0) === (contexts?.totalCount ?? 0),
    by_state: byState,
    failing: [],
    pending: [],
  };
  for (const c of contexts?.nodes ?? []) {
    // A check run has no conclusion until it completes; a commit status only has a state.
    const [name, result, url] =
      c.__typename === "CheckRun"
        ? [c.name, c.conclusion ?? c.status, c.detailsUrl]
        : [c.context, c.state, c.targetUrl];
    if (PENDING[result]) checks.pending.push({ name, required: c.isRequired, url });
    else if (!PASSED[result]) checks.failing.push({ name, required: c.isRequired, url });
  }

  const reasons: Reason[] = [];
  const add = (code: Reason["code"], owner: Reason["owner"], detail: string, fix: string) =>
    reasons.push({ code, owner, detail, fix });
  const listedNote = `${checks.listed} of ${checks.total} listed by name.`;

  if (expectedHead && expectedHead !== pr.headRefOid)
    add(
      "stale_head",
      "author",
      `The PR head is ${pr.headRefOid}, not the ${expectedHead} you expected.`,
      "Inspect both commits (did the push land, or did someone else push?). Do not push or force-push to make them match.",
    );

  if (pr.state === "OPEN") {
    const mergeState = pr.mergeStateStatus;
    if (pr.isDraft)
      add(
        "draft",
        "author",
        "The PR is a draft.",
        "Confirm with whoever opened it that it should leave draft; marking it ready is a human decision.",
      );
    if (mergeState === "DIRTY" || pr.mergeable === "CONFLICTING")
      add(
        "conflicts",
        "author",
        "The PR conflicts with its base branch.",
        "Resolve the conflicts against the base on a local branch and push normally.",
      );
    if (mergeState === "UNKNOWN" || pr.mergeable === "UNKNOWN")
      add(
        "mergeable_unknown",
        "wait",
        "GitHub has not computed mergeability yet.",
        "Call pr_readiness again shortly. Not verified, not a blocker.",
      );
    if (mergeState === "BEHIND")
      add(
        "behind_base",
        "author",
        "GitHub reports the head as out of date with the base branch.",
        "Update the branch with the base, then push.",
      );

    if (!rollup)
      add(
        "checks_missing",
        "wait",
        "No check has reported on the head commit.",
        "After a push, checks usually appear within a minute; call pr_readiness again. If the repository has no CI, this tool cannot verify readiness; facts.merge_state is GitHub's own aggregate.",
      );
    else if (commit.oid !== pr.headRefOid)
      add(
        "stale_head",
        "wait",
        `Check results are for ${commit.oid}, not the head ${pr.headRefOid}.`,
        "Call pr_readiness again shortly.",
      );
    else {
      if (failingCount || rollup.state === "FAILURE" || rollup.state === "ERROR")
        add(
          "checks_failing",
          "author",
          `${failingCount} of ${checks.total} checks failed on the head commit; ${listedNote}`,
          "Open the URLs in facts.checks.failing and read the logs before assuming the code or the author caused it. A check marked required: false is not required by the repository; this tool still waits for it to pass or be re-run.",
        );
      if (pendingCount || rollup.state === "PENDING" || rollup.state === "EXPECTED")
        add(
          "checks_pending",
          "wait",
          `${pendingCount} of ${checks.total} checks have not finished on the head commit; ${listedNote}`,
          "Wait for them to finish, then call pr_readiness again.",
        );
    }

    if (pr.reviewDecision === "REVIEW_REQUIRED")
      add(
        "review_required",
        "reviewer",
        "The review requirement is not satisfied.",
        "Ask the appropriate reviewer; inspect the other reasons for work that is still yours.",
      );
    if (pr.reviewDecision === "CHANGES_REQUESTED")
      add(
        "changes_requested",
        "author",
        "A reviewer requested changes.",
        "Read the review, address it, push, and re-request review.",
      );
    if (pr.isInMergeQueue)
      add(
        "merge_queue",
        "wait",
        "The PR is in the merge queue.",
        "GitHub merges or ejects it; call pr_readiness again later. This tool does not evaluate queue eligibility.",
      );

    const checksExplain = reasons.some((r) => r.code === "checks_failing" || r.code === "checks_pending");
    if (!MERGE_STATES[mergeState] || mergeState === "HAS_HOOKS" || (mergeState === "UNSTABLE" && !checksExplain))
      add(
        "unsupported_merge_state",
        "unknown",
        `GitHub reports merge state ${MERGE_STATES[mergeState] ? mergeState : "(unrecognised)"}, which this tool cannot evaluate or attribute.`,
        `Inspect the PR page: ${pr.url}. Not verified.`,
      );
    if (mergeState === "BLOCKED" && reasons.length === 0)
      add(
        "blocked_by_branch_rule",
        "unknown",
        "GitHub blocks the merge for a rule this tool cannot read (for example required signatures, code owners, conversation resolution or deployments).",
        `Open the PR page; the merge box names the rule: ${pr.url}.`,
      );
  }

  const terminal = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : undefined;
  return {
    pr: pr.url,
    verdict: reasons.length ? "not_ready" : (terminal ?? "ready"),
    head_sha: pr.headRefOid,
    checked_at: checkedAt.toISOString(),
    reasons,
    facts: {
      state: pr.state,
      draft: pr.isDraft,
      base: pr.baseRefName,
      merge_state: pr.mergeStateStatus,
      mergeable: pr.mergeable,
      in_merge_queue: pr.isInMergeQueue,
      review_decision: pr.reviewDecision,
      requested_reviewers: pr.reviewRequests.nodes.flatMap(
        (n) => n.requestedReviewer?.login ?? n.requestedReviewer?.combinedSlug ?? [],
      ),
      checks,
    },
  };
}
