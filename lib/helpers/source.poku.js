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
});
