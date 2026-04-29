import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

describe("source helper purl resolution", () => {
  it("resolves npm purl to repository URL", async () => {
    const getStub = sinon.stub().resolves({
      body: {
        repository: {
          url: "git+https://github.com/cdxgen/cdxgen.git#main",
        },
      },
    });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:npm/cdxgen@12.3.0");

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen.git");
  });

  it("resolves pypi purl using project_urls source fields", async () => {
    const getStub = sinon.stub().resolves({
      body: {
        info: {
          project_urls: {
            Source: "https://github.com/pallets/flask",
          },
        },
      },
    });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:pypi/flask@3.1.2");

    assert.strictEqual(result.repoUrl, "https://github.com/pallets/flask");
  });

  it("returns undefined for unsupported purl type", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:hex/phoenix@1.7.14");

    assert.strictEqual(result, undefined);
  });

  it("validates unsupported purl type explicitly", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = validatePurlSource("pkg:hex/phoenix@1.7.14");

    assert.strictEqual(result.error, "Unsupported purl source type");
  });

  it("resolves github purl to repository URL without registry lookup", async () => {
    const getStub = sinon.stub();
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:github/cdxgen/cdxgen");

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen");
    assert.strictEqual(getStub.callCount, 0);
  });

  it("resolves bitbucket purl to repository URL without registry lookup", async () => {
    const getStub = sinon.stub();
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:bitbucket/acme/team-lib");

    assert.strictEqual(result.repoUrl, "https://bitbucket.org/acme/team-lib");
    assert.strictEqual(getStub.callCount, 0);
  });

  it("resolves maven purl from pom scm metadata", async () => {
    const getStub = sinon.stub();
    const fetchPomXmlAsJson = sinon.stub().resolves({
      scm: {
        url: {
          _: "scm:git:https://github.com/apache/commons-lang.git",
        },
      },
    });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        fetchPomXmlAsJson,
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl(
      "pkg:maven/org.apache.commons/commons-lang3@3.17.0",
    );

    assert.strictEqual(
      result.repoUrl,
      "https://github.com/apache/commons-lang.git",
    );
    assert.strictEqual(
      fetchPomXmlAsJson.firstCall.args[0].urlPrefix,
      "https://repo1.maven.org/maven2/",
    );
    assert.strictEqual(
      fetchPomXmlAsJson.firstCall.args[0].group,
      "org.apache.commons",
    );
    assert.strictEqual(
      fetchPomXmlAsJson.firstCall.args[0].name,
      "commons-lang3",
    );
    assert.strictEqual(fetchPomXmlAsJson.firstCall.args[0].version, "3.17.0");
    assert.strictEqual(getStub.callCount, 0);
  });

  it("resolves maven purl from pom scm connection metadata", async () => {
    const fetchPomXmlAsJson = sinon.stub().resolves({
      scm: {
        connection: {
          _: "scm:git:git://github.com/apache/commons-lang.git",
        },
      },
    });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson,
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl(
      "pkg:maven/org.apache.commons/commons-lang3@3.17.0",
    );

    assert.strictEqual(
      result.repoUrl,
      "git://github.com/apache/commons-lang.git",
    );
  });

  it("resolves composer purl from packagist source metadata", async () => {
    const getStub = sinon.stub().resolves({
      body: {
        packages: {
          "laravel/framework": [
            {
              version: "v11.36.0",
              source: {
                type: "git",
                url: "https://github.com/laravel/framework.git",
              },
            },
          ],
        },
      },
    });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl(
      "pkg:composer/laravel/framework@v11.36.0",
    );

    assert.strictEqual(
      result.repoUrl,
      "https://github.com/laravel/framework.git",
    );
    assert.strictEqual(
      getStub.firstCall.args[0],
      "https://repo.packagist.org/p2/laravel/framework.json",
    );
  });

  it("logs underlying registry lookup errors for purl resolution", async () => {
    const originalNpmUrl = process.env.NPM_URL;
    process.env.NPM_URL = "https://user:secret@example.com/repository/npm/";
    const consoleErrorStub = sinon.stub(console, "error");
    const lookupError = new Error("connect ECONNREFUSED");
    lookupError.code = "ECONNREFUSED";
    lookupError.hostname = "example.com";
    const getStub = sinon.stub().rejects(lookupError);
    try {
      const { resolveGitUrlFromPurl } = await esmock("./source.js", {
        "./utils.js": {
          cdxgenAgent: { get: getStub },
          DEBUG_MODE: false,
          fetchPomXmlAsJson: sinon.stub(),
          getTmpDir: sinon.stub().returns(os.tmpdir()),
          hasDangerousUnicode: sinon.stub().returns(false),
          isSecureMode: false,
          isValidDriveRoot: sinon.stub().returns(true),
          isWin: false,
          safeSpawnSync: sinon.stub(),
        },
      });

      const result = await resolveGitUrlFromPurl("pkg:npm/lodash@4.17.21");

      assert.strictEqual(result, undefined);
      sinon.assert.calledOnce(consoleErrorStub);
      sinon.assert.calledWithMatch(
        consoleErrorStub,
        sinon.match(
          /Unable to resolve repository URL for purl 'pkg:npm\/lodash@4\.17\.21' using registry 'https:\/\/\*\*\*:\*\*\*@example\.com\/repository\/npm\/': connect ECONNREFUSED \(code=ECONNREFUSED, host=example\.com\)/,
        ),
      );
    } finally {
      consoleErrorStub.restore();
      if (originalNpmUrl === undefined) {
        delete process.env.NPM_URL;
      } else {
        process.env.NPM_URL = originalNpmUrl;
      }
    }
  });

  it("cleans up temp directories even when the provided path uses a symlinked temp alias", async () => {
    const realTmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cdxgen-real-tmp-"),
    );
    const realTarget = path.join(realTmpRoot, "checkout");
    const aliasRoot = path.join(os.tmpdir(), `cdxgen-tmp-alias-${Date.now()}`);
    const aliasTarget = path.join(aliasRoot, "checkout");
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTmpRoot, aliasRoot, "dir");
    const { cleanupSourceDir } = await esmock("./source.js", {
      "./logger.js": {
        thoughtLog: sinon.stub(),
      },
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(realTmpRoot),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    try {
      assert.ok(fs.existsSync(aliasTarget));
      cleanupSourceDir(aliasTarget);
      assert.strictEqual(fs.existsSync(aliasTarget), false);
      assert.strictEqual(fs.existsSync(realTarget), false);
      assert.strictEqual(fs.existsSync(realTmpRoot), true);
    } finally {
      fs.rmSync(aliasRoot, { force: true, recursive: true });
      fs.rmSync(realTmpRoot, { force: true, recursive: true });
    }
  });

  it("requires version for maven purl sources", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = validatePurlSource(
      "pkg:maven/org.apache.commons/commons-lang3",
    );

    assert.strictEqual(result.error, "Invalid purl source");
    assert.strictEqual(
      result.details,
      "The provided maven package URL must include a version.",
    );
  });

  it("treats docker purl as unsupported source type", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = validatePurlSource("pkg:docker/cdxgen/cdxgen@1.0.0");

    assert.strictEqual(result.error, "Unsupported purl source type");
  });

  it("resolves generic purl from vcs_url qualifier", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = await resolveGitUrlFromPurl(
      "pkg:generic/example@1.0.0?vcs_url=git+https://github.com/cdxgen/cdxgen.git",
    );

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen.git");
  });

  it("requires vcs_url or download_url qualifier for generic purl", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });

    const result = validatePurlSource("pkg:generic/example@1.0.0");

    assert.strictEqual(result.error, "Unsupported generic purl source");
  });

  it("finds matching git ref for npm package version", async () => {
    const safeSpawnSync = sinon.stub().returns({
      status: 0,
      stdout: `a refs/tags/v1.2.3
b refs/tags/other
`,
    });
    const { findGitRefForPurlVersion } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });
    const result = findGitRefForPurlVersion(
      "https://github.com/cdxgen/cdxgen",
      {
        type: "npm",
        namespace: "cdxgen",
        name: "cdxgen",
        version: "1.2.3",
      },
    );
    assert.strictEqual(result, "v1.2.3");
  });

  it("hardens git ls-remote invocation in secure mode", async () => {
    const safeSpawnSync = sinon.stub().returns({
      status: 0,
      stdout: "a refs/tags/v1.2.3\n",
    });
    const { findGitRefForPurlVersion } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: true,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });

    const result = findGitRefForPurlVersion(
      "https://github.com/cdxgen/cdxgen",
      {
        type: "npm",
        namespace: "cdxgen",
        name: "cdxgen",
        version: "1.2.3",
      },
    );

    assert.strictEqual(result, "v1.2.3");
    assert.strictEqual(safeSpawnSync.firstCall.args[0], "git");
    assert.deepStrictEqual(safeSpawnSync.firstCall.args[1].slice(0, 8), [
      "-c",
      "alias.ls-remote=",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "core.hooksPath=/dev/null",
    ]);
    assert.strictEqual(
      safeSpawnSync.firstCall.args[2].env.GIT_ALLOW_PROTOCOL,
      "https:ssh",
    );
    assert.strictEqual(
      safeSpawnSync.firstCall.args[2].env.GIT_CONFIG_NOSYSTEM,
      "1",
    );
    assert.strictEqual(
      safeSpawnSync.firstCall.args[2].env.GIT_CONFIG_GLOBAL,
      "/dev/null",
    );
  });

  it("selects npm monorepo directory based on package.json name", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-purl-test-"));
    const pkgDir = path.join(tmpRoot, "packages", "core");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@scope/pkg" }),
      "utf-8",
    );
    const { resolvePurlSourceDirectory } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon.stub(),
      },
    });
    const result = resolvePurlSourceDirectory(tmpRoot, {
      type: "npm",
      namespace: "scope",
      name: "pkg",
    });
    assert.strictEqual(result, pkgDir);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("builds release notes from provided tags", async () => {
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 1, stdout: "", stderr: "" }),
      },
    });
    const releaseNotes = buildReleaseNotesFromGit(undefined, {
      releaseNotesCurrentTag: "v1.2.3",
      releaseNotesPreviousTag: "v1.2.2",
    });
    assert.strictEqual(releaseNotes.type, "patch");
    assert.strictEqual(releaseNotes.title, "Release notes for v1.2.3");
    assert.deepStrictEqual(releaseNotes.tags, ["v1.2.3", "v1.2.2"]);
    assert.ok(Array.isArray(releaseNotes.resolves));
    assert.strictEqual(releaseNotes.resolves.length, 0);
  });

  it("returns undefined for unsafe current tag from options", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: 1, stdout: "", stderr: "" });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });
    const releaseNotes = buildReleaseNotesFromGit(undefined, {
      releaseNotesCurrentTag: "-bad-tag",
      releaseNotesPreviousTag: "v1.2.2",
    });
    assert.strictEqual(releaseNotes, undefined);
    assert.strictEqual(safeSpawnSync.callCount, 0);
  });

  it("auto-detects local tags and commit resolves using hardened git command", async () => {
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      if (args.includes("tag")) {
        return { status: 0, stdout: "v2.0.0\nv1.9.0\n", stderr: "" };
      }
      if (args.includes("config")) {
        return {
          status: 0,
          stdout: "https://github.com/cdxgen/cdxgen.git\n",
          stderr: "",
        };
      }
      if (args.includes("--format=%cI")) {
        return { status: 0, stdout: "2026-04-01T12:00:00Z\n", stderr: "" };
      }
      if (args.includes("--pretty=format:%H%x09%s")) {
        return {
          status: 0,
          stdout: "abcdef123456\tFix parser bug\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });
    const releaseNotes = buildReleaseNotesFromGit("/tmp/repo", {});
    assert.strictEqual(releaseNotes.type, "major");
    assert.strictEqual(releaseNotes.timestamp, "2026-04-01T12:00:00Z");
    assert.deepStrictEqual(releaseNotes.tags, ["v2.0.0", "v1.9.0"]);
    assert.strictEqual(releaseNotes.resolves[0].type, "defect");
    assert.strictEqual(releaseNotes.resolves[0].id, "abcdef123456");
    assert.strictEqual(releaseNotes.resolves[0].name, "Fix parser bug");
    assert.strictEqual(releaseNotes.resolves[0].description, "Fix parser bug");
    assert.strictEqual(safeSpawnSync.firstCall.args[0], "git");
  });

  it("ignores unsafe previous tag and skips git log range", async () => {
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      if (args.includes("tag")) {
        return { status: 0, stdout: "v2.0.0\n-bad-prev\n", stderr: "" };
      }
      if (args.includes("--format=%cI")) {
        return { status: 0, stdout: "2026-04-01T12:00:00Z\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });
    const releaseNotes = buildReleaseNotesFromGit("/tmp/repo", {});
    assert.strictEqual(releaseNotes.title, "Release notes for v2.0.0");
    assert.deepStrictEqual(releaseNotes.tags, ["v2.0.0"]);
    assert.strictEqual(releaseNotes.resolves.length, 0);
    assert.strictEqual(
      safeSpawnSync
        .getCalls()
        .some((call) => call.args[1].includes("--pretty=format:%H%x09%s")),
      false,
    );
  });

  it("skips remote tag discovery for invalid releaseNotesGitUrl", async () => {
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      if (args.includes("ls-remote")) {
        return {
          status: 0,
          stdout: "a refs/tags/v2.0.0\nb refs/tags/v1.9.0\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });
    const releaseNotes = buildReleaseNotesFromGit(undefined, {
      releaseNotesGitUrl: "ext::https://github.com/cdxgen/cdxgen.git",
    });
    assert.strictEqual(releaseNotes, undefined);
    assert.strictEqual(
      safeSpawnSync
        .getCalls()
        .some((call) => call.args[1].includes("ls-remote")),
      false,
    );
  });

  it("skips remote tag discovery for leading-dash releaseNotesGitUrl", async () => {
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      if (args.includes("ls-remote")) {
        return {
          status: 0,
          stdout: "a refs/tags/v2.0.0\nb refs/tags/v1.9.0\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "./utils.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        fetchPomXmlAsJson: sinon.stub(),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
        safeSpawnSync,
      },
    });
    const releaseNotes = buildReleaseNotesFromGit(undefined, {
      releaseNotesGitUrl: "-https://github.com/cdxgen/cdxgen.git",
    });
    assert.strictEqual(releaseNotes, undefined);
    assert.strictEqual(
      safeSpawnSync
        .getCalls()
        .some((call) => call.args[1].includes("ls-remote")),
      false,
    );
  });
});
