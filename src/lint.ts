import type { LintHit, LintRule } from "./schema.ts";

export type LintOptions = {
  /** Report `missing_linked_issue` when the body neither closes nor references an issue. */
  require_linked_issue?: boolean;
  /** Rules to skip. */
  ignore_rules?: LintRule[];
  /** GitHub already links a closing issue to this PR (e.g. through the sidebar). */
  has_linked_issue?: boolean;
};

const ISSUE_REF = /(?:^|[\s(])(?:[\w.-]+\/[\w.-]+)?#\d+\b|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/;

/** Lints a pull request body. Text inside HTML comments and code is ignored; line numbers are 1-based. */
export function lintBody(body: string, opts: LintOptions = {}): LintHit[] {
  // Blank out comments and code but keep their newlines, so line numbers still match the body.
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const text = body
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank);
  const lines = text.split("\n");
  const hits: LintHit[] = [];

  if (!text.trim()) {
    hits.push({
      rule: "empty_body",
      line: 1,
      message: "The body is empty (or only template comments).",
      fix: "Describe what the PR changes and how it was tested.",
    });
  }
  lines.forEach((l, i) => {
    if (/^\s*(?:[-*+]|\d+\.)\s+\[ \]/.test(l))
      hits.push({
        rule: "unchecked_box",
        line: i + 1,
        message: `Unchecked box: ${l.trim()}`,
        fix: "Do the item and tick it, or delete the line if it does not apply.",
      });
    const todo = l.match(/\b(TODO|FIXME|TBD|XXX)\b/);
    if (todo)
      hits.push({
        rule: "todo_marker",
        line: i + 1,
        message: `${todo[1]} marker: ${l.trim()}`,
        fix: "Resolve it or replace it with the decision taken.",
      });
  });
  if (opts.require_linked_issue && !opts.has_linked_issue && !ISSUE_REF.test(text)) {
    hits.push({
      rule: "missing_linked_issue",
      line: 1,
      message: "No linked issue: this repository requires one.",
      fix: 'Add "Closes #<issue>" (or "Closes owner/repo#<issue>") to the body.',
    });
  }
  const ignored = new Set(opts.ignore_rules);
  return hits.filter((h) => !ignored.has(h.rule));
}
