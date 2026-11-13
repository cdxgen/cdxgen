import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { createJavaBom, separateDuplicateMavenProject } from "./jvmBom.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("jvmBom", () => {
  it("does not interpret shell metacharacters in Maven module paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-maven-shell-"));
    const fakeBinDir = join(tempDir, "bin");
    const repoDir = join(tempDir, "repo");
    const markerFile = join(tmpdir(), "CDXGEN_GITURL_E2E_MARKER_TEST");
    const shellIfs = "$" + "{IFS}";
    const maliciousDirName = `evil;cd${shellIfs}..;cd${shellIfs}..;printf${shellIfs}CDXGEN_MAVEN_GIT_URL_E2E_SHELL_INJECTION>CDXGEN_GITURL_E2E_MARKER_TEST;#`;
    const maliciousModuleDir = join(repoDir, maliciousDirName);
    const originalPath = process.env.PATH;
    const originalMvnCmd = process.env.MVN_CMD;
    const originalMavenCmd = process.env.MAVEN_CMD;
    const originalMvnArgs = process.env.MVN_ARGS;

    try {
      rmSync(markerFile, { force: true });
      mkdirSync(fakeBinDir, { recursive: true });
      mkdirSync(maliciousModuleDir, { recursive: true });
      writeFileSync(
        join(maliciousModuleDir, "pom.xml"),
        "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>evil</artifactId><version>1.0.0</version></project>",
      );
      writeFileSync(join(maliciousModuleDir, "settings.xml"), "<settings />");
      const fakeMvn = join(fakeBinDir, "mvn");
      writeFileSync(
        fakeMvn,
        `#!/bin/sh
for arg do
case "$arg" in
  -DoutputFile=*)
    output="\${arg#-DoutputFile=}"
    mkdir -p "$(dirname "$output")"
    printf 'org.example:evil:jar:1.0.0:compile\\n' > "$output"
    ;;
esac
done
`,
      );
      chmodSync(fakeMvn, 0o755);
      process.env.PATH = `${fakeBinDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
      delete process.env.MVN_CMD;
      delete process.env.MAVEN_CMD;
      delete process.env.MVN_ARGS;

      await createJavaBom(repoDir, {
        multiProject: true,
        projectType: ["java"],
        specVersion: 1.6,
      });

      assert.strictEqual(existsSync(markerFile), false);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalMvnCmd === undefined) {
        delete process.env.MVN_CMD;
      } else {
        process.env.MVN_CMD = originalMvnCmd;
      }
      if (originalMavenCmd === undefined) {
        delete process.env.MAVEN_CMD;
      } else {
        process.env.MAVEN_CMD = originalMavenCmd;
      }
      if (originalMvnArgs === undefined) {
        delete process.env.MVN_ARGS;
      } else {
        process.env.MVN_ARGS = originalMvnArgs;
      }
      rmSync(markerFile, { force: true });
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("createJarBom()", () => {
  it("resolves Maven metadata once for a directory of jars", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-dir-"));
    try {
      for (const name of ["a-1.0.jar", "b-1.0.jar", "c-1.0.war"]) {
        writeFileSync(join(tmpDir, name), "not a real archive");
      }
      const extractJarArchive = sinon.stub().callsFake(async (jar) => [
        {
          group: "org.example",
          name: jar.split(/[\\/]/).pop().split("-")[0],
          version: "1.0",
        },
      ]);
      const getMvnMetadata = sinon.stub().callsFake(async (pkgList) => pkgList);
      const { createJarBom } = await esmock("./jvmBom.js", {
        "../ecosystems/ecosystems.js": { extractJarArchive, getMvnMetadata },
      });
      await createJarBom(tmpDir, { projectType: ["jar"], specVersion: 1.6 });
      assert.strictEqual(extractJarArchive.callCount, 3);
      // Once for the whole scan; the per-jar call re-resolved every earlier
      // jar's packages and repeated lookups that had already failed.
      assert.strictEqual(getMvnMetadata.callCount, 1);
      assert.strictEqual(getMvnMetadata.firstCall.args[0].length, 3);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

describe("-t sbt-cache", () => {
  it("reads the Coursier cache sbt resolves into", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-sbt-cache-"));
    const saved = {
      COURSIER_CACHE: process.env.COURSIER_CACHE,
      SBT_CACHE_DIR: process.env.SBT_CACHE_DIR,
    };
    try {
      const versionDir = join(
        root,
        "coursier",
        "https",
        "repo1.maven.org",
        "maven2",
        "org",
        "typelevel",
        "cats-core_2.13",
        "2.12.0",
      );
      mkdirSync(versionDir, { recursive: true });
      writeFileSync(join(versionDir, "cats-core_2.13-2.12.0.jar"), "jar");
      writeFileSync(
        join(versionDir, "cats-core_2.13-2.12.0.pom"),
        "<project><groupId>org.typelevel</groupId><artifactId>cats-core_2.13</artifactId><version>2.12.0</version></project>",
      );
      process.env.COURSIER_CACHE = join(root, "coursier");
      const { createJarBom } = await esmock("./jvmBom.js", {
        "../ecosystems/ecosystems.js": {
          extractJarArchive: sinon.stub().resolves([]),
          getMvnMetadata: sinon.stub().callsFake(async (pkgList) => pkgList),
        },
      });
      const bomData = await createJarBom(join(root, "ivy-cache"), {
        projectType: ["sbt-cache"],
        specVersion: 1.6,
        useSbtCache: true,
      });
      assert.ok(
        bomData.bomJson.components.some(
          (c) =>
            c.purl === "pkg:maven/org.typelevel/cats-core_2.13@2.12.0?type=jar",
        ),
      );
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
});

describe("ownComponentRefs()", () => {
  it("collects module refs and terminates on a cyclic component graph", async () => {
    const { ownComponentRefs } = await import("./jvmBom.js");
    const root = {
      purl: "pkg:maven/com.acme/root@1.0?type=jar",
      "bom-ref": "pkg:maven/com.acme/root@1.0?type=jar",
      components: [],
    };
    const module = {
      purl: "pkg:maven/com.acme/module@1.0?type=jar",
      components: [root],
    };
    root.components.push(module, root);
    assert.deepStrictEqual([...ownComponentRefs(root)].sort(), [
      "pkg:maven/com.acme/module@1.0?type=jar",
      "pkg:maven/com.acme/root@1.0?type=jar",
    ]);
    assert.strictEqual(ownComponentRefs(undefined).size, 0);
  });
});

describe("createJavaBom() and vendored Bazel workspaces", () => {
  it("neither builds nor inventories a copied project's MODULE.bazel", async () => {
    const commands = [];
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/fs.js": {
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          commands.push([command, ...(args || [])].join(" "));
          return { status: 1, stdout: "", stderr: "" };
        }),
      },
    });
    const bomData = await createJavaBom(
      join("test", "data", "brotli-exposure", "vendored"),
      {
        installDeps: true,
        multiProject: true,
        projectType: ["java"],
        specVersion: 1.6,
      },
    );
    assert.ok(
      !commands.some((command) => command.includes("bazel")),
      commands.join("\n"),
    );
    assert.ok(
      !(bomData?.bomJson?.components || []).some((c) =>
        c.purl?.startsWith("pkg:bazel/"),
      ),
    );
  });
});

describe("separateDuplicateMavenProject()", () => {
  const root = join(tmpdir(), "maven-same-gav");
  const project = (dir) => ({
    group: "com.example",
    name: "demo",
    version: "0.0.1-SNAPSHOT",
    qualifiers: { type: "jar" },
    purl: "pkg:maven/com.example/demo@0.0.1-SNAPSHOT?type=jar",
    "bom-ref": "pkg:maven/com.example/demo@0.0.1-SNAPSHOT?type=jar",
    properties: [
      { name: "internal:SrcFile", value: join(root, dir, "pom.xml") },
    ],
  });

  it("gives a second project with the same coordinates its directory as subpath", () => {
    const parentComponent = { ...project("two"), components: [] };
    const second = project("one");
    const dependenciesList = [
      { ref: second["bom-ref"], dependsOn: ["pkg:maven/a/b@1?type=jar"] },
    ];
    assert.strictEqual(
      separateDuplicateMavenProject(
        second,
        parentComponent,
        root,
        dependenciesList,
      ),
      true,
    );
    assert.strictEqual(
      second.purl,
      "pkg:maven/com.example/demo@0.0.1-SNAPSHOT?type=jar#one",
    );
    assert.strictEqual(dependenciesList[0].ref, second["bom-ref"]);
    assert.strictEqual(
      parentComponent["bom-ref"],
      "pkg:maven/com.example/demo@0.0.1-SNAPSHOT?type=jar",
    );
  });

  it("leaves the same project and distinct coordinates alone", () => {
    const parentComponent = { ...project("two"), components: [] };
    assert.strictEqual(
      separateDuplicateMavenProject(project("two"), parentComponent, root),
      false,
    );
    const other = { ...project("one"), "bom-ref": "pkg:maven/x/y@1?type=jar" };
    assert.strictEqual(
      separateDuplicateMavenProject(other, parentComponent, root),
      false,
    );
  });
});

describe("createJavaBom() with Gradle dependency lockfiles", () => {
  const multiFixture = join("test", "data", "gradle-lockfile", "multi");
  const gradleOptions = {
    multiProject: true,
    projectType: ["gradle"],
    specVersion: 1.6,
  };
  const componentFor = (bomData, name) =>
    (bomData?.bomJson?.components || []).find((c) => c.name === name);

  it("reads the committed lockfiles when dependency installation is disabled", async () => {
    const bomData = await createJavaBom(multiFixture, {
      ...gradleOptions,
      installDeps: false,
    });
    const guava = componentFor(bomData, "guava");
    assert.strictEqual(guava?.version, "32.1.3-jre");
    assert.strictEqual(guava?.scope, "required");
    assert.strictEqual(
      guava?.purl,
      "pkg:maven/com.google.guava/guava@32.1.3-jre?type=jar",
    );
    const junit = componentFor(bomData, "junit-jupiter-api");
    assert.strictEqual(junit?.scope, "optional");
    const plugin = componentFor(bomData, "gradle-versions-plugin");
    assert.strictEqual(plugin?.scope, "excluded");
    // A module the root and the subproject lock with different scopes
    // collapses to one component with the strongest scope.
    const slf4j = (bomData?.bomJson?.components || []).filter(
      (c) => c.name === "slf4j-api",
    );
    assert.strictEqual(slf4j.length, 1);
    assert.strictEqual(slf4j[0].scope, "required");
    // The catalog entry nothing locks stays out.
    assert.ok(!componentFor(bomData, "commons-lang3"));
    // settings.gradle names the root project, so the BOM has a primary
    // component even though Gradle never ran.
    const root = bomData?.bomJson?.metadata?.component;
    assert.strictEqual(root?.name, "multi");
    assert.ok(root?.["bom-ref"]);
  });

  it("names the primary component from settings.gradle or else the directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-noname-"));
    try {
      for (const [settings, expected] of [
        [undefined, "lockonly"],
        ['rootProject.name = "named-root"\n', "named-root"],
      ]) {
        const projectDir = join(tempDir, "lockonly");
        rmSync(projectDir, { force: true, recursive: true });
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(
          join(projectDir, "build.gradle"),
          "plugins { id 'java' }",
        );
        if (settings) {
          writeFileSync(join(projectDir, "settings.gradle.kts"), settings);
        }
        writeFileSync(
          join(projectDir, "gradle.lockfile"),
          "com.google.guava:guava:32.1.3-jre=runtimeClasspath\nempty=\n",
        );
        const bomData = await createJavaBom(projectDir, {
          installDeps: false,
          projectType: ["gradle"],
          specVersion: 1.6,
        });
        assert.strictEqual(
          componentFor(bomData, "guava")?.version,
          "32.1.3-jre",
        );
        assert.strictEqual(
          bomData?.bomJson?.metadata?.component?.name,
          expected,
        );
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps credentials in the Gradle wrapper URL out of the BOM", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-wrapper-"));
    try {
      mkdirSync(join(projectDir, "gradle", "wrapper"), { recursive: true });
      writeFileSync(join(projectDir, "build.gradle"), "plugins { id 'java' }");
      writeFileSync(
        join(projectDir, "gradle.lockfile"),
        "com.google.guava:guava:32.1.3-jre=runtimeClasspath\nempty=\n",
      );
      writeFileSync(
        join(projectDir, "gradle", "wrapper", "gradle-wrapper.properties"),
        "distributionUrl=https\\://ci-bot\\:hunter2@mirror.example.com/gradle-8.14-bin.zip?sig=Zm9vYmFy\n",
      );
      const bomData = await createJavaBom(projectDir, {
        installDeps: false,
        projectType: ["gradle"],
        specVersion: 1.6,
      });
      const text = JSON.stringify(bomData.bomJson);
      assert.ok(text.includes("mirror.example.com/gradle-8.14-bin.zip"));
      assert.ok(!text.includes("hunter2"), "expected no URL password");
      assert.ok(!text.includes("Zm9vYmFy"), "expected no URL query");
    } finally {
      rmSync(projectDir, { force: true, recursive: true });
    }
  });

  it("still runs gradle properties when installDeps is left unset", async () => {
    const propertiesOutput = [
      "> Task :properties",
      "",
      "------------------------------------------------------------",
      "Root project 'demo'",
      "------------------------------------------------------------",
      "",
      "group: com.example",
      "name: demo",
      "version: 1.0",
      "",
    ].join("\n");
    const commands = [];
    const propertiesCalls = [];
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/fs.js": {
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          commands.push([command, ...(args || [])].join(" "));
          return { status: 1, stdout: "", stderr: "" };
        }),
      },
      "../ecosystems/gradleutils.js": {
        executeParallelGradleProperties: sinon
          .stub()
          .callsFake((_root, projects) => {
            propertiesCalls.push(projects);
            return propertiesOutput;
          }),
      },
    });
    const options = { ...gradleOptions };
    delete options.installDeps;
    const bomData = await createJavaBom(multiFixture, options);
    // `gradle properties` names the root project, as it does on a scan
    // without lockfiles.
    assert.ok(propertiesCalls.length >= 1, "gradle properties must run");
    assert.strictEqual(bomData?.bomJson?.metadata?.component?.name, "demo");
    // `gradle dependencies` needs installDeps, so the lockfiles stand in.
    assert.ok(!commands.some((c) => c.includes("dependencies")));
    assert.strictEqual(componentFor(bomData, "guava")?.version, "32.1.3-jre");
  });

  it("reads no nested Gradle lockfile in a Maven-rooted scan", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-maven-nested-gradle-"));
    try {
      writeFileSync(
        join(tempDir, "pom.xml"),
        [
          '<project xmlns="http://maven.apache.org/POM/4.0.0">',
          "  <modelVersion>4.0.0</modelVersion>",
          "  <groupId>com.example</groupId>",
          "  <artifactId>maven-root</artifactId>",
          "  <version>1.0</version>",
          "</project>",
          "",
        ].join("\n"),
      );
      const sampleDir = join(tempDir, "samples", "plugin");
      mkdirSync(sampleDir, { recursive: true });
      writeFileSync(join(sampleDir, "build.gradle"), "plugins { id 'java' }");
      writeFileSync(
        join(sampleDir, "gradle.lockfile"),
        "org.sample:only-in-sample:1.0=runtimeClasspath\n",
      );
      const degradations = [];
      const { createJavaBom } = await esmock("./jvmBom.js", {
        "../core/buildLedger.js": {
          recordDegradation: sinon
            .stub()
            .callsFake((remediationId) => degradations.push(remediationId)),
        },
      });
      const bomData = await createJavaBom(tempDir, {
        installDeps: false,
        projectType: ["java"],
        specVersion: 1.6,
      });
      assert.ok(!componentFor(bomData, "only-in-sample"));
      assert.ok(!degradations.includes("jvm.gradle.lockfile-only"));
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("prefers the lockfiles over running Gradle when the feature flag is set", async () => {
    const commands = [];
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/fs.js": {
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          commands.push([command, ...(args || [])].join(" "));
          return { status: 1, stdout: "", stderr: "" };
        }),
      },
    });
    const bomData = await createJavaBom(multiFixture, {
      ...gradleOptions,
      featureFlags: ["gradle-prefer-lockfile"],
      installDeps: true,
    });
    assert.deepStrictEqual(commands, []);
    assert.strictEqual(componentFor(bomData, "guava")?.version, "32.1.3-jre");
    assert.strictEqual(
      componentFor(bomData, "jackson-databind")?.scope,
      "required",
    );
    assert.strictEqual(componentFor(bomData, "commons-lang3"), undefined);
  });

  it("prefers the lockfiles when GRADLE_PREFER_LOCKFILE is set", async () => {
    // The tests of one file run interleaved, so the variable is passed to a
    // child scan instead of set on this process. GRADLE_CMD points at a
    // script that records every invocation, so a Gradle run cannot happen
    // unnoticed.
    const workDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-envvar-"));
    try {
      const logFile = join(workDir, "gradle-invocations.log");
      const fakeGradle = join(workDir, "fake-gradle");
      if (process.platform === "win32") {
        writeFileSync(
          `${fakeGradle}.cmd`,
          '@echo off\necho %* >> "%CDXGEN_FAKE_GRADLE_LOG%"\nexit /b 0\n',
        );
      } else {
        writeFileSync(
          fakeGradle,
          '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CDXGEN_FAKE_GRADLE_LOG"\nexit 0\n',
        );
        chmodSync(fakeGradle, 0o755);
      }
      const bomFile = join(workDir, "bom.json");
      const child = spawnSync(
        process.execPath,
        [
          join(repoRoot, "bin", "cdxgen.js"),
          "-t",
          "gradle",
          "--install-deps",
          "-o",
          bomFile,
          multiFixture,
        ],
        {
          encoding: "utf-8",
          timeout: 300000,
          env: {
            ...process.env,
            GRADLE_PREFER_LOCKFILE: "true",
            GRADLE_CMD:
              process.platform === "win32" ? `${fakeGradle}.cmd` : fakeGradle,
            CDXGEN_FAKE_GRADLE_LOG: logFile,
            CDXGEN_NO_CACHE: "true",
          },
        },
      );
      assert.strictEqual(child.status, 0, child.stderr?.slice(-500));
      assert.strictEqual(existsSync(logFile), false, "Gradle must not run");
      const bom = JSON.parse(readFileSync(bomFile, { encoding: "utf-8" }));
      assert.strictEqual(
        bom.components.find((c) => c.name === "guava")?.version,
        "32.1.3-jre",
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses the lockfiles when a Gradle run produces nothing", async () => {
    const degradations = [];
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/fs.js": {
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 1, stdout: "", stderr: "" }),
      },
      "../core/buildLedger.js": {
        recordDegradation: sinon
          .stub()
          .callsFake((remediationId) => degradations.push(remediationId)),
      },
    });
    const bomData = await createJavaBom(multiFixture, {
      ...gradleOptions,
      installDeps: true,
    });
    assert.ok(degradations.includes("jvm.gradle.lockfile-only"));
    assert.strictEqual(componentFor(bomData, "guava")?.version, "32.1.3-jre");
    // A lockfile success must not reach the no-packages failure path.
    assert.ok(!degradations.includes("jvm.gradle.unresolved-config"));
  });

  it("does not parse the lockfiles Gradle enforced", async () => {
    const propertiesOutput = [
      "> Task :properties",
      "",
      "------------------------------------------------------------",
      "Root project 'demo'",
      "------------------------------------------------------------",
      "",
      "group: com.example",
      "version: 1.0",
      "",
    ].join("\n");
    const dependenciesOutput = [
      "> Task :dependencies",
      "",
      "------------------------------------------------------------",
      "Root project 'demo'",
      "------------------------------------------------------------",
      "",
      "runtimeClasspath - Dependencies for source set 'main'.",
      "\\--- com.google.guava:guava:33.0.0-jre",
      "",
    ].join("\n");
    const spawn = sinon
      .stub()
      .returns({ status: 0, stdout: dependenciesOutput, stderr: "" });
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/fs.js": {
        safeSpawnSync: spawn,
      },
      "../ecosystems/gradleutils.js": {
        executeParallelGradleProperties: sinon.stub().returns(propertiesOutput),
      },
    });
    const bomData = await createJavaBom(multiFixture, {
      ...gradleOptions,
      installDeps: true,
    });
    // The versions Gradle resolved win; the lockfile copies add nothing.
    const guavas = (bomData?.bomJson?.components || []).filter(
      (c) => c.name === "guava",
    );
    assert.strictEqual(guavas.length, 1);
    assert.strictEqual(guavas[0].version, "33.0.0-jre");
    // The modules only the lockfiles lock stay out.
    assert.ok(!componentFor(bomData, "jackson-databind"));
    assert.ok(!componentFor(bomData, "gradle-versions-plugin"));
  });

  it("falls back to the version catalog only when no lockfile exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-catalog-"));
    try {
      writeFileSync(
        join(tempDir, "build.gradle"),
        "plugins { id 'java' }\ndependencies { implementation libs.guava }",
      );
      mkdirSync(join(tempDir, "gradle"), { recursive: true });
      writeFileSync(
        join(tempDir, "gradle", "libs.versions.toml"),
        [
          "[versions]",
          'guava = "32.1.3-jre"',
          "",
          "[libraries]",
          'guava = { module = "com.google.guava:guava", version.ref = "guava" }',
          "",
        ].join("\n"),
      );
      const bomData = await createJavaBom(tempDir, {
        installDeps: false,
        projectType: ["gradle"],
        specVersion: 1.6,
      });
      const guava = componentFor(bomData, "guava");
      assert.strictEqual(guava?.version, "32.1.3-jre");
      assert.strictEqual(
        guava?.properties?.find((p) => p.name === "cdx:gradle:catalog")?.value,
        "true",
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  const writeGuavaCatalog = (dir) => {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      [
        "[versions]",
        'guava = "32.1.3-jre"',
        "",
        "[libraries]",
        'guava = { module = "com.google.guava:guava", version.ref = "guava" }',
        "",
      ].join("\n"),
    );
  };

  it("reads no version catalog without a Gradle build file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-nobuild-"));
    try {
      writeFileSync(
        join(tempDir, "pom.xml"),
        "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>y</artifactId><version>1</version></project>",
      );
      writeGuavaCatalog(tempDir);
      const bomData = await createJavaBom(tempDir, {
        installDeps: false,
        projectType: ["java"],
        specVersion: 1.6,
      });
      assert.ok(!componentFor(bomData, "guava"));
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("reads no version catalog when the scan prefers Maven", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-maven-only-"));
    try {
      writeFileSync(join(tempDir, "build.gradle"), "plugins { id 'java' }");
      writeGuavaCatalog(tempDir);
      const bomData = await createJavaBom(tempDir, {
        installDeps: false,
        projectType: ["maven"],
        specVersion: 1.6,
      });
      assert.ok(!componentFor(bomData, "guava"));
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("createJavaBom() with Gradle verification metadata", () => {
  const generatedFixture = join(
    "test",
    "data",
    "gradle-verification",
    "generated",
  );
  const issue978Fixture = join(
    "test",
    "data",
    "gradle-verification",
    "issue-978",
  );
  const componentFor = (bomData, name) =>
    (bomData?.bomJson?.components || []).find((c) => c.name === name);
  const withDegradations = async (path, options) => {
    const degradations = [];
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/buildLedger.js": {
        recordDegradation: sinon
          .stub()
          .callsFake((remediationId) => degradations.push(remediationId)),
      },
    });
    const bomData = await createJavaBom(path, options);
    return { bomData, degradations };
  };

  // The file's digests are the artifact's real digests, so the SHA-256 and
  // SHA-512 contents below hold whether the digest came from the file or
  // from the jar in a warm local cache; a warm cache adds MD5 and SHA-1,
  // which the file does not record, so only a lower bound holds for the
  // length.
  const DATABIND_SHA512 =
    "c6b06d4b20941d9e32b462552031e6c98378e5edce57693e55adcc73cf7d5088af5b3a666a59e94a7f0b57066ac694863919f398f28ee0d7ceb362c8c05f7491";
  const DATABIND_SHA256 =
    "d0ed5b54cb1b0bbb0828e24ce752a43a006dc188b34e3a4ae3238acc7b637418";
  const hashContent = (component, alg) =>
    component?.hashes?.find((h) => h.alg === alg)?.content;
  const identityMethodValues = (component) => {
    // buildBomNSData normalises evidence.identity into a list of entries.
    const identity = component?.evidence?.identity;
    const entries = Array.isArray(identity)
      ? identity
      : identity
        ? [identity]
        : [];
    return entries.flatMap((entry) =>
      (entry.methods || []).map((m) => m.value),
    );
  };
  const hasVerificationEvidence = (component) =>
    identityMethodValues(component).some((value) =>
      value.endsWith(join("gradle", "verification-metadata.xml")),
    );

  it("enriches the lockfile components with the recorded digests", async () => {
    const { bomData, degradations } = await withDegradations(generatedFixture, {
      installDeps: false,
      projectType: ["gradle"],
      specVersion: 1.6,
    });
    const databind = componentFor(bomData, "jackson-databind");
    assert.strictEqual(databind?.version, "2.17.0");
    assert.strictEqual(hashContent(databind, "SHA-256"), DATABIND_SHA256);
    assert.strictEqual(hashContent(databind, "SHA-512"), DATABIND_SHA512);
    assert.ok(databind?.hashes?.length >= 2);
    assert.strictEqual(
      databind?.properties?.find(
        (p) => p.name === "cdx:gradle:verificationMethods",
      )?.value,
      "sha256,sha512",
    );
    // The identity evidence of the lockfile stands; the file only adds
    // digests.
    assert.strictEqual(hasVerificationEvidence(databind), false);
    assert.ok(
      identityMethodValues(databind).some((value) =>
        value.endsWith("gradle.lockfile"),
      ),
    );
    // The lockfiles still stand in for the Gradle run; the verification
    // metadata only enriches them.
    assert.deepStrictEqual(degradations, ["jvm.gradle.lockfile-only"]);
    assert.ok(
      !componentFor(bomData, "jackson-bom")?.properties?.some(
        (p) => p.name === "cdx:gradle:verificationMetadata",
      ),
    );
  });

  it("enriches the lockfile fallback of a failed Gradle run too", async () => {
    const degradations = [];
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../core/fs.js": {
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 1, stdout: "", stderr: "" }),
      },
      "../core/buildLedger.js": {
        recordDegradation: sinon
          .stub()
          .callsFake((remediationId) => degradations.push(remediationId)),
      },
    });
    const bomData = await createJavaBom(generatedFixture, {
      installDeps: true,
      projectType: ["gradle"],
      specVersion: 1.6,
    });
    const databind = componentFor(bomData, "jackson-databind");
    assert.strictEqual(hashContent(databind, "SHA-256"), DATABIND_SHA256);
    assert.strictEqual(hashContent(databind, "SHA-512"), DATABIND_SHA512);
    assert.strictEqual(hasVerificationEvidence(databind), false);
    assert.ok(degradations.includes("jvm.gradle.lockfile-only"));
    assert.ok(!degradations.includes("jvm.gradle.verification-metadata-only"));
  });

  it("builds fallback components only when the feature flag asks for it", async () => {
    const { bomData, degradations } = await withDegradations(issue978Fixture, {
      installDeps: false,
      projectType: ["gradle"],
      specVersion: 1.6,
    });
    // A default scan only enriches: the file's coordinates stay out.
    assert.deepStrictEqual(bomData?.bomJson?.components || [], []);
    assert.deepStrictEqual(degradations, []);
    // With the flag the coordinates stand in, as optional components, since
    // the file cannot tell a runtime dependency from build tooling.
    const flagged = await withDegradations(issue978Fixture, {
      installDeps: false,
      projectType: ["gradle"],
      specVersion: 1.6,
      featureFlags: ["gradle-verification-fallback"],
    });
    const components = flagged.bomData?.bomJson?.components || [];
    assert.ok(components.length > 10, `got ${components.length} components`);
    const databind = componentFor(flagged.bomData, "jackson-databind");
    assert.strictEqual(databind?.version, "2.17.0");
    assert.strictEqual(databind?.scope, "optional");
    assert.strictEqual(hashContent(databind, "SHA-256"), DATABIND_SHA256);
    assert.strictEqual(hashContent(databind, "SHA-512"), DATABIND_SHA512);
    const properties = new Map(
      databind?.properties?.map((p) => [p.name, p.value]),
    );
    assert.strictEqual(
      properties.get("cdx:gradle:verificationMetadata"),
      "true",
    );
    assert.strictEqual(
      properties.get("cdx:gradle:verificationMethods"),
      "sha256,sha512",
    );
    assert.strictEqual(
      properties
        .get("internal:SrcFile")
        ?.endsWith(join("gradle", "verification-metadata.xml")),
      true,
    );
    // This component's identity really does come from the file.
    assert.strictEqual(hasVerificationEvidence(databind), true);
    // Parents, BOMs and plugin markers are not components of this BOM.
    assert.ok(!componentFor(flagged.bomData, "oss-parent"));
    assert.ok(!componentFor(flagged.bomData, "jackson-bom"));
    assert.ok(!componentFor(flagged.bomData, "jackson-base"));
    assert.ok(
      !componentFor(flagged.bomData, "com.google.protobuf.gradle.plugin"),
    );
    assert.ok(!componentFor(flagged.bomData, "protobuf-bom"));
    // The scan records what the fallback costs.
    assert.ok(
      flagged.degradations.includes("jvm.gradle.verification-metadata-only"),
    );
    assert.ok(!flagged.degradations.includes("jvm.gradle.lockfile-only"));
    // The flags the file writes land on the primary component.
    const parentProperties = new Map(
      flagged.bomData?.bomJson?.metadata?.component?.properties?.map((p) => [
        p.name,
        p.value,
      ]),
    );
    assert.strictEqual(
      parentProperties.get("cdx:gradle:verifyMetadata"),
      "true",
    );
    assert.strictEqual(
      parentProperties.get("cdx:gradle:verifySignatures"),
      "false",
    );
  });

  it("enriches catalog components and keeps the fallback off", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-vm-catalog-"));
    try {
      writeFileSync(
        join(tempDir, "build.gradle"),
        "plugins { id 'java' }\ndependencies { implementation libs.jackson.databind }",
      );
      mkdirSync(join(tempDir, "gradle"), { recursive: true });
      writeFileSync(
        join(tempDir, "gradle", "libs.versions.toml"),
        [
          "[versions]",
          'jackson = "2.17.0"',
          "",
          "[libraries]",
          'jackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind", version.ref = "jackson" }',
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(tempDir, "gradle", "verification-metadata.xml"),
        readFileSync(
          join(
            repoRoot,
            "test",
            "data",
            "gradle-verification",
            "generated",
            "gradle",
            "verification-metadata.xml",
          ),
        ),
      );
      const { bomData, degradations } = await withDegradations(tempDir, {
        installDeps: false,
        projectType: ["gradle"],
        specVersion: 1.6,
      });
      const databind = componentFor(bomData, "jackson-databind");
      assert.strictEqual(databind?.version, "2.17.0");
      assert.strictEqual(
        databind?.properties?.find((p) => p.name === "cdx:gradle:catalog")
          ?.value,
        "true",
      );
      assert.strictEqual(hashContent(databind, "SHA-256"), DATABIND_SHA256);
      assert.strictEqual(hashContent(databind, "SHA-512"), DATABIND_SHA512);
      assert.ok(databind?.hashes?.length >= 2);
      assert.ok(
        !databind?.properties?.some(
          (p) => p.name === "cdx:gradle:verificationMetadata",
        ),
      );
      // The catalog's own identity evidence stands.
      assert.strictEqual(hasVerificationEvidence(databind), false);
      assert.deepStrictEqual(degradations, []);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
