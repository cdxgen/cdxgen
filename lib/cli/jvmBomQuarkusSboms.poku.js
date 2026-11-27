// Quarkus projects can carry two kinds of CycloneDX document in target/:
// the dependency SBOMs the quarkus:dependency-sbom goal writes
// (<artifactId>-<version>[-<mode>]-dependency-cyclonedx.json) and, when the
// project also uses the quarkus-cyclonedx extension, a distribution SBOM
// (<executable-name>-cyclonedx.json, e.g. quarkus-run-cyclonedx.json) whose
// components are the built distribution: build-time libraries (scope:
// excluded) and generic file components. A stand-in mvn sits on the PATH and
// fails, as it would for a project whose target/ holds files from an earlier
// build: the scan then reads what target/ already contains.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";
import sinon from "sinon";

import { resetRunState } from "../core/runState.js";

// The non-Quarkus control must take the plugin-BOM path rather than the
// Maven dependency tree, so the preference has to be off before jvmBom.js is
// loaded (the flag is read once at import time).
process.env.PREFER_MAVEN_DEPS_TREE = "false";
const { createJavaBom } = await import("./jvmBom.js");

const isWin = process.platform === "win32";

function writePom(dir, body) {
  mkdirSync(dir, { recursive: true });
  const pomFile = join(dir, "pom.xml");
  writeFileSync(
    pomFile,
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
${body}
</project>`,
  );
  return pomFile;
}

function writeStandInMaven(binDir, marker) {
  mkdirSync(binDir, { recursive: true });
  const shScript = join(binDir, "mvn");
  writeFileSync(
    shScript,
    `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(marker)}\nexit 1\n`,
  );
  chmodSync(shScript, 0o755);
  writeFileSync(
    join(binDir, "mvn.cmd"),
    `@echo off\r\necho ran> "${marker}"\r\nexit /b 1\r\n`,
  );
}

const MAVEN_ENV_NAMES = [
  "PATH",
  "HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "MVN_CMD",
  "MAVEN_CMD",
  "MVN_ARGS",
  "MAVEN_ARGS",
];

async function scanWithStandInMaven(root, project, options) {
  const saved = Object.fromEntries(
    MAVEN_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  const binDir = join(root, "bin");
  const marker = join(root, "mvn-ran");
  const emptyHome = join(root, "home");
  writeStandInMaven(binDir, marker);
  mkdirSync(emptyHome, { recursive: true });
  const logStub = sinon.stub(console, "log");
  try {
    for (const name of MAVEN_ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, saved.PATH].filter(Boolean).join(delimiter);
    process.env.HOME = emptyHome;
    resetRunState();
    const bomNSData = await createJavaBom(project, options);
    return { bomNSData, mvnRan: existsSync(marker) };
  } finally {
    logStub.restore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
  }
}

const DEPENDENCY_SBOM = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {
      type: "application",
      group: "org.acme",
      name: "demo-app",
      version: "1.0.0",
      purl: "pkg:maven/org.acme/demo-app@1.0.0",
    },
  },
  components: [
    {
      type: "library",
      group: "io.quarkus",
      name: "quarkus-core",
      version: "3.20.0",
      purl: "pkg:maven/io.quarkus/quarkus-core@3.20.0?type=jar",
      "bom-ref": "pkg:maven/io.quarkus/quarkus-core@3.20.0?type=jar",
    },
  ],
  dependencies: [
    {
      ref: "pkg:maven/org.acme/demo-app@1.0.0",
      dependsOn: ["pkg:maven/io.quarkus/quarkus-core@3.20.0?type=jar"],
    },
  ],
};

// What the quarkus-cyclonedx extension writes for the built distribution: a
// build-time library under scope: excluded and a generic file component.
const DISTRIBUTION_SBOM = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  components: [
    {
      type: "library",
      "bom-ref": "pkg:maven/io.quarkus/quarkus-bootstrap-runner@3.20.0",
      group: "io.quarkus",
      name: "quarkus-bootstrap-runner",
      version: "3.20.0",
      scope: "excluded",
      purl: "pkg:maven/io.quarkus/quarkus-bootstrap-runner@3.20.0?type=jar",
    },
    {
      type: "file",
      "bom-ref": "pkg:generic/quarkus-run.jar@1.0.0",
      name: "quarkus-run.jar",
      version: "1.0.0",
      purl: "pkg:generic/quarkus-run.jar@1.0.0",
    },
  ],
};

function writeProject(root, { quarkus = true } = {}) {
  const project = join(root, "project");
  writePom(
    project,
    `<groupId>org.acme</groupId>
  <artifactId>demo-app</artifactId>
  <version>1.0.0</version>${
    quarkus
      ? `
  <properties>
    <quarkus.platform.group-id>io.quarkus.platform</quarkus.platform.group-id>
    <quarkus.platform.artifact-id>quarkus-bom</quarkus.platform.artifact-id>
    <quarkus.platform.version>4.0.1</quarkus.platform.version>
  </properties>`
      : ""
  }`,
  );
  const target = join(project, "target");
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "demo-app-1.0.0-dependency-cyclonedx.json"),
    JSON.stringify(DEPENDENCY_SBOM),
  );
  writeFileSync(
    join(target, "quarkus-run-cyclonedx.json"),
    JSON.stringify(DISTRIBUTION_SBOM),
  );
  return project;
}

await describe("quarkus mode BOM selection", async () => {
  await it("keeps only the dependency SBOMs the goal writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-quarkus-sboms-"));
    try {
      const project = writeProject(root, { quarkus: true });
      const { bomNSData, mvnRan } = await scanWithStandInMaven(root, project, {
        installDeps: true,
        projectType: ["quarkus"],
        specVersion: 1.6,
      });
      assert.strictEqual(mvnRan, true, "the stand-in mvn was never invoked");
      const components = bomNSData.bomJson?.components || [];
      const names = new Set(components.map((c) => c.name));
      assert.ok(
        names.has("quarkus-core"),
        "the dependency SBOM's library was not read",
      );
      assert.ok(
        !names.has("quarkus-bootstrap-runner"),
        "the distribution SBOM's build-time component was read",
      );
      assert.ok(
        !components.some((c) => c.type === "file"),
        "the distribution SBOM's file component was read",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await it("keeps the general glob for non-Quarkus projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-quarkus-sboms-plain-"));
    try {
      const project = writeProject(root, { quarkus: false });
      const { bomNSData } = await scanWithStandInMaven(root, project, {
        installDeps: true,
        projectType: ["java"],
        specVersion: 1.6,
      });
      const components = bomNSData.bomJson?.components || [];
      const names = new Set(components.map((c) => c.name));
      // The plain-Maven path keeps reading every cyclonedx-named json in
      // target/, including a distribution SBOM left there.
      assert.ok(
        names.has("quarkus-core"),
        "the dependency SBOM's library was not read",
      );
      
      assert.ok(
        names.has("quarkus-run.jar"),
        "the non-Quarkus glob stopped reading a cyclonedx json in target/",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
