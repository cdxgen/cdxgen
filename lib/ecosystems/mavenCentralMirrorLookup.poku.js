import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import { resetRunState } from "../core/runState.js";
import { MAVEN_CENTRAL_MIRROR_URLS } from "../inventory/mavenCentralMirror.js";

// One sequential test: the Maven metadata path reads HOME and the repository
// variables process-wide, and poku gives each file its own process.
const MIRROR = MAVEN_CENTRAL_MIRROR_URLS.google;
const MIRROR_HOST = new URL(MIRROR).host;

function pom({ group, name, version, licenses, scm }) {
  return [
    "<project>",
    `<groupId>${group}</groupId>`,
    `<artifactId>${name}</artifactId>`,
    `<version>${version}</version>`,
    licenses
      ? `<licenses>${licenses.map((l) => `<license><name>${l}</name></license>`).join("")}</licenses>`
      : "",
    scm ? `<scm><url>${scm}</url></scm>` : "",
    "</project>",
  ].join("");
}

it("getMvnMetadata fetches from the mirror and keeps Central out of the mirror", async () => {
  const saved = Object.fromEntries(
    [
      "HOME",
      "USERPROFILE",
      "MAVEN_CENTRAL_MIRROR",
      "MAVEN_CENTRAL_URL",
      "FETCH_LICENSE",
      "CDXGEN_RS_DISABLE",
    ].map((n) => [n, process.env[n]]),
  );
  const root = mkdtempSync(join(tmpdir(), "cdxgen-maven-mirror-"));
  try {
    for (const name of [
      "HOME",
      "USERPROFILE",
      "MAVEN_CENTRAL_MIRROR",
      "MAVEN_CENTRAL_URL",
      "FETCH_LICENSE",
      "CDXGEN_RS_DISABLE",
    ]) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    process.env.FETCH_LICENSE = "true";
    process.env.CDXGEN_RS_DISABLE = "fetch";
    process.env.MAVEN_CENTRAL_MIRROR = "true";
    resetRunState();

    const pomBody = pom({
      group: "com.acme",
      name: "mirrored",
      version: "1.0",
      licenses: ["Apache-2.0"],
      scm: "https://github.com/acme/mirrored",
    });
    const requested = [];
    const agentGetStub = sinon.stub().callsFake((url) => {
      requested.push(url);
      if (url === `${MIRROR}com/acme/mirrored/1.0/mirrored-1.0.pom`) {
        return Promise.resolve({ statusCode: 200, body: pomBody });
      }
      const err = new Error("Response code 404 (Not Found)");
      err.response = { statusCode: 404, headers: {} };
      return Promise.reject(err);
    });
    const mocked = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGetStub }),
        },
      },
    );
    const { resetJvmLocalRepoCaches } = await import(
      "../inventory/jvmLocalRepos.js"
    );
    resetJvmLocalRepoCaches();

    const pkgList = [{ group: "com.acme", name: "mirrored", version: "1.0" }];
    await mocked.getMvnMetadata(pkgList, {});
    assert.deepStrictEqual(requested, [
      `${MIRROR}com/acme/mirrored/1.0/mirrored-1.0.pom`,
    ]);
    // The licence and the repository URL come from the POM content, so the
    // component describes the project, not the mirror it was fetched from.
    assert.deepStrictEqual(pkgList[0].license, ["Apache-2.0"]);
    assert.deepStrictEqual(pkgList[0].repository, {
      url: "https://github.com/acme/mirrored",
    });
    assert.ok(
      !JSON.stringify(pkgList).includes(MIRROR_HOST),
      "no component field names the mirror host",
    );

    // An explicit MAVEN_CENTRAL_URL keeps winning over the mirror switch.
    requested.length = 0;
    process.env.MAVEN_CENTRAL_URL = "https://nexus.corp/repository";
    const explicit = [{ group: "com.acme", name: "mirrored", version: "1.0" }];
    await mocked.getMvnMetadata(explicit, {});
    assert.deepStrictEqual(requested, [
      "https://nexus.corp/repository/com/acme/mirrored/1.0/mirrored-1.0.pom",
    ]);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
