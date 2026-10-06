import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { createJavaBom } from "./jvmBom.js";

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
