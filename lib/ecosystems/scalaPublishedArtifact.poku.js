import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import { publishedArtifactId } from "../inventory/scalaCoords.js";

// These assertions change HOME and the cache variables, which are
// process-wide. poku gives each file its own process, so they live in one
// sequential test in a file of their own.

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

function pom({ group, name, version, parent, licenses, description }) {
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
    "</project>",
  ].join("");
}

// A jar is a zip; the hash reads only need bytes, not a valid archive.
function writeArtifact(repo, coordinates, jar = "jar bytes") {
  const { group, name, version, parent, licenses, description } = coordinates;
  const dir = join(repo, ...group.split("."), name, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}-${version}.pom`),
    pom({ group, name, version, parent, licenses, description }),
  );
  writeFileSync(join(dir, `${name}-${version}.jar`), jar);
}

const compilerVersion = (value) => [
  { name: "cdx:scala:compilerVersion", value },
];

it("scala components are enriched through their published artifactId", async () => {
  // The name rebuilt from the component properties, never from the purl.
  assert.strictEqual(
    publishedArtifactId({
      name: "cats-core",
      properties: compilerVersion("2.13"),
    }),
    "cats-core_2.13",
  );
  assert.strictEqual(
    publishedArtifactId({
      name: "upickle_sjs1",
      properties: compilerVersion("3"),
    }),
    "upickle_sjs1_3",
  );
  // Names that already end in a Scala version are used as they are.
  assert.strictEqual(
    publishedArtifactId({
      name: "foo_3.3.7",
      properties: compilerVersion("3"),
    }),
    "foo_3.3.7",
  );
  assert.strictEqual(
    publishedArtifactId({
      name: "kind-projector_2.13.16",
      properties: compilerVersion("2.13"),
    }),
    "kind-projector_2.13.16",
  );
  // A Java library is looked up by its name.
  assert.strictEqual(
    publishedArtifactId({ name: "commons-text" }),
    "commons-text",
  );
  assert.strictEqual(
    publishedArtifactId({ name: "commons-text", properties: [] }),
    "commons-text",
  );

  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-scala-published-"));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    process.env.CDXGEN_RS_DISABLE = "fetch";
    const coursier = join(root, "coursier");
    process.env.COURSIER_CACHE = coursier;
    const central = join(coursier, "v1", "https", "repo1.maven.org", "maven2");
    // The parent carries the licence; the jar bytes are stable content.
    writeArtifact(central, {
      group: "org.typelevel",
      name: "cats-core_2.13",
      version: "2.12.0",
      parent: {
        group: "org.typelevel",
        name: "cats-parent",
        version: "2.12.0",
      },
      description: "Cats core",
    });
    writeArtifact(central, {
      group: "org.typelevel",
      name: "cats-parent",
      version: "2.12.0",
      licenses: ["MIT"],
    });
    writeArtifact(central, {
      group: "com.lihaoyi",
      name: "upickle_sjs1_3",
      version: "4.4.3",
      description: "uPickle",
      licenses: ["MIT"],
    });

    const requested = [];
    const agentGetStub = sinon.stub().callsFake((url) => {
      requested.push(url);
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

    // The sbt component: the binary suffix is stripped from its name, and the
    // published name reads the local POM chain, the licence and the jar
    // hashes, with zero requests.
    const cats = {
      group: "org.typelevel",
      name: "cats-core",
      version: "2.12.0",
      purl: "pkg:maven/org.typelevel/cats-core@2.12.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
      properties: compilerVersion("2.13"),
      "bom-ref":
        "pkg:maven/org.typelevel/cats-core@2.12.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
    };
    await mocked.getMvnMetadata([cats], {});
    assert.strictEqual(cats.description, "Cats core");
    assert.deepStrictEqual(cats.license, ["MIT"]);
    assert.ok(cats.hashes?.length > 0, "the jar hashes are missing");
    assert.deepStrictEqual(requested, []);

    // The Scala.js component reads its platform-suffixed artifact.
    const upickle = {
      group: "com.lihaoyi",
      name: "upickle_sjs1",
      version: "4.4.3",
      properties: compilerVersion("3"),
    };
    await mocked.getMvnMetadata([upickle], {});
    assert.strictEqual(upickle.description, "uPickle");

    // Name, purl and bom-ref are the same after enrichment.
    assert.strictEqual(cats.name, "cats-core");
    assert.strictEqual(
      cats.purl,
      "pkg:maven/org.typelevel/cats-core@2.12.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
    );
    assert.strictEqual(
      cats["bom-ref"],
      "pkg:maven/org.typelevel/cats-core@2.12.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
    );

    // With FETCH_LICENSE, an empty cache and a stubbed agent, the only POM
    // request is for the published name.
    process.env.FETCH_LICENSE = "true";
    process.env.COURSIER_CACHE = join(root, "empty-coursier");
    resetJvmLocalRepoCaches();
    const remote = {
      group: "org.typelevel",
      name: "cats-core",
      version: "2.12.0",
      purl: "pkg:maven/org.typelevel/cats-core@2.12.0",
      properties: compilerVersion("2.13"),
    };
    await mocked.getMvnMetadata([remote], {});
    assert.deepStrictEqual(requested, [
      "https://repo1.maven.org/maven2/org/typelevel/cats-core_2.13/2.12.0/cats-core_2.13-2.12.0.pom",
    ]);
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
