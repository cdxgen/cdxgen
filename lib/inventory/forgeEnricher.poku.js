/**
 * Batching of the forge commit lookups.
 *
 * These run against a local HTTP double through a stubbed `cdxgenAgent`, so the
 * assertions describe what went out on the wire rather than what the call site
 * meant to ask for.
 */
import { strict as assert } from "node:assert";
import process from "node:process";

import esmock from "esmock";
import { it } from "poku";

// Pinned rather than read from the environment so the credential-precedence
// assertion below means the same thing on a developer machine, where a real
// GITHUB_TOKEN is usually exported, and in CI, where it may not be. poku gives
// each test file its own process, so this does not reach another suite.
process.env.GITHUB_TOKEN = "ambient-token-that-must-not-win";

/**
 * Load forgeEnricher with a git origin and an agent that records every request
 * and answers the forge APIs from `responses`.
 */
async function loadEnricher(originUrl, responses, requested) {
  const agent = {
    get: async (url, options) => {
      requested.push({ headers: options?.headers, url });
      const body = responses[url];
      if (body === undefined) {
        // The real client raises on an error status, carrying it on the
        // response; the batch reads the status from the raised error, so the
        // double must raise the same shape.
        const error = new Error("Request failed with status code 404");
        error.response = { headers: {}, statusCode: 404 };
        throw error;
      }
      return { body, statusCode: 200 };
    },
  };
  return await esmock(
    "./forgeEnricher.js",
    {
      "../core/activity.js": {
        cdxgenAgent: agent,
        readEnvironmentVariable: (name) => process.env[name],
      },
      "./envcontext.js": { getOriginUrl: () => originUrl },
    },
    {
      "../core/httpClient.js": {
        createHttpClient: () => agent,
      },
    },
  );
}

it("the GitHub commit lookups are issued as one batched round", async () => {
  const commits = [{ hash: "aaa1" }, { hash: "bbb2" }, { hash: "ccc3" }];
  const responses = {};
  for (const [index, commit] of commits.entries()) {
    responses[
      `https://api.github.com/repos/acme/app/commits/${commit.hash}/pulls`
    ] = [
      {
        created_at: "2026-01-01T00:00:00Z",
        number: index + 1,
        user: { login: "dev" },
      },
    ];
    responses[
      `https://api.github.com/repos/acme/app/pulls/${index + 1}/reviews`
    ] = [];
  }
  const requested = [];
  const mod = await loadEnricher(
    "https://github.com/acme/app.git",
    responses,
    requested,
  );
  const result = await mod.enrichFromForge("/repo", commits, {
    forgeToken: "t0ken",
  });
  assert.deepEqual(result.dataSources, ["github-api"]);
  const pullsRequests = requested.filter((r) => r.url.endsWith("/pulls"));
  // Three commit lookups, and every one carries the caller's credential — the
  // batch must not drop it on the way to the pool.
  assert.equal(pullsRequests.length, 3);
  for (const request of pullsRequests) {
    assert.equal(request.headers.Authorization, "Bearer t0ken");
  }
  // They are all issued before the first review lookup, which is what makes
  // them one round rather than three serial pairs.
  const firstReview = requested.findIndex((r) => r.url.endsWith("/reviews"));
  const lastPulls = requested.findLastIndex((r) => r.url.endsWith("/pulls"));
  assert.ok(
    lastPulls < firstReview,
    `expected every /pulls request before the first /reviews; got ${requested
      .map((r) => r.url)
      .join(", ")}`,
  );
});

it("the GitLab commit lookups are issued as one batched round", async () => {
  const commits = [{ hash: "aaa1" }, { hash: "bbb2" }];
  const project = encodeURIComponent("acme/app");
  const responses = {};
  for (const [index, commit] of commits.entries()) {
    responses[
      `https://gitlab.com/api/v4/projects/${project}/repository/commits/${commit.hash}/merge_requests`
    ] = [{ author: { username: "dev" }, iid: index + 1 }];
    responses[
      `https://gitlab.com/api/v4/projects/${project}/merge_requests/${index + 1}/approvals`
    ] = { approved_by: [] };
  }
  const requested = [];
  const mod = await loadEnricher(
    "https://gitlab.com/acme/app.git",
    responses,
    requested,
  );
  const result = await mod.enrichFromForge("/repo", commits, {
    forgeToken: "gl-t0ken",
  });
  assert.deepEqual(result.dataSources, ["gitlab-api"]);
  const mrRequests = requested.filter((r) => r.url.endsWith("/merge_requests"));
  assert.equal(mrRequests.length, 2);
  for (const request of mrRequests) {
    assert.equal(request.headers["PRIVATE-TOKEN"], "gl-t0ken");
  }
  const firstApproval = requested.findIndex((r) =>
    r.url.endsWith("/approvals"),
  );
  const lastMr = requested.findLastIndex((r) =>
    r.url.endsWith("/merge_requests"),
  );
  assert.ok(lastMr < firstApproval);
});

it("a commit the forge has no pull request for is not asked again", async () => {
  // One commit with a pull request, one without: the forge answers 404 for
  // the second in the batched round.
  const commits = [{ hash: "aaa1" }, { hash: "bbb2" }];
  const responses = {
    "https://api.github.com/repos/acme/app/commits/aaa1/pulls": [
      { created_at: "2026-01-01T00:00:00Z", number: 7, user: { login: "dev" } },
    ],
    "https://api.github.com/repos/acme/app/pulls/7/reviews": [],
  };
  const requested = [];
  const mod = await loadEnricher(
    "https://github.com/acme/app.git",
    responses,
    requested,
  );
  const result = await mod.enrichFromForge("/repo", commits, {
    forgeToken: "t0ken",
  });
  // The commit lookup ran once per commit in the batch, and the 404 the
  // second one received was final: the loop did not ask for it again.
  const pullsUrls = requested
    .map((r) => r.url)
    .filter((url) => url.endsWith("/pulls"));
  assert.deepEqual(pullsUrls.sort(), [
    "https://api.github.com/repos/acme/app/commits/aaa1/pulls",
    "https://api.github.com/repos/acme/app/commits/bbb2/pulls",
  ]);
  // The commit with the pull request keeps its review; the one without is
  // simply absent rather than an error.
  assert.equal(result.prReviews.length, 1);
  assert.equal(result.prReviews[0].commitHash, "aaa1");
  assert.equal(result.prReviews[0].prNumber, 7);
});
