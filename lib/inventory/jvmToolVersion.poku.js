import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  resolveJvmToolVersion,
  versionFromToolPath,
} from "./jvmToolVersion.js";

function put(root, file, content, mode) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode) {
    chmodSync(target, mode);
  }
  return target;
}

describe("versionFromToolPath()", () => {
  it("reads sdkman, Homebrew and unpacked distribution directories", () => {
    assert.strictEqual(
      versionFromToolPath("/h/.sdkman/candidates/maven/3.9.9/bin/mvn", "mvn"),
      "3.9.9",
    );
    assert.strictEqual(
      versionFromToolPath(
        "/opt/homebrew/Cellar/gradle/8.14/libexec/bin/gradle",
        "gradle",
      ),
      "8.14",
    );
    assert.strictEqual(
      versionFromToolPath("/opt/apache-maven-3.9.11/bin/mvn", "mvn"),
      "3.9.11",
    );
    assert.strictEqual(
      versionFromToolPath("/h/.sdkman/candidates/sbt/1.10.11/bin/sbt", "sbt"),
      "1.10.11",
    );
    assert.strictEqual(versionFromToolPath("/usr/bin/mvn", "mvn"), undefined);
    assert.strictEqual(
      versionFromToolPath("/h/.sdkman/candidates/maven/current/bin/mvn", "mvn"),
      undefined,
    );
  });
});

describe("wrapper and checkout folders", () => {
  it("ignores a checkout folder named like a distribution", () => {
    assert.strictEqual(
      versionFromToolPath("/work/gradle-8.14/app/gradlew", "gradlew"),
      undefined,
    );
    assert.strictEqual(
      versionFromToolPath("/work/gradle-8.14/app/bin/gradle", "gradle"),
      "8.14",
    );
  });
  it("prefers the pinned wrapper version to the folder", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-jvmtool-"));
    try {
      const gradlew = put(root, "gradle-8.14/gradlew", "#!/bin/sh\n", 0o755);
      put(
        root,
        "gradle-8.14/gradle/wrapper/gradle-wrapper.properties",
        "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1-bin.zip\n",
      );
      assert.strictEqual(
        resolveJvmToolVersion("gradlew", { command: gradlew }),
        "9.1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveJvmToolVersion()", () => {
  it("reads a wrapper's distribution without running it", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-jvmtool-"));
    try {
      const sentinel = join(root, "ran");
      const mvnw = put(root, "mvnw", `#!/bin/sh\ntouch ${sentinel}\n`, 0o755);
      put(
        root,
        ".mvn/wrapper/maven-wrapper.properties",
        "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip\n",
      );
      const gradlew = put(root, "gradlew", "#!/bin/sh\n", 0o755);
      put(
        root,
        "gradle/wrapper/gradle-wrapper.properties",
        "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip\n",
      );
      assert.strictEqual(
        resolveJvmToolVersion("mvnw", { command: mvnw }),
        "3.9.6",
      );
      assert.strictEqual(
        resolveJvmToolVersion("gradlew", { command: gradlew }),
        "8.14",
      );
      assert.strictEqual(
        resolveJvmToolVersion("mvnw", { command: "./mvnw", cwd: root }),
        "3.9.6",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reads the version from the jar a distribution carries, and never runs the tool", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-jvmtool-"));
    try {
      const sentinel = join(root, "ran");
      const mvn = put(
        root,
        "maven/bin/mvn",
        `#!/bin/sh\ntouch ${sentinel}\n`,
        0o755,
      );
      put(root, "maven/lib/maven-core-3.8.7.jar", "");
      const gradle = put(root, "gradle/bin/gradle", "#!/bin/sh\n", 0o755);
      put(root, "gradle/lib/gradle-launcher-8.14.jar", "");
      const sbt = put(root, "sbt/bin/sbt", "#!/bin/sh\n", 0o755);
      put(root, "sbt/lib/sbt-1.0.jar", "");
      assert.strictEqual(
        resolveJvmToolVersion("mvn", { command: mvn }),
        "3.8.7",
      );
      assert.strictEqual(
        resolveJvmToolVersion("gradle", { command: gradle }),
        "8.14",
      );
      assert.strictEqual(
        resolveJvmToolVersion("sbt", { command: sbt }),
        undefined,
      );
      assert.strictEqual(
        resolveJvmToolVersion("zip", { command: mvn }),
        undefined,
      );
      assert.strictEqual(existsSync(sentinel), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
