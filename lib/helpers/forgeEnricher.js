import { getOriginUrl } from "./envcontext.js";
import { cdxgenAgent } from "./utils.js";

/**
 * Parses GitHub repository origin URL to extract owner and repo name.
 *
 * @param {string} url The git origin url
 * @returns {Object|null} Object containing owner and repo, or null
 */
// Only accept single path segments made of git-safe characters, and never the
// `.`/`..` traversal segments, so a malicious remote.origin.url cannot steer the
// authenticated request to a different GitHub/GitLab API path.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function isSafeSegment(seg) {
  return Boolean(seg) && seg !== "." && seg !== ".." && SAFE_SEGMENT.test(seg);
}

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

  const githubToken = options.forgeToken || process.env.GITHUB_TOKEN;
  const gitlabToken = options.forgeToken || process.env.GITLAB_TOKEN;

  if (githubInfo && githubToken) {
    result.dataSources.push("github-api");
    const { owner, repo } = githubInfo;

    // To avoid hitting API rate limits or spamming, limit to the most recent 5 AI commits
    const commitsToQuery = aiCommits.slice(0, 5);

    for (const commit of commitsToQuery) {
      try {
        const pullsRes = await cdxgenAgent.get(
          `https://api.github.com/repos/${owner}/${repo}/commits/${commit.hash}/pulls`,
          {
            headers: {
              Authorization: `Bearer ${githubToken}`,
              "User-Agent": "cdxgen-oversight",
              Accept: "application/vnd.github+json",
            },
            responseType: "json",
            throwHttpErrors: false,
          },
        );

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
              headers: {
                Authorization: `Bearer ${githubToken}`,
                "User-Agent": "cdxgen-oversight",
                Accept: "application/vnd.github+json",
              },
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

    for (const commit of commitsToQuery) {
      try {
        const mrRes = await cdxgenAgent.get(
          `https://gitlab.com/api/v4/projects/${projectEncoded}/repository/commits/${commit.hash}/merge_requests`,
          {
            headers: {
              "PRIVATE-TOKEN": gitlabToken,
              "User-Agent": "cdxgen-oversight",
            },
            responseType: "json",
            throwHttpErrors: false,
          },
        );

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
              headers: {
                "PRIVATE-TOKEN": gitlabToken,
                "User-Agent": "cdxgen-oversight",
              },
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
