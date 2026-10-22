import { z } from "zod";

export const LINT_RULES = ["empty_body", "unchecked_box", "todo_marker", "missing_linked_issue"] as const;
export const REASON_CODES = [
  "draft",
  "conflicts",
  "mergeable_unknown",
  "checks_failing",
  "checks_pending",
  "unsigned_commits",
  "stale_head",
  "body_lint",
  "too_large_to_verify",
] as const;

const pr = z
  .string()
  .describe(
    'The pull request: a URL ("https://github.com/octo-org/widgets/pull/42"), "octo-org/widgets#42" or "octo-org/widgets/42".',
  );

export const lintOptions = {
  require_linked_issue: z
    .boolean()
    .default(false)
    .describe('Set true when the repository requires every PR to reference an issue (e.g. "Closes #12").'),
  ignore_rules: z.array(z.enum(LINT_RULES)).default([]).describe("Lint rules to skip."),
};

export const readinessInput = z.object({
  pr,
  expected_head_sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional()
    .describe(
      "The commit you expect at the PR head, e.g. the output of `git rev-parse HEAD` after your last push. When the PR head differs, the verdict is not_ready with reason stale_head.",
    ),
  ...lintOptions,
});

export const lintInput = z.object({
  pr: pr.optional().describe(`${pr.description} Give this or body.`),
  body: z.string().optional().describe("A PR body to lint before publishing it. Give this or pr."),
  ...lintOptions,
});

export const lintHit = z.object({
  rule: z.enum(LINT_RULES),
  line: z.number().describe("1-based line in the body."),
  message: z.string(),
  fix: z.string().describe("What to change to clear the hit."),
});

export const lintOutput = z.object({
  target: z.string().describe('The PR URL, or "body" when a body was given.'),
  clean: z.boolean().describe("True when there are no hits."),
  hits: z.array(lintHit),
});

export const readinessOutput = z.object({
  pr: z.string().describe("The PR URL."),
  verdict: z
    .enum(["ready", "not_ready", "merged", "closed"])
    .describe("ready only when reasons is empty. merged and closed PRs are reported, not judged."),
  head_sha: z.string().describe("The PR head commit this verdict is for."),
  reasons: z
    .array(
      z.object({
        code: z.enum(REASON_CODES),
        detail: z.string(),
        fix: z.string().describe("The next action that clears this reason."),
      }),
    )
    .describe("Everything blocking a ready verdict. Empty when ready, merged or closed."),
  facts: z.object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    draft: z.boolean(),
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    review_decision: z
      .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
      .nullable()
      .describe("Reported, not judged: the author cannot clear it alone."),
    checks: z.object({
      total: z.number(),
      by_conclusion: z.record(z.string(), z.number()).describe('Check count per conclusion, e.g. {"SUCCESS": 4}.'),
      failing: z.array(z.string()).describe("Names of failed, cancelled or timed-out checks."),
      pending: z.array(z.string()).describe("Names of checks not finished yet."),
    }),
    unsigned_commits: z.number().describe("Commits without a verified signature."),
    requested_reviewers: z.array(z.string()).describe("Users and teams (org/team) still asked to review."),
    lint_hits: z.array(lintHit),
  }),
});

export type LintRule = (typeof LINT_RULES)[number];
export type LintHit = z.infer<typeof lintHit>;
export type ReasonCode = (typeof REASON_CODES)[number];
export type Readiness = z.infer<typeof readinessOutput>;
