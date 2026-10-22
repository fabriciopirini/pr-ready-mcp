import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

/** A pull request address. */
export type PrRef = { owner: string; repo: string; number: number };

const NAME = "[A-Za-z0-9_.-]+";
const URL_FORM = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/pull/([1-9]\\d{0,9})/?$`);
const SHORT_FORM = new RegExp(`^(${NAME})/(${NAME})#([1-9]\\d{0,9})$`);

/** Parses `https://github.com/o/r/pull/1` or `o/r#1`, validating the whole string. */
export function parsePrRef(input: string): PrRef | undefined {
  const m = input.match(URL_FORM) ?? input.match(SHORT_FORM);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url state isDraft mergeable mergeStateStatus reviewDecision isInMergeQueue headRefOid baseRefName
      reviewRequests(first: 100) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } } }
      }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup {
          state
          contexts(first: 100) {
            totalCount
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
              ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
            }
          }
        } } }
      }
    }
  }
}`;

// The response is parsed, not cast: an unexpected shape is an invalid_response, never a guess.
const counts = z.array(z.object({ state: z.string(), count: z.number() }));
const pullRequest = z.object({
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  mergeStateStatus: z.string(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  isInMergeQueue: z.boolean(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  reviewRequests: z.object({
    nodes: z.array(
      z.object({
        requestedReviewer: z.object({ login: z.string().optional(), combinedSlug: z.string().optional() }).nullable(),
      }),
    ),
  }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          oid: z.string(),
          statusCheckRollup: z
            .object({
              state: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
              contexts: z.object({
                totalCount: z.number(),
                checkRunCountsByState: counts,
                statusContextCountsByState: counts,
                nodes: z.array(
                  z.discriminatedUnion("__typename", [
                    z.object({
                      __typename: z.literal("CheckRun"),
                      name: z.string(),
                      status: z.string(),
                      conclusion: z.string().nullable(),
                      detailsUrl: z.string().nullable(),
                      isRequired: z.boolean(),
                    }),
                    z.object({
                      __typename: z.literal("StatusContext"),
                      context: z.string(),
                      state: z.string(),
                      targetUrl: z.string().nullable(),
                      isRequired: z.boolean(),
                    }),
                  ]),
                ),
              }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
});

/** The pull request as the GraphQL API returns it for QUERY. */
export type PullRequest = z.infer<typeof pullRequest>;

const response = z.object({
  data: z.object({ repository: z.object({ pullRequest: pullRequest.nullable() }).nullable() }),
});

type ErrorCode =
  | "invalid_input"
  | "auth_required"
  | "forbidden"
  | "not_found_or_inaccessible"
  | "rate_limited"
  | "upstream_error"
  | "invalid_response";

/** A failed collection. The server returns it to the client as a JSON tool error; there is no verdict. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  constructor(code: ErrorCode, message: string, retryable = false, retryAfterSeconds?: number) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Reads pull requests from GitHub. */
export type GitHub = { pullRequest(ref: PrRef): Promise<PullRequest> };

const TIMEOUT_MS = 15_000;

async function defaultToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: TIMEOUT_MS });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Seconds until the limit resets, from retry-after or x-ratelimit-reset; undefined when GitHub gave neither.
function retryAfter(headers: Headers): number | undefined {
  const after = Number(headers.get("retry-after"));
  if (after > 0) return after;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return undefined;
}

function rateLimited(seconds: number | undefined): ToolError {
  const when = seconds === undefined ? "GitHub gave no reset time" : `retry in ${seconds}s`;
  return new ToolError("rate_limited", `GitHub rate limit reached; ${when}.`, true, seconds);
}

/** GitHub GraphQL client. One fixed POST per call; the token is resolved on the first request. */
export function createGitHub({ fetch = globalThis.fetch, token = defaultToken } = {}): GitHub {
  return {
    async pullRequest(ref) {
      const name = `${ref.owner}/${ref.repo}#${ref.number}`;
      const auth = await token();
      if (!auth)
        throw new ToolError("auth_required", "No GitHub token: set GITHUB_TOKEN, or sign in with `gh auth login`.");
      let res: Response;
      try {
        res = await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: { authorization: `bearer ${auth}`, "content-type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: ref }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        const timeout = e instanceof Error && e.name === "TimeoutError";
        throw new ToolError(
          "upstream_error",
          timeout ? `GitHub did not answer within ${TIMEOUT_MS / 1000}s.` : "Could not reach GitHub.",
          true,
        );
      }
      if (res.status === 401) throw new ToolError("auth_required", "GitHub rejected the token (HTTP 401).");
      if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"))
        throw rateLimited(retryAfter(res.headers));
      if (res.status === 403) throw new ToolError("forbidden", `The token may not read ${name} (HTTP 403).`);
      if (res.status >= 500) throw new ToolError("upstream_error", `GitHub returned HTTP ${res.status}.`, true);
      if (!res.ok) throw new ToolError("invalid_response", `GitHub returned HTTP ${res.status}.`);

      let json: { errors?: { type?: string; path?: unknown[] }[] };
      try {
        json = await res.json();
      } catch {
        throw new ToolError("invalid_response", "GitHub's response was not JSON.");
      }
      const errors = json.errors ?? [];
      if (errors.some((e) => e.type === "RATE_LIMITED")) throw rateLimited(retryAfter(res.headers));
      if (errors.length === 1 && errors[0].type === "NOT_FOUND")
        throw new ToolError("not_found_or_inaccessible", `${name} does not exist or the token cannot see it.`);
      // Any other error means some field may be missing: refuse rather than judge a partial answer.
      if (errors.length) {
        const where = errors.map((e) => `${e.type ?? "error"} at ${(e.path ?? []).join(".") || "query"}`).join("; ");
        throw new ToolError("invalid_response", `GitHub returned errors for ${name}: ${where}.`);
      }
      const parsed = response.safeParse(json);
      if (!parsed.success) {
        const path = parsed.error.issues[0]?.path.join(".");
        throw new ToolError("invalid_response", `GitHub's response for ${name} has an unexpected shape at ${path}.`);
      }
      const pr = parsed.data.data.repository?.pullRequest;
      if (!pr) throw new ToolError("not_found_or_inaccessible", `${name} does not exist or the token cannot see it.`);
      return pr;
    },
  };
}
