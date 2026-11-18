import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  addJdkToInventory,
  classifyJavaBinary,
  createJdkComponent,
  createJdkInventory,
  jdkCpe,
  jdkVendorFor,
  parseJavaVersionOutput,
  parseJdkRelease,
  readJdkIdentity,
} from "./jdkIdentity.js";
import { extractJavaMajor } from "./toolRequirements.js";

const TEMURIN_21 = `IMPLEMENTOR="Eclipse Adoptium"
IMPLEMENTOR_VERSION="Temurin-21.0.5+11"
JAVA_RUNTIME_VERSION="21.0.5+11-LTS"
JAVA_VERSION="21.0.5"
JAVA_VERSION_DATE="2024-10-15"
OS_ARCH="aarch64"
OS_NAME="Linux"
MODULES="java.base java.logging"
`;
const TEMURIN_8 = `JAVA_VERSION="1.8.0_504"
OS_NAME="Linux"
OS_ARCH="x86_64"
SOURCE=".:git:abc"
IMPLEMENTOR="Eclipse Adoptium"
IMPLEMENTOR_VERSION="Temurin-8u504-b09"
`;
const TEMURIN_8_FULL = `JAVA_VERSION="1.8.0_504"
OS_ARCH="aarch64"
IMPLEMENTOR="Eclipse Adoptium"
FULL_VERSION="1.8.0_504-b01"
SEMANTIC_VERSION="8.0.504+1"
`;
const ORACLE_GRAALVM = `IMPLEMENTOR="Oracle Corporation"
JAVA_RUNTIME_VERSION="23.0.2+7-jvmci-b01"
JAVA_VERSION="23.0.2"
GRAALVM_VERSION="24.1.2"
OS_ARCH="aarch64"
`;
const GRAALVM_CE = ORACLE_GRAALVM.replace(
  "Oracle Corporation",
  "GraalVM Community",
);
const CORRETTO = `IMPLEMENTOR="Amazon.com Inc."
IMPLEMENTOR_VERSION="Corretto-21.0.7.6.1"
JAVA_RUNTIME_VERSION="21.0.7+6-LTS"
JAVA_VERSION="21.0.7"
OS_ARCH="x86_64"
`;

function identityOf(text, home = "/opt/jdk") {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-jdk-"));
  try {
    writeFileSync(join(dir, "release"), text);
    const identity = readJdkIdentity(dir, dir);
    return identity && { ...identity, home };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("parseJdkRelease()", () => {
  it("reads quoted values and ignores comments and bad keys", () => {
    const values = parseJdkRelease(`# comment\n${TEMURIN_21}lower="x"\n`);
    assert.strictEqual(values.JAVA_VERSION, "21.0.5");
    assert.strictEqual(values.IMPLEMENTOR, "Eclipse Adoptium");
    assert.strictEqual(values.lower, undefined);
  });
});

describe("JDK identity from a release file", () => {
  it("names Temurin 21 with vendor, build, CPE and purl", () => {
    const component = createJdkComponent(identityOf(TEMURIN_21));
    assert.strictEqual(component.name, "java");
    assert.strictEqual(component.version, "21.0.5");
    assert.strictEqual(component.purl, "pkg:generic/temurin-jdk@21.0.5%2B11");
    assert.strictEqual(
      component.cpe,
      "cpe:2.3:a:eclipse:temurin:21.0.5:*:*:*:*:*:*:*",
    );
    const properties = Object.fromEntries(
      component.properties.map((p) => [p.name, p.value]),
    );
    assert.strictEqual(properties["cdx:java:vendor"], "Eclipse Temurin");
    assert.strictEqual(properties["cdx:java:build"], "11");
    assert.strictEqual(properties["cdx:java:arch"], "aarch64");
    assert.strictEqual(properties["cdx:java:home"], "/opt/jdk");
    assert.ok(!JSON.stringify(component).includes("java.base"));
  });
  it("reads a Java 8 release with its legacy version and CPE", () => {
    const identity = identityOf(TEMURIN_8);
    assert.strictEqual(identity.version, "1.8.0_504");
    assert.strictEqual(identity.build, "b09");
    assert.strictEqual(
      jdkCpe(identity.vendor, identity.version),
      "cpe:2.3:a:eclipse:temurin:1.8.0:update504:*:*:*:*:*:*",
    );
    assert.strictEqual(extractJavaMajor(identity.version), 8);
  });
  it("takes the build of a Java 8 release from FULL_VERSION", () => {
    const identity = identityOf(TEMURIN_8_FULL);
    assert.strictEqual(identity.build, "b01");
    assert.strictEqual(identity.runtimeVersion, "1.8.0_504-b01");
  });
  it("tells Oracle GraalVM, GraalVM CE and Corretto apart", () => {
    assert.strictEqual(identityOf(ORACLE_GRAALVM).vendor.key, "graalvm-oracle");
    assert.strictEqual(identityOf(GRAALVM_CE).vendor.key, "graalvm-ce");
    const corretto = createJdkComponent(identityOf(CORRETTO));
    assert.strictEqual(corretto.cpe.split(":")[3], "amazon");
    assert.strictEqual(corretto.purl, "pkg:generic/corretto-jdk@21.0.7%2B6");
  });
  it("answers nothing for a file without a Java version", () => {
    assert.strictEqual(identityOf('IMPLEMENTOR="x"\n'), undefined);
    assert.strictEqual(identityOf('JAVA_VERSION="$(id)"\n'), undefined);
  });
  it("does not follow a release file that links out of the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-jdk-"));
    try {
      mkdirSync(join(dir, "home"));
      assert.strictEqual(readJdkIdentity(join(dir, "home"), dir), undefined);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("jdkVendorFor()", () => {
  const cases = [
    [["Eclipse Adoptium"], "temurin"],
    [["Azul Systems, Inc."], "zulu"],
    [["BellSoft"], "liberica"],
    [["Microsoft"], "microsoft"],
    [["Red Hat, Inc."], "redhat"],
    [["SUSE"], "suse"],
    [["Alpine"], "alpine"],
    [["Debian"], "debian"],
    [["Ubuntu"], "ubuntu"],
    [["Oracle Corporation"], "oracle"],
    [["Somebody Else"], "openjdk"],
  ];
  for (const [texts, key] of cases) {
    it(`maps ${texts[0]} to ${key}`, () => {
      assert.strictEqual(jdkVendorFor(...texts).key, key);
    });
  }
});

describe("parseJavaVersionOutput()", () => {
  it("reads Temurin 21", () => {
    const identity = parseJavaVersionOutput(
      'openjdk version "21.0.7" 2025-04-15 LTS\nOpenJDK Runtime Environment Temurin-21.0.7+6 (build 21.0.7+6-LTS)\nOpenJDK 64-Bit Server VM Temurin-21.0.7+6 (build 21.0.7+6-LTS, mixed mode)',
    );
    assert.strictEqual(identity.version, "21.0.7");
    assert.strictEqual(identity.build, "6");
    assert.strictEqual(identity.vendor.key, "temurin");
  });
  it("reads the Java 8 form with the vendor in parentheses", () => {
    const identity = parseJavaVersionOutput(
      'openjdk version "1.8.0_504"\nOpenJDK Runtime Environment (Temurin)(build 1.8.0_504-b09)\nOpenJDK 64-Bit Server VM (build 25.504-b09, mixed mode)',
    );
    assert.strictEqual(identity.version, "1.8.0_504");
    assert.strictEqual(identity.build, "b09");
    assert.strictEqual(identity.vendor.key, "temurin");
  });
  it("keeps Oracle JDK apart from OpenJDK builds", () => {
    const identity = parseJavaVersionOutput(
      'java version "21.0.7" 2025-04-15 LTS\nJava(TM) SE Runtime Environment (build 21.0.7+8-LTS-245)',
    );
    assert.strictEqual(identity.vendor.key, "oracle");
  });
  it("reads GraalVM, and never reads an echoed option line", () => {
    const identity = parseJavaVersionOutput(
      'java version "23.0.2" 2025-01-21\nJava(TM) SE Runtime Environment Oracle GraalVM 23.0.2+7.1 (build 23.0.2+7-jvmci-b01)',
    );
    assert.strictEqual(identity.vendor.key, "graalvm-oracle");
    assert.strictEqual(parseJavaVersionOutput("Picked up X: 1"), undefined);
    assert.strictEqual(parseJavaVersionOutput(undefined), undefined);
  });
});

describe("the JDK inventory", () => {
  it("keeps one component per identity with every home as an occurrence", () => {
    const inventory = createJdkInventory();
    const identity = identityOf(TEMURIN_21);
    addJdkToInventory(inventory, identity, "/opt/a");
    addJdkToInventory(inventory, identity, "/opt/b");
    addJdkToInventory(inventory, identityOf(CORRETTO), "/opt/c");
    assert.strictEqual(inventory.runtimeComponents.length, 2);
    assert.deepStrictEqual(
      inventory.runtimeComponents[0].evidence.occurrences.map(
        (o) => o.location,
      ),
      ["/opt/a", "/opt/b"],
    );
  });
  it("recognises the launcher names", () => {
    assert.strictEqual(classifyJavaBinary("java"), "java");
    assert.strictEqual(classifyJavaBinary("java.exe", "win32"), "java");
    assert.strictEqual(classifyJavaBinary("javac"), undefined);
  });
});

describe("distro and Semeru builds", () => {
  it("gives a distro JDK no upstream CPE and labels the distro", () => {
    const component = createJdkComponent(
      identityOf(
        'IMPLEMENTOR="Ubuntu"\nJAVA_VERSION="21.0.13"\nJAVA_RUNTIME_VERSION="21.0.13+1-Ubuntu-1ubuntu0.24.04"\nOS_ARCH="x86_64"\n',
      ),
    );
    assert.strictEqual(component.cpe, undefined);
    assert.ok(
      component.properties.some(
        (p) =>
          p.name === "cdx:java:vendor" && p.value === "Ubuntu build of OpenJDK",
      ),
    );
    const parsed = parseJavaVersionOutput(
      'openjdk version "21.0.13" 2026-10-21\nOpenJDK Runtime Environment (build 21.0.13+1-Ubuntu-1ubuntu0.24.04)',
    );
    assert.strictEqual(parsed.vendor.key, "ubuntu");
  });
  it("treats Semeru as not affected with or without JVM_VARIANT", () => {
    const exposure = (component) =>
      component.properties.find(
        (p) => p.name === "cdx:java:base64IntrinsicExposure",
      ).value;
    assert.strictEqual(
      exposure(
        createJdkComponent(
          identityOf('IMPLEMENTOR="IBM Corporation"\nJAVA_VERSION="21.0.9"\n'),
        ),
      ),
      "not-affected",
    );
    const parsed = parseJavaVersionOutput(
      'openjdk version "21.0.9" 2026-10-21 LTS\nIBM Semeru Runtime Open Edition 21.0.9.0 (build 21.0.9+10-LTS)\nEclipse OpenJ9 VM 21.0.9.0',
    );
    assert.strictEqual(parsed.vendor.key, "semeru");
    assert.strictEqual(exposure(createJdkComponent(parsed)), "not-affected");
  });
  it("treats an arm64 JDK as not affected and an unknown arch as exposed", () => {
    const exposure = (arch) =>
      createJdkComponent(
        identityOf(
          `IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="21.0.9"\n${arch ? `OS_ARCH="${arch}"\n` : ""}`,
        ),
      ).properties.find((p) => p.name === "cdx:java:base64IntrinsicExposure")
        .value;
    assert.strictEqual(exposure("aarch64"), "not-affected");
    assert.strictEqual(exposure("x86_64"), "exposed");
    assert.strictEqual(exposure("amd64"), "exposed");
    assert.strictEqual(exposure(undefined), "exposed");
  });
});
