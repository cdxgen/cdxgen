import process from "node:process";

import { assert, it } from "poku";

import { repoMetadataToGitHubApiUrl, toGitHubApiUrl } from "./ecosystems.js";

// The repository URL comes from registry metadata, and the licence request
// built from it carries GITHUB_TOKEN. Only a plain owner and repository name
// may become the /repos/<owner>/<repo> path; anything that would rewrite the
// path or query of that request is not a GitHub repository URL at all.

const previousApiUrl = process.env.GITHUB_API_URL;
delete process.env.GITHUB_API_URL;

it("toGitHubApiUrl accepts the usual repository url forms", () => {
  for (const url of [
    "https://github.com/acme/widget",
    "https://github.com/acme/widget/",
    "https://github.com/acme/widget.git",
    "git+https://github.com/acme/widget.git",
    "https://github.com/acme/widget#readme",
    "https://github.com/acme/widget.git#main",
    "https://github.com/acme/widget?ref=main",
  ]) {
    assert.strictEqual(
      toGitHubApiUrl(url, undefined),
      "https://api.github.com/repos/acme/widget",
      url,
    );
  }
  assert.strictEqual(
    toGitHubApiUrl("https://github.com/acme/my.widget_v2-rc", undefined),
    "https://api.github.com/repos/acme/my.widget_v2-rc",
  );
});

it("toGitHubApiUrl refuses owner and repository names that steer the api path", () => {
  for (const url of [
    "https://github.com/../user\\repos?visibility=private&x=",
    "https://github.com/../../user",
    "https://github.com/acme/..",
    "https://github.com/acme/widget%2Fcontents",
    "https://github.com/acme/widget;x",
    "https://github.com/acme/wid get",
    "https://github.com/acme/",
    "https://github.com/acme",
    "https://evil.com/github.com/acme/widget",
  ]) {
    assert.strictEqual(toGitHubApiUrl(url, undefined), undefined, url);
  }
});

it("repoMetadataToGitHubApiUrl applies the same rule to group and name", () => {
  assert.strictEqual(
    repoMetadataToGitHubApiUrl({ group: "github.com/ugorji", name: "go" }),
    "https://api.github.com/repos/ugorji/go",
  );
  assert.strictEqual(
    repoMetadataToGitHubApiUrl({ group: "acme", name: "widget" }),
    "https://api.github.com/repos/acme/widget",
  );
  for (const repoMetadata of [
    { group: "github.com/..", name: "user\\repos?x=" },
    { group: "acme/extra", name: "widget" },
    { group: "acme", name: "../../user" },
    { group: "acme", name: "widget?per_page=1" },
    { group: "acme", name: "widget#x" },
    { group: "acme", name: "" },
    { group: "acme" },
  ]) {
    assert.strictEqual(
      repoMetadataToGitHubApiUrl(repoMetadata),
      undefined,
      JSON.stringify(repoMetadata),
    );
  }
});

if (previousApiUrl === undefined) {
  delete process.env.GITHUB_API_URL;
} else {
  process.env.GITHUB_API_URL = previousApiUrl;
}
