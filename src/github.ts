import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** A pull request address. */
export type PrRef = { owner: string; repo: string; number: number };

/** Parses `https://github.com/o/r/pull/1`, `o/r#1` or `o/r/1`. Returns undefined for anything else. */
export function parsePrRef(input: string): PrRef | undefined {
  const m =
    input.trim().match(/^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/) ??
    input.trim().match(/^([\w.-]+)\/([\w.-]+)(?:#|\/)(\d+)$/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url state isDraft mergeable reviewDecision headRefOid body
      closingIssuesReferences(first: 1) { totalCount }
      reviewRequests(first: 100) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } } }
      }
      commits(first: 100) { totalCount nodes { commit { oid signature { isValid } } } }
      headCommit: commits(last: 1) {
        nodes { commit { oid statusCheckRollup { contexts(first: 100) {
          totalCount
          nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }
        } } } }
      }
    }
  }
}`;

type CheckContext =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string };

/** The pull request as the GraphQL API returns it for PR_QUERY. */
export type PullRequest = {
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRefOid: string;
  body: string;
  closingIssuesReferences: { totalCount: number };
  reviewRequests: { nodes: { requestedReviewer: { login?: string; combinedSlug?: string } | null }[] };
  commits: { totalCount: number; nodes: { commit: { oid: string; signature: { isValid: boolean } | null } }[] };
  headCommit: {
    nodes: {
      commit: {
        oid: string;
        statusCheckRollup: { contexts: { totalCount: number; nodes: CheckContext[] } } | null;
      };
    }[];
  };
};

/** Reads pull requests from GitHub. */
export type GitHub = { pullRequest(ref: PrRef): Promise<PullRequest> };

async function defaultToken(): Promise<string> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"]);
    if (stdout.trim()) return stdout.trim();
  } catch {}
  throw new Error("No GitHub token: set GITHUB_TOKEN, or sign in with `gh auth login`.");
}

/** GitHub GraphQL client. The token is resolved on the first request, not at startup. */
export function createGitHub({ fetch = globalThis.fetch, token = defaultToken } = {}): GitHub {
  return {
    async pullRequest(ref) {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { authorization: `bearer ${await token()}`, "content-type": "application/json" },
        body: JSON.stringify({ query: PR_QUERY, variables: ref }),
      });
      if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as {
        data?: { repository: { pullRequest: PullRequest | null } | null };
        errors?: { message: string }[];
      };
      const pr = json.data?.repository?.pullRequest;
      if (pr) return pr;
      const why = json.errors?.map((e) => e.message).join("; ") || "not found";
      throw new Error(`Cannot read ${ref.owner}/${ref.repo}#${ref.number}: ${why}`);
    },
  };
}
