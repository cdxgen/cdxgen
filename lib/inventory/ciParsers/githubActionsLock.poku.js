import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  MAX_ACTIONS_LOCKFILE_BYTES,
  parseActionsLockfile,
  parseActionsLockfileString,
} from "./githubActionsLock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "test",
  "data",
  "actions-lock",
);

const SHA1_A = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const SHA1_B = "cafebabecafebabecafebabecafebabecafebabe";
const SHA1_C = "0123456789abcdef0123456789abcdef01234567";
const SHA1_D = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SHA1_E = "111122223333444455556666777788889999aaaa";
const SHA256_A =
  "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";

function fixturePath(caseName) {
  return path.join(
    fixturesRoot,
    caseName,
    ".github",
    "workflows",
    "actions.lock",
  );
}

function readFixture(caseName) {
  return readFileSync(fixturePath(caseName), "utf-8");
}

function assertEmptyResult(result) {
  assert.deepStrictEqual(
    {
      version: result.version,
      sourceVersion: result.sourceVersion,
      workflows: result.workflows,
      dependencies: result.dependencies,
    },
    {
      version: null,
      sourceVersion: undefined,
      workflows: {},
      dependencies: {},
    },
  );
  assert.ok(Array.isArray(result.warnings), "warnings must be an array");
  assert.ok(
    result.warnings.length >= 1,
    `expected at least one warning, got: ${JSON.stringify(result.warnings)}`,
  );
}

function assertWarningMentions(result, text) {
  assert.ok(
    result.warnings.some((warning) => warning.includes(text)),
    `expected a warning mentioning '${text}', got: ${JSON.stringify(result.warnings)}`,
  );
}

function dependencyEntry(overrides) {
  return {
    owner: "example-org",
    repo: "action",
    ref: "v1.0.0",
    hashAlgo: "sha1",
    commit: SHA1_A,
    ownerId: 9100001,
    repoId: 9100002,
    hostname: undefined,
    uses: [],
    ...overrides,
  };
}

function buildLockText({
  version = "v0.0.2",
  workflows = {},
  dependencies = {},
}) {
  const lines = [`version: '${version}'`];
  const workflowPaths = Object.keys(workflows);
  if (workflowPaths.length) {
    lines.push("workflows:");
    for (const workflowPath of workflowPaths) {
      lines.push(`    ${JSON.stringify(workflowPath)}:`);
      for (const pin of workflows[workflowPath]) {
        lines.push(`        - '${pin}'`);
      }
    }
  }
  const pinKeys = Object.keys(dependencies);
  if (pinKeys.length) {
    lines.push("dependencies:");
    for (const pinKey of pinKeys) {
      const entry = dependencies[pinKey];
      lines.push(`    '${pinKey}':`);
      if (entry.hostname !== undefined) {
        lines.push(`        hostname: '${entry.hostname}'`);
      }
      lines.push(`        ref: '${entry.ref}'`);
      lines.push(`        commit: 'sha1-${entry.commit}'`);
      lines.push(`        owner_id: ${entry.ownerId}`);
      lines.push(`        repo_id: ${entry.repoId}`);
      if (entry.uses?.length) {
        lines.push("        uses:");
        for (const usesPin of entry.uses) {
          lines.push(`            - '${usesPin}'`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("parseActionsLockfile valid fixtures", () => {
  it("exposes the size limit as a constant", () => {
    assert.strictEqual(MAX_ACTIONS_LOCKFILE_BYTES, 1048576);
  });

  it("parses a valid v0.0.1 lockfile and normalises pin keys", () => {
    const result = parseActionsLockfile(fixturePath("valid-v0.0.1"));
    assert.deepStrictEqual(
      {
        version: result.version,
        sourceVersion: result.sourceVersion,
        workflows: result.workflows,
        dependencies: result.dependencies,
      },
      {
        version: "v0.0.1",
        sourceVersion: "v0.0.1",
        workflows: {
          ".github/workflows/build.yml": [
            "example-org/first-action@v1.2.3",
            "example-org/second-action@main",
          ],
        },
        dependencies: {
          "example-org/first-action@v1.2.3": dependencyEntry({
            owner: "example-org",
            repo: "first-action",
            ref: "v1.2.3",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          }),
          "example-org/second-action@main": dependencyEntry({
            repo: "second-action",
            ref: "main",
            commit: SHA1_B,
            ownerId: 9100001,
            repoId: 9100003,
          }),
        },
      },
    );
    assert.deepStrictEqual(result.warnings, []);
  });

  it("parses a valid v0.0.2 lockfile and folds owner/repo case", () => {
    const result = parseActionsLockfile(fixturePath("valid-v0.0.2"));
    assert.deepStrictEqual(
      {
        version: result.version,
        sourceVersion: result.sourceVersion,
        workflows: result.workflows,
        dependencies: result.dependencies,
      },
      {
        version: "v0.0.2",
        sourceVersion: undefined,
        workflows: {
          ".github/workflows/release.yml": [
            "example-org/setup-node@v4.1.0",
            "example-org/upload-artifact@v3.2.4",
          ],
        },
        dependencies: {
          "example-org/setup-node@v4.1.0": dependencyEntry({
            repo: "setup-node",
            ref: "v4.1.0",
            commit: SHA1_C,
            ownerId: 9100011,
            repoId: 9100012,
          }),
          "example-org/upload-artifact@v3.2.4": dependencyEntry({
            repo: "upload-artifact",
            ref: "v3.2.4",
            commit: SHA1_D,
            ownerId: 9100011,
            repoId: 9100013,
          }),
        },
      },
    );
    assert.deepStrictEqual(result.warnings, []);
  });

  it("parses a valid v0.0.3 lockfile with optional hostnames", () => {
    const result = parseActionsLockfile(fixturePath("valid-v0.0.3"));
    assert.deepStrictEqual(
      {
        version: result.version,
        sourceVersion: result.sourceVersion,
        workflows: result.workflows,
        dependencies: result.dependencies,
      },
      {
        version: "v0.0.3",
        sourceVersion: undefined,
        workflows: {
          ".github/workflows/deploy.yml": [
            "example-org/tenant-scanner@v2.0.0",
            "example-org/local-helper@v1.0.0",
            "actions/checkout@v6.0.2",
          ],
        },
        dependencies: {
          "example-org/tenant-scanner@v2.0.0": dependencyEntry({
            repo: "tenant-scanner",
            ref: "v2.0.0",
            commit: SHA1_E,
            ownerId: 9100021,
            repoId: 9100022,
            hostname: "octocorp.ghe.com",
          }),
          "example-org/local-helper@v1.0.0": dependencyEntry({
            repo: "local-helper",
            ref: "v1.0.0",
            ownerId: 9100021,
            repoId: 9100023,
          }),
          "actions/checkout@v6.0.2": dependencyEntry({
            owner: "actions",
            repo: "checkout",
            ref: "v6.0.2",
            commit: SHA1_B,
            ownerId: 9100024,
            repoId: 9100025,
            hostname: "github.com",
          }),
        },
      },
    );
    assert.deepStrictEqual(result.warnings, []);
  });

  it("parses a sha256 digest into hashAlgo and the bare hex commit", () => {
    const result = parseActionsLockfile(fixturePath("valid-sha256"));
    assert.deepStrictEqual(
      {
        version: result.version,
        sourceVersion: result.sourceVersion,
        workflows: result.workflows,
        dependencies: result.dependencies,
      },
      {
        version: "v0.0.2",
        sourceVersion: undefined,
        workflows: {
          ".github/workflows/verify.yml": ["example-org/verify-runner@v5.0.1"],
        },
        dependencies: {
          "example-org/verify-runner@v5.0.1": dependencyEntry({
            repo: "verify-runner",
            ref: "v5.0.1",
            hashAlgo: "sha256",
            commit: SHA256_A,
            ownerId: 9100031,
            repoId: 9100032,
          }),
        },
      },
    );
    assert.deepStrictEqual(result.warnings, []);
  });

  it("parses transitive uses edges with a shared leaf action", () => {
    const result = parseActionsLockfile(fixturePath("valid-transitive-uses"));
    assert.deepStrictEqual(
      {
        version: result.version,
        sourceVersion: result.sourceVersion,
        workflows: result.workflows,
        dependencies: result.dependencies,
      },
      {
        version: "v0.0.2",
        sourceVersion: undefined,
        workflows: {
          ".github/workflows/ci.yml": [
            "example-org/composite-a@v1.0.0",
            "example-org/formatter-c@v2.1.0",
            "example-org/helper-b@v3.0.0",
          ],
        },
        dependencies: {
          "example-org/composite-a@v1.0.0": dependencyEntry({
            repo: "composite-a",
            ownerId: 9100041,
            repoId: 9100042,
            uses: [
              "example-org/helper-b@v3.0.0",
              "example-org/formatter-c@v2.1.0",
            ],
          }),
          "example-org/formatter-c@v2.1.0": dependencyEntry({
            repo: "formatter-c",
            ref: "v2.1.0",
            commit: SHA1_B,
            ownerId: 9100041,
            repoId: 9100043,
            uses: ["example-org/helper-b@v3.0.0"],
          }),
          "example-org/helper-b@v3.0.0": dependencyEntry({
            repo: "helper-b",
            ref: "v3.0.0",
            commit: SHA1_C,
            ownerId: 9100041,
            repoId: 9100044,
          }),
        },
      },
    );
    assert.deepStrictEqual(result.warnings, []);
  });
});

describe("parseActionsLockfile invalid fixtures", () => {
  it("rejects a future schema version", () => {
    const result = parseActionsLockfile(fixturePath("invalid-future-version"));
    assertEmptyResult(result);
    assertWarningMentions(result, "unsupported lockfile version");
  });

  it("rejects a uses cycle", () => {
    const result = parseActionsLockfile(fixturePath("invalid-uses-cycle"));
    assertEmptyResult(result);
    assertWarningMentions(result, "uses cycle detected");
  });

  it("rejects duplicate mapping keys", () => {
    const result = parseActionsLockfile(fixturePath("invalid-duplicate-key"));
    assertEmptyResult(result);
    assertWarningMentions(result, "duplicate mapping key");
  });

  it("rejects malformed commit digests", () => {
    const result = parseActionsLockfile(
      fixturePath("invalid-malformed-digest"),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "malformed commit digest");
  });

  it("rejects sub-action path pin keys", () => {
    const result = parseActionsLockfile(fixturePath("invalid-subpath-key"));
    assertEmptyResult(result);
    assertWarningMentions(result, "invalid pin key");
  });

  it("rejects pin keys whose ref contains @", () => {
    const result = parseActionsLockfile(fixturePath("invalid-ref-with-at"));
    assertEmptyResult(result);
    assertWarningMentions(result, "invalid pin key");
  });

  it("rejects unknown entry fields", () => {
    const result = parseActionsLockfile(fixturePath("invalid-unknown-field"));
    assertEmptyResult(result);
    assertWarningMentions(result, "unknown field 'source_url'");
  });

  it("rejects hostname on a v0.0.2 entry", () => {
    const result = parseActionsLockfile(
      fixturePath("invalid-hostname-in-v0.0.2"),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "unknown field 'hostname'");
  });

  it("rejects a uses key missing from dependencies", () => {
    const result = parseActionsLockfile(
      fixturePath("invalid-missing-uses-dep"),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "not defined in dependencies");
  });

  it("rejects broken YAML", () => {
    const result = parseActionsLockfile(fixturePath("invalid-broken-yaml"));
    assertEmptyResult(result);
    assertWarningMentions(result, "invalid YAML");
  });
});

describe("parseActionsLockfile file-level behaviour", () => {
  it("returns the empty result for a missing file", () => {
    const result = parseActionsLockfile(
      path.join(fixturesRoot, "missing-case", "actions.lock"),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "does not exist");
  });

  it("returns the empty result for a directory", () => {
    const result = parseActionsLockfile(fixturesRoot);
    assertEmptyResult(result);
    assertWarningMentions(result, "not a regular file");
  });

  it("rejects a file larger than the size limit without reading it", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "actions-lock-"));
    try {
      const oversizedPath = path.join(tempDir, "actions.lock");
      writeFileSync(
        oversizedPath,
        `# ${"x".repeat(MAX_ACTIONS_LOCKFILE_BYTES)}`,
      );
      const result = parseActionsLockfile(oversizedPath);
      assertEmptyResult(result);
      assertWarningMentions(
        result,
        `larger than the limit of ${MAX_ACTIONS_LOCKFILE_BYTES} bytes`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("parseActionsLockfileString", () => {
  it("stores workflow keys built with path.join using / on every platform", () => {
    const workflowKey = path.join(".github", "workflows", "ci.yml");
    const text = buildLockText({
      workflows: { [workflowKey]: ["example-org/plain-action@v1.0.0"] },
      dependencies: {
        "example-org/plain-action@v1.0.0": {
          ref: "v1.0.0",
          commit: SHA1_A,
          ownerId: 9100001,
          repoId: 9100002,
        },
      },
    });
    const result = parseActionsLockfileString(text);
    assert.strictEqual(result.version, "v0.0.2");
    assert.deepStrictEqual(result.workflows, {
      ".github/workflows/ci.yml": ["example-org/plain-action@v1.0.0"],
    });
    assert.deepStrictEqual(result.warnings, []);
  });

  it("rejects workflow keys that escape the repository", () => {
    // path.join normalises ".." away, so the keys are written literally.
    const escapingKeys = [
      "../evil.yml",
      ".github/../../evil.yml",
      ".\\..\\evil.yml",
    ];
    for (const workflowKey of escapingKeys) {
      const text = buildLockText({
        workflows: { [workflowKey]: ["example-org/plain-action@v1.0.0"] },
        dependencies: {
          "example-org/plain-action@v1.0.0": {
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      });
      const result = parseActionsLockfileString(text);
      assertEmptyResult(result);
      assertWarningMentions(result, "'..' segment");
    }
  });

  it("rejects workflow keys with a '.' segment", () => {
    for (const workflowKey of [
      "./.github/workflows/ci.yml",
      ".github/./workflows/ci.yml",
    ]) {
      const result = parseActionsLockfileString(
        buildLockText({
          workflows: { [workflowKey]: ["example-org/plain-action@v1.0.0"] },
          dependencies: {
            "example-org/plain-action@v1.0.0": {
              ref: "v1.0.0",
              commit: SHA1_A,
              ownerId: 9100001,
              repoId: 9100002,
            },
          },
        }),
      );
      assertEmptyResult(result);
      assertWarningMentions(result, "'.' segment");
    }
  });

  it("rejects workflow keys that collide once separators are normalised", () => {
    const result = parseActionsLockfileString(
      buildLockText({
        workflows: {
          ".github/workflows/ci.yml": ["example-org/plain-action@v1.0.0"],
          ".github\\workflows\\ci.yml": ["example-org/plain-action@v1.0.0"],
        },
        dependencies: {
          "example-org/plain-action@v1.0.0": {
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      }),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "normalise to the same path");
  });

  it("rejects absolute workflow paths", () => {
    const result = parseActionsLockfileString(
      buildLockText({
        workflows: { "/abs/ci.yml": ["example-org/plain-action@v1.0.0"] },
        dependencies: {
          "example-org/plain-action@v1.0.0": {
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      }),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "is absolute");
  });

  it("rejects Windows drive workflow paths", () => {
    const result = parseActionsLockfileString(
      buildLockText({
        workflows: { "C:\\build\\ci.yml": ["example-org/plain-action@v1.0.0"] },
        dependencies: {
          "example-org/plain-action@v1.0.0": {
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      }),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "is absolute");
  });

  it("rejects a self-referencing uses entry", () => {
    const result = parseActionsLockfileString(
      buildLockText({
        workflows: {
          ".github/workflows/loop.yml": ["example-org/self-loop@v1.0.0"],
        },
        dependencies: {
          "example-org/self-loop@v1.0.0": {
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
            uses: ["example-org/self-loop@v1.0.0"],
          },
        },
      }),
    );
    assertEmptyResult(result);
    assertWarningMentions(
      result,
      "uses cycle detected: example-org/self-loop@v1.0.0 -> example-org/self-loop@v1.0.0",
    );
  });

  it("rejects two entries that normalise to the same pin key", () => {
    const text = buildLockText({
      workflows: { ".github/workflows/ci.yml": ["example-org/dup@v1.0.0"] },
      dependencies: {
        "Example-Org/Dup@v1.0.0": {
          ref: "v1.0.0",
          commit: SHA1_A,
          ownerId: 9100001,
          repoId: 9100002,
        },
        "example-org/dup@v1.0.0": {
          ref: "v1.0.0",
          commit: SHA1_A,
          ownerId: 9100001,
          repoId: 9100002,
        },
      },
    });
    const result = parseActionsLockfileString(text);
    assertEmptyResult(result);
    assertWarningMentions(result, "normalise to the same pin key");
  });

  it("rejects two v0.0.1 entries that differ only in the digest suffix", () => {
    const text = [
      "version: 'v0.0.1'",
      "dependencies:",
      `    'example-org/plain-action@v1.0.0:sha1-${SHA1_A}':`,
      "        tag: 'v1.0.0'",
      `        commit: 'sha1-${SHA1_A}'`,
      "        owner_id: 9100001",
      "        repo_id: 9100002",
      `    'example-org/plain-action@v1.0.0:sha1-${SHA1_B}':`,
      "        tag: 'v1.0.0'",
      `        commit: 'sha1-${SHA1_B}'`,
      "        owner_id: 9100001",
      "        repo_id: 9100002",
    ].join("\n");
    const result = parseActionsLockfileString(text);
    assertEmptyResult(result);
    assertWarningMentions(result, "or in the digest suffix");
  });

  it("keeps the workflow's ref in the key and the resolved ref in the entry", () => {
    const result = parseActionsLockfileString(
      buildLockText({
        workflows: { ".github/workflows/ci.yml": ["actions/checkout@v4"] },
        dependencies: {
          "actions/checkout@v4": {
            ref: "v4.3.1",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      }),
    );
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(Object.keys(result.dependencies), [
      "actions/checkout@v4",
    ]);
    assert.strictEqual(
      result.dependencies["actions/checkout@v4"].ref,
      "v4.3.1",
    );
  });

  it("rejects a v0.0.1 pin key whose digest does not match the entry", () => {
    const text = [
      "version: 'v0.0.1'",
      "workflows:",
      "    '.github/workflows/ci.yml':",
      `        - 'example-org/plain-action@v1.0.0:sha1-${SHA1_A}'`,
      "dependencies:",
      `    'example-org/plain-action@v1.0.0:sha1-${SHA1_B}':`,
      "        tag: 'v1.0.0'",
      `        commit: 'sha1-${SHA1_B}'`,
      "        owner_id: 9100001",
      "        repo_id: 9100002",
    ].join("\n");
    const result = parseActionsLockfileString(text);
    assertEmptyResult(result);
    assertWarningMentions(result, "carries digest");
  });

  it("rejects a workflows pin that is missing from dependencies", () => {
    const result = parseActionsLockfileString(
      buildLockText({
        workflows: {
          ".github/workflows/ci.yml": ["example-org/absent-action@v1.0.0"],
        },
        dependencies: {
          "example-org/other-action@v1.0.0": {
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      }),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "not defined in dependencies");
  });

  it("rejects a workflow pin list that is not an array", () => {
    const result = parseActionsLockfileString(
      [
        "version: 'v0.0.2'",
        "workflows:",
        "    '.github/workflows/ci.yml': 'example-org/plain-action@v1.0.0'",
      ].join("\n"),
    );
    assertEmptyResult(result);
    assertWarningMentions(result, "pin list that is not an array");
  });

  it("rejects unknown top-level fields", () => {
    const text = `${buildLockText({})}notes: 'why does this exist'\n`;
    const result = parseActionsLockfileString(text);
    assertEmptyResult(result);
    assertWarningMentions(result, "unknown top-level field 'notes'");
  });

  it("rejects a missing version", () => {
    const result = parseActionsLockfileString("workflows: {}\n");
    assertEmptyResult(result);
    assertWarningMentions(result, "missing the required version field");
  });

  it("rejects a non-string version", () => {
    const result = parseActionsLockfileString("version: 0.0.2\n");
    assertEmptyResult(result);
    assertWarningMentions(result, "unsupported lockfile version");
  });

  it("rejects a non-mapping document", () => {
    const result = parseActionsLockfileString("just a scalar\n");
    assertEmptyResult(result);
    assertWarningMentions(result, "must be a YAML mapping");
  });

  it("rejects an empty document", () => {
    const result = parseActionsLockfileString("");
    assertEmptyResult(result);
    assertWarningMentions(result, "the lockfile is empty");
  });

  it("rejects non-text input", () => {
    const result = parseActionsLockfileString(undefined);
    assertEmptyResult(result);
    assertWarningMentions(result, "not text");
  });

  it("reports duplicate mapping keys", () => {
    const text = [
      "version: 'v0.0.2'",
      "dependencies:",
      "    'example-org/dup@v1.0.0':",
      "        ref: 'v1.0.0'",
      `        commit: 'sha1-${SHA1_A}'`,
      "        owner_id: 9100001",
      "        repo_id: 9100002",
      "    'example-org/dup@v1.0.0':",
      "        ref: 'v1.0.0'",
      `        commit: 'sha1-${SHA1_A}'`,
      "        owner_id: 9100001",
      "        repo_id: 9100002",
    ].join("\n");
    const result = parseActionsLockfileString(text);
    assertEmptyResult(result);
    assertWarningMentions(result, "duplicate mapping key");
  });

  it("rejects YAML aliases that inflate the document", () => {
    const text = [
      "version: 'v0.0.2'",
      "dependencies:",
      "    'example-org/first@v1.0.0': &entry",
      "        ref: 'v1.0.0'",
      `        commit: 'sha1-${SHA1_A}'`,
      "        owner_id: 9100001",
      "        repo_id: 9100002",
      "    'example-org/second@v1.0.0': *entry",
    ].join("\n");
    const result = parseActionsLockfileString(text);
    assertEmptyResult(result);
    assertWarningMentions(result, "YAML aliases are not allowed");
  });

  it("warns about hidden Unicode but still parses the file", () => {
    const text = `${readFixture("valid-v0.0.2")}# reviewed\u200Bby an agent\n`;
    const result = parseActionsLockfileString(text);
    assert.strictEqual(result.version, "v0.0.2");
    assert.ok(result.dependencies["example-org/setup-node@v4.1.0"]);
    assert.strictEqual(result.warnings.length, 1);
    assertWarningMentions(result, "hidden Unicode characters");
  });

  it("validates v0.0.3 hostnames", () => {
    const validHostnames = [
      "github.com",
      "a.ghe.com",
      "octo-corp.ghe.com",
      `${"a".repeat(63)}.ghe.com`,
    ];
    const invalidHostnames = [
      "GitHub.com",
      "octocorp.ghe.com.evil",
      "ghe.com",
      "-lead.ghe.com",
      "trail-.ghe.com",
      "under_score.ghe.com",
      `${"a".repeat(64)}.ghe.com`,
      " octocorp.ghe.com",
    ];
    for (const hostname of validHostnames) {
      const text = buildLockText({
        version: "v0.0.3",
        workflows: {
          ".github/workflows/ci.yml": ["example-org/hosted-action@v1.0.0"],
        },
        dependencies: {
          "example-org/hosted-action@v1.0.0": {
            hostname,
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      });
      const result = parseActionsLockfileString(text);
      assert.deepStrictEqual(
        result.warnings,
        [],
        `hostname '${hostname}' should be accepted`,
      );
      assert.strictEqual(
        result.dependencies["example-org/hosted-action@v1.0.0"].hostname,
        hostname,
      );
    }
    for (const hostname of invalidHostnames) {
      const text = buildLockText({
        version: "v0.0.3",
        workflows: {
          ".github/workflows/ci.yml": ["example-org/hosted-action@v1.0.0"],
        },
        dependencies: {
          "example-org/hosted-action@v1.0.0": {
            hostname,
            ref: "v1.0.0",
            commit: SHA1_A,
            ownerId: 9100001,
            repoId: 9100002,
          },
        },
      });
      const result = parseActionsLockfileString(text);
      assertEmptyResult(result);
      assertWarningMentions(result, "invalid hostname");
    }
  });

  it("does not throw on truncations of a valid lockfile", () => {
    const text = readFixture("valid-v0.0.2");
    const offsets = [];
    for (let offset = 0; offset <= text.length; offset += 7) {
      offsets.push(offset);
    }
    // A deterministic pseudo-random sweep of the remaining offsets.
    let state = 42;
    for (let index = 0; index < 200; index += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      offsets.push(Math.floor((state / 2147483648) * (text.length + 1)));
    }
    offsets.push(text.length - 1, text.length);
    for (const offset of offsets) {
      const result = parseActionsLockfileString(
        text.slice(0, offset),
        "truncated.lock",
      );
      assert.ok(
        result.version === null || typeof result.version === "string",
        `unexpected version at offset ${offset}`,
      );
      assert.ok(result.workflows && result.dependencies);
      assert.ok(Array.isArray(result.warnings));
    }
  });
});
