import { cdxgenAgent, readEnvironmentVariable } from "../core/activity.js";
import { getUserAgent } from "../core/userAgent.js";
import { getOriginUrl } from "./envcontext.js";
import { prefetchJson } from "./fetchBatch.js";

/**
 * Fetch the commit-level lookups for a whole commit list in one round.
 *
 * Both forges answer "which pull/merge request contains this commit?" from a
 * URL built entirely from the commit hash, so the whole list is knowable before
 * the loop. The review and approval lookups that follow are not: their URL
 * carries a number that only arrives with the response, so they stay serial.
 *
 * The requests carry a caller-supplied credential, which the cdxrs protocol has
 * no field for, so `prefetchJson` routes them to the JS pool.
 *
 * @param {Array<string>} urls Commit-level URLs.
 * @param {Object} headers Headers to send with each, including the credential.
 * @returns {Promise<Map<string, {ok?: boolean, body?: *}>>} Map keyed by URL.
 */
async function prefetchCommitLookups(urls, headers) {
  return await prefetchJson(
    urls.map((url) => ({ headers, responseType: "json", url })),
  );
}

/**
 * Read a prefetched commit lookup as the response shape the loop expects.
 *
 * The loop tests `statusCode === 200`, and a batch entry records whether the
 * request succeeded. A hit becomes a 200, and a definite answer with an
 * error status becomes that status, which the loop's own check treats as "no
 * pull request" without asking again: a 404 is the forge saying the commit
 * has none, and a 429 or 5xx is the answer after the batch's own retries.
 * Only a transport failure, with no status, is left to the caller to retry.
 *
 * @param {Map<string, {ok?: boolean, status?: number, body?: *}>} prefetched
 * @param {string} url
 * @returns {{statusCode: number, body: *}|undefined}
 */
function prefetchedCommitLookup(prefetched, url) {
  const entry = prefetched.get(url);
  if (entry?.ok) {
    return { body: entry.body, statusCode: 200 };
  }
  if (entry && entry.status !== undefined) {
    return { body: entry.body, statusCode: entry.status };
  }
  return undefined;
}

// Only accept single path segments made of git-safe characters, and never the
// `.`/`..` traversal segments, so a malicious remote.origin.url cannot steer the
// authenticated request to a different GitHub/GitLab API path.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function isSafeSegment(seg) {
  return Boolean(seg) && seg !== "." && seg !== ".." && SAFE_SEGMENT.test(seg);
}

/**
 * Parse a GitHub repository URL into its owner and repository name.
 *
 * Only accepts URLs where github.com is the actual host (rejecting spoofed
 * hosts such as `https://evil.com/github.com/o/r`) and only git-safe path
 * segments, so an untrusted remote URL cannot steer authenticated API requests.
 *
 * @param {string} url The git origin url
 * @returns {{owner: string, repo: string}|null} Object containing owner and repo, or null
 */
export function parseGitHubUrl(url) {
  if (!url) return null;
  // Require github.com to be the actual host (preceded by start, `//`, or `@`),
  // so URLs like `https://evil.com/github.com/o/r` do not match.
  const match = url.match(
    /(?:^|@|\/\/)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (match && isSafeSegment(match[1]) && isSafeSegment(match[2])) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Parses GitLab repository origin URL to extract project path/ID.
 *
 * @param {string} url The git origin url
 * @returns {string|null} The project path (owner/repo) or null
 */
export function parseGitLabUrl(url) {
  if (!url) return null;
  const match = url.match(
    /(?:^|@|\/\/)gitlab\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (match && isSafeSegment(match[1]) && isSafeSegment(match[2])) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

/**
 * Enriches AI commits with details from GitHub or GitLab API if tokens are present.
 *
 * @param {string} dir Root directory of the repository
 * @param {Array<Object>} aiCommits List of AI commit objects
 * @param {Object} options Options containing forgeToken or env context
 * @returns {Promise<Object>} Object containing reviews list and authoritative flags
 */
export async function enrichFromForge(dir, aiCommits, options = {}) {
  const result = {
    dataSources: [],
    prReviews: [], // Array of review states { commitHash, hasIndependentApproval, selfApproved, reviewLatencySeconds }
  };

  const originUrl = getOriginUrl(dir);
  if (!originUrl) {
    return result;
  }

  const githubInfo = parseGitHubUrl(originUrl);
  const gitlabProject = parseGitLabUrl(originUrl);

  const githubToken =
    options.forgeToken || readEnvironmentVariable("GITHUB_TOKEN");
  const gitlabToken =
    options.forgeToken || readEnvironmentVariable("GITLAB_TOKEN");

  if (githubInfo && githubToken) {
    result.dataSources.push("github-api");
    const { owner, repo } = githubInfo;

    // To avoid hitting API rate limits or spamming, limit to the most recent 5 AI commits
    const commitsToQuery = aiCommits.slice(0, 5);
    const githubHeaders = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": getUserAgent("api.github.com"),
    };
    const pullsUrlFor = (commit) =>
      `https://api.github.com/repos/${owner}/${repo}/commits/${commit.hash}/pulls`;
    const prefetchedPulls = await prefetchCommitLookups(
      commitsToQuery.map(pullsUrlFor),
      githubHeaders,
    );

    for (const commit of commitsToQuery) {
      try {
        const pullsUrl = pullsUrlFor(commit);
        const pullsRes =
          prefetchedCommitLookup(prefetchedPulls, pullsUrl) ||
          (await cdxgenAgent.get(pullsUrl, {
            headers: githubHeaders,
            responseType: "json",
            throwHttpErrors: false,
          }));

        if (
          pullsRes?.statusCode === 200 &&
          Array.isArray(pullsRes.body) &&
          pullsRes.body.length > 0
        ) {
          const pr = pullsRes.body[0];
          const prNumber = pr.number;
          const prAuthor = pr.user?.login;

          // Fetch reviews
          const reviewsRes = await cdxgenAgent.get(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
            {
              headers: githubHeaders,
              responseType: "json",
              throwHttpErrors: false,
            },
          );

          if (
            reviewsRes?.statusCode === 200 &&
            Array.isArray(reviewsRes.body)
          ) {
            let hasIndependentApproval = false;
            let selfApproved = false;
            let approvedTime = null;

            for (const review of reviewsRes.body) {
              if (review.state === "APPROVED") {
                const reviewer = review.user?.login;
                const isBot =
                  review.user?.type === "Bot" || /\[bot\]/i.test(reviewer);

                if (reviewer === prAuthor) {
                  selfApproved = true;
                } else if (!isBot) {
                  hasIndependentApproval = true;
                  approvedTime = new Date(review.submitted_at);
                }
              }
            }

            let reviewLatencySeconds = null;
            if (approvedTime && pr.created_at) {
              const createdTime = new Date(pr.created_at);
              reviewLatencySeconds = Math.max(
                0,
                Math.floor((approvedTime - createdTime) / 1000),
              );
            }

            result.prReviews.push({
              commitHash: commit.hash,
              hasIndependentApproval,
              selfApproved,
              reviewLatencySeconds,
              prNumber,
              prAuthor,
            });
          }
        }
      } catch (_err) {
        // Degrade gracefully
      }
    }
  } else if (gitlabProject && gitlabToken) {
    result.dataSources.push("gitlab-api");
    const projectEncoded = encodeURIComponent(gitlabProject);
    const commitsToQuery = aiCommits.slice(0, 5);
    const gitlabHeaders = {
      "PRIVATE-TOKEN": gitlabToken,
      "User-Agent": getUserAgent("gitlab.com"),
    };
    const mrUrlFor = (commit) =>
      `https://gitlab.com/api/v4/projects/${projectEncoded}/repository/commits/${commit.hash}/merge_requests`;
    const prefetchedMrs = await prefetchCommitLookups(
      commitsToQuery.map(mrUrlFor),
      gitlabHeaders,
    );

    for (const commit of commitsToQuery) {
      try {
        const mrUrl = mrUrlFor(commit);
        const mrRes =
          prefetchedCommitLookup(prefetchedMrs, mrUrl) ||
          (await cdxgenAgent.get(mrUrl, {
            headers: gitlabHeaders,
            responseType: "json",
            throwHttpErrors: false,
          }));

        if (
          mrRes?.statusCode === 200 &&
          Array.isArray(mrRes.body) &&
          mrRes.body.length > 0
        ) {
          const mr = mrRes.body[0];
          const mrIid = mr.iid;
          const mrAuthor = mr.author?.username;

          // Fetch approvals/reviews
          const approvalsRes = await cdxgenAgent.get(
            `https://gitlab.com/api/v4/projects/${projectEncoded}/merge_requests/${mrIid}/approvals`,
            {
              headers: gitlabHeaders,
              responseType: "json",
              throwHttpErrors: false,
            },
          );

          if (approvalsRes?.statusCode === 200 && approvalsRes.body) {
            const approvals = approvalsRes.body;
            let hasIndependentApproval = false;
            let selfApproved = false;

            const approvedBy = approvals.approved_by || [];
            for (const approval of approvedBy) {
              const approver = approval.user?.username;
              const isBot = /\[bot\]/i.test(approver);

              if (approver === mrAuthor) {
                selfApproved = true;
              } else if (!isBot) {
                hasIndependentApproval = true;
              }
            }

            let reviewLatencySeconds = null;
            if (hasIndependentApproval && mr.created_at && mr.updated_at) {
              const createdTime = new Date(mr.created_at);
              const approvedTime = new Date(mr.updated_at);
              reviewLatencySeconds = Math.max(
                0,
                Math.floor((approvedTime - createdTime) / 1000),
              );
            }

            result.prReviews.push({
              commitHash: commit.hash,
              hasIndependentApproval,
              selfApproved,
              reviewLatencySeconds,
              prNumber: mrIid,
              prAuthor: mrAuthor,
            });
          }
        }
      } catch (_err) {
        // Degrade gracefully
      }
    }
  }

  return result;
}
