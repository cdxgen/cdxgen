import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { candidateJdkHomes, collectJdkInfo } from "./jdkRootfs.js";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "cdxgen-jdk-rootfs-"));
}

function makeJdk(root, home, release, launcher = true) {
  const directory = join(root, ...home.split("/"));
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(join(directory, "release"), release);
  if (launcher) {
    writeFileSync(join(directory, "bin", "java"), "#!/bin/sh\n");
  }
  return directory;
}

const release = (version, implementor = "Eclipse Adoptium") =>
  `JAVA_VERSION="${version}"\nIMPLEMENTOR="${implementor}"\nJAVA_RUNTIME_VERSION="${version}+1-LTS"\n`;

describe("candidateJdkHomes()", () => {
  it("finds homes under the fixed parents and skips links and non-JDKs", () => {
    const root = makeRoot();
    try {
      makeJdk(root, "opt/java/openjdk", release("21.0.5"));
      makeJdk(root, "usr/local/jdk-17", release("17.0.14"));
      makeJdk(root, "home/dev/.sdkman/candidates/java/25-tem", release("25"));
      makeJdk(root, "opt/not-a-jdk-no-launcher", release("9"), false);
      symlinkSync(
        "25-tem",
        join(root, "home/dev/.sdkman/candidates/java/current"),
      );
      const homes = candidateJdkHomes(root, []).map((home) =>
        home.slice(root.length).replaceAll("\\", "/"),
      );
      assert.deepStrictEqual(homes.sort(), [
        "/home/dev/.sdkman/candidates/java/25-tem",
        "/opt/java/openjdk",
        "/usr/local/jdk-17",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("ignores a JAVA_HOME that leaves the rootfs", () => {
    const root = makeRoot();
    try {
      makeJdk(root, "opt/jdk-x", release("21.0.5"));
      const homes = candidateJdkHomes(root, [
        "JAVA_HOME=/../../etc",
        "JAVA_HOME=C:\\jdk",
        "JAVA_HOME=/opt/jdk-x",
      ]);
      assert.strictEqual(homes.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectJdkInfo()", () => {
  it("links the launcher file component to the JDK and leaves owned homes alone", () => {
    const root = makeRoot();
    try {
      makeJdk(root, "opt/java/openjdk", release("21.0.5"));
      makeJdk(
        root,
        "usr/lib/jvm/java-21-openjdk",
        release("21.0.9", "Red Hat"),
      );
      const launcher = {
        "bom-ref": "pkg:generic/java?file=1",
        name: "java",
        type: "file",
        properties: [
          { name: "internal:SrcFile", value: "/opt/java/openjdk/bin/java" },
        ],
      };
      const { jdkComponents, dependencies } = collectJdkInfo(
        root,
        ["/usr/lib/jvm/java-21-openjdk/bin/java"],
        [],
        [launcher],
      );
      assert.strictEqual(jdkComponents.length, 1);
      assert.strictEqual(
        jdkComponents[0].purl,
        "pkg:generic/temurin-jdk@21.0.5%2B1",
      );
      assert.ok(
        dependencies.some(
          (dependency) =>
            dependency.ref === launcher["bom-ref"] &&
            dependency.dependsOn.includes(jdkComponents[0]["bom-ref"]),
        ),
      );
      assert.ok(
        launcher.properties.some(
          (property) =>
            property.name === "cdx:java:vendor" &&
            property.value === "Eclipse Temurin",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("compares owned paths with or without the leading slash", () => {
    const root = makeRoot();
    try {
      makeJdk(
        root,
        "usr/lib/jvm/java-21-openjdk",
        release("21.0.13", "Alpine"),
      );
      const { jdkComponents } = collectJdkInfo(
        root,
        ["usr/lib/jvm/java-21-openjdk/bin/java"],
        [],
        [],
      );
      assert.deepStrictEqual(jdkComponents, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("leaves a home under /usr/lib/jvm to a JDK package whose file list is unknown", () => {
    const root = makeRoot();
    try {
      makeJdk(
        root,
        "usr/lib/jvm/java-21-amazon-corretto",
        release("21.0.13", "Amazon.com Inc."),
      );
      makeJdk(root, "opt/java/openjdk", release("21.0.5"));
      const withPackage = collectJdkInfo(
        root,
        [],
        [],
        [],
        ["java-21-amazon-corretto-headless", "glibc"],
      );
      assert.deepStrictEqual(
        withPackage.jdkComponents.map((jdk) => jdk.version),
        ["21.0.5"],
      );
      // Without a JDK package the home is a plain unpackaged JDK
      const without = collectJdkInfo(root, [], [], [], ["glibc"]);
      assert.strictEqual(without.jdkComponents.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
