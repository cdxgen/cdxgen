import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { MAVEN_CENTRAL_MIRROR_URLS } from "../inventory/mavenCentralMirror.js";

// The mirror switch is read per invocation, but the artifacts are written
// once per process; the run reset between the two tests keeps them apart.
const MIRROR = MAVEN_CENTRAL_MIRROR_URLS.google;

it("createJavaBom hands sbt a mirror repositories file through SBT_OPTS", async () => {
  const saved = Object.fromEntries(
    [
      "HOME",
      "USERPROFILE",
      "MAVEN_CENTRAL_MIRROR",
      "COURSIER_CACHE",
      "SBT_CACHE_DIR",
      "MAVEN_CACHE_DIR",
    ].map((n) => [n, process.env[n]]),
  );
  const root = mkdtempSync(join(tmpdir(), "cdxgen-sbt-mirror-"));
  try {
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    process.env.MAVEN_CENTRAL_MIRROR = "true";
    process.env.COURSIER_CACHE = join(root, "coursier");
    process.env.SBT_CACHE_DIR = join(root, "ivy");
    process.env.MAVEN_CACHE_DIR = join(root, "m2");
    resetRunState();

    const project = join(root, "app");
    mkdirSync(join(project, "project"), { recursive: true });
    writeFileSync(
      join(project, "project", "build.properties"),
      "sbt.version=1.10.11\n",
    );
    writeFileSync(join(project, "build.sbt"), 'name := "app"\n');

    const calls = [];
    const sbtutils = await import("../ecosystems/sbtutils.js");
    const { createJavaBom } = await esmock("./jvmBom.js", {
      "../ecosystems/sbtutils.js": {
        ...sbtutils,
        sbtSpawnSync: (cmd, args, options) => {
          calls.push({ cmd, args, env: options.env });
          return { status: 1, stdout: "", stderr: "no sbt here" };
        },
      },
    });
    await createJavaBom(project, {
      projectType: ["sbt"],
      installDeps: true,
      multiProject: false,
      specVersion: 1.7,
    });
    const sbtCall = calls.find((call) =>
      call.args.join(" ").includes("dependencyTree"),
    );
    assert.ok(sbtCall, "sbt was invoked");
    const configMatch = /-Dsbt\.repository\.config=(\S+)/.exec(
      sbtCall.env.SBT_OPTS || "",
    );
    assert.ok(configMatch, "SBT_OPTS names a repositories file");
    assert.ok(existsSync(configMatch[1]));
    const repositories = readFileSync(configMatch[1], "utf-8");
    assert.ok(repositories.includes(`maven-central: ${MIRROR}`));
    assert.ok(sbtCall.env.SBT_OPTS.includes("-Dsbt.override.build.repos=true"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
    rmSync(root, { recursive: true, force: true });
  }
});

it("collectMvnDependencies passes the mirror settings and wrapper env to Maven", async () => {
  const saved = Object.fromEntries(
    [
      "MAVEN_CENTRAL_MIRROR",
      "MAVEN_CACHE_DIR",
      "MVN_ARGS",
      "MAVEN_ARGS",
      "MAVEN_OPTS",
    ].map((n) => [n, process.env[n]]),
  );
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-mirror-"));
  try {
    process.env.MAVEN_CENTRAL_MIRROR = "true";
    process.env.MAVEN_CACHE_DIR = join(root, "m2");
    delete process.env.MVN_ARGS;
    delete process.env.MAVEN_ARGS;
    delete process.env.MAVEN_OPTS;
    resetRunState();

    const project = join(root, "app");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>app</artifactId><version>1.0</version></project>",
    );

    const fsModule = await import("../core/fs.js");
    const spawnCalls = [];
    const { collectMvnDependencies } = await esmock("../inventory/deps.js", {
      "../core/fs.js": {
        ...fsModule,
        safeSpawnSync: (cmd, args, options) => {
          spawnCalls.push({ cmd, args, env: options?.env });
          return { status: 1, stdout: "", stderr: "no maven here" };
        },
      },
    });
    await collectMvnDependencies("mvn", project, true, false);
    assert.strictEqual(spawnCalls.length, 1);
    const call = spawnCalls[0];
    const gsIndex = call.args.indexOf("-gs");
    assert.ok(gsIndex > -1, "the Maven command names a global settings file");
    assert.ok(existsSync(call.args[gsIndex + 1]));
    const settings = readFileSync(call.args[gsIndex + 1], "utf-8");
    assert.ok(settings.includes(`<url>${MIRROR}</url>`));
    assert.ok(settings.includes("<mirrorOf>central</mirrorOf>"));
    assert.strictEqual(call.env.MVNW_REPOURL, MIRROR.replace(/\/$/, ""));

    // Without the switch neither the settings file nor the wrapper env appears.
    spawnCalls.length = 0;
    delete process.env.MAVEN_CENTRAL_MIRROR;
    resetRunState();
    await collectMvnDependencies("mvn", project, true, false);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].args.indexOf("-gs"), -1);
    assert.strictEqual(spawnCalls[0].env.MVNW_REPOURL, undefined);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
    rmSync(root, { recursive: true, force: true });
  }
});
