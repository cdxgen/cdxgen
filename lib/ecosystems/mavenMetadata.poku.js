import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The Maven metadata path reads the local caches through HOME and the cache
// variables, which are process-wide. poku gives each file its own process, so
// these assertions live in one sequential test in a file of their own.

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_OPTS",
  "MAVEN_CACHE_DIR",
  "MAVEN_HOME",
  "M2_HOME",
  "GRADLE_USER_HOME",
  "GRADLE_CACHE_DIR",
  "GRADLE_RO_DEP_CACHE",
  "COURSIER_CACHE",
  "XDG_CACHE_HOME",
  "FETCH_LICENSE",
  "MAVEN_CENTRAL_URL",
  "ANDROID_MAVEN_URL",
  "CDXGEN_RS_DISABLE",
];

function pom({ group, name, version, parent, licenses, description, scm }) {
  return [
    "<project>",
    parent
      ? `<parent><groupId>${parent.group}</groupId><artifactId>${parent.name}</artifactId><version>${parent.version}</version></parent>`
      : "",
    group ? `<groupId>${group}</groupId>` : "",
    `<artifactId>${name}</artifactId>`,
    version ? `<version>${version}</version>` : "",
    description ? `<description>${description}</description>` : "",
    licenses
      ? `<licenses>${licenses.map((l) => `<license><name>${l}</name></license>`).join("")}</licenses>`
      : "",
    scm ? `<scm><url>${scm}</url></scm>` : "",
    "</project>",
  ].join("");
}

it("getMvnMetadata answers from local caches before any remote repository", async () => {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-metadata-"));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    // The JS batch pool, so every request goes through the stubbed agent.
    process.env.CDXGEN_RS_DISABLE = "fetch";
    const repo = join(root, "home", ".m2", "repository");
    const writePom = (coordinates) => {
      const dir = join(
        repo,
        ...coordinates.group.split("."),
        coordinates.name,
        coordinates.version,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${coordinates.name}-${coordinates.version}.pom`),
        pom(coordinates),
      );
    };
    // A child that inherits its licence from a grandparent, all on disk.
    writePom({
      group: "org.apache",
      name: "apache",
      version: "30",
      licenses: ["Apache-2.0"],
      scm: "https://github.com/apache/maven-apache-parent",
    });
    writePom({
      group: "org.apache.commons",
      name: "commons-parent",
      version: "70",
      parent: { group: "org.apache", name: "apache", version: "30" },
    });
    writePom({
      group: "org.apache.commons",
      name: "commons-text",
      version: "1.12.0",
      description: "Text   utilities",
      parent: {
        group: "org.apache.commons",
        name: "commons-parent",
        version: "70",
      },
    });

    const requested = [];
    const remote = new Map([
      [
        "https://repo1.maven.org/maven2/com/acme/child/1.0/child-1.0.pom",
        pom({
          group: "com.acme",
          name: "child",
          version: "1.0",
          description: "Kept without its parent",
          parent: { group: "com.acme", name: "missing-parent", version: "9" },
        }),
      ],
      [
        "https://repo1.maven.org/maven2/com/acme/sibling/1.0/sibling-1.0.pom",
        pom({
          group: "com.acme",
          name: "sibling",
          version: "1.0",
          parent: { group: "com.acme", name: "missing-parent", version: "9" },
        }),
      ],
      [
        "https://maven.google.com/com/google/firebase/firebase-common/21.0.0/firebase-common-21.0.0.pom",
        pom({
          group: "com.google.firebase",
          name: "firebase-common",
          version: "21.0.0",
          licenses: ["Apache-2.0"],
        }),
      ],
    ]);
    const agentGetStub = sinon.stub().callsFake((url) => {
      requested.push(url);
      if (remote.has(url)) {
        return Promise.resolve({ statusCode: 200, body: remote.get(url) });
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

    // Without FETCH_LICENSE or force nothing is requested, yet the local POM
    // chain still supplies the licence.
    const local = [
      { group: "org.apache.commons", name: "commons-text", version: "1.12.0" },
      { group: "com.acme", name: "child", version: "1.0" },
    ];
    await mocked.getMvnMetadata(local, {});
    assert.deepStrictEqual(requested, []);
    assert.deepStrictEqual(local[0].license, ["Apache-2.0"]);
    assert.strictEqual(local[0].description, "Text utilities");
    assert.deepStrictEqual(local[0].repository, {
      url: "https://github.com/apache/maven-apache-parent",
    });

    // Forced: only what the local caches cannot answer goes out.
    const pkgList = [
      { group: "org.apache.commons", name: "commons-text", version: "1.12.0" },
      // The cyclonedx-maven-plugin already resolved this licence.
      {
        group: "com.acme",
        name: "plugin-resolved",
        version: "1.0",
        licenses: [{ license: { id: "MIT" } }],
      },
      { group: "com.acme", name: "child", version: "1.0" },
      { group: "com.acme", name: "sibling", version: "1.0" },
      { group: "com.acme", name: "snapshot", version: "2.0-SNAPSHOT" },
      {
        group: "com.acme",
        name: "own-module",
        version: "1.0",
        purl: "pkg:maven/com.acme/own-module@1.0?type=jar",
      },
      {
        group: "com.acme",
        name: "local-repo",
        version: "1.0",
        purl: "pkg:maven/com.acme/local-repo@1.0?repository_url=file%3A%2F%2F%2Ftmp%2Frepo&type=jar",
      },
      {
        group: "com.google.firebase",
        name: "firebase-common",
        version: "21.0.0",
      },
    ];
    await mocked.getMvnMetadata(pkgList, {}, true, {
      skipPurls: new Set(["pkg:maven/com.acme/own-module@1.0?type=jar"]),
    });
    assert.deepStrictEqual(requested.sort(), [
      "https://maven.google.com/com/google/firebase/firebase-common/21.0.0/firebase-common-21.0.0.pom",
      "https://repo1.maven.org/maven2/com/acme/child/1.0/child-1.0.pom",
      // The shared missing parent is asked for once and remembered.
      "https://repo1.maven.org/maven2/com/acme/missing-parent/9/missing-parent-9.pom",
      "https://repo1.maven.org/maven2/com/acme/sibling/1.0/sibling-1.0.pom",
    ]);
    // A missing parent no longer discards what the child declared.
    assert.strictEqual(pkgList[2].description, "Kept without its parent");
    assert.deepStrictEqual(pkgList[7].license, ["Apache-2.0"]);
    assert.strictEqual(pkgList[1].license, undefined);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    const { resetJvmLocalRepoCaches } = await import(
      "../inventory/jvmLocalRepos.js"
    );
    resetJvmLocalRepoCaches();
    rmSync(root, { force: true, recursive: true });
  }
});

it("getMvnMetadata names no throwaway cache jar as the identity source", async () => {
  const { getMvnMetadata } = await import("./ecosystems.js");
  const purl = "pkg:maven/com.acme/lib@1.0?type=jar";
  const treeIdentity = () => ({
    identity: {
      field: "purl",
      confidence: 1,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 1,
          value: "build.sbt",
        },
      ],
    },
  });
  // The jar the sbt --deep run resolved into its throwaway cache is deleted
  // with the scan; naming it would make two runs over one project differ.
  const fromTempCache = {
    group: "com.acme",
    name: "lib",
    version: "1.0",
    purl,
    "bom-ref": purl,
    evidence: treeIdentity(),
  };
  await getMvnMetadata([fromTempCache], {
    [purl]: {
      jarFile: join(tmpdir(), "sbt-cache-arun", "lib-1.0.jar"),
      namespaces: ["com.acme"],
    },
  });
  assert.deepStrictEqual(fromTempCache.evidence, treeIdentity());

  // A jar of the developer's own cache is a stable file a reader can find.
  const fromLocalCache = {
    group: "com.acme",
    name: "lib",
    version: "1.0",
    purl,
    "bom-ref": purl,
    evidence: treeIdentity(),
  };
  await getMvnMetadata([fromLocalCache], {
    [purl]: {
      jarFile:
        "/home/user/.cache/coursier/v1/https/repo1.maven.org/maven2/com/acme/lib/1.0/lib-1.0.jar",
      namespaces: ["com.acme"],
    },
  });
  assert.strictEqual(
    fromLocalCache.evidence.identity.methods[0].technique,
    "binary-analysis",
  );
  assert.strictEqual(
    fromLocalCache.evidence.identity.methods[0].value,
    "/home/user/.cache/coursier/v1/https/repo1.maven.org/maven2/com/acme/lib/1.0/lib-1.0.jar",
  );
});
