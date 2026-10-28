// Decides whether a pull request or merge-queue entry changes only files that
// no test reads, so the required jobs can finish without running the suites.
//
// The jobs still start and still report success, and a summary line says why
// they stopped early. The files that qualify are issue templates and other
// community files, documentation markdown that no test names, and workflows
// that are not part of the test pipeline. Any other file, or a documentation
// file that a test refers to by name, sends the change through the full run.
//
// Environment:
//   EVENT_NAME     the workflow event; only pull_request and merge_group qualify
//   GITHUB_OUTPUT  receives docs-only=true or docs-only=false
//
// The checkout must have fetch-depth 2, so that HEAD^1 is the base the change
// is applied to: the pull request merge commit, or the merge-queue commit.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

const SAFE_PREFIXES = [".github/ISSUE_TEMPLATE/"];
const SAFE_FILES = new Set([
  ".github/CODEOWNERS",
  ".github/FUNDING.yml",
  ".github/release.yml",
]);
// Workflows that run the required checks or that a unit test parses. A change
// to one of them has to be tested by the run it changes.
const PIPELINE_WORKFLOWS = new Set([
  "codeql.yml",
  "lint.yml",
  "nodejs.yml",
  "repotests-quick.yml",
  "repotests.yml",
]);
const TEST_SOURCES = [
  "lib",
  "contrib",
  "test",
  "ci",
  "package.json",
  ".pokurc.jsonc",
];

/**
 * True for a markdown file in the repository root or under docs/. Other
 * markdown, such as skills, fixtures and the plugin copy, is checked by tests.
 *
 * @param {string} file Repository relative path
 * @returns {boolean}
 */
export function isDocsMarkdown(file) {
  return (
    file.endsWith(".md") && (!file.includes("/") || file.startsWith("docs/"))
  );
}

/**
 * True for a workflow file outside the test pipeline.
 *
 * @param {string} file Repository relative path
 * @returns {boolean}
 */
export function isOtherWorkflow(file) {
  const prefix = ".github/workflows/";
  if (!file.startsWith(prefix)) {
    return false;
  }
  const name = file.slice(prefix.length);
  return (
    !name.includes("/") &&
    (name.endsWith(".yml") || name.endsWith(".yaml")) &&
    !PIPELINE_WORKFLOWS.has(name)
  );
}

/**
 * Classifies a set of changed files.
 *
 * @param {string[]} files Changed paths, including deleted and renamed ones
 * @param {function(string): boolean} referencedByTests Whether a documentation
 *   file's base name appears in any test source
 * @returns {{docsOnly: boolean, reason: string}}
 */
export function classify(files, referencedByTests) {
  if (!files.length) {
    return { docsOnly: false, reason: "no changed files were found" };
  }
  for (const file of files) {
    if (
      SAFE_FILES.has(file) ||
      SAFE_PREFIXES.some((p) => file.startsWith(p)) ||
      isOtherWorkflow(file)
    ) {
      continue;
    }
    if (!isDocsMarkdown(file)) {
      return { docsOnly: false, reason: `${file} is not a documentation file` };
    }
    if (referencedByTests(file)) {
      return { docsOnly: false, reason: `${file} is read by a test` };
    }
  }
  return { docsOnly: true, reason: "only documentation files changed" };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function changedFiles() {
  const out = git(["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"]);
  return out.split("\n").filter(Boolean);
}

function referencedByTests(file) {
  const name = file.split("/").pop();
  try {
    git(["grep", "-F", "-q", "--", name, "--", ...TEST_SOURCES]);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const event = process.env.EVENT_NAME;
  let result = {
    docsOnly: false,
    reason: `a ${event} run always runs the suites`,
  };
  if (event === "pull_request" || event === "merge_group") {
    result = classify(changedFiles(), referencedByTests);
  }
  console.log(`docs-only=${result.docsOnly}: ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `docs-only=${result.docsOnly}\nreason=${result.reason}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
