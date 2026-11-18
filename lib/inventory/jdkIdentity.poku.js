import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  addJdkToInventory,
  annotateOsPackageJdks,
  classifyJavaBinary,
  createJdkComponent,
  createJdkInventory,
  jdkIdentityFromOsPackage,
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
  it("names Temurin 21 with vendor, build and purl, and no CPE", () => {
    const component = createJdkComponent(identityOf(TEMURIN_21));
    assert.strictEqual(component.name, "java");
    assert.strictEqual(component.version, "21.0.5");
    assert.strictEqual(component.purl, "pkg:generic/temurin-jdk@21.0.5%2B11");
    assert.strictEqual(component.cpe, undefined);
    const properties = Object.fromEntries(
      component.properties.map((p) => [p.name, p.value]),
    );
    assert.strictEqual(properties["cdx:java:vendor"], "Eclipse Temurin");
    assert.strictEqual(properties["cdx:java:build"], "11");
    assert.strictEqual(properties["cdx:java:arch"], "aarch64");
    assert.strictEqual(properties["cdx:java:home"], "/opt/jdk");
    assert.ok(!JSON.stringify(component).includes("java.base"));
  });
  it("reads a Java 8 release with its legacy version", () => {
    const identity = identityOf(TEMURIN_8);
    assert.strictEqual(identity.version, "1.8.0_504");
    assert.strictEqual(identity.build, "b09");
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
    assert.strictEqual(corretto.cpe, undefined);
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
  it("labels the distro of a distro JDK", () => {
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

describe("JDKs that OS packages install", () => {
  const pkg = (purl, name, version, props = []) => ({
    name,
    version,
    purl,
    properties: props.map(([n, v]) => ({ name: n, value: v })),
  });
  const prop = (component, name) =>
    component.properties.find((p) => p.name === name)?.value;
  const cases = [
    [
      "deb",
      pkg(
        "pkg:deb/ubuntu/openjdk-21-jre-headless@21.0.13.0.3%2B1-1~24.04.1?arch=amd64&distro=ubuntu-24.04",
        "openjdk-21-jre-headless",
        "21.0.13.0.3+1-1~24.04.1",
      ),
      "21.0.13",
      "Ubuntu build of OpenJDK",
      "exposed",
    ],
    [
      "rpm",
      pkg(
        "pkg:rpm/redhat/java-21-openjdk-headless@1:21.0.13.0.11-1.el9?arch=x86_64",
        "java-21-openjdk-headless",
        "1:21.0.13.0.11-1.el9",
      ),
      "21.0.13",
      "Red Hat build of OpenJDK",
      "exposed",
    ],
    [
      "corretto rpm",
      pkg(
        "pkg:rpm/amazon/java-21-amazon-corretto-headless@1:21.0.13.0.11-1.amzn2023.1?arch=aarch64",
        "java-21-amazon-corretto-headless",
        "1:21.0.13.0.11-1.amzn2023.1",
      ),
      "21.0.13",
      "Amazon Corretto",
      "not-affected",
    ],
    [
      "apk",
      pkg(
        "pkg:apk/alpine/openjdk21-jre-headless@21.0.13.0.3_p1-r0?arch=x86_64",
        "openjdk21-jre-headless",
        "21.0.13.0.3_p1-r0",
      ),
      "21.0.13",
      "Alpine build of OpenJDK",
      "exposed",
    ],
    [
      "homebrew",
      pkg("pkg:brew/openjdk@21@21.0.5", "openjdk@21", "21.0.5"),
      "21.0.5",
      "OpenJDK",
      "exposed",
    ],
    [
      "chocolatey",
      pkg("pkg:chocolatey/Temurin25@25.0.4.1", "Temurin25", "25.0.4.1"),
      "25.0.4.1",
      "Eclipse Temurin",
      "exposed",
    ],
    [
      "windows program",
      pkg(
        "pkg:swid/Eclipse%20Temurin%20JDK@25.0.4.101?tag_id=x",
        "Eclipse Temurin JDK with Hotspot 25.0.4.1+1 (x64)",
        "25.0.4.101",
        [
          ["cdx:osquery:category", "windows_programs"],
          [
            "install_location",
            "C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.4.101-hotspot\\",
          ],
        ],
      ),
      "25.0.4.1",
      "Eclipse Temurin",
      "exposed",
    ],
  ];
  for (const [label, component, version, vendor, exposure] of cases) {
    it(`recognises the ${label} package`, () => {
      const copy = structuredClone(component);
      assert.strictEqual(
        annotateOsPackageJdks([copy], { hostArch: "x86_64" }),
        1,
      );
      assert.strictEqual(prop(copy, "cdx:java:version"), version);
      assert.strictEqual(prop(copy, "cdx:java:vendor"), vendor);
      assert.strictEqual(prop(copy, "cdx:java:vm"), "hotspot");
      assert.strictEqual(
        prop(copy, "cdx:java:base64IntrinsicExposure"),
        exposure,
      );
      // The package keeps its own version and purl
      assert.strictEqual(copy.version, component.version);
      assert.strictEqual(copy.purl, component.purl);
    });
  }
  it("takes the Windows home from the install location, the Java 8 rpm version from its update, and leaves other packages alone", () => {
    const windows = structuredClone(cases[6][1]);
    annotateOsPackageJdks([windows]);
    assert.strictEqual(
      prop(windows, "cdx:java:home"),
      "C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.4.101-hotspot",
    );
    assert.strictEqual(
      jdkIdentityFromOsPackage(
        pkg(
          "pkg:rpm/redhat/java-1.8.0-openjdk@1:1.8.0.432.b06-2.el9",
          "java-1.8.0-openjdk",
          "1:1.8.0.432.b06-2.el9",
        ),
      ).version,
      "1.8.0_432",
    );
    for (const [purl, name] of [
      ["pkg:deb/ubuntu/openjdk-21-doc@21.0.13", "openjdk-21-doc"],
      ["pkg:deb/ubuntu/openjdk-21-source@21.0.13", "openjdk-21-source"],
      [
        "pkg:rpm/redhat/java-21-openjdk-javadoc@21.0.13",
        "java-21-openjdk-javadoc",
      ],
      ["pkg:deb/ubuntu/libc6@2.39", "libc6"],
    ]) {
      assert.strictEqual(
        jdkIdentityFromOsPackage(pkg(purl, name, "21.0.13")),
        undefined,
      );
    }
  });
});
