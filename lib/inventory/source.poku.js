import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

describe("source helper purl resolution", () => {
  it("gitClone() records a blocked clone in dry-run mode", async () => {
    const recordActivity = sinon.stub();
    const safeSpawnSync = sinon.stub();
    const { gitClone } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        createDryRunError: (action, target, reason) => {
          const error = new Error(reason);
          error.action = action;
          error.code = "CDXGEN_DRY_RUN";
          error.target = target;
          error.dryRun = true;
          return error;
        },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isDryRun: true,
        isSecureMode: false,
        recordActivity,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const clonedPath = gitClone("https://github.com/cdxgen/cdxgen.git", "main");

    assert.ok(clonedPath.includes("dry-run-clone"));
    sinon.assert.notCalled(safeSpawnSync);
    sinon.assert.calledOnce(recordActivity);
    assert.strictEqual(recordActivity.firstCall.args[0].kind, "clone");
    assert.strictEqual(recordActivity.firstCall.args[0].status, "blocked");
  });

  it("hardenedGitCommand() tags git operations with the specific subcommand", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: 0, stdout: "", stderr: "" });
    const { hardenedGitCommand } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isDryRun: false,
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    hardenedGitCommand(["fetch", "--tags"], { cwd: "/tmp/repo" });

    sinon.assert.calledWithMatch(safeSpawnSync, "git", ["fetch", "--tags"], {
      cdxgenActivity: sinon.match({
        gitOperation: "fetch",
        kind: "git-fetch",
      }),
      cwd: "/tmp/repo",
    });
  });

  it("hardenedGitCommand() keeps a URL password away from the credential helpers", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: 0, stdout: "", stderr: "" });
    const { hardenedGitCommand } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isDryRun: false,
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });
    const gitArgsFor = (remote) => {
      safeSpawnSync.resetHistory();
      hardenedGitCommand(["ls-remote", "--refs", "--", remote]);
      return safeSpawnSync.firstCall.args[1];
    };

    for (const remote of [
      "https://user:token@example.com/org/repo.git",
      "https://x-access-token:token@example.com:8443/org/repo.git",
      "https://token:@example.com/org/repo.git",
      "https://:token@example.com/org/repo.git",
    ]) {
      assert.deepStrictEqual(
        gitArgsFor(remote),
        ["-c", "credential.helper=", "ls-remote", "--refs", "--", remote],
        remote,
      );
    }
    // Without a password in the URL the account's helpers still answer.
    for (const remote of [
      "https://example.com/org/repo.git",
      "https://example.com:8443/org/repo.git",
      "https://user@example.com/org/repo.git",
      "https://example.com/org/repo.git?ref=a:b@c",
      "git@example.com:org/repo.git",
    ]) {
      assert.deepStrictEqual(
        gitArgsFor(remote),
        ["ls-remote", "--refs", "--", remote],
        remote,
      );
    }
  });

  it("resolves npm purl to repository URL", async () => {
    const getStub = sinon.stub().resolves({
      body: {
        repository: {
          url: "git+https://github.com/cdxgen/cdxgen.git#main",
        },
      },
    });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:npm/cdxgen@12.3.0");

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen.git");
  });

  it("asks the npm registry only about a purl that names a package", async () => {
    const originalNpmUrl = process.env.NPM_URL;
    process.env.NPM_URL = "https://npm.example.com/repository/npm-group/";
    const getStub = sinon.stub().resolves({
      body: {
        repository: { url: "git+https://github.com/cdxgen/cdxgen.git" },
      },
    });
    const prefetchStub = sinon.stub().resolves(new Map());
    try {
      const { prefetchGitUrlSources, resolveGitUrlFromPurl } = await esmock(
        "./source.js",
        {
          "./fetchBatch.js": {
            gatedGet: (url, options) => getStub(url, options),
            prefetchEnabled: () => true,
            prefetchJson: prefetchStub,
          },
          "../core/activity.js": {
            cdxgenAgent: { get: getStub },
            DEBUG_MODE: false,
            hasDangerousUnicode: sinon.stub().returns(false),
            isSecureMode: false,
          },
          "../core/fs.js": {
            getTmpDir: sinon.stub().returns(os.tmpdir()),
            safeSpawnSync: sinon.stub(),
          },
          "../core/paths.js": {
            isValidDriveRoot: sinon.stub().returns(true),
            isWin: false,
          },
        },
      );
      // The name is appended to the registry URL, which may carry the
      // operator's credential. One that is not a package name would address
      // another path on that host, so no document is requested for it.
      const notPackages = [
        "pkg:npm/..%2Fnpm-private%2Fbilling-core@1.0.0",
        "pkg:npm/../npm-private/billing-core@1.0.0",
        "pkg:npm/%40acme/..%2F..%2Fnpm-private%2Fbilling-core@1.0.0",
        "pkg:npm/%40acme/..@1.0.0",
        "pkg:npm/left-pad%3Fwrite%3Dtrue@1.0.0",
        "pkg:npm/a%5C..%5Cb@1.0.0",
      ];
      for (const purl of notPackages) {
        assert.strictEqual(await resolveGitUrlFromPurl(purl), undefined, purl);
      }
      await prefetchGitUrlSources(notPackages);
      sinon.assert.notCalled(getStub);
      sinon.assert.notCalled(prefetchStub);

      await prefetchGitUrlSources([
        ...notPackages,
        "pkg:npm/%40babel/core@7.0.0",
      ]);
      sinon.assert.calledOnceWithExactly(prefetchStub, [
        { url: "https://npm.example.com/repository/npm-group/@babel/core" },
      ]);
      const result = await resolveGitUrlFromPurl("pkg:npm/%40babel/core@7.0.0");
      assert.strictEqual(
        result.repoUrl,
        "https://github.com/cdxgen/cdxgen.git",
      );
      sinon.assert.calledOnceWithMatch(
        getStub,
        "https://npm.example.com/repository/npm-group/@babel/core",
      );
    } finally {
      if (originalNpmUrl === undefined) {
        delete process.env.NPM_URL;
      } else {
        process.env.NPM_URL = originalNpmUrl;
      }
    }
  });

  it("asks the other registries only about purls that name a package", async () => {
    const getStub = sinon.stub().resolves({ body: {} });
    const prefetchStub = sinon.stub().resolves(new Map());
    const { prefetchGitUrlSources, resolveGitUrlFromPurl } = await esmock(
      "./source.js",
      {
        "./fetchBatch.js": {
          gatedGet: (url, options) => getStub(url, options),
          prefetchEnabled: () => true,
          prefetchJson: prefetchStub,
        },
      },
    );
    const notPackages = [
      "pkg:pypi/..%2Fsimple@1.0.0",
      "pkg:pypi/requests@1.0%2F..%2F..",
      "pkg:gem/..@1.0.0",
      "pkg:gem/rake@..%2F..",
      "pkg:cargo/..%2Fcrates@1.0.0",
      "pkg:cargo/a%5Cb@1.0.0",
      "pkg:pub/http@1.0.0%2F..%2F..",
      "pkg:composer/..%2Fx/y@1.0.0",
      "pkg:composer/vendor/..@1.0.0",
    ];
    for (const purl of notPackages) {
      assert.strictEqual(await resolveGitUrlFromPurl(purl), undefined, purl);
    }
    await prefetchGitUrlSources(notPackages);
    sinon.assert.notCalled(getStub);
    sinon.assert.notCalled(prefetchStub);
    await prefetchGitUrlSources([...notPackages, "pkg:pypi/requests@2.31.0"]);
    sinon.assert.calledOnce(prefetchStub);
    assert.strictEqual(prefetchStub.firstCall.args[0].length, 1);
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
      "./fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:pypi/flask@3.1.2");

    assert.strictEqual(result.repoUrl, "https://github.com/pallets/flask");
  });

  it("returns undefined for unsupported purl type", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:hex/phoenix@1.7.14");

    assert.strictEqual(result, undefined);
  });

  it("validates unsupported purl type explicitly", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = validatePurlSource("pkg:hex/phoenix@1.7.14");

    assert.strictEqual(result.error, "Unsupported purl source type");
  });

  it("resolves github purl to repository URL without registry lookup", async () => {
    const getStub = sinon.stub();
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:github/cdxgen/cdxgen");

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen");
    assert.strictEqual(getStub.callCount, 0);
  });

  it("resolves bitbucket purl to repository URL without registry lookup", async () => {
    const getStub = sinon.stub();
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl("pkg:bitbucket/acme/team-lib");

    assert.strictEqual(result.repoUrl, "https://bitbucket.org/acme/team-lib");
    assert.strictEqual(getStub.callCount, 0);
  });

  it("resolves maven purl from pom scm metadata", async () => {
    // The POM is looked up on Maven Central, not on a mirror.
    const previousMirror = process.env.MAVEN_CENTRAL_MIRROR;
    delete process.env.MAVEN_CENTRAL_MIRROR;
    try {
      const getStub = sinon.stub();
      const fetchPomXmlAsJson = sinon.stub().resolves({
        scm: {
          url: {
            _: "scm:git:https://github.com/apache/commons-lang.git",
          },
        },
      });
      const { resolveGitUrlFromPurl } = await esmock("./source.js", {
        "./fetchBatch.js": {
          gatedGet: (url, options) => getStub(url, options),
        },
        "../core/activity.js": {
          cdxgenAgent: { get: getStub },
          DEBUG_MODE: false,
          hasDangerousUnicode: sinon.stub().returns(false),
          isSecureMode: false,
        },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns(os.tmpdir()),
          safeSpawnSync: sinon.stub(),
        },
        "../core/paths.js": {
          isValidDriveRoot: sinon.stub().returns(true),
          isWin: false,
        },
      });

      const result = await resolveGitUrlFromPurl(
        "pkg:maven/org.apache.commons/commons-lang3@3.17.0",
        { fetchPomXmlAsJson },
      );

      // The injected fetcher must actually be reached. A caller that forgets to
      // pass it would otherwise resolve every maven purl to undefined without
      // any error, which is indistinguishable from a package that has no scm
      // metadata.
      sinon.assert.calledOnce(fetchPomXmlAsJson);

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
    } finally {
      if (previousMirror !== undefined) {
        process.env.MAVEN_CENTRAL_MIRROR = previousMirror;
      }
    }
  });

  it("resolveGitUrlFromPurl() throws for a maven purl when fetchPomXmlAsJson is not injected", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    await assert.rejects(
      () =>
        resolveGitUrlFromPurl(
          "pkg:maven/org.apache.commons/commons-lang3@3.17.0",
        ),
      /injected fetchPomXmlAsJson/,
    );
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl(
      "pkg:maven/org.apache.commons/commons-lang3@3.17.0",
      { fetchPomXmlAsJson },
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
      "./fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
        "./fetchBatch.js": {
          gatedGet: (url, options) => getStub(url, options),
        },
        "../core/activity.js": {
          cdxgenAgent: { get: getStub },
          DEBUG_MODE: false,
          hasDangerousUnicode: sinon.stub().returns(false),
          isSecureMode: false,
        },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns(os.tmpdir()),
          safeSpawnSync: sinon.stub(),
        },
        "../core/paths.js": {
          isValidDriveRoot: sinon.stub().returns(true),
          isWin: false,
        },
      });

      const result = await resolveGitUrlFromPurl("pkg:npm/lodash@4.17.21", {
        fetchPomXmlAsJson: sinon.stub(),
      });

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

  it("keeps registry lookups on the configured host when the override has no trailing slash", async () => {
    const overrides = {
      NPM_URL: "https://user:secret@npm.example.com",
      PYPI_URL: "https://user:secret@pypi.example.com",
      RUBYGEMS_V1_URL: "https://user:secret@gems.example.com",
      RUBYGEMS_V2_URL: "https://user:secret@gems.example.com",
      RUST_CRATES_URL: "https://user:secret@crates.example.com",
    };
    const getStub = sinon.stub().resolves({ body: {} });
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "./fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: getStub },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
        readEnvironmentVariable: (name) => overrides[name],
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    // Each name would become the host of the request, and be sent the
    // registry credentials, if it were appended straight after the host. A
    // name that is a valid package name is asked for below the configured
    // path; any other is not asked for at all.
    const lookups = [
      [
        "pkg:npm/%40attacker.example/leftpad@1.0.0",
        "https://user:secret@npm.example.com/@attacker.example/leftpad",
      ],
      ["pkg:npm/.attacker.example/leftpad@1.0.0", undefined],
      ["pkg:pypi/%40attacker@1.0.0", undefined],
      ["pkg:gem/%40attacker.example", undefined],
      ["pkg:gem/%40attacker.example@1.0.0", undefined],
      ["pkg:cargo/%40attacker.example@1.0.0", undefined],
    ];
    for (const [purl, expectedUrl] of lookups) {
      getStub.resetHistory();
      await resolveGitUrlFromPurl(purl);
      if (!expectedUrl) {
        sinon.assert.notCalled(getStub);
        continue;
      }
      sinon.assert.calledOnce(getStub);
      const requestedUrl = getStub.firstCall.args[0];
      assert.strictEqual(requestedUrl, expectedUrl);
      assert.ok(new URL(requestedUrl).hostname.endsWith(".example.com"), purl);
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
      "../core/logger.js": {
        thoughtLog: sinon.stub(),
      },
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(realTmpRoot),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    try {
      assert.ok(fs.existsSync(aliasTarget));
      cleanupSourceDir(aliasTarget);
      assert.strictEqual(fs.existsSync(aliasTarget), false);
      assert.strictEqual(fs.existsSync(realTarget), false);
      assert.strictEqual(fs.existsSync(realTmpRoot), true);
    } finally {
      fs.rmSync(aliasRoot, {
        force: true,
        recursive: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      fs.rmSync(realTmpRoot, {
        force: true,
        recursive: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("requires version for maven purl sources", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = validatePurlSource("pkg:docker/cdxgen/cdxgen@1.0.0");

    assert.strictEqual(result.error, "Unsupported purl source type");
  });

  it("resolves generic purl from vcs_url qualifier", async () => {
    const { resolveGitUrlFromPurl } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

    const result = await resolveGitUrlFromPurl(
      "pkg:generic/example@1.0.0?vcs_url=git%2Bhttps:%2F%2Fgithub.com%2Fcdxgen%2Fcdxgen.git",
    );

    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen.git");
  });

  it("requires vcs_url or download_url qualifier for generic purl", async () => {
    const { validatePurlSource } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: true,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });
    const result = resolvePurlSourceDirectory(tmpRoot, {
      type: "npm",
      namespace: "scope",
      name: "pkg",
    });
    assert.strictEqual(result, pkgDir);
    fs.rmSync(tmpRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("builds release notes from provided tags", async () => {
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 1, stdout: "", stderr: "" }),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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

  it("does not list remote tags for an origin git reads as an unchecked remote", async () => {
    // git treats host:path as an SCP-like remote, but cdxgen does not
    // recognise it as remote, so it would skip the host allowlist.
    for (const origin of [
      "evil.invalid:github.com/x",
      "deploy@evil.invalid:github.com/x",
    ]) {
      const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: "true\n", stderr: "" };
        }
        if (args.includes("config")) {
          return { status: 0, stdout: `${origin}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      const { buildReleaseNotesFromGit } = await esmock("./source.js", {
        "../core/activity.js": {
          cdxgenAgent: { get: sinon.stub() },
          DEBUG_MODE: false,
          hasDangerousUnicode: sinon.stub().returns(false),
          isSecureMode: false,
        },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns(os.tmpdir()),
          safeSpawnSync,
        },
        "../core/paths.js": {
          isValidDriveRoot: sinon.stub().returns(true),
          isWin: false,
        },
        // git is stubbed, so the check that asks it whose repository this is
        // is stubbed with it.
        "./envcontext.js": { isOwnGitRepository: () => true },
      });
      buildReleaseNotesFromGit(os.tmpdir(), {});
      assert.ok(
        !safeSpawnSync.getCalls().some((c) => c.args[1].includes("ls-remote")),
        origin,
      );
    }
  });

  it("does not list remote tags for an origin that names github.com in its path", async () => {
    for (const origin of [
      "https://evil.invalid/github.com/x",
      "https://evil.invalid//github.com/x",
      "git@evil.invalid:github.com/x",
    ]) {
      const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: "true\n", stderr: "" };
        }
        if (args.includes("config")) {
          return { status: 0, stdout: `${origin}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      const { buildReleaseNotesFromGit } = await esmock("./source.js", {
        "../core/activity.js": {
          cdxgenAgent: { get: sinon.stub() },
          DEBUG_MODE: false,
          hasDangerousUnicode: sinon.stub().returns(false),
          isSecureMode: false,
        },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns(os.tmpdir()),
          safeSpawnSync,
        },
        "../core/paths.js": {
          isValidDriveRoot: sinon.stub().returns(true),
          isWin: false,
        },
      });
      buildReleaseNotesFromGit(os.tmpdir(), {});
      assert.ok(
        !safeSpawnSync.getCalls().some((c) => c.args[1].includes("ls-remote")),
        origin,
      );
    }
  });

  it("runs ls-remote outside any repository in the working directory", async () => {
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      if (args.includes("config")) {
        return {
          status: 0,
          stdout: "https://github.com/cdxgen/cdxgen.git\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
      // git is stubbed, so the check that asks it whose repository this is
      // is stubbed with it.
      "./envcontext.js": { isOwnGitRepository: () => true },
    });
    buildReleaseNotesFromGit(os.tmpdir(), {});
    const lsRemote = safeSpawnSync
      .getCalls()
      .find((c) => c.args[1].includes("ls-remote"));
    assert.ok(lsRemote, "expected ls-remote for a github.com origin");
    assert.ok(lsRemote.args[2].env.GIT_DIR, "GIT_DIR must be set");
    assert.ok(!fs.existsSync(lsRemote.args[2].env.GIT_DIR));
    assert.strictEqual(lsRemote.args[2].env.GIT_NO_LAZY_FETCH, "1");
  });

  it("gitClone() refuses a remote that fails validation", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0, stderr: "" });
    const { gitClone } = await esmock("./source.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
    });
    assert.throws(
      () => gitClone("https://allowed.example\\@evil.example/x.git"),
      /Invalid URL Format/,
    );
    assert.strictEqual(safeSpawnSync.callCount, 0);
  });

  it("checkoutClonedRepository() refuses a tree it cannot measure", async () => {
    // The listing of a tree with millions of entries overruns the spawn
    // buffer. Such a repository is not checked out.
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      if (args.includes("ls-tree")) {
        const error = new Error("spawnSync git ENOBUFS");
        error.code = "ENOBUFS";
        return { error, status: null, stderr: "", stdout: "" };
      }
      return { status: 0, stderr: "", stdout: "" };
    });
    const { checkoutClonedRepository } = await esmock("./source.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdirSync: sinon.stub(),
        safeSpawnSync,
        safeWriteSync: sinon.stub(),
      },
    });
    const cloneDir = path.join(os.tmpdir(), "fake-repo");
    const result = checkoutClonedRepository(cloneDir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /not checked out/);
    // Every call names the clone, so git cannot pick a repository further up.
    for (const call of safeSpawnSync.getCalls()) {
      assert.ok(
        call.args[1].includes(`--git-dir=${path.join(cloneDir, ".git")}`),
      );
    }
    assert.ok(
      !safeSpawnSync.getCalls().some((call) => call.args[1].includes("reset")),
      "nothing may be checked out",
    );
  });

  it("returns undefined for unsafe current tag from options", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: 1, stdout: "", stderr: "" });
    const { buildReleaseNotesFromGit } = await esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
      // git is stubbed, so the check that asks it whose repository this is
      // is stubbed with it.
      "./envcontext.js": { isOwnGitRepository: () => true },
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
      // git is stubbed, so the check that asks it whose repository this is
      // is stubbed with it.
      "./envcontext.js": { isOwnGitRepository: () => true },
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync,
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
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

  it("takes no release notes from a repository the directory points its .git at", async () => {
    const { buildReleaseNotesFromGit, hardenedGitCommand } = await import(
      "./source.js"
    );
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-notes-"));
    const originalWarn = console.warn;
    try {
      const otherDir = path.join(tmpRoot, "other");
      const scannedDir = path.join(tmpRoot, "scanned");
      fs.mkdirSync(otherDir);
      fs.mkdirSync(scannedDir);
      const commit = [
        "-c",
        "user.name=cdxgen",
        "-c",
        "user.email=cdxgen@example.org",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
      ];
      for (const args of [
        ["init", "-q"],
        [...commit, "first"],
        ["-c", "tag.gpgsign=false", "tag", "v9.9.8"],
        [...commit, "fix: other repository secret"],
        ["-c", "tag.gpgsign=false", "tag", "v9.9.9"],
      ]) {
        const result = hardenedGitCommand(args, { cwd: otherDir });
        assert.ok(result.status === 0, `git ${args.at(-1)}: ${result.stderr}`);
      }
      fs.writeFileSync(
        path.join(scannedDir, ".git"),
        "gitdir: ../other/.git\n",
      );
      const ownNotes = buildReleaseNotesFromGit(otherDir, {});
      assert.deepStrictEqual(ownNotes.tags.toSorted(), ["v9.9.8", "v9.9.9"]);
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(" "));
      assert.strictEqual(buildReleaseNotesFromGit(scannedDir, {}), undefined);
      assert.ok(warnings.some((w) => w.includes(scannedDir)));
    } finally {
      console.warn = originalWarn;
      fs.rmSync(tmpRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
});

describe("isSafeGitRefName", () => {
  it("accepts ordinary tag and branch names", async () => {
    const { isSafeGitRefName } = await import("./source.js");
    for (const refName of [
      "v1.2.3",
      "main",
      "refs/tags/v1",
      "@scope/pkg@1.0",
    ]) {
      assert.ok(isSafeGitRefName(refName), `${refName} should be accepted`);
    }
  });

  it("rejects refs that would be read as git options or shell syntax", async () => {
    const { isSafeGitRefName } = await import("./source.js");
    for (const refName of [
      "--upload-pack=touch /tmp/pwned",
      "-oProxyCommand=id",
      "v1;id",
      "v1 --depth",
      "",
      undefined,
    ]) {
      assert.ok(
        !isSafeGitRefName(refName),
        `${JSON.stringify(refName)} should be rejected`,
      );
    }
  });
});

describe("splitSourcePaths", () => {
  it("splits a list of missing paths and keeps an existing path whole", async () => {
    const { splitSourcePaths } = await import("./source.js");
    assert.deepStrictEqual(splitSourcePaths(`a${path.sep}x, b${path.sep}y`), [
      `a${path.sep}x`,
      `b${path.sep}y`,
    ]);
    assert.deepStrictEqual(splitSourcePaths("plain"), ["plain"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-split,"));
    try {
      assert.deepStrictEqual(splitSourcePaths(dir), [dir]);
    } finally {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
});

describe("getSourceLabel and getSourceBaseName", () => {
  const encodedPurl =
    "pkg:generic/demo@1.0?vcs_url=git%2Bhttps:%2F%2Fci-bot:hunter2%40git.example.com%2Facme%2Fdemo.git";

  it("leaves credentials out of the label of a purl", async () => {
    const { getSourceBaseName, getSourceLabel } = await import("./source.js");
    assert.strictEqual(getSourceLabel(encodedPurl), "pkg:generic/demo@1.0");
    assert.strictEqual(getSourceBaseName(encodedPurl), "demo@1.0");
    assert.strictEqual(
      getSourceBaseName(
        "pkg:generic/demo@1.0?vcs_url=git+https://ci-bot:hunter2@git.example.com/acme/demo.git#src",
      ),
      "demo.git",
    );
    assert.strictEqual(
      getSourceBaseName("pkg:npm/%40cdxgen/cdxgen@12.0.0"),
      "cdxgen@12.0.0",
    );
  });

  it("leaves credentials out of the label of a git URL", async () => {
    const { getSourceBaseName, getSourceLabel } = await import("./source.js");
    const url =
      "https://ci-bot:hunter2@git.example.com/acme/demo.git?private_token=abc123#frag";
    assert.ok(!getSourceLabel(url).includes("hunter2"));
    assert.ok(!getSourceLabel(url).includes("abc123"));
    assert.strictEqual(getSourceBaseName(url), "demo.git");
    assert.strictEqual(
      getSourceBaseName("https://ci-bot:hunter2@git.example.com"),
      "git.example.com",
    );
    assert.strictEqual(
      getSourceBaseName("git@github.com:cdxgen/cdxgen.git"),
      "cdxgen.git",
    );
  });

  it("names a project like the last path segment of the argument", async () => {
    const { getSourceBaseName } = await import("./source.js");
    // The names that bin/cdxgen.js gave before credentials were removed from
    // them, which Dependency-Track projects are keyed on.
    const cases = [
      [
        "pkg:generic/demo@1.0?vcs_url=git+https://git.example.com/acme/demo.git",
        "demo.git",
      ],
      [
        "pkg:npm/demo@1.0?repository_url=https://r.example.com/npm&vcs_url=git+https://git.example.com/acme/demo.git",
        "demo.git",
      ],
      ["https://git.example.com/acme/demo.git", "demo.git"],
      ["https://git.example.com/acme/demo", "demo"],
      ["git@github.com:cdxgen/cdxgen.git", "cdxgen.git"],
      ["pkg:npm/%40cdxgen/cdxgen@12.0.0", "cdxgen@12.0.0"],
    ];
    for (const [source, expected] of cases) {
      assert.strictEqual(path.basename(source), expected, source);
      assert.strictEqual(getSourceBaseName(source), expected, source);
    }
    // Only the fragment and query string differ from the old name.
    assert.strictEqual(
      getSourceBaseName("https://git.example.com/acme/demo.git?ref=v1#src"),
      "demo.git",
    );
  });

  it("keeps credentials out of the project name", async () => {
    const { getSourceBaseName } = await import("./source.js");
    const sources = [
      "pkg:generic/demo@1.0?vcs_url=git+https://ci-bot:hunter2@git.example.com/acme/demo.git?private_token=abc123#frag",
      "pkg:generic/demo@1.0?vcs_url=git+https://ci-bot:hunter2@git.example.com/acme/demo.git&download_url=https://x.example.com/a?token=abc123",
      "https://ci-bot:hunter2@git.example.com/acme/demo.git?private_token=abc123/def#frag",
      "https://ci-bot:hunter2@git.example.com/acme/demo.git#abc123/def",
      "pkg:generic/demo@1.0?vcs_url=git%2Bhttps:%2F%2Fci-bot:hunter2%40git.example.com%2Facme%2Fdemo.git",
    ];
    for (const source of sources) {
      const name = getSourceBaseName(source);
      for (const secret of ["hunter2", "abc123", "ci-bot", "private_token"]) {
        assert.ok(!name.includes(secret), `${secret} in ${name} for ${source}`);
      }
    }
  });

  it("keeps a local path as it is", async () => {
    const { getSourceBaseName, getSourceLabel } = await import("./source.js");
    const local = path.join("work", "issue#42?");
    assert.strictEqual(getSourceLabel(local), local);
    assert.strictEqual(getSourceBaseName(local), "issue#42?");
  });
});

describe("redactGitOutput", () => {
  it("replaces the credentials of every URL in the text", async () => {
    const { redactGitOutput } = await import("./source.js");
    assert.strictEqual(
      redactGitOutput(
        "fatal: unable to access 'https://user:p@ss@example.com/x.git/'\nssh://git@host/y a://b://u:p@h/",
      ),
      "fatal: unable to access 'https://***:***@example.com/x.git/'\nssh://***:***@host/y a://b://***:***@h/",
    );
  });

  it("takes linear time on remote output full of URLs", async () => {
    const { redactGitOutput } = await import("./source.js");
    const redacted = redactGitOutput("://@".repeat(250000));
    assert.strictEqual(redacted, "://***:***@".repeat(250000));
  });
});

describe("remote URL redaction", () => {
  it("sanitizeRemoteUrlForLogs() masks userinfo and drops the query string and fragment", async () => {
    const { sanitizeRemoteUrlForLogs } = await import("./source.js");
    assert.strictEqual(
      sanitizeRemoteUrlForLogs(
        "https://ci-bot:hunter2@git.example.com/acme/demo.git?X-Amz-Signature=abc123#frag",
      ),
      "https://***:***@git.example.com/acme/demo.git",
    );
    assert.strictEqual(
      sanitizeRemoteUrlForLogs(
        "https://git.example.com/acme/demo.git?private_token=abc123",
      ),
      "https://git.example.com/acme/demo.git",
    );
    assert.strictEqual(
      sanitizeRemoteUrlForLogs("https://github.com/cdxgen/cdxgen.git"),
      "https://github.com/cdxgen/cdxgen.git",
    );
  });

  it("sanitizeRemoteUrlForLogs() redacts a URL that cannot be parsed", async () => {
    const { sanitizeRemoteUrlForLogs } = await import("./source.js");
    assert.strictEqual(
      sanitizeRemoteUrlForLogs(
        "https://ci-bot:hunter2@git.example.com:port/demo.git?token=abc123",
      ),
      "https://***:***@git.example.com:port/demo.git",
    );
    assert.strictEqual(
      sanitizeRemoteUrlForLogs(
        "https://ci-bot:hunter#2@git.example.com/demo.git?token=abc123",
      ),
      "https://***:***@git.example.com/demo.git",
    );
    assert.strictEqual(
      sanitizeRemoteUrlForLogs("git@github.com:cdxgen/cdxgen.git?token=abc123"),
      "git@github.com:cdxgen/cdxgen.git",
    );
    assert.strictEqual(
      sanitizeRemoteUrlForLogs("git@github.com:cdxgen/cdxgen.git"),
      "git@github.com:cdxgen/cdxgen.git",
    );
  });

  it("redactGitOutput() drops the query string git echoes without the userinfo", async () => {
    const { redactGitOutput } = await import("./source.js");
    const repoUrl =
      "https://ci-bot:hunter2@git.example.com/acme/demo.git?X-Amz-Signature=abc123";
    assert.strictEqual(
      redactGitOutput(
        "fatal: unable to access 'https://git.example.com/acme/demo.git?X-Amz-Signature=abc123/': The requested URL returned error: 403",
        repoUrl,
      ),
      "fatal: unable to access 'https://git.example.com/acme/demo.git': The requested URL returned error: 403",
    );
    assert.strictEqual(
      redactGitOutput(`fatal: repository '${repoUrl}' not found`, repoUrl),
      "fatal: repository 'https://***:***@git.example.com/acme/demo.git' not found",
    );
    assert.strictEqual(
      redactGitOutput(
        "warning: redirecting to https://proxy.example.com/https://ci-bot:hunter2@git.example.com/acme/demo.git/?token=abc123\nfatal: see <https://git.example.com/help#access> or https://other:secret2@mirror.example.org:8443/x",
      ),
      "warning: redirecting to https://proxy.example.com/https://***:***@git.example.com/acme/demo.git/\nfatal: see <https://git.example.com/help> or https://***:***@mirror.example.org:8443/x",
    );
    assert.strictEqual(
      redactGitOutput("error: what? no URL here # at all"),
      "error: what? no URL here # at all",
    );
  });
});

describe("purl sources with unescaped reserved characters", () => {
  const loadSource = () =>
    esmock("./source.js", {
      "../core/activity.js": {
        cdxgenAgent: { get: sinon.stub() },
        DEBUG_MODE: false,
        hasDangerousUnicode: sinon.stub().returns(false),
        isSecureMode: false,
      },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeSpawnSync: sinon.stub(),
      },
      "../core/paths.js": {
        isValidDriveRoot: sinon.stub().returns(true),
        isWin: false,
      },
    });

  it("accepts a version written with its build metadata unescaped", async () => {
    const { validatePurlSource } = await loadSource();
    assert.strictEqual(
      validatePurlSource("pkg:cargo/wasi@0.11.0+wasi-snapshot-preview1"),
      null,
    );
    assert.strictEqual(
      validatePurlSource("pkg:cargo/wasi@0.11.0%2Bwasi-snapshot-preview1"),
      null,
    );
  });

  it("resolves a purl whose version and vcs_url both carry a raw +", async () => {
    const { resolveGitUrlFromPurl } = await loadSource();
    const result = await resolveGitUrlFromPurl(
      "pkg:generic/example@1.0.0+build?vcs_url=git+https://github.com/cdxgen/cdxgen.git",
    );
    assert.strictEqual(result.repoUrl, "https://github.com/cdxgen/cdxgen.git");
    assert.strictEqual(result.version, "1.0.0+build");
  });

  it("still rejects input that holds no purl", async () => {
    const { validatePurlSource } = await loadSource();
    assert.strictEqual(
      validatePurlSource("pkg:npm/").error,
      "Invalid purl source",
    );
  });
});

describe("redactPackageManagerOutput()", () => {
  it("removes URL credentials and query strings from npm output", async () => {
    const { redactPackageManagerOutput } = await import("./source.js");
    const stderr = [
      "npm error code ECONNREFUSED",
      "npm error FetchError: request to https://ci-bot:***@artifacts.example/sdk-2.4.0.tgz?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeef failed, reason: connect ECONNREFUSED",
      "npm error 404  The requested resource 'sdk@https://ci-bot:secretpass@artifacts.example/sdk-2.4.0.tgz?sig=secretsig' could not be found or you do not have permission to access it.",
      "error git+ssh://user:secretpass@git.example/sdk.git: Request failed",
    ].join("\n");
    const redacted = redactPackageManagerOutput(stderr);
    assert.ok(!redacted.includes("deadbeef"));
    assert.ok(!redacted.includes("AKIAEXAMPLE"));
    assert.ok(!redacted.includes("secretsig"));
    assert.ok(!redacted.includes("secretpass"));
    assert.ok(!redacted.includes("ci-bot"));
    assert.ok(
      redacted.includes(
        "request to https://***:***@artifacts.example/sdk-2.4.0.tgz?*** failed, reason: connect ECONNREFUSED",
      ),
    );
    assert.ok(
      redacted.includes(
        "'sdk@https://***:***@artifacts.example/sdk-2.4.0.tgz?***' could not be found",
      ),
    );
    assert.ok(redacted.includes("npm error code ECONNREFUSED"));
    assert.ok(redacted.includes("git+ssh://***:***@git.example/sdk.git"));
  });

  it("removes query strings from pip retry lines without a scheme", async () => {
    const { redactPackageManagerOutput } = await import("./source.js");
    const stderr = [
      "  WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError(...)': /internalpkg-1.0-py3-none-any.whl?private_token=glpat-CANARY123",
      "ERROR: Could not install requirement internalpkg@ http://127.0.0.1:18476/internalpkg-1.0-py3-none-any.whl?private_token=glpat-CANARY123#sha256=abc from file",
      "Did you mean this?",
    ].join("\n");
    const redacted = redactPackageManagerOutput(stderr);
    assert.ok(!redacted.includes("glpat-CANARY123"));
    assert.ok(redacted.includes("/internalpkg-1.0-py3-none-any.whl?***"));
    assert.ok(redacted.includes("whl?***#sha256=abc from file"));
    assert.ok(redacted.includes("Did you mean this?"));
  });

  it("returns empty and non-string values unchanged", async () => {
    const { redactPackageManagerOutput } = await import("./source.js");
    assert.strictEqual(redactPackageManagerOutput(undefined), undefined);
    assert.strictEqual(redactPackageManagerOutput(null), null);
    assert.strictEqual(redactPackageManagerOutput(""), "");
    assert.strictEqual(
      redactPackageManagerOutput("npm error code E404"),
      "npm error code E404",
    );
  });
});
