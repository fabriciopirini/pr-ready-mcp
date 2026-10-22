import { z } from "zod";

export const REASON_CODES = [
  "draft",
  "conflicts",
  "mergeable_unknown",
  "behind_base",
  "checks_failing",
  "checks_pending",
  "checks_missing",
  "stale_head",
  "review_required",
  "changes_requested",
  "merge_queue",
  "unsupported_merge_state",
  "blocked_by_branch_rule",
] as const;

export const readinessInput = z.strictObject({
  pr: z
    .string()
    .describe('The pull request: "owner/repo#42" or "https://github.com/owner/repo/pull/42". GitHub.com only.'),
  expected_head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, "expected_head_sha must be the full 40-character sha from `git rev-parse HEAD`")
    .optional()
    .describe(
      "The full 40-character sha you expect at the PR head: run `git rev-parse HEAD` after your push. If the PR head differs, the verdict is not_ready with stale_head.",
    ),
});

const check = z.object({
  name: z.string().describe("Check run or commit status name, as the repository named it."),
  required: z.boolean().describe("Whether the repository requires it. A label only: it never changes the verdict."),
  url: z.string().nullable().describe("Where to read its result."),
});

export const readinessOutput = z.object({
  pr: z.string().describe("The canonical PR URL."),
  verdict: z
    .enum(["ready", "not_ready", "merged", "closed"])
    .describe("ready only when reasons is empty. not_ready means not verified ready; reasons say why."),
  head_sha: z.string().describe("The PR head commit this verdict is for."),
  checked_at: z.string().describe("When GitHub was read (ISO 8601). An observation, not a lease."),
  reasons: z
    .array(
      z.object({
        code: z.enum(REASON_CODES),
        owner: z
          .enum(["author", "reviewer", "wait", "unknown"])
          .describe("Whose move it is: a hand-off hint, not permission to act and not a claim about other reasons."),
        detail: z.string().describe("What was observed: counts and categories."),
        fix: z.string().describe("The next step. Inspection first; never a write command."),
      }),
    )
    .describe("Every reason the PR is not verified ready. Empty when ready, merged or closed."),
  facts: z.object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    draft: z.boolean(),
    base: z.string().describe("The base branch."),
    merge_state: z
      .string()
      .describe("GitHub's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS or UNKNOWN."),
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    in_merge_queue: z.boolean(),
    review_decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
    requested_reviewers: z.array(z.string()).describe("Users and teams (org/team) asked to review."),
    checks: z.object({
      rollup: z
        .enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"])
        .nullable()
        .describe("GitHub's combined state over every check on the head; null when none has reported."),
      total: z.number().describe("Checks on the head commit."),
      listed: z.number().describe("Checks read by name (at most 100)."),
      details_complete: z.boolean().describe("False when failing and pending below are a sample of the first 100."),
      by_state: z.record(z.string(), z.number()).describe('Complete count per state, e.g. {"SUCCESS": 18}.'),
      failing: z.array(check),
      pending: z.array(check),
    }),
  }),
});

export type Readiness = z.infer<typeof readinessOutput>;
export type Reason = Readiness["reasons"][number];
