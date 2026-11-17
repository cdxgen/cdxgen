// The one place a JDK's identity becomes a component, for the formulation of a
// source scan, the container and rootfs scan, and the OS scan of a live host.
// HotSpot defects such as the C2 Base64 intrinsic overflow (issue #4862) hit a
// range of builds of one vendor's JDK on one kind of CPU, so a BOM has to name
// the vendor, the version, the build and the place of every JDK a host or an
// image carries, whichever package manager, tarball or sdkman put it there.
//
// An identity is read, never executed, wherever the JDK home is known: the
// `release` file every JDK carries at its top level holds JAVA_VERSION,
// JAVA_RUNTIME_VERSION, IMPLEMENTOR, IMPLEMENTOR_VERSION and OS_ARCH. Where
// only a java command is available, the identity is read from the output of
// `java -version`, which Java 8 prints as well. `-XshowSettings:properties` is
// never used: it dumps system properties, which carry the passwords of a
// JAVA_TOOL_OPTIONS.
//
// There is no purl type for a JDK. As the Go toolchain is `pkg:generic/go`,
// the identity here is `pkg:generic/<vendor>-jdk@<version>+<build>`, one name
// per vendor so that Temurin 21.0.7 and Oracle 21.0.7 do not share an
// identity, and the build in the version because a respin of one release is a
// different binary. The CPE is the one the vendor's advisories use.

import { readScanFileText } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

/**
 * The longest a `release` file is read. The file holds a dozen lines; the
 * GraalVM ones list their modules and run to a few kilobytes.
 *
 * @type {number}
 */
export const JDK_RELEASE_MAX_BYTES = 64 * 1024;
export const JDK_RELEASE_FILE_NAME = "release";

/**
 * The most JDK-named files one scan opens in search of a release file.
 *
 * @type {number}
 */
export const MAX_JDK_PROBES = 64;

const MAX_VALUE_LENGTH = 128;

// vendor key -> naming. `cpe` is `vendor:product`. Order matters for the
// keyword match: the specific vendors come before the generic ones.
const VENDORS = [
  {
    key: "temurin",
    label: "Eclipse Temurin",
    keywords: ["temurin", "adoptium", "adoptopenjdk"],
    cpe: "eclipse:temurin",
    purlName: "temurin-jdk",
  },
  {
    key: "graalvm-oracle",
    label: "Oracle GraalVM",
    keywords: ["oracle graalvm"],
    cpe: "oracle:graalvm_for_jdk",
    purlName: "oracle-graalvm",
  },
  {
    key: "graalvm-ce",
    label: "GraalVM Community Edition",
    keywords: ["graalvm"],
    cpe: "oracle:graalvm",
    purlName: "graalvm-ce",
  },
  {
    key: "corretto",
    label: "Amazon Corretto",
    keywords: ["corretto", "amazon"],
    cpe: "amazon:corretto",
    purlName: "corretto-jdk",
  },
  {
    key: "zulu",
    label: "Azul Zulu",
    keywords: ["zulu", "azul"],
    cpe: "azul:zulu",
    purlName: "zulu-jdk",
  },
  {
    key: "liberica",
    label: "BellSoft Liberica",
    keywords: ["liberica", "bellsoft"],
    cpe: "bell-sw:liberica_jdk",
    purlName: "liberica-jdk",
  },
  {
    key: "microsoft",
    label: "Microsoft Build of OpenJDK",
    keywords: ["microsoft"],
    cpe: "microsoft:openjdk",
    purlName: "microsoft-openjdk",
  },
  {
    key: "redhat",
    label: "Red Hat build of OpenJDK",
    keywords: ["red hat", "red_hat", "redhat"],
    cpe: "redhat:openjdk",
    purlName: "redhat-openjdk",
  },
  {
    key: "sapmachine",
    label: "SapMachine",
    keywords: ["sapmachine", "sap se"],
    cpe: "sap:sapmachine",
    purlName: "sapmachine-jdk",
  },
  {
    key: "oracle",
    label: "Oracle JDK",
    keywords: ["oracle"],
    cpe: "oracle:jdk",
    purlName: "oracle-jdk",
  },
  {
    key: "suse",
    label: "SUSE build of OpenJDK",
    keywords: ["suse"],
    cpe: "openjdk:openjdk",
    purlName: "openjdk",
  },
  {
    key: "alpine",
    label: "Alpine build of OpenJDK",
    keywords: ["alpine"],
    cpe: "openjdk:openjdk",
    purlName: "openjdk",
  },
  {
    key: "debian",
    label: "Debian build of OpenJDK",
    keywords: ["debian", "ubuntu"],
    cpe: "openjdk:openjdk",
    purlName: "openjdk",
  },
];
const GENERIC_VENDOR = {
  key: "openjdk",
  label: "OpenJDK",
  cpe: "openjdk:openjdk",
  purlName: "openjdk",
};

/**
 * Parse the text of a JDK `release` file: one `KEY="value"` per line.
 *
 * @param {string|undefined} text content of the file
 * @returns {Object<string, string>} the keys with their unquoted values
 */
export function parseJdkRelease(text) {
  const values = {};
  for (const rawLine of `${text || ""}`.split(/\r?\n/)) {
    const line = rawLine.trim();
    const equals = line.indexOf("=");
    if (equals <= 0 || line.startsWith("#")) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (/^[A-Z0-9_]+$/.test(key) && value.length <= MAX_VALUE_LENGTH) {
      values[key] = value;
    }
  }
  return values;
}

// A Java version as the JDK spells it: 21, 21.0.7, 25.0.4.1, 1.8.0_504, 26-ea.
function isJavaVersion(value) {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d+(?:\.\d+)*(?:_\d+)?(?:-[0-9A-Za-z]+)?$/.test(value)
  );
}

// The build of a runtime version: `21.0.7+6-LTS` -> `6`, `1.8.0_504-b09` ->
// `b09`, `17.0.10+7-Ubuntu-122.04` -> `7`.
function buildOf(runtimeVersion) {
  const value = `${runtimeVersion || ""}`;
  const plus = value.indexOf("+");
  if (plus !== -1) {
    const build = value.slice(plus + 1).split(/[-.]/, 1)[0];
    return /^\d+$/.test(build) ? build : undefined;
  }
  const dash = value.lastIndexOf("-b");
  if (dash !== -1) {
    const build = value.slice(dash + 1);
    return /^b\d+$/.test(build) ? build : undefined;
  }
  return undefined;
}

/**
 * Choose the vendor entry for the text a JDK reports about its maker.
 *
 * @param {...string} texts IMPLEMENTOR, IMPLEMENTOR_VERSION, runtime line
 * @returns {Object} the vendor entry; OpenJDK when nothing matches
 */
export function jdkVendorFor(...texts) {
  const haystack = texts
    .filter((text) => typeof text === "string")
    .join(" ")
    .toLowerCase();
  for (const vendor of VENDORS) {
    if (vendor.keywords.some((keyword) => haystack.includes(keyword))) {
      return vendor;
    }
  }
  return GENERIC_VENDOR;
}

/**
 * The CPE a vulnerability database files a JDK release under. NVD spells
 * the Java 8 release `1.8.0` with the patch level `update504`.
 *
 * @param {Object} vendor vendor entry from jdkVendorFor
 * @param {string} version JAVA_VERSION
 * @returns {string} CPE 2.3 string
 */
export function jdkCpe(vendor, version) {
  const legacy = /^(1\.\d+\.\d+)_(\d+)/.exec(version);
  if (legacy) {
    return `cpe:2.3:a:${vendor.cpe}:${legacy[1]}:update${legacy[2]}:*:*:*:*:*:*`;
  }
  const clean = version.split("-", 1)[0];
  return `cpe:2.3:a:${vendor.cpe}:${clean}:*:*:*:*:*:*:*`;
}

/**
 * Describe a JDK from the keys of its `release` file.
 *
 * @param {Object<string, string>} release result of parseJdkRelease
 * @returns {Object|undefined} the identity, or undefined when the file names
 *   no Java version
 */
export function jdkIdentityFromRelease(release) {
  const version = release?.JAVA_VERSION;
  if (!isJavaVersion(version)) {
    return undefined;
  }
  // Java 8 has no JAVA_RUNTIME_VERSION; its FULL_VERSION is `1.8.0_504-b01`.
  const runtimeVersion = release.JAVA_RUNTIME_VERSION || release.FULL_VERSION;
  const implementor = release.IMPLEMENTOR;
  const implementorVersion = release.IMPLEMENTOR_VERSION;
  return {
    version: version.split("-", 1)[0],
    runtimeVersion,
    build: buildOf(runtimeVersion) || buildOf(implementorVersion),
    implementor,
    implementorVersion,
    arch: release.OS_ARCH,
    // GraalVM builds name Oracle or a community as the implementor; the
    // GRAALVM_VERSION key is what marks them as GraalVM.
    vendor: release.GRAALVM_VERSION
      ? jdkVendorFor(
          /community/i.test(implementor || "") ? "graalvm" : "oracle graalvm",
        )
      : jdkVendorFor(implementor, implementorVersion),
    graalvmVersion: release.GRAALVM_VERSION,
    source: "release-file",
  };
}

/**
 * Describe a JDK from the output of `java -version` (standard error, which
 * is where every Java version prints it) or of `java --version`.
 *
 * ```
 * openjdk version "21.0.7" 2025-04-15 LTS
 * OpenJDK Runtime Environment Temurin-21.0.7+6 (build 21.0.7+6-LTS)
 * ```
 *
 * @param {string|undefined} text output with the option echoes removed
 * @returns {Object|undefined} the identity, or undefined when no line names a
 *   Java version
 */
export function parseJavaVersionOutput(text) {
  const lines = `${text || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let version;
  let runtimeLine = "";
  for (const line of lines) {
    const quoted = /^(?:openjdk|java) version "([^"]{1,64})"/i.exec(line);
    const bare = /^(?:openjdk|java) (\d[^\s]{0,63})(?:\s|$)/i.exec(line);
    if (!version && (quoted || bare)) {
      version = (quoted || bare)[1];
    } else if (/Runtime Environment/i.test(line)) {
      runtimeLine = line;
    }
  }
  if (!isJavaVersion(version)) {
    return undefined;
  }
  const buildMatch = /\(build ([^)\s]{1,64})/i.exec(runtimeLine);
  const runtimeVersion = buildMatch ? buildMatch[1] : undefined;
  const afterEnvironment = runtimeLine
    .replace(/^.*Runtime Environment/i, "")
    .replace(/\(build[^)]*\)/i, "")
    .trim();
  // Java 8 prints the vendor in parentheses: `(Temurin)(build 1.8.0_504-b09)`
  const implementor = afterEnvironment.replace(/[()]/g, " ").trim();
  const vendor = jdkVendorFor(
    implementor,
    /^openjdk/i.test(lines[0] || "") ? "" : "oracle",
  );
  return {
    version: version.split("-", 1)[0],
    runtimeVersion,
    build: buildOf(runtimeVersion),
    implementor: implementor || undefined,
    vendor,
    source: "java-version-output",
  };
}

/**
 * Read the identity of the JDK in a home directory from its release file,
 * through the bounded file helpers: only a regular file inside the scan root
 * is opened, the read is capped, and nothing is executed.
 *
 * @param {string} javaHome absolute path of the JDK home
 * @param {string|undefined} rootDir directory the home must live in
 * @param {function(string, number, string): (string|undefined)} [readText]
 *   bounded reader, `readScanFileText` unless a test brings one
 * @returns {Object|undefined} identity with `home`, or undefined
 */
export function readJdkIdentity(javaHome, rootDir, readText) {
  if (typeof javaHome !== "string" || !javaHome) {
    return undefined;
  }
  let end = javaHome.length;
  while (end > 0 && (javaHome[end - 1] === "/" || javaHome[end - 1] === "\\")) {
    end--;
  }
  const text = (readText || readScanFileText)(
    `${javaHome.slice(0, end)}/${JDK_RELEASE_FILE_NAME}`,
    JDK_RELEASE_MAX_BYTES,
    rootDir,
  );
  const identity = jdkIdentityFromRelease(parseJdkRelease(text));
  return identity ? { ...identity, home: javaHome } : undefined;
}

/**
 * The properties a JDK component carries. Values are small facts: the
 * vendor, versions and the place; never the release file's other keys.
 *
 * @param {Object} identity result of readJdkIdentity or parseJavaVersionOutput
 * @param {string} [home] logical path of the JDK home, as the scan names it
 * @returns {{name: string, value: string}[]}
 */
export function jdkProperties(identity, home) {
  const properties = [
    { name: "cdx:java:vendor", value: identity.vendor.label },
  ];
  const add = (name, value) => {
    if (value) {
      properties.push({ name: `cdx:java:${name}`, value: `${value}` });
    }
  };
  add("implementor", identity.implementor);
  add("implementorVersion", identity.implementorVersion);
  add("graalvmVersion", identity.graalvmVersion);
  add("runtimeVersion", identity.runtimeVersion);
  add("build", identity.build);
  add("arch", identity.arch);
  add("home", home ?? identity.home);
  add("versionSource", identity.source);
  return properties;
}

/**
 * A JDK is one `platform` component named java, with the vendor's CPE and
 * the generic identity described at the top of this file.
 *
 * @param {Object} identity result of readJdkIdentity or parseJavaVersionOutput
 * @param {Object} [options]
 * @param {string} [options.home] logical home path for the properties
 * @returns {Object} component with `purl` and `bom-ref`
 */
export function createJdkComponent(identity, options = {}) {
  const purlVersion = identity.build
    ? `${identity.version}+${identity.build}`
    : identity.version;
  const component = {
    type: "platform",
    name: "java",
    version: identity.version,
    cpe: jdkCpe(identity.vendor, identity.version),
    properties: jdkProperties(identity, options.home),
  };
  if (options.home || identity.home) {
    component.evidence = {
      occurrences: [{ location: options.home ?? identity.home }],
    };
  }
  return applyPurl(
    component,
    tryBuildPurl({
      type: "generic",
      name: identity.vendor.purlName,
      version: purlVersion,
    }),
    `jdk:${identity.vendor.key}:${purlVersion}`,
  );
}

/**
 * Whether a file name is a JDK's launcher.
 *
 * @param {string} fileName basename
 * @param {string} [platform] `win32` names `java.exe`
 * @returns {string|undefined} `java` for a launcher, undefined otherwise
 */
export function classifyJavaBinary(fileName, platform) {
  const expected = platform === "win32" ? "java.exe" : "java";
  return fileName === expected ? "java" : undefined;
}

/**
 * Start collecting the JDK components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], byRef: Map<string, Object>}}
 */
export function createJdkInventory() {
  return { runtimeComponents: [], dependencies: [], byRef: new Map() };
}

/**
 * Record a JDK in the inventory: one component per identity, with every
 * home it was found in as an occurrence and a `cdx:java:home` property.
 *
 * @param {Object} inventory accumulator from createJdkInventory
 * @param {Object} identity result of readJdkIdentity
 * @param {string} [home] logical path of the JDK home
 * @returns {Object} the component of the identity
 */
export function addJdkToInventory(inventory, identity, home) {
  const component = createJdkComponent(identity, { home });
  const ref = component["bom-ref"];
  const known = inventory.byRef.get(ref);
  if (known) {
    const location = home ?? identity.home;
    if (
      location &&
      !known.evidence.occurrences.some((o) => o.location === location)
    ) {
      known.evidence.occurrences.push({ location });
      known.properties.push({ name: "cdx:java:home", value: location });
    }
    return known;
  }
  inventory.byRef.set(ref, component);
  inventory.runtimeComponents.push(component);
  inventory.dependencies.push({ ref, dependsOn: [] });
  return component;
}

/**
 * Tag a java launcher file component with the JDK it belongs to and link it
 * to the JDK's component.
 *
 * @param {Object} inventory accumulator from createJdkInventory
 * @param {Object} component file component with a `properties` array
 * @param {Object} identity result of readJdkIdentity
 * @param {string} [home] logical path of the JDK home
 */
export function attachJdk(inventory, component, identity, home) {
  component.properties.push(
    { name: "cdx:java:version", value: identity.version },
    { name: "cdx:java:vendor", value: identity.vendor.label },
  );
  const jdk = addJdkToInventory(inventory, identity, home);
  if (component["bom-ref"]) {
    inventory.dependencies.push({
      ref: component["bom-ref"],
      dependsOn: [jdk["bom-ref"]],
    });
  }
}
