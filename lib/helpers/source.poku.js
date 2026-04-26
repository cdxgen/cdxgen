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

    assert.strictEqual(result, undefined);
  });

  it("validates unsupported purl type explicitly", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
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

    const result = validatePurlSource(
      "pkg:maven/org.apache.commons/commons-lang3@3.17.0",
    );

    assert.strictEqual(result.error, "Unsupported purl source type");
  });

  it("resolves docker purl to repository URL using namespace/name", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
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

    const result = await resolveGitUrlFromPurl(
      "pkg:docker/cdxgen/cdxgen@1.0.0",
    );

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen");
  });

  it("resolves generic purl from vcs_url qualifier", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
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
