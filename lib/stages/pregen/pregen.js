import { readdirSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  DEBUG_MODE,
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
  recordObservedActivity,
} from "../../core/activity.js";
import {
  commandOutputText,
  isLedgerEnabled,
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
  recordLedgerEvent,
} from "../../core/buildLedger.js";
import { deferFailOnError } from "../../core/deferredExit.js";
import { hasAnyProjectType, isFeatureEnabled } from "../../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeSpawnSync,
  TIMEOUT_MS,
} from "../../core/fs.js";
import { isMac, isWin } from "../../core/paths.js";
import { isProjectToolingAllowed } from "../../core/projectTooling.js";
import {
  dosaiDotnetRequirement,
  dosaiDotnetRequirementAdvice,
  dosaiDotnetRequirementDetail,
  markDosaiLaunchFailureReported,
} from "../../inventory/dosai.js";
import {
  bundleInstallWithDocker,
  collectJavaInfo,
  collectRubyInfo,
  getOrInstallNvmTool,
  installRubyBundler,
  installRubyVersion,
  installSdkmanTool,
  isNvmAvailable,
  isRbenvAvailable,
  isSdkmanAvailable,
  isSdkmanToolAvailable,
  performBundleInstall,
  runSwiftCommand,
  SDKMAN_JAVA_TOOL_ALIASES,
} from "../../inventory/envcontext.js";
import {
  compareSdkmanVersions,
  DEFAULT_JAVA_MAJOR,
  detectProjectJavaMajor,
  determineRequiredJavaVersion,
  extractJavaMajor,
  minimumGradleVersionForJava,
  parseJvmToolProjectType,
  parseSdkmanrc,
  readGradleWrapperVersion,
  readMavenWrapperVersion,
  readSbtBuildPropertiesVersion,
  readToolVersionEnvHint,
  readToolVersionOverride,
  resolveGradleVersionForJava,
  resolvePartialVersion,
} from "../../inventory/jvmToolEnv.js";
import { resolvePluginBinary } from "../../inventory/plugins.js";
import {
  classifyProbeResult,
  describeSpawnRestriction,
  parseGemfileLockBundlerVersion,
  readDeclaredToolRequirements,
} from "../../inventory/toolRequirements.js";

/**
 * Method to prepare the build environment for BOM generation purposes.
 *
 * @param {String} filePath Path
 * @param {Object} options CLI options
 */
export function prepareEnv(filePath, options) {
  if (isSecureMode) {
    return;
  }
  if (filePath) {
    filePath = resolve(filePath);
  }
  // Runs before the project type check: a .NET tree is also found when cdxgen
  // detects the project types itself.
  if (!isDryRun) {
    prepareDotnetEnv(filePath, options);
  }
  if (!options.projectType) {
    return;
  }
  // The JVM preparation provisions the JDK ahead of the build tools, so an
  // alias it already installed must not be installed a second time here.
  // It runs under dry-run too, where it reports the toolchain it would set up
  // instead of setting it up.
  const jdkAliasHandled = prepareJvmBuildEnv(filePath, options);
  recordDeclaredToolRequirements(filePath);
  if (isDryRun) {
    return;
  }
  for (const pt of options.projectType) {
    if (SDKMAN_JAVA_TOOL_ALIASES[pt]) {
      if (pt !== jdkAliasHandled) {
        prepareSdkmanBuild(pt);
      }
      break;
    }
  }
  // Check the pre-requisites for various types
  preparePythonEnv(filePath, options);
  prepareNodeEnv(filePath, options);
  prepareSwiftEnv(filePath, options);
  prepareRubyEnv(filePath, options);
}

/**
 * Check that dosai, which deep runs use for .NET evidence, can start. The
 * dosai bundled with cdxgen-plugins-bin is framework-dependent, so it needs a
 * .NET runtime at least as new as the one it targets (.NET 11 from dosai
 * 5.0.0). Running it lets the .NET host apply its own version rules. Skipped
 * in the container images, which ship a dosai that works with their SDK, and
 * when DOSAI_CMD names another build, such as the self-contained -full one.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 */
export function prepareDotnetEnv(filePath, options) {
  if (
    !options.deep ||
    !filePath ||
    readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true" ||
    readEnvironmentVariable("DOSAI_CMD") ||
    !isDotnetInScope(filePath, options)
  ) {
    return;
  }
  const dosaiBin = resolvePluginBinary("dosai");
  if (!dosaiBin) {
    // A missing plugin is reported where dosai runs
    return;
  }
  const result = safeSpawnSync(dosaiBin, ["--version"], {
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
  });
  if (result?.status === 0 && !result.error) {
    return;
  }
  const output = commandOutputText(result) || "";
  const requirement = dosaiDotnetRequirement(output);
  const detail = requirement
    ? dosaiDotnetRequirementDetail(requirement)
    : "dosai could not start";
  console.log(
    `WARNING: ${detail}, so this deep run has no dosai evidence for .NET (call graph, reachability, crypto). ${dosaiDotnetRequirementAdvice(requirement)}`,
  );
  if (requirement) {
    markDosaiLaunchFailureReported(dosaiBin);
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
    ecosystem: "csharp",
    tool: "dosai",
    detail: `${detail}; .NET evidence from dosai is unavailable.`,
    impact: LEDGER_EVENT_IMPACTS.COMPONENTS,
  });
  deferFailOnError(options, {
    ecosystem: "csharp",
    tool: "dosai",
    detail,
    exitCode: typeof result?.status === "number" ? result.status : undefined,
    command: `${dosaiBin} --version`,
    outputExcerpt: output.trim() || undefined,
  });
}

/**
 * Whether the run covers .NET: a .NET project type, or, when cdxgen detects
 * the types itself, a .NET project or solution file in the tree.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 *
 * @returns {Boolean}
 */
function isDotnetInScope(filePath, options) {
  if (options.projectType?.length) {
    return hasAnyProjectType(["csharp"], options, false);
  }
  if (!hasAnyProjectType(["csharp"], options, true)) {
    return false;
  }
  return (
    getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}*.{csproj,vbproj,fsproj,sln,slnx}`,
      options,
    ).length > 0
  );
}

/**
 * Record the tool requirements the project declares through its well-known
 * tool pin files (`.tool-versions`, `.nvmrc`, `package.json`, `go.mod`, …),
 * one `tool.expected` event per requirement. Recording is the only purpose of
 * the file walk, so it is skipped entirely when the ledger is disabled.
 *
 * @param {String} filePath Project path
 */
function recordDeclaredToolRequirements(filePath) {
  if (!isLedgerEnabled() || !filePath) {
    return;
  }
  for (const requirement of readDeclaredToolRequirements(filePath)) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
      ecosystem: requirement.ecosystem,
      tool: requirement.tool,
      wanted: requirement.wanted,
      source: requirement.source,
      path: requirement.path,
    });
  }
  recordDeclaredJvmToolRequirements(filePath);
}

/**
 * Record the JVM tool versions a repository pins through its build tool
 * wrappers and `.sdkmanrc`.
 *
 * These readers live in `jvmToolEnv.js`, which imports the shared comparator
 * from `toolRequirements.js`; reading them here rather than inside
 * `readDeclaredToolRequirements` keeps that dependency one-directional.
 *
 * @param {String} filePath Project path
 * @returns {void}
 */
function recordDeclaredJvmToolRequirements(filePath) {
  const declarations = [
    ["gradle", readGradleWrapperVersion(filePath), "gradle-wrapper.properties"],
    ["maven", readMavenWrapperVersion(filePath), "maven-wrapper.properties"],
    [
      "sbt",
      readSbtBuildPropertiesVersion(filePath),
      "project/build.properties",
    ],
  ];
  const sdkmanPins = parseSdkmanrc(filePath) || {};
  for (const [tool, wanted] of Object.entries(sdkmanPins)) {
    declarations.push([tool, wanted, ".sdkmanrc"]);
  }
  for (const [tool, declared, source] of declarations) {
    // The wrapper readers return `{ version, distributionUrl }` while the sbt
    // and `.sdkmanrc` readers return the version directly.
    const wanted = typeof declared === "string" ? declared : declared?.version;
    if (!wanted) {
      continue;
    }
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
      ecosystem: "java",
      tool,
      wanted: `${wanted}`,
      source,
      path: join(filePath, source),
    });
  }
}

/**
 * Method to prepare sdkman build environment for BOM generation purposes.
 *
 * @param {String} projectType Project type
 */
export function prepareSdkmanBuild(projectType) {
  if (!isSdkmanAvailable()) {
    console.log(
      "Install sdkman by following the instructions at https://sdkman.io/install",
    );
    return;
  }
  const toolType = "java";
  return installSdkmanTool(toolType, projectType);
}

/**
 * Binary names used to probe and select each JVM build tool, keyed by sdkman
 * candidate name.
 *
 * @type {Object<string, Object<string, string>>}
 */
const JVM_TOOL_BINARIES = {
  maven: { env: "MVN_CMD", command: "mvn", windowsCommand: "mvn.cmd" },
  gradle: {
    env: "GRADLE_CMD",
    command: "gradle",
    windowsCommand: "gradle.bat",
  },
  sbt: { env: "SBT_CMD", command: "sbt", windowsCommand: "sbt.bat" },
  // No env entry: scala runs are driven through SCALA_HOME set by the installer.
  scala: { command: "scala", windowsCommand: "scala.bat" },
};

/**
 * Version prefix used to pick a default version when a tool is required but
 * nothing pins it. Maven is restricted to the 3.9 line because it keeps JDK
 * 8-25 compatibility; other tools take the newest stable release.
 *
 * @type {Object<string, string>}
 */
const JVM_TOOL_DEFAULT_PREFIXES = {
  maven: "3.9",
};

/** sdkman candidates cdxgen can provision for JVM builds. */
const JVM_BUILD_TOOLS = ["maven", "gradle", "sbt", "scala"];

/**
 * True while `CDXGEN_JVM_TOOL_PINNED` holds a value cdxgen set itself, which
 * makes it safe to clear on the next preparation run. Long-lived processes
 * such as the server prepare the environment once per request.
 */
let cdxgenOwnsPinnedToolEnv = false;

/**
 * Method to detect and provision JVM build tools (maven, gradle, sbt, scala)
 * plus a compatible JDK before BOM generation.
 *
 * Two styles are supported:
 * - Explicit: a versioned project type such as `-t maven3.9.9` installs that
 *   exact sdkman version and pins it for the generation step.
 * - Automatic: with the `jvm-tool-setup` feature flag, tool versions are
 *   derived from repo markers (`.sdkmanrc`, build tool wrappers,
 *   `project/build.properties`) and missing tools are provisioned. Projects
 *   pinning a tool through a wrapper are left alone because the wrapper
 *   provisions itself; only JDK compatibility is checked.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 *
 * @returns {String|undefined} The `javaNN` project type whose JDK this call
 *   already provisioned, so the caller can skip installing it again.
 */
export function prepareJvmBuildEnv(filePath, options) {
  // Each invocation re-derives the pin, so a signal left behind by an earlier
  // run must not leak into this one. A value the user set stays untouched.
  if (cdxgenOwnsPinnedToolEnv) {
    delete process.env.CDXGEN_JVM_TOOL_PINNED;
    cdxgenOwnsPinnedToolEnv = false;
  }
  const explicitPins = [];
  for (const pt of options.projectType || []) {
    const parsed = parseJvmToolProjectType(pt);
    if (!parsed) {
      continue;
    }
    if (!parsed.valid) {
      console.log(
        `Invalid version '${parsed.version}' in the project type '${pt}'. Pass an exact sdkman version identifier such as -t maven3.9.9, -t gradle8.14.3, -t sbt1.10.11, or -t scala3.6.4. Run 'sdk list maven' style commands to see the available identifiers.`,
      );
      continue;
    }
    explicitPins.push({
      tool: parsed.tool,
      version: parsed.version,
      source: "cli",
    });
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
      ecosystem: "java",
      tool: parsed.tool,
      wanted: parsed.version,
      source: "cli",
    });
  }
  const autoMode = isFeatureEnabled(options, "jvm-tool-setup");
  if (!explicitPins.length && !autoMode) {
    return;
  }
  if (isWin) {
    console.log(
      "Automatic JVM build tool provisioning requires sdkman, which is unavailable on Windows. Use the project's mvnw/gradlew wrappers or the cdxgen container image, which bundles maven, gradle, sbt, and scala.",
    );
    return;
  }
  const detected = autoMode
    ? detectJvmToolsFromRepo(filePath, explicitPins)
    : { installPins: [], wrapperVersions: [], javaVersionHint: undefined };
  const installPins = [...explicitPins, ...detected.installPins];
  if (!installPins.length && !detected.wrapperVersions.length) {
    return;
  }
  if (isDryRun) {
    // Versions are left unresolved: resolving them means asking sdkman over
    // the network, which dry-run does not do.
    recordJvmBuildEnvIntent(options, installPins, detected);
    return;
  }
  // Resolve partial versions (e.g. maven3.9 -> 3.9.16) before touching the JDK
  // so the compatibility matrix sees the real versions. The Gradle default
  // install is constrained by the JDK the project declared or asked for, so a
  // Java 27 project never gets a Gradle that cannot run on it.
  const explicitJavaType = (options.projectType || []).find((pt) =>
    Boolean(SDKMAN_JAVA_TOOL_ALIASES[pt]),
  );
  const explicitJavaMajor = explicitJavaType
    ? extractJavaMajor(SDKMAN_JAVA_TOOL_ALIASES[explicitJavaType])
    : undefined;
  const gradleJavaMajor =
    Math.max(detected.javaVersionHint || 0, explicitJavaMajor || 0) ||
    undefined;
  const resolvedPins = [];
  for (const pin of installPins) {
    const resolved = resolveJvmToolPinVersion(pin, gradleJavaMajor);
    if (resolved) {
      resolvedPins.push(resolved);
    }
  }
  // Install the JDK first: build tools and the generation step both need it.
  const knownToolVersions = [...resolvedPins, ...detected.wrapperVersions];
  const javaMajor = ensureCompatibleJdk(
    filePath,
    options,
    knownToolVersions,
    detected.javaVersionHint,
  );
  warnGradleJavaIncompatibility(knownToolVersions, javaMajor);
  let pinnedToolSelected = false;
  for (const pin of resolvedPins) {
    const installed = provisionJvmTool(pin, options);
    if (installed) {
      setJvmToolCommandEnv(pin);
      if (pin.source === "cli") {
        pinnedToolSelected = true;
      }
    }
  }
  // Signal the maven/gradle resolvers that an explicit CLI pin must beat the
  // project wrappers.
  if (pinnedToolSelected) {
    process.env.CDXGEN_JVM_TOOL_PINNED = "true";
    cdxgenOwnsPinnedToolEnv = true;
  }
  return (options.projectType || []).find((pt) =>
    Boolean(SDKMAN_JAVA_TOOL_ALIASES[pt]),
  );
}

/**
 * Human-readable explanation of where a tool version came from, used in the
 * dry-run report so the reader can trace every decision back to its input.
 *
 * @type {Object<string, string>}
 */
const JVM_PIN_SOURCE_REASONS = {
  cli: "pinned by the versioned project type on the command line",
  "env-override": "pinned by the tool's *_TOOL environment variable",
  sdkmanrc: "pinned by the project's .sdkmanrc",
  "env-hint": "taken from the tool's *_VERSION environment variable",
  default:
    "the default version, because the project uses the tool without a wrapper and no usable command was found",
  wrapper: "pinned by the project's build tool wrapper",
  "build-properties": "declared in the project's project/build.properties",
};

/**
 * Report the JVM toolchain that would be provisioned, without provisioning it.
 *
 * Dry-run exists so that the reader can see every side effect cdxgen would
 * cause before allowing it to run for real, and provisioning a toolchain is
 * the largest side effect this stage has: it downloads and installs software
 * and then rewrites the command environment used for the rest of the run.
 * Skipping the stage silently would hide exactly what dry-run is for, so each
 * install, each JDK decision, and each environment variable that would change
 * is recorded as a blocked activity instead.
 *
 * @param {Object} options CLI options
 * @param {Array} installPins Tools that would be installed
 * @param {Object} detected Repo detection result
 */
export function recordJvmBuildEnvIntent(options, installPins, detected) {
  const knownToolVersions = [...installPins, ...detected.wrapperVersions];
  for (const pin of installPins) {
    const version = pin.version || JVM_TOOL_DEFAULT_PREFIXES[pin.tool] || "";
    const versionLabel = pin.version
      ? pin.version
      : `${version ? `${version}.x` : "latest"} (resolved from sdkman at run time)`;
    recordObservedActivity("provision", `sdkman:${pin.tool}@${versionLabel}`, {
      metadata: {
        packageType: pin.tool,
        toolSource: pin.source,
      },
      reason: `Would install ${pin.tool} ${versionLabel} with sdkman: ${JVM_PIN_SOURCE_REASONS[pin.source] || pin.source}.`,
      status: "blocked",
      traceDetail: `${pin.tool}:${pin.source}`,
    });
    const commandEnv = JVM_TOOL_BINARIES[pin.tool]?.env;
    if (commandEnv) {
      recordObservedActivity("env", `process.env:${commandEnv}`, {
        metadata: { packageType: pin.tool },
        reason: `Would point ${commandEnv} at the provisioned ${pin.tool}.`,
        status: "blocked",
      });
    }
  }
  for (const pin of detected.wrapperVersions) {
    recordObservedActivity("discover", `${pin.tool}@${pin.version}`, {
      metadata: {
        packageType: pin.tool,
        toolSource: pin.source,
      },
      reason: `Detected ${pin.tool} ${pin.version} ${JVM_PIN_SOURCE_REASONS[pin.source] || pin.source}. Nothing would be installed because the project provisions it itself.`,
      traceDetail: `${pin.tool}:${pin.source}`,
    });
  }
  const targetMajor = determineTargetJavaMajor(
    knownToolVersions,
    detected.javaVersionHint,
  );
  const explicitJavaType = (options.projectType || []).find((pt) =>
    Boolean(SDKMAN_JAVA_TOOL_ALIASES[pt]),
  );
  if (explicitJavaType) {
    // An explicit javaNN type is always installed, so it is reported as one.
    recordObservedActivity(
      "provision",
      `sdkman:java@${SDKMAN_JAVA_TOOL_ALIASES[explicitJavaType]}`,
      {
        metadata: { packageType: "java" },
        reason: `Would install ${SDKMAN_JAVA_TOOL_ALIASES[explicitJavaType]} with sdkman: requested by the ${explicitJavaType} project type.`,
        status: "blocked",
        traceDetail: explicitJavaType,
      },
    );
  } else {
    // Otherwise the JDK is installed only when the active one is too old, and
    // the active version cannot be read without running java. Report the
    // requirement and the fallback rather than implying a certain install.
    const javaAlias = pickJavaAliasForMajor(targetMajor);
    recordObservedActivity("decision", `java>=${targetMajor}`, {
      metadata: { packageType: "java" },
      reason: javaAlias
        ? `The detected build tools need Java ${targetMajor} or higher. The active JDK would be checked first, and ${SDKMAN_JAVA_TOOL_ALIASES[javaAlias]} installed with sdkman only if it is older.`
        : `The detected build tools need Java ${targetMajor} or higher, which cdxgen cannot provision automatically.`,
      status: "blocked",
      traceDetail: `java:${targetMajor}`,
    });
  }
  if (installPins.some((pin) => pin.source === "cli")) {
    recordObservedActivity("env", "process.env:CDXGEN_JVM_TOOL_PINNED", {
      reason:
        "Would be set so the Maven and Gradle resolvers prefer the pinned command over the project's wrapper scripts.",
      status: "blocked",
    });
  }
}

/**
 * Highest JDK major the detected toolchain needs, falling back to the default
 * when nothing constrains it.
 *
 * @param {Array} knownToolVersions Tool versions that will run
 * @param {Number} javaVersionHint JDK major requested by the repo
 *
 * @returns {Number} JDK major to target.
 */
function determineTargetJavaMajor(knownToolVersions, javaVersionHint) {
  const neededJava = determineRequiredJavaVersion(knownToolVersions);
  return Math.max(javaVersionHint || 0, neededJava || 0) || DEFAULT_JAVA_MAJOR;
}

/**
 * Detect the JVM build tools a project needs from its own version pins, in
 * precedence order: MAVEN_TOOL style overrides, `.sdkmanrc`, container/CI
 * version hints, then build tool wrappers and repo markers. Wrapper-pinned
 * tools are returned as known versions without an install because the
 * wrapper downloads its own distribution.
 *
 * @param {String} filePath Project path
 * @param {Array} explicitPins Pins collected from versioned project types
 *
 * @returns {Object} `{ installPins, wrapperVersions, javaVersionHint }`
 */
export function detectJvmToolsFromRepo(filePath, explicitPins) {
  const installPins = [];
  const wrapperVersions = [];
  const explicitTools = new Set((explicitPins || []).map((p) => p.tool));
  const sdkmanrc = filePath ? parseSdkmanrc(filePath) : undefined;
  const gradleWrapper = filePath
    ? readGradleWrapperVersion(filePath)
    : undefined;
  const mavenWrapper = filePath ? readMavenWrapperVersion(filePath) : undefined;
  const sbtBuildVersion = filePath
    ? readSbtBuildPropertiesVersion(filePath)
    : undefined;
  for (const tool of JVM_BUILD_TOOLS) {
    if (explicitTools.has(tool)) {
      continue;
    }
    const override = readToolVersionOverride(tool);
    if (override) {
      if (DEBUG_MODE) {
        console.log(
          `Using ${tool} ${override} from the ${tool.toUpperCase()}_TOOL environment variable.`,
        );
      }
      installPins.push({ tool, version: override, source: "env-override" });
      continue;
    }
    if (sdkmanrc?.[tool]) {
      console.log(`Using ${tool} ${sdkmanrc[tool]} from the .sdkmanrc file.`);
      installPins.push({ tool, version: sdkmanrc[tool], source: "sdkmanrc" });
      continue;
    }
    const envHint = readToolVersionEnvHint(tool);
    if (envHint) {
      if (DEBUG_MODE) {
        console.log(
          `Using ${tool} ${envHint} from the ${tool.toUpperCase()}_VERSION environment variable.`,
        );
      }
      installPins.push({ tool, version: envHint, source: "env-hint" });
      continue;
    }
    // Wrapper-first: a project-pinned tool is never installed by cdxgen.
    if (tool === "gradle" && gradleWrapper) {
      if (DEBUG_MODE) {
        console.log(
          `Gradle ${gradleWrapper.version} is pinned by the project wrapper. The wrapper will provision it.`,
        );
      }
      wrapperVersions.push({
        tool,
        version: gradleWrapper.version,
        source: "wrapper",
      });
      continue;
    }
    if (tool === "maven" && mavenWrapper) {
      if (DEBUG_MODE) {
        console.log(
          `Maven ${mavenWrapper.version} is pinned by the project wrapper. The wrapper will provision it.`,
        );
      }
      wrapperVersions.push({
        tool,
        version: mavenWrapper.version,
        source: "wrapper",
      });
      continue;
    }
    if (tool === "sbt") {
      if (!filePath) {
        continue;
      }
      if (sbtBuildVersion) {
        if (DEBUG_MODE) {
          console.log(
            `sbt ${sbtBuildVersion} is declared in project/build.properties. The sbt launcher will provision it.`,
          );
        }
        wrapperVersions.push({
          tool,
          version: sbtBuildVersion,
          source: "build-properties",
        });
      }
      if (
        (sbtBuildVersion || safeExistsSync(join(filePath, "build.sbt"))) &&
        !isJvmToolUsable(tool)
      ) {
        installPins.push({ tool, version: undefined, source: "default" });
      }
      continue;
    }
    if (tool === "scala") {
      // scala has no reliable repo marker; it is only provisioned when
      // explicitly pinned via .sdkmanrc, env hints, or overrides.
      continue;
    }
    // maven and gradle fall back to a default install when the repo uses the
    // tool without a wrapper and no usable command exists.
    const toolMarkers =
      tool === "maven"
        ? ["pom.xml"]
        : [
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
          ];
    const markerFound = filePath
      ? toolMarkers.some((marker) => safeExistsSync(join(filePath, marker)))
      : false;
    if (markerFound && !isJvmToolUsable(tool)) {
      installPins.push({ tool, version: undefined, source: "default" });
    }
  }
  const javaVersionHint =
    (sdkmanrc?.java ? extractJavaMajor(sdkmanrc.java) : undefined) ??
    (filePath ? detectProjectJavaMajor(filePath) : undefined);
  recordDetectedJvmPins(installPins, wrapperVersions);
  return { installPins, wrapperVersions, javaVersionHint };
}

/**
 * Record one `tool.expected` event per JVM pin detected from the repo, with
 * the pin's declared version and the source that declared it.
 *
 * @param {Array} installPins Pins that cdxgen would install
 * @param {Array} wrapperVersions Versions the project provisions itself
 */
function recordDetectedJvmPins(installPins, wrapperVersions) {
  if (!isLedgerEnabled()) {
    return;
  }
  for (const pin of installPins) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
      ecosystem: "java",
      tool: pin.tool,
      wanted: pin.version,
      source: pin.source === "env-override" ? "override" : pin.source,
    });
  }
  for (const pin of wrapperVersions) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
      ecosystem: "java",
      tool: pin.tool,
      wanted: pin.version,
      source: pin.source,
    });
  }
}

/**
 * Resolve a tool pin to an exact, locally known version. Exact versions that
 * are already installed pass through untouched; otherwise the available
 * sdkman versions are consulted to resolve partial prefixes such as `3.9`
 * and to pick defaults.
 *
 * @param {Object} pin `{ tool, version?, source }`
 * @param {Number|undefined} javaMajor JDK major the project declared or
 *   configured, when known. Constrains the default Gradle install so a
 *   project on a new JDK never resolves a Gradle that cannot run on it.
 *
 * @returns {Object|undefined} Pin with an exact version, or undefined when no
 *   version could be determined.
 */
export function resolveJvmToolPinVersion(pin, javaMajor) {
  if (pin.version && isSdkmanToolAvailable(pin.tool, pin.version)) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
      ecosystem: "java",
      tool: pin.tool,
      wanted: pin.version,
      found: pin.version,
      source: "sdkman",
      detail: `${pin.tool} ${pin.version} is already installed.`,
    });
    return pin;
  }
  const versionList = fetchSdkmanVersionList(pin.tool);
  if (versionList === undefined) {
    // sdk list failed (offline or sdkman missing). Exact versions are still
    // worth attempting directly; defaults are not.
    if (pin.version) {
      return pin;
    }
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
      ecosystem: "java",
      tool: pin.tool,
      source: "sdkman",
      detail: `No installable ${pin.tool} version could be determined: 'sdk list ${pin.tool}' did not return any versions.`,
    });
    console.log(
      `Could not determine an installable version for ${pin.tool}: 'sdk list ${pin.tool}' did not return any versions.`,
    );
    return undefined;
  }
  const prefix = pin.version || JVM_TOOL_DEFAULT_PREFIXES[pin.tool] || "";
  const resolved =
    pin.tool === "gradle" && !pin.version
      ? resolveGradleVersionForJava(versionList, javaMajor)
      : resolvePartialVersion(versionList, prefix);
  if (!resolved) {
    if (pin.version) {
      return pin;
    }
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
      ecosystem: "java",
      tool: pin.tool,
      wanted: prefix,
      source: "sdkman",
      detail: `No stable ${pin.tool} version matched the default prefix '${prefix}'.`,
    });
    console.log(
      `No stable ${pin.tool} version matched the default prefix '${prefix}'. Pass an exact version identifier via -t ${pin.tool}<version>.`,
    );
    return undefined;
  }
  if (resolved !== pin.version) {
    console.log(
      `Resolved ${pin.tool} version '${pin.version || "default"}' to '${resolved}' from the available sdkman versions.`,
    );
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
    ecosystem: "java",
    tool: pin.tool,
    wanted: pin.version,
    found: resolved,
    source: "sdkman",
  });
  return { ...pin, version: resolved };
}

/**
 * Fetch the versions available for a candidate via `sdk list`.
 *
 * @param {String} tool sdkman candidate name
 *
 * @returns {String|undefined} Command output, or undefined on failure.
 */
export function fetchSdkmanVersionList(tool) {
  if (!isSdkmanAvailable()) {
    return undefined;
  }
  const result = safeSpawnSync(
    readEnvironmentVariable("SHELL") || "bash",
    ["-i", "-c", `sdk list ${tool}`],
    {
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return result.stdout ? result.stdout.toString() : "";
}

/**
 * Check whether a JVM build tool already has a usable command, honouring the
 * existing `MVN_CMD`/`GRADLE_CMD`/`SBT_CMD` overrides.
 *
 * The probe deliberately runs outside the scanned project. Build tool
 * launchers read JVM arguments from the working directory before doing
 * anything else - Maven from `.mvn/jvm.config` and sbt from `.jvmopts` or
 * `.sbtopts` - so a `--version` call inside a project would let that project
 * inject options such as `-javaagent` into the probe. Only the presence of a
 * working command is being established here, which the project cannot affect.
 *
 * @param {String} tool Tool name
 *
 * @returns {Boolean} True when the tool responds to `--version`.
 */
export function isJvmToolUsable(tool) {
  const toolBinary = JVM_TOOL_BINARIES[tool];
  if (!toolBinary) {
    return false;
  }
  // Honour explicit command overrides such as MVN_CMD/GRADLE_CMD/SBT_CMD.
  const binaryName = toolBinary[isWin ? "windowsCommand" : "command"];
  const overrideCommand = toolBinary.env
    ? readEnvironmentVariable(toolBinary.env)
    : undefined;
  const probeCommand = overrideCommand || binaryName;
  if (isDryRun) {
    // Executing the tool is blocked here, and a blocked probe would report
    // every tool as missing. Looking the binary up on PATH answers the same
    // question without running anything.
    const located = overrideCommand
      ? safeExistsSync(overrideCommand) && overrideCommand
      : locateToolBinaryOnPath(binaryName);
    recordObservedActivity("probe", probeCommand, {
      metadata: { packageType: tool, probeType: "build-tool-availability" },
      reason: located
        ? `Found ${tool} at ${located} on PATH without executing it.`
        : `No ${tool} command found on PATH. It was not executed.`,
      status: "blocked",
      traceDetail: tool,
    });
    if (located) {
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
        ecosystem: "java",
        tool,
        source: "PATH",
        path: located,
      });
    } else {
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
        ecosystem: "java",
        tool,
        source: "PATH",
        detail: `No ${tool} command was found on PATH.`,
      });
    }
    return Boolean(located);
  }
  const result = safeSpawnSync(probeCommand, ["--version"], {
    cdxgenActivity: {
      kind: "probe",
      metadata: { tool },
      probeType: "build-tool-availability",
    },
    cwd: getTmpDir(),
    encoding: "utf-8",
    shell: isWin,
    timeout: TIMEOUT_MS,
  });
  const usable = !result.error && result.status === 0;
  if (usable) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
      ecosystem: "java",
      tool,
      source: "PATH",
    });
  } else if (
    describeSpawnRestriction(probeCommand) ||
    classifyProbeResult(result) === "denied"
  ) {
    // A probe that could not run says nothing about the tool's presence.
    recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
      ecosystem: "java",
      tool,
      source: "PATH",
      detail: `The ${tool} availability probe could not run, so the tool's presence is unknown.`,
    });
  } else {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
      ecosystem: "java",
      tool,
      source: "PATH",
      detail: `No working ${tool} command answered the availability probe.`,
    });
  }
  return usable;
}

/**
 * Find an executable on PATH without running it.
 *
 * @param {String} binaryName Binary to look for
 *
 * @returns {String|undefined} Full path to the binary, when present.
 */
function locateToolBinaryOnPath(binaryName) {
  for (const pathEntry of (readEnvironmentVariable("PATH") || "").split(
    delimiter,
  )) {
    if (!pathEntry) {
      continue;
    }
    const candidate = join(pathEntry, binaryName);
    if (safeExistsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Ensure a JDK compatible with the pinned tools is active. Installs a JDK
 * only when the current java is missing or older than required; an explicit
 * `javaNN` project type is honoured as-is with a warning when it is too old.
 *
 * @param {String} filePath Project path
 * @param {Object} options CLI options
 * @param {Array} knownToolVersions Tool versions that will run
 * @param {Number} javaVersionHint JDK major requested by the repo
 *
 * @returns {Number|undefined} Effective JDK major after the check.
 */
export function ensureCompatibleJdk(
  filePath,
  options,
  knownToolVersions,
  javaVersionHint,
) {
  const neededJava = determineRequiredJavaVersion(knownToolVersions);
  const explicitJavaType = (options.projectType || []).find((pt) =>
    Boolean(SDKMAN_JAVA_TOOL_ALIASES[pt]),
  );
  if (explicitJavaType) {
    const aliasMajor = Number.parseInt(
      explicitJavaType.replace("java", ""),
      10,
    );
    if (neededJava && aliasMajor < neededJava) {
      console.log(
        `WARNING: the pinned JVM build tools require Java ${neededJava} or higher, but Java ${aliasMajor} was requested.`,
      );
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
        ecosystem: "java",
        tool: "java",
        wanted: `${neededJava}`,
        found: `${aliasMajor}`,
        source: "cli",
        detail: `The pinned JVM build tools require Java ${neededJava} or higher, but Java ${aliasMajor} was requested.`,
      });
    }
    // The javaNN alias install is idempotent; running it here keeps the JDK
    // ahead of the build tool installs.
    prepareSdkmanBuild(explicitJavaType);
    return Math.max(aliasMajor || 0, neededJava || 0);
  }
  const currentJava = collectJavaInfo(filePath || process.cwd());
  const currentMajor = currentJava?.version
    ? extractJavaMajor(currentJava.version)
    : undefined;
  const targetMajor = determineTargetJavaMajor(
    knownToolVersions,
    javaVersionHint,
  );
  if (currentMajor !== undefined && currentMajor >= targetMajor) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
      ecosystem: "java",
      tool: "java",
      wanted: `${targetMajor}`,
      found: `${currentMajor}`,
      source: "env",
      detail: `The active Java ${currentMajor} satisfies the Java ${targetMajor}+ requirement of the pinned build tools.`,
    });
    return currentMajor;
  }
  const javaAlias = pickJavaAliasForMajor(targetMajor);
  if (!javaAlias) {
    console.log(
      `WARNING: Java ${targetMajor} or higher is required to run the pinned JVM build tools, and it could not be provisioned automatically. Install a suitable JDK or pass a version type such as -t java${targetMajor}.`,
    );
    recordJvmRequirementShortfall(targetMajor, currentMajor);
    return currentMajor;
  }
  console.log(
    `The pinned JVM build tools need Java ${targetMajor} or higher.${currentMajor ? ` The current Java ${currentMajor} is older.` : ""} Installing ${SDKMAN_JAVA_TOOL_ALIASES[javaAlias]} with sdkman.`,
  );
  recordJvmRequirementShortfall(targetMajor, currentMajor);
  prepareSdkmanBuild(javaAlias);
  return targetMajor;
}

/**
 * Record the JDK shortfall the pinned build tools run into: a mismatch when a
 * live JDK was found and is too old, a missing tool when no JDK answered the
 * probe at all.
 *
 * @param {Number} targetMajor Required JDK major
 * @param {Number} currentMajor Active JDK major, when one was found
 */
function recordJvmRequirementShortfall(targetMajor, currentMajor) {
  if (currentMajor === undefined) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
      ecosystem: "java",
      tool: "java",
      wanted: `${targetMajor}`,
      source: "env",
      detail: `No active JDK answered the version probe, and the pinned build tools need Java ${targetMajor} or higher.`,
    });
    return;
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
    ecosystem: "java",
    tool: "java",
    wanted: `${targetMajor}`,
    found: `${currentMajor}`,
    source: "env",
    detail: `The pinned build tools need Java ${targetMajor} or higher; the active Java ${currentMajor} is older.`,
  });
}

/**
 * Pick the closest `javaNN` alias covering a required JDK major.
 *
 * @param {Number} major Required JDK major
 *
 * @returns {String|undefined} Alias such as `java17`.
 */
export function pickJavaAliasForMajor(major) {
  if (SDKMAN_JAVA_TOOL_ALIASES[`java${major}`]) {
    return `java${major}`;
  }
  const knownMajors = Object.keys(SDKMAN_JAVA_TOOL_ALIASES)
    .map((pt) => Number.parseInt(pt.replace("java", ""), 10))
    .filter((m) => !Number.isNaN(m) && m >= major)
    .sort((a, b) => a - b);
  return knownMajors.length ? `java${knownMajors[0]}` : undefined;
}

/**
 * Warn when the Gradle version in play cannot run on the effective JDK.
 *
 * @param {Array} knownToolVersions Tool versions that will run
 * @param {Number} javaMajor Effective JDK major
 */
export function warnGradleJavaIncompatibility(knownToolVersions, javaMajor) {
  const gradleVersion = (knownToolVersions || []).find(
    (pin) => pin.tool === "gradle",
  )?.version;
  if (!gradleVersion || !javaMajor) {
    return;
  }
  const minimumGradle = minimumGradleVersionForJava(javaMajor);
  if (
    minimumGradle &&
    compareSdkmanVersions(gradleVersion, minimumGradle) < 0
  ) {
    console.log(
      `WARNING: Gradle ${gradleVersion} cannot run on Java ${javaMajor}; Gradle ${minimumGradle} or higher is required. Pass a compatible JDK type such as -t java17, or update the project's Gradle wrapper.`,
    );
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
      ecosystem: "java",
      tool: "gradle",
      wanted: minimumGradle,
      found: gradleVersion,
      source: "env",
      detail: `Gradle ${gradleVersion} cannot run on Java ${javaMajor}; Gradle ${minimumGradle} or higher is required.`,
    });
  }
}

/**
 * Install a pinned tool unless it is already available, applying the failure
 * policy used by the ruby preparation: continue with whatever exists unless
 * both `deep` and `failOnError` are set.
 *
 * @param {Object} pin `{ tool, version, source }`
 * @param {Object} options CLI options
 *
 * @returns {Boolean} True when the exact version is active.
 */
export function provisionJvmTool(pin, options) {
  if (!isSdkmanAvailable()) {
    if (isJvmToolUsable(pin.tool)) {
      console.log(
        `sdkman is unavailable, but a working ${pin.tool} command exists on PATH. Continuing with it instead of ${pin.version || "the pinned version"}.`,
      );
      return false;
    }
    console.log(
      "Install sdkman by following the instructions at https://sdkman.io/install",
    );
    if (options.deep) {
      deferFailOnError(options, {
        ecosystem: "java",
        tool: pin.tool,
        detail:
          "sdkman is not installed, so the declared JVM tool pin could not be provisioned",
      });
    }
    return false;
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, {
    ecosystem: "java",
    tool: pin.tool,
    command: `sdk install ${pin.tool} ${pin.version}`,
    detail: `Installing ${pin.tool} ${pin.version} with sdkman.`,
  });
  if (!installSdkmanTool(pin.tool, pin.version)) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
      ecosystem: "java",
      tool: pin.tool,
      command: `sdk install ${pin.tool} ${pin.version}`,
      detail: `The sdkman install of ${pin.tool} ${pin.version} did not succeed.`,
    });
    if (options.deep) {
      deferFailOnError(options, {
        ecosystem: "java",
        tool: pin.tool,
        detail: `the sdkman install of ${pin.tool} ${pin.version} did not succeed`,
      });
    }
    return false;
  }
  return true;
}

/**
 * Point the tool command environment variables at the freshly provisioned
 * binary so the existing resolvers pick it up deterministically.
 *
 * @param {Object} pin `{ tool, version }`
 */
export function setJvmToolCommandEnv(pin) {
  const toolBinary = JVM_TOOL_BINARIES[pin.tool];
  if (!toolBinary?.env) {
    // scala is driven through SCALA_HOME, which the installer already set.
    return;
  }
  const toolHome = readEnvironmentVariable(`${pin.tool.toUpperCase()}_HOME`);
  if (!toolHome) {
    return;
  }
  const toolBin = join(
    toolHome,
    "bin",
    toolBinary[isWin ? "windowsCommand" : "command"],
  );
  if (safeExistsSync(toolBin)) {
    process.env[toolBinary.env] = toolBin;
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
      ecosystem: "java",
      tool: pin.tool,
      wanted: pin.version,
      found: pin.version,
      source: "sdkman",
      path: toolBin,
      detail: `The ${pin.tool} command environment now points at the provisioned ${pin.version}.`,
    });
  }
}

/**
 * Method to check and prepare the environment for python
 *
 * @param {String} _filePath Path
 * @param {Object} options CLI Options
 */
export function preparePythonEnv(_filePath, options) {
  if (hasAnyProjectType(["python"], options, false)) {
    if (
      isLedgerEnabled() &&
      !readEnvironmentVariable("VIRTUAL_ENV") &&
      !readEnvironmentVariable("CONDA_PREFIX")
    ) {
      recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
        ecosystem: "python",
        detail:
          "No active virtualenv or conda environment was detected; dependency resolution will use the system interpreter.",
        impact: LEDGER_EVENT_IMPACTS.COMPONENTS,
      });
    }
    if (
      DEBUG_MODE &&
      readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true" &&
      arch() !== "x64"
    ) {
      console.log(
        `INFO: Many pypi packages have limited support for ${arch()} architecture. Run the cdxgen container image with --platform=linux/amd64 for best experience.`,
      );
    }
    if (platform() === "win32") {
      console.log(
        "Install the appropriate compilers and build tools on Windows by following this documentation - https://wiki.python.org/moin/WindowsCompilers",
      );
    }
  }
  for (const pyversion of [
    "python36",
    "python38",
    "python39",
    "python310",
    "python311",
    "python312",
    "python313",
  ]) {
    if (
      options.projectType?.includes(pyversion) &&
      !readEnvironmentVariable("PIP_INSTALL_ARGS")
    ) {
      const tempDir = safeMkdtempSync(join(getTmpDir(), "cdxgen-pip-"));
      const py_version_number = pyversion.replace("python3", "3.");
      process.env.PIP_INSTALL_ARGS = `--python-version ${py_version_number} --ignore-requires-python --no-warn-conflicts --only-binary=:all:`;
      process.env.PIP_TARGET = tempDir;
      if (DEBUG_MODE) {
        console.log(
          "PIP_INSTALL_ARGS set to",
          readEnvironmentVariable("PIP_INSTALL_ARGS"),
        );
        console.log("PIP_TARGET set to", readEnvironmentVariable("PIP_TARGET"));
      }
      break;
    }
  }
}

/**
 * Method to check and prepare the environment for node
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareNodeEnv(filePath, options) {
  // check tool for windows
  let npmInstallAttempted = false;
  for (const pt of options.projectType) {
    const nodeVersion = pt.replace(/\D/g, "");
    if (
      pt.startsWith("node") &&
      nodeVersion &&
      !readEnvironmentVariable("NODE_INSTALL_ARGS")
    ) {
      if (!isNvmAvailable()) {
        if (readEnvironmentVariable("NVM_DIR")) {
          // for scenarios where nvm is not present, but
          // we have $NVM_DIR
          // custom logic to find nvmNodePath
          let nvmNodePath;
          const possibleNodeDir = join(
            readEnvironmentVariable("NVM_DIR"),
            "versions",
            "node",
          );

          if (!tryLoadNvmAndInstallTool(nodeVersion)) {
            console.log(
              `Could not install Nodejs${nodeVersion}. There is a problem with loading nvm from ${readEnvironmentVariable("NVM_DIR")}`,
            );
            return;
          }

          const nodeVersionArray = readdirSync(possibleNodeDir, {
            withFileTypes: true,
          });
          const nodeRe = new RegExp(`^v${nodeVersion}.`);
          for (const nodeVersionsIter of nodeVersionArray) {
            const fullPath = join(possibleNodeDir, nodeVersionsIter.name);
            if (
              nodeVersionsIter.isDirectory() &&
              nodeRe.test(nodeVersionsIter.name)
            ) {
              nvmNodePath = join(fullPath, "bin");
            }
          }
          if (nvmNodePath) {
            doNpmInstall(filePath, nvmNodePath, options);
            npmInstallAttempted = true;
          } else {
            console.log(
              `"node version ${nodeVersion} was not found. Please install it with 'nvm install ${nodeVersion}"`,
            );
            return;
          }
        } else {
          console.log(
            "Install nvm by following the instructions at https://github.com/nvm-sh/nvm",
          );
          return;
        }
      }
      // set path instead of nvm use
      const nvmNodePath = getOrInstallNvmTool(nodeVersion);
      if (!nvmNodePath) {
        console.log(
          `Unable to locate Nodejs ${nodeVersion} with nvm. Install it with 'nvm install ${nodeVersion}'.`,
        );
        continue;
      }
      doNpmInstall(filePath, nvmNodePath, options);
      npmInstallAttempted = true;
    }
  }
  recordNodeModulesEvidence(filePath, npmInstallAttempted);
}

/**
 * Record when the scanned project has no node_modules tree and no npm install
 * was attempted during preparation, since installed-package evidence will be
 * unavailable to the generation step.
 *
 * @param {String} filePath Project path
 * @param {Boolean} npmInstallAttempted Whether an npm install ran
 */
function recordNodeModulesEvidence(filePath, npmInstallAttempted) {
  if (!isLedgerEnabled() || !filePath || npmInstallAttempted) {
    return;
  }
  // Node preparation runs for every project type, so a missing node_modules
  // only says something about a project that declares npm dependencies at all.
  if (!safeExistsSync(join(filePath, "package.json"))) {
    return;
  }
  if (safeExistsSync(join(filePath, "node_modules"))) {
    return;
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
    ecosystem: "npm",
    remediationId: "js.no-node-modules",
    detail:
      "node_modules is absent and no npm install was attempted, so installed-package evidence will be unavailable.",
    impact: LEDGER_EVENT_IMPACTS.TRANSITIVE_DEPS,
  });
}

/**
 * If NVM_DIR is in path, however nvm command is not loaded.
 * it is possible that required nodeVersion is not installed.
 * This function loads nvm and install the nodeVersion
 *
 * @param {String} nodeVersion required version number
 *
 * @returns {Boolean} true if successful, otherwise false
 */
export function tryLoadNvmAndInstallTool(nodeVersion) {
  const NVM_DIR = readEnvironmentVariable("NVM_DIR");

  const command = `
      if [ -f ${NVM_DIR}/nvm.sh ]; then
        . ${NVM_DIR}/nvm.sh
        nvm install ${nodeVersion}
      else
        echo "NVM script not found at ${NVM_DIR}/nvm.sh"
        exit 1
      fi
      `;

  const result = safeSpawnSync(
    readEnvironmentVariable("SHELL") || "bash",
    ["-c", command],
    {
      encoding: "utf-8",
    },
  );

  return result.status === 0;
}

/**
 * This method installs and create package-lock.json
 *
 * @param {String} filePath Path
 * @param {String} nvmNodePath Path to node version in nvm
 * @param {Object} [options] CLI options
 */
export function doNpmInstall(filePath, nvmNodePath, options = {}) {
  // we do not install if INSTALL_ARGS set false
  if (["0", "false"].includes(readEnvironmentVariable("NODE_INSTALL_ARGS"))) {
    return;
  }
  // npm install runs the project's own lifecycle scripts, such as preinstall,
  // even with --package-lock-only.
  if (options.installDeps === false) {
    return;
  }
  const newPath = `${nvmNodePath}${delimiter}${readEnvironmentVariable("PATH")}`;
  let installArgs =
    readEnvironmentVariable("NPM_INSTALL_ARGS") || "--package-lock-only";
  const installCommand = "install";
  if (isSecureMode) {
    installArgs = `${installArgs} --ignore-scripts --no-audit`;
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, {
    ecosystem: "npm",
    tool: "npm",
    command: `npm ${installCommand} ${installArgs}`,
    path: filePath,
    detail: "Installing the project dependencies with npm.",
  });
  const resultNpmInstall = safeSpawnSync(
    readEnvironmentVariable("SHELL") || "bash",
    // The nvm node directory is already prepended to PATH below
    ["-i", "-c", `npm ${installCommand} ${installArgs}`],
    {
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      cwd: filePath,
      env: {
        ...process.env,
        PATH: newPath,
      },
    },
  );

  if (resultNpmInstall.status !== 0 || resultNpmInstall.error) {
    // There was some problem with NpmInstall
    recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
      ecosystem: "npm",
      tool: "npm",
      command: `npm ${installCommand} ${installArgs}`,
      path: filePath,
      exitCode:
        typeof resultNpmInstall.status === "number"
          ? resultNpmInstall.status
          : undefined,
      detail: "The npm install did not succeed.",
      outputExcerpt: commandOutputText(resultNpmInstall),
    });
    if (DEBUG_MODE) {
      if (resultNpmInstall.stdout) {
        console.log(resultNpmInstall.stdout);
      }
      if (resultNpmInstall.stderr) {
        console.log(resultNpmInstall.stderr);
      }
    }
  }
}

/**
 * Method to check and build the swift project
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareSwiftEnv(filePath, options) {
  if (!hasAnyProjectType(["swift"], options, false)) {
    return;
  }
  if (platform() === "win32") {
    console.log(
      "Ensure Swift for Windows is installed by following the instructions at https://www.swift.org/install/windows/",
    );
  }
  if (
    readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true" &&
    platform() === "linux" &&
    arch() !== "x64"
  ) {
    console.log(
      "INFO: Swift for Linux has known issues on non x64 machines. Run the cdxgen container image with --platform=linux/amd64 for best experience.",
    );
  }
  // `swift package resolve` runs the project's Package.swift, so it waits for
  // the same permission as the scan's other project tooling.
  if (
    (options.deep || options?.lifecycle?.includes("post-build")) &&
    isProjectToolingAllowed(options)
  ) {
    const swiftFiles = getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}Package*.swift`,
      options,
    );
    const pkgResolvedFiles = getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}Package.resolved`,
      options,
    );
    const outputFileMaps = getAllFiles(
      filePath,
      ".build/**/debug/**/output-file-map.json",
      options,
    );
    const fastlaneFiles = getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}Fastfile`,
      options,
    );
    if (
      (!pkgResolvedFiles.length || !outputFileMaps.length) &&
      swiftFiles.length
    ) {
      if (fastlaneFiles.length) {
        console.log(
          "For best results, build the project using the 'bundle exec fastlane' command prior to invoking cdxgen.",
        );
        console.log(
          "Look for any Makefile or CI workflow files to identify the full command along with the arguments to build this project.\nYou may also need access to keychain and private dependencies used.",
        );
        return;
      }
      for (const f of swiftFiles) {
        const basePath = dirname(f);
        console.log(
          "Attempting to generate the Package.resolved file",
          basePath,
        );
        const cmdOutput = runSwiftCommand(basePath, [
          "package",
          "-v",
          "resolve",
        ]);
        const resolvedFile = join(basePath, "Package.resolved");
        if (!cmdOutput) {
          console.log(
            "The Swift package command did not yield the expected result. Build this project manually before invoking cdxgen.",
          );
          recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
            ecosystem: "swift",
            tool: "swift",
            command: "swift package -v resolve",
            path: basePath,
            remediationId: "swift.package-command",
            detail:
              "The swift package resolve command did not produce a usable result.",
          });
          recordLedgerEvent(LEDGER_EVENT_KINDS.FALLBACK_ENGAGED, {
            ecosystem: "swift",
            tool: "swift",
            remediationId: "swift.package-command",
            impact: LEDGER_EVENT_IMPACTS.TRANSITIVE_DEPS,
            detail:
              "Swift dependencies will be read from the manifest alone because package resolution did not yield a Package.resolved file.",
          });
        }
        if (!safeExistsSync(resolvedFile)) {
          console.log(
            "Package.resolved file did not get generated successfully. Check the Package.swift file for declared dependencies.\nCheck if any private registry needs to be configured for the build to succeed.",
          );
        }
      }
    }
  }
}

/**
 * Method to check and prepare the environment for Ruby projects
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareRubyEnv(filePath, options) {
  // Skip preparation early
  if (
    !hasAnyProjectType(["ruby"], options, false) ||
    !options.installDeps ||
    options?.lifecycle?.includes("pre-build")
  ) {
    return;
  }
  const gemFiles = getAllFiles(
    filePath,
    `${options.multiProject ? "**/" : ""}Gemfile`,
    {
      ...options,
      exclude: (options.exclude || []).concat([
        "**/vendor/cache/**",
        "**/vendor/bundle/**",
      ]),
    },
  );
  if (!gemFiles.length) {
    return;
  }
  const gemLockFiles = getAllFiles(
    filePath,
    `${options.multiProject ? "**/" : ""}Gemfile*.lock`,
    {
      ...options,
      exclude: (options.exclude || []).concat([
        "**/vendor/cache/**",
        "**/vendor/bundle/**",
      ]),
    },
  );
  if (gemLockFiles.length && !options.deep) {
    return;
  }
  let rubyVersionNeeded;
  const rbenvPresent = isRbenvAvailable();
  const cdxgenGemHome =
    readEnvironmentVariable("CDXGEN_GEM_HOME") ||
    readEnvironmentVariable("BUNDLE_PATH") ||
    readEnvironmentVariable("GEM_HOME") ||
    safeMkdtempSync(join(getTmpDir(), "cdxgen-gem-home-"));
  process.env.CDXGEN_GEM_HOME = cdxgenGemHome;
  // Is there a .ruby-version file in the project?
  if (safeExistsSync(join(filePath, ".ruby-version"))) {
    rubyVersionNeeded = readFileSync(join(filePath, ".ruby-version"), {
      encoding: "utf-8",
    })
      .trim()
      .replace("ruby-", "");
    if (rubyVersionNeeded) {
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
        ecosystem: "ruby",
        tool: "ruby",
        wanted: rubyVersionNeeded,
        source: ".ruby-version",
        path: join(filePath, ".ruby-version"),
      });
    }
  } else if (safeExistsSync(join(filePath, "Gemfile.lock"))) {
    // Is there a lock file that can be used to identify the needed Ruby version?
    const gemlockData = readFileSync(join(filePath, "Gemfile.lock"), {
      encoding: "utf-8",
    });
    let rubyVersionMarker = false;
    for (let l of gemlockData.split("\n")) {
      l = l.replaceAll("\r", "").trim();
      if (l.includes("RUBY VERSION")) {
        rubyVersionMarker = true;
      }
      if (rubyVersionMarker && l.includes("ruby ")) {
        const possibleVersion = l
          .split("ruby ")
          .pop()
          .split("p")[0]
          .split("d")[0];
        if (/^\d+/.test(possibleVersion)) {
          rubyVersionNeeded = possibleVersion;
          break;
        }
      }
    }
    if (rubyVersionNeeded) {
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
        ecosystem: "ruby",
        tool: "ruby",
        wanted: rubyVersionNeeded,
        source: "Gemfile.lock",
      });
    }
    const bundlerVersion = parseGemfileLockBundlerVersion(gemlockData);
    if (bundlerVersion) {
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
        ecosystem: "ruby",
        tool: "bundler",
        wanted: bundlerVersion,
        source: "Gemfile.lock",
      });
    }
  } else {
    // Is the user invoking with a ruby with custom version type. Eg: -t ruby2.5.4
    let projectTypes = options.projectType;
    if (
      options.projectType &&
      (typeof options.projectType === "string" ||
        options.projectType instanceof String)
    ) {
      projectTypes = options.projectType.split(",");
    }
    for (const apt of projectTypes) {
      if (!apt.startsWith("ruby")) {
        continue;
      }
      const possibleVersion = apt.replace("ruby", "");
      if (/^\d+/.test(possibleVersion)) {
        rubyVersionNeeded = possibleVersion;
        break;
      }
    }
    if (rubyVersionNeeded) {
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_EXPECTED, {
        ecosystem: "ruby",
        tool: "ruby",
        wanted: rubyVersionNeeded,
        source: "project-type",
      });
    }
  }
  // Do we already have this version
  const existingRuby = collectRubyInfo(filePath);
  if (
    rubyVersionNeeded &&
    existingRuby?.version?.startsWith(`ruby ${rubyVersionNeeded} `)
  ) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
      ecosystem: "ruby",
      tool: "ruby",
      wanted: rubyVersionNeeded,
      found: existingRuby.version,
      source: "env",
      detail: `The active interpreter is the required Ruby ${rubyVersionNeeded}.`,
    });
    if (DEBUG_MODE) {
      console.log(`Required Ruby version ${rubyVersionNeeded} is present.`);
    }
    process.env.CDXGEN_RUBY_CMD = "ruby";
    process.env.CDXGEN_GEM_CMD = "gem";
    process.env.CDXGEN_BUNDLE_CMD = "bundle";
    rubyVersionNeeded = undefined;
    // Do we have a proper GEM_HOME already?
    if (cdxgenGemHome && safeExistsSync(cdxgenGemHome)) {
      const gemspecFiles = getAllFiles(
        cdxgenGemHome,
        "**/specifications/**/*.gemspec",
        options,
      );
      if (gemspecFiles.length > 3) {
        return;
      }
    }
  } else if (rubyVersionNeeded && !existingRuby?.version) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
      ecosystem: "ruby",
      tool: "ruby",
      wanted: rubyVersionNeeded,
      source: "env",
      detail: `No Ruby interpreter answered the version probe, and Ruby ${rubyVersionNeeded} is required.`,
    });
  } else if (
    rubyVersionNeeded &&
    !existingRuby.version.startsWith(`ruby ${rubyVersionNeeded} `)
  ) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
      ecosystem: "ruby",
      tool: "ruby",
      wanted: rubyVersionNeeded,
      found: existingRuby.version,
      source: "env",
      detail: `Ruby ${rubyVersionNeeded} is required and the active interpreter reports ${existingRuby.version}.`,
    });
  }
  if (rubyVersionNeeded && !rbenvPresent) {
    console.log(
      `This project requires Ruby ${rubyVersionNeeded}. cdxgen can automatically install the required version of Ruby with rbenv command.`,
    );
    if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
      console.log(
        "Try using the container image ghcr.io/cdxgen/cdxgen, which includes the rbenv command along with the dependencies such as ruby-build, rust, etc for successful compilation.",
      );
      if (isMac) {
        console.log(
          "Alternatively, install rbenv with homebrew `brew install rbenv`, followed by `rbenv init`",
        );
      }
    }
  }
  if (rubyVersionNeeded) {
    // Should we use docker
    if (isFeatureEnabled(options, "ruby-docker-install") || isWin) {
      for (const agemf of gemFiles) {
        bundleInstallWithDocker(
          rubyVersionNeeded,
          cdxgenGemHome,
          dirname(agemf),
        );
      }
      if (DEBUG_MODE) {
        const gemspecFiles = getAllFiles(
          cdxgenGemHome,
          `${options.multiProject ? "**/" : ""}*.gemspec`,
          options,
        );
        if (gemspecFiles.length > 3) {
          console.log(
            `GEM_HOME ${cdxgenGemHome} includes ${gemspecFiles.length} .gemspec files. Bundle install with docker was successful.`,
          );
        }
      }
      return;
    }
    if (isMac) {
      console.log(
        "Installing Ruby with rbenv on macOS could fail for a variety of reasons.",
      );
      console.log(
        `TIP: Use the custom container image "ghcr.io/cdxgen/cdxgen-debian-ruby34" with the argument "-t ruby${rubyVersionNeeded}".`,
      );
    }
    // Try rbenv install
    const { fullToolBinDir, status } = installRubyVersion(
      rubyVersionNeeded,
      filePath,
    );
    let bundleTool = "bundle";
    if (status) {
      if (fullToolBinDir) {
        if (
          !readEnvironmentVariable("PATH")?.includes(
            `versions/${rubyVersionNeeded}`,
          )
        ) {
          process.env.PATH = `${fullToolBinDir}${delimiter}${process.env.PATH}`;
        }
        process.env.CDXGEN_RUBY_CMD = join(fullToolBinDir, "ruby");
        process.env.CDXGEN_GEM_CMD = join(fullToolBinDir, "gem");
        process.env.CDXGEN_BUNDLE_CMD = join(fullToolBinDir, "bundle");
        bundleTool = join(fullToolBinDir, "bundle");
        process.env.CDXGEN_BUNDLE_CMD = bundleTool;
        if (!safeExistsSync(bundleTool)) {
          const bundlerStatus = installRubyBundler(
            rubyVersionNeeded,
            undefined,
          );
          if (!bundlerStatus && !readEnvironmentVariable("CDXGEN_DEBUG_MODE")) {
            console.log(
              "bundler didn't get installed successfully. Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
            );
          }
        }
      }
      // Do we have a proper GEM_HOME already?
      if (cdxgenGemHome && safeExistsSync(cdxgenGemHome)) {
        const gemspecFiles = getAllFiles(
          cdxgenGemHome,
          "**/specifications/**/*.gemspec",
          {
            ...options,
            exclude: (options.exclude || []).concat([
              "**/vendor/cache/**",
              "**/vendor/bundle/**",
            ]),
          },
        );
        if (gemspecFiles.length > 3) {
          if (DEBUG_MODE) {
            console.log(
              `GEM_HOME ${cdxgenGemHome} includes ${gemspecFiles.length} .gemspec files. Skipping bundle install.`,
            );
          }
          return;
        }
      }
      if (
        bundleTool &&
        (bundleTool === "bundle" || safeExistsSync(bundleTool))
      ) {
        if (DEBUG_MODE) {
          if (bundleTool === "bundle") {
            console.log("cdxgen will use the default bundle command.");
          } else {
            console.log(`bundle command is available at ${bundleTool}`);
          }
        }
        // Invoke bundle install
        for (const agemf of gemFiles) {
          performBundleInstall(
            cdxgenGemHome,
            rubyVersionNeeded,
            bundleTool,
            dirname(agemf),
          );
        }
      }
    } else {
      console.log(`Ruby install has failed for version ${rubyVersionNeeded}.`);
      if (options.deep) {
        deferFailOnError(options, {
          ecosystem: "ruby",
          tool: "ruby",
          detail: `the ruby ${rubyVersionNeeded} install failed`,
        });
      }
    }
  } else {
    // Just attempt bundle install
    console.log(
      "Attempting bundle install with the default Ruby installation.",
    );
    for (const agemf of gemFiles) {
      performBundleInstall(
        cdxgenGemHome,
        rubyVersionNeeded,
        "bundle",
        dirname(agemf),
      );
    }
  }
}
