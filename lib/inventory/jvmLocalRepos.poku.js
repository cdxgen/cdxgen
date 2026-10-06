import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import {
  coursierCacheDir,
  findLocalMavenArtifact,
  findMavenCoordinatesBySha1,
  gradleCacheRoots,
  inferMavenCoordinatesFromPath,
  localRepositoryFromSettings,
  mavenLocalRepositories,
  mavenRepoArgs,
  resetJvmLocalRepoCaches,
  splitArtifactFileName,
} from "./jvmLocalRepos.js";

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
];

function touch(file, content = "") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

it("splitArtifactFileName separates classifiers and extensions", () => {
  assert.deepStrictEqual(splitArtifactFileName("foo-1.0.jar", "foo", "1.0"), {
    classifier: "",
    extension: "jar",
  });
  assert.deepStrictEqual(
    splitArtifactFileName("foo-1.0-linux-x86_64.jar", "foo", "1.0"),
    { classifier: "linux-x86_64", extension: "jar" },
  );
  assert.strictEqual(splitArtifactFileName("bar-1.0.jar", "foo", "1.0"), undefined);
  assert.strictEqual(splitArtifactFileName("foo-1.0x.jar", "foo", "1.0"), undefined);
});

it("mavenRepoArgs reads maven.repo.local and the settings file", () => {
  const base = join(tmpdir(), "project");
  assert.deepStrictEqual(
    mavenRepoArgs(["-Dmaven.repo.local=/cache/m2", "-s", "settings.xml"], base),
    {
      repoLocal: resolve(base, "/cache/m2"),
      settingsFile: join(base, "settings.xml"),
    },
  );
  assert.deepStrictEqual(
    mavenRepoArgs(["-D", "maven.repo.local=rel", "--settings=/x/s.xml"], base),
    { repoLocal: join(base, "rel"), settingsFile: resolve(base, "/x/s.xml") },
  );
  assert.deepStrictEqual(mavenRepoArgs(["-q", "-DskipTests"], base), {});
});

it("local JVM caches are found and read without the network", () => {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-jvm-repos-"));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    const home = join(root, "home");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    resetJvmLocalRepoCaches();

    // Repository order: MAVEN_CACHE_DIR, explicit -Dmaven.repo.local, settings, default.
    const settingsRepo = join(home, "settings-repo");
    touch(
      join(home, ".m2", "settings.xml"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven property syntax.
      "<settings><localRepository>${user.home}/settings-repo</localRepository></settings>",
    );
    assert.strictEqual(
      localRepositoryFromSettings(join(home, ".m2", "settings.xml")),
      settingsRepo,
    );
    const argRepo = join(root, "arg-repo");
    process.env.MVN_ARGS = `-Dmaven.repo.local=${argRepo}`;
    process.env.MAVEN_CACHE_DIR = join(root, "cache-dir");
    assert.deepStrictEqual(mavenLocalRepositories(), [
      join(root, "cache-dir"),
      argRepo,
      settingsRepo,
      join(home, ".m2", "repository"),
    ]);

    // Maven layout, with a classifier jar next to the main one.
    const mavenDir = join(settingsRepo, "org", "example", "lib", "1.0");
    touch(join(mavenDir, "lib-1.0-linux.jar"), "native");
    touch(join(mavenDir, "lib-1.0.pom"), "<project/>");
    touch(join(mavenDir, "lib-1.0.jar"), "main");
    touch(join(mavenDir, "lib-1.0.jar.sha1"), `${SHA_A}  lib-1.0.jar\n`);
    const mavenHit = findLocalMavenArtifact("org.example", "lib", "1.0");
    assert.strictEqual(mavenHit.jarPath, join(mavenDir, "lib-1.0.jar"));
    assert.strictEqual(mavenHit.pomPath, join(mavenDir, "lib-1.0.pom"));
    assert.strictEqual(
      findLocalMavenArtifact("org.example", "lib", "1.0", {
        classifier: "linux",
      }).jarPath,
      join(mavenDir, "lib-1.0-linux.jar"),
    );

    // Gradle layout: every file sits under a directory named after its SHA-1.
    process.env.GRADLE_USER_HOME = join(root, "gradle-home");
    const gradleRoot = join(
      root,
      "gradle-home",
      "caches",
      "modules-2",
      "files-2.1",
    );
    assert.deepStrictEqual(gradleCacheRoots(), [gradleRoot]);
    const gradleVersionDir = join(gradleRoot, "com.acme", "tool", "2.0");
    touch(join(gradleVersionDir, SHA_B, "tool-2.0.jar"), "jar");
    touch(join(gradleVersionDir, "c".repeat(40), "tool-2.0-sources.jar"), "src");
    touch(join(gradleVersionDir, "d".repeat(40), "tool-2.0.pom"), "<project/>");
    resetJvmLocalRepoCaches();
    const gradleHit = findLocalMavenArtifact("com.acme", "tool", "2.0");
    assert.strictEqual(
      gradleHit.jarPath,
      join(gradleVersionDir, SHA_B, "tool-2.0.jar"),
    );
    assert.strictEqual(gradleHit.sha1, SHA_B);
    assert.ok(gradleHit.pomPath.endsWith("tool-2.0.pom"));

    // Coursier layout under a repository other than repo1.
    process.env.COURSIER_CACHE = join(root, "coursier");
    assert.strictEqual(coursierCacheDir(), join(root, "coursier"));
    const coursierDir = join(
      root,
      "coursier",
      "https",
      "maven-central.storage-download.googleapis.com",
      "maven2",
      "io",
      "sample",
      "core_2.13",
      "3.1",
    );
    touch(join(coursierDir, "core_2.13-3.1.jar"), "jar");
    touch(
      join(coursierDir, "core_2.13-3.1.pom"),
      "<project><groupId>io.sample</groupId><artifactId>core_2.13</artifactId><version>3.1</version></project>",
    );
    resetJvmLocalRepoCaches();
    const coursierHit = findLocalMavenArtifact("io.sample", "core_2.13", "3.1");
    assert.strictEqual(coursierHit.jarPath, join(coursierDir, "core_2.13-3.1.jar"));
    assert.strictEqual(
      coursierHit.repoUrl,
      "https://maven-central.storage-download.googleapis.com/maven2",
    );

    // Misses are memoised until the caches are reset.
    assert.strictEqual(findLocalMavenArtifact("late", "artifact", "1"), null);
    touch(join(argRepo, "late", "artifact", "1", "artifact-1.jar"), "jar");
    assert.strictEqual(findLocalMavenArtifact("late", "artifact", "1"), null);
    resetJvmLocalRepoCaches();
    assert.ok(findLocalMavenArtifact("late", "artifact", "1").jarPath);

    // Coordinates from where a file sits.
    assert.deepStrictEqual(
      inferMavenCoordinatesFromPath(join(mavenDir, "lib-1.0-linux.jar")),
      {
        group: "org.example",
        name: "lib",
        version: "1.0",
        classifier: "linux",
        extension: "jar",
      },
    );
    assert.deepStrictEqual(
      inferMavenCoordinatesFromPath(join(gradleVersionDir, SHA_B, "tool-2.0.jar")),
      {
        group: "com.acme",
        name: "tool",
        version: "2.0",
        classifier: "",
        extension: "jar",
        sha1: SHA_B,
      },
    );
    const snapshot = join(
      argRepo,
      "org",
      "snap",
      "app",
      "1.0-SNAPSHOT",
      "app-1.0-20240102.030405-7.jar",
    );
    touch(snapshot, "jar");
    assert.deepStrictEqual(inferMavenCoordinatesFromPath(snapshot), {
      group: "org.snap",
      name: "app",
      version: "1.0-SNAPSHOT",
      classifier: "",
      extension: "jar",
    });
    assert.strictEqual(
      inferMavenCoordinatesFromPath(join(coursierDir, "core_2.13-3.1.jar")).group,
      "io.sample",
    );
    // A copied cache outside the configured roots is still recognised.
    const copied = join(root, "copy", ".m2", "repository", "x", "y", "1", "y-1.jar");
    touch(copied, "jar");
    assert.strictEqual(inferMavenCoordinatesFromPath(copied).group, "x");
    assert.strictEqual(
      inferMavenCoordinatesFromPath(join(root, "elsewhere", "y-1.jar")),
      undefined,
    );

    // SHA-1 lookups answer from the Gradle directory names and Maven .sha1 files.
    resetJvmLocalRepoCaches();
    assert.strictEqual(findMavenCoordinatesBySha1(SHA_B).name, "tool");
    assert.strictEqual(findMavenCoordinatesBySha1(SHA_A.toUpperCase()).name, "lib");
    assert.strictEqual(findMavenCoordinatesBySha1("e".repeat(40)), undefined);
    assert.strictEqual(findMavenCoordinatesBySha1("not-a-digest"), undefined);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetJvmLocalRepoCaches();
    rmSync(root, { force: true, recursive: true });
  }
});

it("coursierCacheDir follows XDG_CACHE_HOME on Linux", () => {
  if (process.platform !== "linux") {
    return;
  }
  const saved = {
    COURSIER_CACHE: process.env.COURSIER_CACHE,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  try {
    delete process.env.COURSIER_CACHE;
    process.env.XDG_CACHE_HOME = "/xdg";
    assert.strictEqual(coursierCacheDir(), join("/xdg", "coursier", "v1"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
