import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

// One sequential test: it points the cache variables at fixtures, and
// SBT_CACHE_DIR is read when jvmBom.js loads.
const WRAPPER_JAR = join(
  "test",
  "data",
  "gradle-repotest",
  "gradle",
  "wrapper",
  "gradle-wrapper.jar",
);

/**
 * Put a jar and its POM into a Coursier cache.
 *
 * @param {string} cacheRoot Coursier cache root.
 * @param {string} group groupId.
 * @param {string} artifactId Published artifactId.
 * @param {string} version Version.
 * @returns {string} Path of the jar.
 */
function writeCoursierArtifact(cacheRoot, group, artifactId, version) {
  const dir = join(
    cacheRoot,
    "https",
    "repo1.maven.org",
    "maven2",
    ...group.split("."),
    artifactId,
    version,
  );
  mkdirSync(dir, { recursive: true });
  const jarPath = join(dir, `${artifactId}-${version}.jar`);
  copyFileSync(WRAPPER_JAR, jarPath);
  writeFileSync(
    join(dir, `${artifactId}-${version}.pom`),
    `<project><groupId>${group}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`,
  );
  return jarPath;
}

it("sbt --deep resolves into the user's caches and reads only the resolved jars", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-sbt-deep-"));
  const saved = {
    COURSIER_CACHE: process.env.COURSIER_CACHE,
    MAVEN_CACHE_DIR: process.env.MAVEN_CACHE_DIR,
    SBT_CACHE_DIR: process.env.SBT_CACHE_DIR,
  };
  try {
    const coursier = join(root, "coursier");
    const ivy = join(root, "ivy");
    process.env.COURSIER_CACHE = coursier;
    process.env.SBT_CACHE_DIR = ivy;
    process.env.MAVEN_CACHE_DIR = join(root, "m2");
    const scalaJar = writeCoursierArtifact(
      coursier,
      "com.example",
      "wrapper_3",
      "1.0.0",
    );
    // sbt resolved into the Coursier cache, so a copy in the Maven local
    // repository is not the one read.
    const m2Dir = join(root, "m2", "com", "example", "wrapper_3", "1.0.0");
    mkdirSync(m2Dir, { recursive: true });
    copyFileSync(WRAPPER_JAR, join(m2Dir, "wrapper_3-1.0.0.jar"));
    // A jar no tree lists stays unread.
    writeCoursierArtifact(coursier, "com.example", "unrelated", "9.9.9");
    const ivyDir = join(ivy, "com.example", "legacy", "jars");
    mkdirSync(ivyDir, { recursive: true });
    copyFileSync(WRAPPER_JAR, join(ivyDir, "legacy-2.0.jar"));

    const project = join(root, "app");
    mkdirSync(join(project, "project"), { recursive: true });
    writeFileSync(
      join(project, "project", "build.properties"),
      "sbt.version=1.10.11\n",
    );
    writeFileSync(join(project, "build.sbt"), 'name := "app"\n');
    const tree = [
      "com.example:app_3:0.1.0",
      "  +-com.example:legacy:2.0",
      "  +-com.example:missing:3.0",
      "  +-com.example:wrapper_3:1.0.0",
      "",
    ].join("\n");
    const calls = [];
    const sbtutils = await import("../ecosystems/sbtutils.js");
    const { collectSbtDependencyJars, createJavaBom } = await esmock(
      "./jvmBom.js",
      {
        "../ecosystems/sbtutils.js": {
          ...sbtutils,
          sbtSpawnSync: (_cmd, args, options) => {
            calls.push({ args, env: options.env });
            const command = args.join(" ");
            const toFile = command.match(/toFile (\S+) --force/);
            if (toFile) {
              writeFileSync(toFile[1], tree);
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      },
    );
    const bomData = await createJavaBom(project, {
      projectType: ["sbt"],
      deep: true,
      installDeps: true,
      multiProject: false,
      specVersion: 1.7,
    });

    const treeCall = calls.find((c) => c.args.join(" ").includes("toFile"));
    assert.ok(treeCall, "the dependency tree command ran");
    // sbt keeps the user's caches and resolves no classifier jars.
    assert.strictEqual(treeCall.env.COURSIER_CACHE, coursier);
    assert.strictEqual(treeCall.env.SBT_IVY_HOME, process.env.SBT_IVY_HOME);
    for (const call of calls) {
      assert.ok(!call.args.join(" ").includes("updateClassifiers"));
    }

    const wrapper = bomData.bomJson.components.find(
      (c) => c.name === "wrapper",
    );
    assert.ok(wrapper, "the Scala dependency is in the BOM");
    const wrapperNs = bomData.nsMapping[wrapper.purl];
    assert.ok(wrapperNs, "the Scala dependency has jar namespaces");
    assert.strictEqual(wrapperNs.jarFile, scalaJar);
    assert.ok(
      wrapperNs.namespaces.includes("org.gradle.wrapper.GradleWrapperMain"),
    );
    const legacy = bomData.bomJson.components.find((c) => c.name === "legacy");
    assert.ok(
      bomData.nsMapping[legacy.purl]?.namespaces?.length,
      "the Ivy cache jar is read",
    );
    // Only the jars of the resolved dependencies are read.
    assert.ok(
      !Object.keys(bomData.nsMapping).some((purl) =>
        purl.includes("unrelated"),
      ),
    );
    const missing = bomData.bomJson.components.find(
      (c) => c.name === "missing",
    );
    assert.ok(missing && !bomData.nsMapping[missing.purl]);

    // Applications and packages already mapped are skipped.
    const known = { "pkg:maven/com.example/legacy@2.0?type=jar": {} };
    const mapping = await collectSbtDependencyJars(
      [
        { ...wrapper, type: "application" },
        {
          group: "com.example",
          name: "legacy",
          version: "2.0",
          purl: "pkg:maven/com.example/legacy@2.0?type=jar",
        },
      ],
      known,
    );
    assert.deepStrictEqual(mapping, {});
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});
