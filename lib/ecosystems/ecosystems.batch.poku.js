import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// These tests mutate FETCH_LICENSE and GO_FETCH_VCS, which are process-wide.
// poku runs the `it` blocks of one file concurrently but gives each file its
// own process, so they live here rather than alongside the rest of the
// ecosystems tests, where the leak reached an unrelated NuGet assertion.

it("prefetchGoPkgMetadata batches the pages getGoPkgLicense and getGoPkgVCSUrl read", async () => {
  const licenseHtml = `<div id="#lic-0">MIT</div><h2 class="go-textTitle">MIT</h2>`;
  const agentGetStub = sinon.stub().callsFake((url) =>
    Promise.resolve({
      body: url.includes("tab=licenses")
        ? licenseHtml
        : `<div class="UnitMeta-repo"><a href="https://example.com/repo">repo</a></div>`,
    }),
  );
  // Pin the JS batch pool so the prefetch goes through the mocked agent rather
  // than a cdxrs subprocess, and so every request is countable here.
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousFetchVcs = process.env.GO_FETCH_VCS;
  const { resetBatchFetchAvailability } = await import(
    "../inventory/fetchBatch.js"
  );
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.FETCH_LICENSE = "true";
  process.env.GO_FETCH_VCS = "true";
  resetBatchFetchAvailability();
  try {
    const mocked = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGetStub }),
        },
      },
    );
    mocked.resetGoPkgPrefetch();
    const modules = [
      { group: "", name: "gopkg.in/yaml.v3" },
      { group: "", name: "go.opencensus.io" },
      // github.com resolves its VCS URL from the path, so only its licence tab
      // is worth fetching.
      { group: "", name: "github.com/spf13/cobra" },
    ];
    await mocked.prefetchGoPkgMetadata(modules);
    // Two documents each for the first two modules, one for the github module.
    assert.strictEqual(agentGetStub.callCount, 5);
    assert.strictEqual(
      agentGetStub
        .getCalls()
        .some((c) => c.args[0] === "https://pkg.go.dev/github.com/spf13/cobra"),
      false,
    );
    // The readers are served from the batch: no further requests.
    for (const module of modules) {
      await mocked.getGoPkgLicense(module);
    }
    assert.strictEqual(agentGetStub.callCount, 5);
    assert.strictEqual(
      await mocked.getGoPkgVCSUrl("", "github.com/spf13/cobra"),
      "https://github.com/spf13/cobra",
    );
    assert.strictEqual(agentGetStub.callCount, 5);
  } finally {
    process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    process.env.FETCH_LICENSE = previousFetchLicense;
    process.env.GO_FETCH_VCS = previousFetchVcs;
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    }
    if (previousFetchLicense === undefined) {
      delete process.env.FETCH_LICENSE;
    }
    if (previousFetchVcs === undefined) {
      delete process.env.GO_FETCH_VCS;
    }
    resetBatchFetchAvailability();
  }
});

it("getMvnMetadata prefetches repository licences for POMs that declare none", async () => {
  const pomWithLicense =
    "<project><licenses><license><name>Apache-2.0</name></license></licenses><scm><url>https://github.com/acme/licensed</url></scm></project>";
  const pomWithoutLicense =
    "<project><scm><url>https://github.com/acme/bare</url></scm></project>";
  const requested = [];
  const agentGetStub = sinon.stub().callsFake((url) => {
    requested.push(url);
    if (url.includes("repo1.maven.org")) {
      return Promise.resolve({
        body: url.includes("/licensed/") ? pomWithLicense : pomWithoutLicense,
      });
    }
    return Promise.resolve({
      body: {
        html_url: url,
        license: { name: "MIT License", spdx_id: "MIT" },
      },
    });
  });
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  // The stub answers Maven Central only, so the POMs must not go to a mirror.
  const previousMirror = process.env.MAVEN_CENTRAL_MIRROR;
  delete process.env.MAVEN_CENTRAL_MIRROR;
  const { resetBatchFetchAvailability } = await import(
    "../inventory/fetchBatch.js"
  );
  process.env.CDXGEN_RS_DISABLE = "fetch";
  resetBatchFetchAvailability();
  try {
    const mocked = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGetStub }),
        },
      },
    );
    mocked.resetRepoLicensePrefetch();
    // `force` rather than FETCH_LICENSE, so this test does not mutate an env
    // var the other test in this file reads.
    await mocked.getMvnMetadata(
      [
        { group: "com.acme", name: "licensed", version: "1.0.0" },
        { group: "com.acme", name: "bare", version: "1.0.0" },
        // Same scm URL as `bare`. The batch coalesces the two into one licence
        // request; the serial path, which has no cache, would make two.
        { group: "com.acme", name: "bare-sibling", version: "1.0.0" },
      ],
      {},
      true,
    );
    const licenseApiCalls = requested.filter((url) =>
      url.startsWith("https://api.github.com/"),
    );
    // The POM that declares a licence never reaches getRepoLicense, so its
    // repository is not prefetched.
    assert.deepStrictEqual(licenseApiCalls, [
      "https://api.github.com/repos/acme/bare/license",
    ]);
    // And the round really did populate the prefetch map: a subsequent lookup
    // of the same repository is served from it without a request.
    const before = requested.length;
    await mocked.getRepoLicense("https://github.com/acme/bare", undefined);
    assert.strictEqual(requested.length, before);
  } finally {
    process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    }
    if (previousMirror !== undefined) {
      process.env.MAVEN_CENTRAL_MIRROR = previousMirror;
    }
    resetBatchFetchAvailability();
  }
});
