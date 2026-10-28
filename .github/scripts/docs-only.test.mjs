import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, isDocsMarkdown, isOtherWorkflow } from "./docs-only.mjs";

const never = () => false;
const always = () => true;

describe("isDocsMarkdown", () => {
  it("accepts markdown at the root and under docs", () => {
    assert.equal(isDocsMarkdown("README.md"), true);
    assert.equal(isDocsMarkdown("docs/LESSON1.md"), true);
  });

  it("rejects markdown elsewhere and other file types", () => {
    assert.equal(isDocsMarkdown(".agents/skills/x/SKILL.md"), false);
    assert.equal(isDocsMarkdown("lib/x/README.md"), false);
    assert.equal(isDocsMarkdown("docs/cbom-custom-spki-denylist.yaml"), false);
    assert.equal(isDocsMarkdown("docs/image.png"), false);
  });
});

describe("isOtherWorkflow", () => {
  it("accepts workflows outside the test pipeline", () => {
    assert.equal(isOtherWorkflow(".github/workflows/project-sync.yml"), true);
    assert.equal(isOtherWorkflow(".github/workflows/binary-builds.yml"), true);
  });

  it("rejects the pipeline workflows and other paths", () => {
    for (const file of [
      ".github/workflows/nodejs.yml",
      ".github/workflows/repotests.yml",
      ".github/workflows/repotests-quick.yml",
      ".github/workflows/lint.yml",
      ".github/workflows/codeql.yml",
      ".github/workflows/determine-rebuild-tags.js",
      ".github/workflows/sub/other.yml",
      ".github/actions/setup/action.yml",
    ]) {
      assert.equal(isOtherWorkflow(file), false, file);
    }
  });
});

describe("classify", () => {
  it("is docs-only for documentation and community files", () => {
    const files = [
      "docs/LESSON1.md",
      ".github/ISSUE_TEMPLATE/epic.yml",
      ".github/CODEOWNERS",
      ".github/FUNDING.yml",
      ".github/workflows/project-sync.yml",
    ];
    assert.equal(classify(files, never).docsOnly, true);
  });

  it("is not docs-only when any file is code, workflow or data", () => {
    for (const other of [
      "lib/cli/index.js",
      "package.json",
      ".github/workflows/nodejs.yml",
      ".github/workflows/repotests-quick.yml",
      ".github/scripts/docs-only.mjs",
      "data/queries.json",
    ]) {
      const result = classify(["docs/LESSON1.md", other], never);
      assert.equal(result.docsOnly, false, other);
      assert.match(result.reason, new RegExp(other.replace(/[.]/g, "\\.")));
    }
  });

  it("is not docs-only when a test reads the documentation file", () => {
    const result = classify(["docs/CUSTOM_PROPERTIES.md"], always);
    assert.equal(result.docsOnly, false);
    assert.match(result.reason, /read by a test/);
  });

  it("is not docs-only for an empty change", () => {
    assert.equal(classify([], never).docsOnly, false);
  });
});
