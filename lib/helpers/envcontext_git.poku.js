import { assert, it } from "poku";

import { gitLogAuthors, gitLogTrailers } from "./envcontext.js";

it("verifies gitLogAuthors retrieves authors from current repository", () => {
  const authors = gitLogAuthors(process.cwd(), 50);
  assert.ok(Array.isArray(authors));
  if (authors.length > 0) {
    const first = authors[0];
    assert.ok(first.name);
    assert.ok(first.email);
  }
});

it("verifies gitLogTrailers retrieves commits from current repository", () => {
  const commits = gitLogTrailers(process.cwd(), 50);
  assert.ok(Array.isArray(commits));
  if (commits.length > 0) {
    const first = commits[0];
    assert.ok(first.hash);
    assert.ok(typeof first.message === "string");
  }
});
