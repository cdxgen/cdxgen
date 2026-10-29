import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import {
  compareSdkmanVersions,
  DEFAULT_JAVA_MAJOR,
  detectProjectJavaMajor,
  determineRequiredJavaVersion,
  extractJavaMajor,
  extractSdkListVersions,
  GRADLE_JAVA_CAPS,
  isPrereleaseVersion,
  isValidSdkmanVersion,
  minimumGradleVersionForJava,
  minimumJdkForToolVersion,
  parseJvmToolProjectType,
  parseSdkmanrc,
  readGradleWrapperVersion,
  readMavenWrapperVersion,
  readSbtBuildPropertiesVersion,
  resolveGradleVersionForJava,
  resolvePartialVersion,
} from "./jvmToolEnv.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "jvm-tools",
);

it("isValidSdkmanVersion accepts safe identifiers", () => {
  for (const version of [
    "3.9.9",
    "8.14",
    "1.10.11",
    "4.0.0-rc-5",
    "21.0.7-tem",
    "3.10.0-rc-1",
    "2.0.0-RC15",
    "9.1.0",
    "25-tem",
    "8.0.452-amzn",
    "8.0.504-amzn",
    "22.3.r17-grl",
    "21.0.12+1.1-tem",
    "26.0.2+1.1-tem",
    "8.0.504+1-tem",
  ]) {
    assert.ok(isValidSdkmanVersion(version), `${version} should be valid`);
  }
});

it("isValidSdkmanVersion matches in linear time on separator runs", () => {
  // Repeated separators once split ambiguously between the pattern's groups,
  // which made matching exponential in the number of repetitions.
  const started = process.hrtime.bigint();
  for (const repetitions of [16, 24, 32]) {
    assert.ok(!isValidSdkmanVersion(`0-${"..".repeat(repetitions)}!`));
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `took ${elapsedMs}ms, expected linear time`);
});

it("isValidSdkmanVersion rejects unsafe identifiers", () => {
  for (const version of [
    "",
    "x9",
    "9;rm -rf",
    "$(whoami)",
    "9.9\nrm",
    "9.9`id`",
    "9.9$(id)",
    "maven",
    "-9.9",
    ".9",
    "9..9",
    "9.9-",
    "9.9-rc.",
    "9.9+",
    "9.9+.1",
    `${"9".repeat(10)}.9.${"9".repeat(60)}`,
    undefined,
    null,
    123,
  ]) {
    assert.ok(!isValidSdkmanVersion(version), `${version} should be invalid`);
  }
});

it("parseJvmToolProjectType parses versioned tool types", () => {
  assert.deepStrictEqual(parseJvmToolProjectType("maven3.9.9"), {
    tool: "maven",
    version: "3.9.9",
    valid: true,
  });
  assert.deepStrictEqual(parseJvmToolProjectType("mvn3.9.9"), {
    tool: "maven",
    version: "3.9.9",
    valid: true,
  });
  assert.deepStrictEqual(parseJvmToolProjectType("gradle8.14"), {
    tool: "gradle",
    version: "8.14",
    valid: true,
  });
  assert.deepStrictEqual(parseJvmToolProjectType("sbt1.10"), {
    tool: "sbt",
    version: "1.10",
    valid: true,
  });
  assert.deepStrictEqual(parseJvmToolProjectType("scala3.6.4"), {
    tool: "scala",
    version: "3.6.4",
    valid: true,
  });
  assert.deepStrictEqual(parseJvmToolProjectType("maven4.0.0-rc-5"), {
    tool: "maven",
    version: "4.0.0-rc-5",
    valid: true,
  });
  assert.deepStrictEqual(parseJvmToolProjectType("GRADLE8.14"), {
    tool: "gradle",
    version: "8.14",
    valid: true,
  });
});

it("parseJvmToolProjectType rejects bare and unrelated types", () => {
  for (const projectType of [
    "maven",
    "mvn",
    "gradle",
    "sbt",
    "scala",
    "java17",
    "mavenxyz",
    "maven..",
    "js",
    "",
    undefined,
  ]) {
    assert.strictEqual(
      parseJvmToolProjectType(projectType),
      undefined,
      `${projectType} should not parse`,
    );
  }
});

it("parseJvmToolProjectType flags unsafe version tokens as invalid", () => {
  for (const projectType of [
    "maven3.9;rm -rf",
    "gradle8.$(id)",
    "sbt1;rm",
    "maven3.9\nrm",
  ]) {
    const parsed = parseJvmToolProjectType(projectType);
    assert.ok(parsed, `${projectType} should still parse structurally`);
    assert.strictEqual(parsed.valid, false);
  }
});

it("parseSdkmanrc reads pins from a full file", () => {
  assert.deepStrictEqual(parseSdkmanrc(join(fixturesDir, "sdkmanrc-full")), {
    java: "21.0.7-tem",
    maven: "3.9.16",
    gradle: "9.6.1",
    sbt: "1.10.11",
  });
});

it("parseSdkmanrc skips malformed lines and unknown candidates", () => {
  assert.deepStrictEqual(
    parseSdkmanrc(join(fixturesDir, "sdkmanrc-malformed")),
    { maven: "3.9.9", sbt: "1.10.11" },
  );
});

it("parseSdkmanrc returns undefined for missing files", () => {
  assert.strictEqual(
    parseSdkmanrc(join(fixturesDir, "does-not-exist")),
    undefined,
  );
  assert.strictEqual(
    parseSdkmanrc(join(fixturesDir, "maven-nowrapper")),
    undefined,
  );
});

it("readGradleWrapperVersion parses -bin and -all distributions", () => {
  assert.deepStrictEqual(
    readGradleWrapperVersion(join(fixturesDir, "gradle-wrapper-bin")),
    {
      version: "8.14.3",
      distributionUrl:
        "https://services.gradle.org/distributions/gradle-8.14.3-bin.zip",
    },
  );
  const allWrapper = readGradleWrapperVersion(
    join(fixturesDir, "gradle-wrapper-all"),
  );
  assert.strictEqual(allWrapper.version, "9.6.1");
  assert.strictEqual(
    allWrapper.distributionUrl,
    "https://services.gradle.org/distributions/gradle-9.6.1-all.zip",
  );
  assert.strictEqual(
    allWrapper.distributionSha256Sum,
    "bbaeb2fef8710818cf0e261201dab964c572f92b942812df0c3620d62a529a01",
  );
});

it("readGradleWrapperVersion drops a checksum that is not a hex digest", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "cdxgen-jvmwrapper-"));
  try {
    const wrapperDir = join(tmpBase, "gradle", "wrapper");
    mkdirSync(wrapperDir, { recursive: true });
    // The checksum is copied into the BOM as a CycloneDX hash, so hostile or
    // truncated values must not reach it.
    for (const hostileSum of [
      "$(id)`whoami`",
      "not-a-hash",
      "bbaeb2fe",
      `${"a".repeat(64)}z`,
    ]) {
      writeFileSync(
        join(wrapperDir, "gradle-wrapper.properties"),
        `distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.1-all.zip\ndistributionSha256Sum=${hostileSum}\n`,
      );
      const wrapperInfo = readGradleWrapperVersion(tmpBase);
      assert.strictEqual(wrapperInfo.version, "9.6.1");
      assert.strictEqual(
        wrapperInfo.distributionSha256Sum,
        undefined,
        `${hostileSum} should not be emitted as a hash`,
      );
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

it("readGradleWrapperVersion returns undefined without a wrapper", () => {
  assert.strictEqual(
    readGradleWrapperVersion(join(fixturesDir, "gradle-nowrapper")),
    undefined,
  );
  assert.strictEqual(
    readGradleWrapperVersion(join(fixturesDir, "does-not-exist")),
    undefined,
  );
});

it("readMavenWrapperVersion parses modern and legacy wrappers", () => {
  const wrapper = readMavenWrapperVersion(join(fixturesDir, "maven-wrapper"));
  assert.strictEqual(wrapper.version, "3.9.9");
  assert.strictEqual(
    wrapper.distributionUrl,
    "https://repo1.maven.org/maven2/org/apache/maven/apache-maven/3.9.9/binaries/apache-maven-3.9.9-bin.zip",
  );
  // Legacy wrappers without a distributionUrl are treated as unpinned.
  assert.strictEqual(
    readMavenWrapperVersion(join(fixturesDir, "maven-wrapper-legacy")),
    undefined,
  );
  assert.strictEqual(
    readMavenWrapperVersion(join(fixturesDir, "maven-nowrapper")),
    undefined,
  );
});

it("readSbtBuildPropertiesVersion reads project/build.properties", () => {
  assert.strictEqual(
    readSbtBuildPropertiesVersion(join(fixturesDir, "sbt-basic")),
    "1.10.11",
  );
  assert.strictEqual(
    readSbtBuildPropertiesVersion(join(fixturesDir, "maven-nowrapper")),
    undefined,
  );
});

it("minimumJdkForToolVersion follows the compatibility matrix", () => {
  assert.strictEqual(minimumJdkForToolVersion("maven", "3.9.9"), 8);
  assert.strictEqual(minimumJdkForToolVersion("maven", "4.0.0-rc-5"), 17);
  assert.strictEqual(minimumJdkForToolVersion("gradle", "8.14.3"), 8);
  assert.strictEqual(minimumJdkForToolVersion("gradle", "9.6.1"), 17);
  assert.strictEqual(minimumJdkForToolVersion("sbt", "1.10.11"), 8);
  assert.strictEqual(minimumJdkForToolVersion("sbt", "2.0.6"), 17);
  assert.strictEqual(minimumJdkForToolVersion("scala", "3.6.4"), 8);
  // Unknown tool versions fall back to the tool default.
  assert.strictEqual(minimumJdkForToolVersion("maven", "5.0.0"), 8);
  assert.strictEqual(minimumJdkForToolVersion("unknown", "1.0.0"), undefined);
});

it("determineRequiredJavaVersion returns the highest requirement", () => {
  assert.strictEqual(
    determineRequiredJavaVersion([
      { tool: "maven", version: "3.9.9" },
      { tool: "gradle", version: "8.14.3" },
    ]),
    8,
  );
  assert.strictEqual(
    determineRequiredJavaVersion([
      { tool: "maven", version: "3.9.9" },
      { tool: "gradle", version: "9.6.1" },
    ]),
    17,
  );
  assert.strictEqual(determineRequiredJavaVersion([]), undefined);
  assert.strictEqual(determineRequiredJavaVersion(undefined), undefined);
  assert.strictEqual(DEFAULT_JAVA_MAJOR, 21);
});

it("extractJavaMajor parses java version descriptions", () => {
  assert.strictEqual(extractJavaMajor("openjdk 21.0.11 2025-04-15"), 21);
  assert.strictEqual(extractJavaMajor("11.0.31"), 11);
  assert.strictEqual(extractJavaMajor('openjdk version "17.0.9"'), 17);
  // General availability releases print an undotted major.
  assert.strictEqual(extractJavaMajor("openjdk 25 2025-09-16"), 25);
  assert.strictEqual(extractJavaMajor("25 2025-09-16"), 25);
  // sdkman java identifiers, dotted and undotted.
  assert.strictEqual(extractJavaMajor("21.0.7-tem"), 21);
  assert.strictEqual(extractJavaMajor("25-tem"), 25);
  // Legacy identifiers name the major after the leading 1.
  assert.strictEqual(extractJavaMajor("1.8.0_452"), 8);
  assert.strictEqual(extractJavaMajor("no numbers here"), undefined);
  assert.strictEqual(extractJavaMajor(undefined), undefined);
});

it("gradle java caps expose the known combinations", () => {
  assert.strictEqual(minimumGradleVersionForJava(21), GRADLE_JAVA_CAPS[21]);
  assert.strictEqual(minimumGradleVersionForJava(25), "9.1.0");
  assert.strictEqual(minimumGradleVersionForJava(27), "9.8.0");
  assert.strictEqual(minimumGradleVersionForJava(11), undefined);
});

it("resolveGradleVersionForJava skips Gradle releases the JDK cannot run", () => {
  const gradleList = [
    "================================================================================",
    "Available Gradle Versions",
    "================================================================================",
    "     9.8.2               9.7.0               8.14.5              8.5             ",
    "     9.8.0-rc-1          9.7.0-rc-1          8.0                 7.3             ",
  ].join("\n");
  // Without a known JDK the default install keeps picking the newest stable.
  assert.strictEqual(
    resolveGradleVersionForJava(gradleList, undefined),
    "9.8.2",
  );
  // Java 21 needs Gradle 8.5+, so the newest stable satisfies it.
  assert.strictEqual(resolveGradleVersionForJava(gradleList, 21), "9.8.2");
  // Java 27 needs Gradle 9.8+: 9.7.0 is skipped and prereleases stay out.
  assert.strictEqual(resolveGradleVersionForJava(gradleList, 27), "9.8.2");
  // A stale sdkman that only advertises Gradle 8 has nothing to offer a
  // Java 27 project: no version is chosen over one that cannot run.
  assert.strictEqual(
    resolveGradleVersionForJava("     8.14.5    8.0", 27),
    undefined,
  );
});

it("isPrereleaseVersion detects rc and milestone suffixes", () => {
  assert.ok(isPrereleaseVersion("4.0.0-rc-5"));
  assert.ok(isPrereleaseVersion("4.0.0-rc-6"));
  assert.ok(isPrereleaseVersion("2.0.0-RC15"));
  assert.ok(isPrereleaseVersion("3.0.0-M1"));
  assert.ok(!isPrereleaseVersion("3.9.9"));
  assert.ok(!isPrereleaseVersion("21.0.7-tem"));
  // Vendor suffixes that merely start with the same letters stay stable.
  assert.ok(!isPrereleaseVersion("21.0.7-crac"));
  assert.ok(!isPrereleaseVersion("21.0.7-mandrel"));
  assert.ok(!isPrereleaseVersion(undefined));
});

it("compareSdkmanVersions orders versions numerically", () => {
  assert.ok(compareSdkmanVersions("3.9.16", "3.9.9") > 0);
  assert.ok(compareSdkmanVersions("3.9.9", "3.9.16") < 0);
  assert.ok(compareSdkmanVersions("3.10.0", "3.9.16") > 0);
  assert.ok(compareSdkmanVersions("8.14", "8.9") > 0);
  assert.ok(compareSdkmanVersions("9.1.0", "9.1.0") === 0);
  // stable beats prerelease at the same core version
  assert.ok(compareSdkmanVersions("3.10.0", "3.10.0-rc-1") > 0);
  // prerelease numbers compare numerically
  assert.ok(compareSdkmanVersions("4.0.0-rc-15", "4.0.0-rc-6") > 0);
});

it("extractSdkListVersions tokenizes sdk list output", () => {
  const mavenList = readFileSync(join(fixturesDir, "sdk-list-maven.txt"), {
    encoding: "utf-8",
  });
  const versions = extractSdkListVersions(mavenList);
  assert.ok(
    versions.length > 20,
    `expected many versions, got ${versions.length}`,
  );
  assert.ok(versions.includes("3.9.9"));
  assert.ok(versions.includes("3.9.16"));
  assert.ok(versions.includes("4.0.0-rc-5"));
  assert.ok(!versions.some((v) => v.includes("=") || v.includes("*")));
  assert.deepStrictEqual(extractSdkListVersions(undefined), []);
});

it("resolvePartialVersion picks the newest stable match", () => {
  const mavenList = readFileSync(join(fixturesDir, "sdk-list-maven.txt"), {
    encoding: "utf-8",
  });
  const gradleList = readFileSync(join(fixturesDir, "sdk-list-gradle.txt"), {
    encoding: "utf-8",
  });
  assert.strictEqual(resolvePartialVersion(mavenList, "3.9"), "3.9.16");
  assert.strictEqual(resolvePartialVersion(mavenList, "3.9.9"), "3.9.9");
  // A prerelease prefix allows prerelease matches.
  assert.strictEqual(
    resolvePartialVersion(mavenList, "4.0.0-rc"),
    "4.0.0-rc-6",
  );
  // Stable prefix never resolves to a prerelease.
  assert.strictEqual(resolvePartialVersion(mavenList, "3.10"), undefined);
  assert.strictEqual(resolvePartialVersion(gradleList, "8.14"), "8.14.5");
  assert.strictEqual(resolvePartialVersion(gradleList, ""), "9.7.0");
  assert.strictEqual(resolvePartialVersion("", "3.9"), undefined);
});

it("detectProjectJavaMajor reads compiler and toolchain declarations", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "cdxgen-jvmtoolenv-"));
  try {
    const gradleProject = join(tmpBase, "gradle");
    mkdirSync(gradleProject);
    writeFileSync(
      join(gradleProject, "build.gradle"),
      "java {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(17)\n  }\n}\n",
    );
    assert.strictEqual(detectProjectJavaMajor(gradleProject), 17);

    const mavenProject = join(tmpBase, "maven");
    mkdirSync(mavenProject);
    writeFileSync(
      join(mavenProject, "pom.xml"),
      "<properties><maven.compiler.release>11</maven.compiler.release></properties>",
    );
    assert.strictEqual(detectProjectJavaMajor(mavenProject), 11);

    const enforcerProject = join(tmpBase, "enforcer");
    mkdirSync(enforcerProject);
    writeFileSync(
      join(enforcerProject, "pom.xml"),
      "<requireJavaVersion><version>[1.8,)</version></requireJavaVersion>",
    );
    assert.strictEqual(detectProjectJavaMajor(enforcerProject), 8);

    // Dependency version ranges share the element name and must be ignored.
    const rangeProject = join(tmpBase, "ranges");
    mkdirSync(rangeProject);
    writeFileSync(
      join(rangeProject, "pom.xml"),
      "<dependency><groupId>junit</groupId><version>[4.13,5.0)</version></dependency>",
    );
    assert.strictEqual(detectProjectJavaMajor(rangeProject), undefined);

    const legacySourceProject = join(tmpBase, "legacy-source");
    mkdirSync(legacySourceProject);
    writeFileSync(
      join(legacySourceProject, "pom.xml"),
      "<properties><maven.compiler.source>1.8</maven.compiler.source></properties>",
    );
    assert.strictEqual(detectProjectJavaMajor(legacySourceProject), 8);

    assert.strictEqual(detectProjectJavaMajor(tmpBase), undefined);
    assert.strictEqual(detectProjectJavaMajor(undefined), undefined);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

it("re-exports the one shared comparator from toolRequirements", async () => {
  const toolRequirements = await import("./toolRequirements.js");
  assert.strictEqual(compareSdkmanVersions, toolRequirements.compareVersions);
  assert.strictEqual(isPrereleaseVersion, toolRequirements.isPrereleaseVersion);
  assert.strictEqual(extractJavaMajor, toolRequirements.extractJavaMajor);
});
