import { Buffer } from "node:buffer";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";
import { valid } from "semver";
import * as toml from "smol-toml";

import {
  DEBUG_MODE,
  readEnvironmentVariable,
  recordDecisionActivity,
} from "../core/activity.js";
import {
  commandOutputText,
  isLedgerEnabled,
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
  recordDegradation,
  recordLedgerEvent,
} from "../core/buildLedger.js";
import { getAllFiles, safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { isWin } from "../core/paths.js";
import { collectJarNS } from "../inventory/deps.js";
import { minimumGradleVersionForJava } from "../inventory/jvmToolEnv.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import { parsePkgJson } from "./parsers-js.js";

/**
 * True when the pre-generation stage pinned an exact JVM build tool version
 * from the CLI (e.g. `-t maven3.9.9`). Project wrappers must not override
 * such an explicit pin.
 */
function isJvmToolPinned() {
  return ["true", "1"].includes(
    readEnvironmentVariable("CDXGEN_JVM_TOOL_PINNED"),
  );
}

/**
 * Method to return the gradle command to use.
 *
 * Project-local wrapper scripts (`gradlew`) are attacker-controlled files in
 * the scanned project, so they are only used when dependency tooling is
 * allowed (`options.installDeps !== false`); otherwise the system Gradle is
 * used.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export function getGradleCommand(srcPath, rootPath, options = {}) {
  let gradleCmd = "gradle";
  const pinnedToolSelected = isJvmToolPinned();
  // Introspection mode exists to observe the project's own toolchain, so it
  // keeps using wrappers even when dependency installation is disabled.
  const allowProjectWrappers =
    options.installDeps !== false || options.introspect === true;

  let findGradleFile = "gradlew";
  if (platform() === "win32") {
    findGradleFile = "gradlew.bat";
  }

  if (
    allowProjectWrappers &&
    !pinnedToolSelected &&
    safeExistsSync(join(srcPath, findGradleFile))
  ) {
    // Use local gradle wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, findGradleFile), 0o775);
    } catch (_e) {
      // The wrapper stays un-chmod'ed; the spawn below still reports any
      // permission failure as a normal command failure.
    }
    gradleCmd = resolve(join(srcPath, findGradleFile));
    recordDecisionActivity(gradleCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: "project-wrapper",
        tool: "gradle",
      },
      reason: `Selected project-local Gradle wrapper ${gradleCmd}.`,
    });
  } else if (
    allowProjectWrappers &&
    !pinnedToolSelected &&
    rootPath &&
    safeExistsSync(join(rootPath, findGradleFile))
  ) {
    // Check if the root directory has a wrapper script
    try {
      chmodSync(join(rootPath, findGradleFile), 0o775);
    } catch (_e) {
      // The wrapper stays un-chmod'ed; the spawn below still reports any
      // permission failure as a normal command failure.
    }
    gradleCmd = resolve(join(rootPath, findGradleFile));
    recordDecisionActivity(gradleCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: "root-wrapper",
        tool: "gradle",
      },
      reason: `Selected root-level Gradle wrapper ${gradleCmd}.`,
    });
  } else if (readEnvironmentVariable("GRADLE_CMD")) {
    gradleCmd = readEnvironmentVariable("GRADLE_CMD");
    recordDecisionActivity(gradleCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: pinnedToolSelected ? "pinned-cli" : "GRADLE_CMD",
        tool: "gradle",
      },
      reason: pinnedToolSelected
        ? `Selected Gradle command ${gradleCmd} pinned via the CLI project type.`
        : `Selected Gradle command from GRADLE_CMD (${gradleCmd}).`,
    });
  } else if (readEnvironmentVariable("GRADLE_HOME")) {
    gradleCmd = join(readEnvironmentVariable("GRADLE_HOME"), "bin", "gradle");
    recordDecisionActivity(gradleCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: "GRADLE_HOME",
        tool: "gradle",
      },
      reason: `Selected Gradle command from GRADLE_HOME (${gradleCmd}).`,
    });
  } else {
    recordDecisionActivity(gradleCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: "PATH",
        tool: "gradle",
      },
      reason: "Falling back to Gradle from PATH.",
    });
    // A Gradle from PATH is a sound outcome whenever its version satisfies
    // the wrapper pin, so the fallback is recorded as costing nothing.
    recordLedgerEvent(LEDGER_EVENT_KINDS.FALLBACK_ENGAGED, {
      ecosystem: "java",
      tool: "gradle",
      source: "PATH",
      impact: LEDGER_EVENT_IMPACTS.NONE,
      detail:
        "No wrapper, GRADLE_CMD, or GRADLE_HOME was found; Gradle will run from PATH.",
    });
  }
  return gradleCmd;
}

/**
 * System properties that force the evaluation model cdxgen's Gradle
 * introspection depends on.
 *
 * The bundled init script registers `afterEvaluate` on every project and a
 * `taskGraph.whenReady` listener, so it cannot run under isolated projects
 * (which forbid reaching into another project's model and fail the build at
 * configuration time, see issue #4444) nor under the configuration cache (whose
 * reuse skips init scripts entirely, dropping the `<CDXGEN:repository>` and
 * `<CDXGEN:includedBuild>` markers even when the first run succeeded). Both
 * features are commonly enabled from `gradle.properties` (e.g. okhttp), which
 * command-line `-D` flags override, so every cdxgen invocation turns them
 * off: these are ephemeral introspection builds, not the user's build. The
 * isolated-projects property is spelled `org.gradle.unsafe.isolated-projects`
 * from Gradle 8.6 until Gradle 9.7 renamed it, so both spellings are forced
 * off to cover every Gradle in between. The configuration cache likewise
 * keeps its pre-8.1 `org.gradle.unsafe.configuration-cache` spelling.
 *
 * Each feature is handled as one group. Gradle disables a feature when any of
 * its spellings is explicitly `false`, so if the user already chose a value
 * via `GRADLE_ARGS`, either as a `-D` property under any spelling or as the
 * `--[no-]isolated-projects` / `--[no-]configuration-cache` option (which
 * beats `-D` properties), cdxgen adds no override for that feature at all.
 *
 * @param {string[]} gradleArguments User-supplied general gradle arguments.
 * @returns {string[]} The `-D` flags to inject before the user's arguments.
 */
function gradleEvaluationOverrides(gradleArguments) {
  const features = [
    {
      option: "isolated-projects",
      properties: [
        "org.gradle.isolated-projects",
        "org.gradle.unsafe.isolated-projects",
      ],
    },
    {
      option: "configuration-cache",
      properties: [
        "org.gradle.configuration-cache",
        "org.gradle.unsafe.configuration-cache",
      ],
    },
  ];
  const overrides = [];
  for (const { option, properties } of features) {
    const userChose = gradleArguments.some(
      (arg) =>
        arg === `--${option}` ||
        arg === `--no-${option}` ||
        properties.some((property) => arg.startsWith(`-D${property}=`)),
    );
    if (!userChose) {
      overrides.push(...properties.map((property) => `-D${property}=false`));
    }
  }
  return overrides;
}

/**
 * Method to combine the general gradle arguments, the sub-commands and the sub-commands' arguments in the correct way
 *
 * @param {string[]} gradleArguments The general gradle arguments, which must only be added once
 * @param {string[]} gradleSubCommands The sub-commands that are to be executed by gradle
 * @param {string[]} gradleSubCommandArguments The arguments specific to the sub-command(s), which much be added PER sub-command
 * @param {int} gradleCommandLength The length of the full gradle-command
 *
 * @returns {string[]} Array of arrays of arguments to be added to the gradle command
 */
export function buildGradleCommandArguments(
  gradleArguments,
  gradleSubCommands,
  gradleSubCommandArguments,
  gradleCommandLength,
) {
  const mainGradleArguments = [
    "--build-cache",
    "--console",
    "plain",
    "--no-parallel",
  ]
    .concat(getGradleDaemonParameter())
    .concat(gradleEvaluationOverrides(gradleArguments))
    .concat(gradleArguments);
  const maxCliArgsLength = isWin
    ? 7500 - gradleCommandLength - mainGradleArguments.join(" ").length - 2
    : -1;
  if (DEBUG_MODE && maxCliArgsLength !== -1) {
    console.log(
      "Running on Windows with a very long command -- splitting into multiple commands",
    );
  }
  const splitArgs = [];
  let allGradleArguments = [].concat(mainGradleArguments);
  let remainingLength = maxCliArgsLength;
  for (const gradleSubCommand of gradleSubCommands) {
    const subCommandLength =
      [gradleSubCommand, ...gradleSubCommandArguments].join(" ").length + 1;
    if (maxCliArgsLength !== -1 && remainingLength - subCommandLength < 0) {
      splitArgs.push(allGradleArguments);
      allGradleArguments = [].concat(mainGradleArguments);
      remainingLength = maxCliArgsLength;
    }
    allGradleArguments.push(gradleSubCommand);
    allGradleArguments = allGradleArguments.concat(gradleSubCommandArguments);
    remainingLength -= subCommandLength;
  }
  if (allGradleArguments.length !== mainGradleArguments.length) {
    splitArgs.push(allGradleArguments);
  }
  return splitArgs;
}

function getGradleDaemonParameter() {
  switch (readEnvironmentVariable("GRADLE_USE_DAEMON")) {
    case "default":
      return [];
    case "false":
    case "1":
      return ["--no-daemon"];
    default:
      return ["--daemon"];
  }
}

/**
 * Parse a Gradle task header line such as `> Task :app:dependencies FAILED`
 * into the path of the project that owns the task and the task's name.
 *
 * @param {string} line A line of Gradle output
 * @returns {{projectPath: string, taskName: string}|undefined} The owning
 *   project's path (`""` for a root task such as `:dependencies`) and the task
 *   name, or undefined when the line is not a task header
 */
function parseGradleTaskHeader(line) {
  if (!line.startsWith("> Task :")) {
    return undefined;
  }
  // The path is the first token: a status such as UP-TO-DATE or FAILED may
  // follow it, and a CRLF line keeps its carriage return.
  const taskPath = line.slice("> Task ".length).trim().split(/\s+/)[0];
  const lastColon = taskPath.lastIndexOf(":");
  return {
    projectPath: taskPath.slice(0, lastColon),
    taskName: taskPath.slice(lastColon + 1),
  };
}

/**
 * Method to split the output produced by Gradle using parallel processing by project
 *
 * Gradle groups console output by task and prints a `> Task :path` header
 * before each group, repeating it whenever a task's output resumes after
 * another task's. Each group is therefore keyed by the project in its own
 * header (`> Task :app:dependencies` belongs to `:app`), never by whatever
 * report header happened to precede it, and the groups of one project are
 * concatenated in order, so reordering or interrupting the task reports cannot
 * move a report to another project or overwrite one (issue 4465). The groups
 * of a root task (`:dependencies`) all take the root project's name from the
 * `Root project '…'` header that only a root task prints, so a continuation
 * group, which carries no report header, stays with the rest of the root
 * report. The groups of other tasks are dropped along with their headers.
 *
 * @param {string} rawOutput Full output produced by Gradle using parallel processing
 * @param {string[]} relevantTasks The list of gradle tasks whose output need to be considered.
 * @returns {map} Map with subProject names as keys and corresponding dependency task outputs as values.
 */
export function splitOutputByGradleProjects(rawOutput, relevantTasks) {
  const outputSplitBySubprojects = new Map();
  const relevantTaskNames = new Set(relevantTasks);
  const taskChunks = [];
  // Lines before the first task header (build logs) belong to no task.
  let currentChunk;
  for (const line of rawOutput.split("\n")) {
    const taskHeader = parseGradleTaskHeader(line);
    if (taskHeader) {
      currentChunk = relevantTaskNames.has(taskHeader.taskName)
        ? { projectPath: taskHeader.projectPath, lines: [line] }
        : undefined;
      if (currentChunk) {
        taskChunks.push(currentChunk);
      }
    } else if (currentChunk) {
      currentChunk.lines.push(line);
    }
  }
  let rootProjectName;
  for (const chunk of taskChunks) {
    if (chunk.projectPath) {
      continue;
    }
    const rootHeader = chunk.lines.find((line) =>
      line.startsWith("Root project '"),
    );
    if (rootHeader) {
      rootProjectName = rootHeader.split("'")[1];
      break;
    }
  }
  for (const chunk of taskChunks) {
    const projectName = chunk.projectPath || rootProjectName || "root";
    outputSplitBySubprojects.set(
      projectName,
      `${outputSplitBySubprojects.get(projectName) || ""}${chunk.lines.join("\n")}\n`,
    );
  }
  return outputSplitBySubprojects;
}

/**
 * Parse gradle projects output
 *
 * @param {string} rawOutput Raw string output
 */
export function parseGradleProjects(rawOutput) {
  let rootProject = "root";
  const projects = new Set();
  if (typeof rawOutput === "string") {
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replaceAll("\r", "");
      if (l.startsWith("Root project ")) {
        rootProject = l
          .split("Root project ")[1]
          .split(" ")[0]
          .replace(/'/g, "");
      } else if (l.includes("--- Project")) {
        const tmpB = l.split("Project ");
        if (tmpB && tmpB.length > 1) {
          const projName = tmpB[1].split(" ")[0].replace(/'/g, "");
          // Include all projects including test projects
          if (projName.startsWith(":")) {
            // Handle the case where the project name could have a space. Eg: +--- project :app (*)
            const tmpName = projName.split(" ")[0];
            if (tmpName.length > 1) {
              projects.add(tmpName);
            }
          }
        }
      } else if (l.includes("--- project ")) {
        const tmpB = l.split("--- project ");
        if (tmpB && tmpB.length > 1) {
          const projName = tmpB[1];
          if (projName.startsWith(":")) {
            const tmpName = projName.split(" ")[0];
            if (tmpName.length > 1) {
              projects.add(tmpName);
            }
          }
        }
      } else if (l.includes("-> project ")) {
        const tmpB = l.split("-> project ");
        if (tmpB && tmpB.length > 1) {
          const projName = tmpB[1];
          if (projName.startsWith(":")) {
            const tmpName = projName.split(" ")[0];
            if (tmpName.length > 1) {
              projects.add(tmpName);
            }
          }
        }
      }
    });
  }
  return {
    rootProject,
    projects: Array.from(projects),
  };
}

/**
 * Parse gradle properties output
 *
 * @param {string} rawOutput Raw string output
 * @param {string} gradleModuleName The name (or 'path') of the module as seen from the root of the project
 */
export function parseGradleProperties(rawOutput, gradleModuleName = null) {
  let rootProject = "root";
  const projects = new Set();
  const metadata = { group: "", version: "latest", properties: [] };
  if (gradleModuleName) {
    metadata.properties.push({
      name: "internal:GradleModule",
      value: gradleModuleName,
    });
  }
  if (typeof rawOutput === "string") {
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replaceAll("\r", "");
      if (
        !gradleModuleName &&
        (l.startsWith("Root project '") || l.startsWith("Project '"))
      ) {
        metadata.properties.push({
          name: "internal:GradleModule",
          value: l.split("'")[1],
        });
        return;
      }
      if (l.startsWith("----") || l.startsWith(">") || !l.includes(": ")) {
        return;
      }
      const tmpB = l.split(": ");
      if (tmpB && tmpB.length === 2) {
        if (tmpB[0] === "name") {
          rootProject = tmpB[1].trim();
        } else if (tmpB[0] === "group") {
          metadata[tmpB[0]] = tmpB[1];
        } else if (tmpB[0] === "version") {
          metadata[tmpB[0]] = tmpB[1].trim().replace("unspecified", "latest");
        } else if (["buildFile", "projectDir", "rootDir"].includes(tmpB[0])) {
          metadata.properties.push({ name: tmpB[0], value: tmpB[1].trim() });
        } else if (tmpB[0] === "subprojects") {
          const spStrs = tmpB[1].replace(/[[\]']/g, "").split(", ");
          const tmpprojects = spStrs
            .flatMap((s) => s.replace("project ", ""))
            .filter((s) => ![""].includes(s.trim()));
          tmpprojects.forEach(projects.add, projects);
        }
      }
    });
  }
  return {
    rootProject,
    projects: Array.from(projects),
    metadata,
  };
}

/**
 * Execute gradle properties command using multi-threading and return parsed output
 *
 * @param {string} dir Directory to execute the command
 * @param {array} allProjectsStr List of all sub-projects (including the preceding `:`)
 * @param {array} extraArgs List of extra arguments to use when calling gradle
 *
 * @returns {string} The combined output for all subprojects of the Gradle properties task
 */
export function executeParallelGradleProperties(
  dir,
  allProjectsStr,
  extraArgs = [],
  options = {},
) {
  const gradleCmd = getGradleCommand(dir, null, options);
  const gradleArgs = buildGradleCommandArguments(
    extraArgs.concat(
      readEnvironmentVariable("GRADLE_ARGS")
        ? readEnvironmentVariable("GRADLE_ARGS").split(" ")
        : [],
    ),
    allProjectsStr.map((project) =>
      project ? `${project}:properties` : "properties",
    ),
    readEnvironmentVariable("GRADLE_ARGS_PROPERTIES")
      ? readEnvironmentVariable("GRADLE_ARGS_PROPERTIES").split(" ")
      : [],
    gradleCmd.length,
  );
  const allOutputs = [];
  for (const gradleArg of gradleArgs) {
    if (DEBUG_MODE) {
      console.log(
        `Executing ${gradleCmd} with arguments ${gradleArg.join(" ").substring(0, 150)}... in ${dir}`,
      );
    }
    const result = safeSpawnSync(gradleCmd, gradleArg, {
      cwd: dir,
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      recordGradleInvocationFailure(result, {
        command: `${basename(gradleCmd)} ${gradleArg.join(" ")}`,
      });
      if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
        thoughtLog(
          "Gradle build has failed. Perhaps the user is using the wrong container image?",
        );
      } else {
        thoughtLog(
          "Gradle build has failed. I recommend using Java container images.",
        );
      }
      if (result.stderr) {
        console.group("*** GRADLE BUILD ERRORS ***");
        console.error(result.stdout, result.stderr);
        console.groupEnd();
        console.log(
          "1. Check if the correct version of java and gradle are installed and available in PATH. For example, some project might require Java 11 with gradle 7.\n cdxgen container image bundles Java 23 with gradle 8 which might be incompatible.",
        );
        console.log(
          "2. Try running cdxgen with the custom JDK11-based image `ghcr.io/cdxgen/cdxgen-java11:v13`.",
        );
        if (result.stderr?.includes("not get unknown property")) {
          console.log(
            "3. Check if the SBOM is generated for the correct root project for your application.",
          );
        } else if (
          result.stderr?.includes(
            "In version catalog libs, import of external catalog file failed",
          )
        ) {
          console.log(
            "3. Catalog file is required for gradle dependency resolution to succeed.",
          );
        } else if (result.stderr?.includes("Unrecognized option")) {
          console.log(
            "3. Try removing the unrecognized options to improve compatibility with a range of Java versions. Refer to the error message above.",
          );
        }
        if (result.stderr.includes("does not exist")) {
          return "";
        }
      }
    }
    if (result.stdout !== null) {
      allOutputs.push(result.stdout);
    }
  }
  const stdout = allOutputs.join("\n");
  if (stdout) {
    return Buffer.from(stdout).toString();
  }
  return "";
}

/** First class-file major a JDK maps from: class file 52 is Java 8. */
const CLASS_FILE_MAJOR_OFFSET = 44;

/**
 * Causes already reported this run, so a properties invocation and a
 * dependencies invocation failing for the same reason record the diagnosis
 * once.
 *
 * @type {Set<string>}
 */
const reportedGradleFailureCauses = new Set();

/** Whether an invocation failure was recorded this run. */
let gradleInvocationFailed = false;

/**
 * Forget the causes diagnosed so far, so a process that generates more than
 * one BOM diagnoses each run on its own.
 *
 * @returns {void}
 */
export function resetGradleFailureCauses() {
  reportedGradleFailureCauses.clear();
  gradleInvocationFailed = false;
}

/**
 * Whether a gradle invocation has already failed outright this run, so a
 * caller can skip reporting a consequence of that failure as its own
 * degradation.
 *
 * @returns {boolean} True once an invocation failure has been recorded.
 */
export function hasGradleInvocationFailure() {
  return gradleInvocationFailed;
}

/**
 * Extract the Java major from an `Unsupported class file major version N`
 * message: the class file the running JVM refused, which names the JDK that
 * is too new for this Gradle.
 *
 * @param {string} text Combined gradle output.
 * @returns {number|undefined} The refused Java major, when named.
 */
function refusedJavaMajorFromMessage(text) {
  const marker = "Unsupported class file major version ";
  const start = text.indexOf(marker);
  if (start === -1) {
    return undefined;
  }
  const digits = text
    .slice(start + marker.length)
    .split(/\s|\.|,|\r|\n/)[0]
    .trim();
  const major = Number.parseInt(digits, 10);
  return Number.isNaN(major) ? undefined : major - CLASS_FILE_MAJOR_OFFSET;
}

/**
 * Extract the Java pair the modern launcher refusal names: the JVM major
 * Gradle demands and, when the message says so, the one the build is
 * configured to use. Anything the message does not clearly name stays
 * undefined — the demanded major is substituted into an install command, so
 * it must be a bare Java major and nothing else.
 *
 * @param {string} text Combined gradle output.
 * @returns {{wanted: number, found: number|undefined}|undefined} The required and running Java majors, when the refusal names them.
 */
function javaPairFromLauncherDemand(text) {
  const demandMarker = "Gradle requires JVM ";
  const demandStart = text.indexOf(demandMarker);
  if (demandStart === -1) {
    return undefined;
  }
  const wantedDigits = text
    .slice(demandStart + demandMarker.length)
    .split(/\s|\.|,|\r|\n/)[0]
    .trim();
  const wanted = Number.parseInt(wantedDigits, 10);
  if (Number.isNaN(wanted)) {
    return undefined;
  }
  const foundMarker = "configured to use JVM ";
  const foundStart = text.indexOf(foundMarker);
  let found;
  if (foundStart !== -1) {
    const foundDigits = text
      .slice(foundStart + foundMarker.length)
      .split(/\s|\.|,|\r|\n/)[0]
      .trim();
    const parsed = Number.parseInt(foundDigits, 10);
    if (!Number.isNaN(parsed)) {
      found = parsed;
    }
  }
  return { wanted, found };
}

/**
 * Extract the Java pair an `UnsupportedClassVersionError` names: the class
 * file version that was compiled for a newer JDK and the version the running
 * JDK recognises, so the event can say "needs Java A, found Java B".
 *
 * @param {string} text Combined gradle output.
 * @returns {{wanted: number, found: number}|undefined} The required and running Java majors.
 */
function javaPairFromClassVersionError(text) {
  if (!text.includes("UnsupportedClassVersionError")) {
    return undefined;
  }
  const compiledMarker = "class file version ";
  const compiledStart = text.indexOf(compiledMarker);
  const limitMarker = "recognizes class file versions up to ";
  const limitStart = text.indexOf(limitMarker);
  if (compiledStart === -1 || limitStart === -1) {
    return { wanted: Number.NaN, found: Number.NaN };
  }
  const wanted = Number.parseInt(
    text.slice(compiledStart + compiledMarker.length).trim(),
    10,
  );
  const found = Number.parseInt(
    text.slice(limitStart + limitMarker.length).trim(),
    10,
  );
  return {
    wanted: wanted - CLASS_FILE_MAJOR_OFFSET,
    found: found - CLASS_FILE_MAJOR_OFFSET,
  };
}

/**
 * Record why a gradle invocation failed. Every failure also records the
 * `jvm.gradle.invocation-failed` degradation so the reflection can rank the
 * repair; version-incompatibility causes additionally record a
 * `tool.mismatch` event naming the versions, which is the fact the report
 * cannot derive from an empty BOM alone. Diagnosis events are recorded once
 * per cause per run; the degradation dedupes in the reflection by id.
 *
 * @param {Object} result The spawnSync result of the failed invocation.
 * @param {Object} context Call-site facts.
 * @param {string} [context.command] The redacted command that was attempted.
 * @param {string} [context.gradleVersion] The gradle version in play, when the caller knows it.
 * @returns {void}
 */
export function recordGradleInvocationFailure(result, context = {}) {
  if (!isLedgerEnabled()) {
    return;
  }
  if (!result || (result.status === 0 && !result.error)) {
    return;
  }
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  const exitCode =
    typeof result.status === "number" ? result.status : undefined;
  let causeDetail = "the gradle invocation failed";

  // The JDK is too new for this Gradle: the build script or the launcher
  // refuses its class files. Gradle's own compatibility table names the
  // minimum release that runs on the refused Java major.
  const refusedJavaMajor = refusedJavaMajorFromMessage(output);
  // Gradle's own modern refusal, which names the JVM it demands before any
  // class file is loaded.
  const launcherDemand =
    refusedJavaMajor === undefined
      ? javaPairFromLauncherDemand(output)
      : undefined;
  if (refusedJavaMajor !== undefined) {
    const minimumGradle = minimumGradleVersionForJava(refusedJavaMajor);
    const causeKey = `java-too-new:${refusedJavaMajor}`;
    if (!reportedGradleFailureCauses.has(causeKey)) {
      reportedGradleFailureCauses.add(causeKey);
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
        ecosystem: "java",
        tool: "gradle",
        wanted: minimumGradle ? `${minimumGradle}` : undefined,
        found: context.gradleVersion,
        source: "invocation",
        detail: minimumGradle
          ? `Gradle cannot run on Java ${refusedJavaMajor} and refused its class files; Gradle ${minimumGradle} or higher supports it.`
          : `Gradle cannot run on Java ${refusedJavaMajor} and refused its class files.`,
      });
    }
    causeDetail = `gradle cannot run on Java ${refusedJavaMajor}`;
  } else if (launcherDemand) {
    // The demand names the JDK Gradle needs; the JVM that answered it is
    // the one the build was configured to use.
    const causeKey = `jvm-demanded:${launcherDemand.wanted}:${launcherDemand.found}`;
    if (!reportedGradleFailureCauses.has(causeKey)) {
      reportedGradleFailureCauses.add(causeKey);
      recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
        ecosystem: "java",
        tool: "java",
        wanted: `${launcherDemand.wanted}`,
        found:
          launcherDemand.found === undefined
            ? undefined
            : `${launcherDemand.found}`,
        source: "invocation",
        detail:
          launcherDemand.found === undefined
            ? `Gradle requires Java ${launcherDemand.wanted} or later to run.`
            : `Gradle requires Java ${launcherDemand.wanted} or later to run; the active JVM is Java ${launcherDemand.found}.`,
      });
    }
    causeDetail = "the gradle launcher requires a newer JDK";
  } else {
    // The opposite skew: Gradle (or its wrapper) is compiled for a newer JDK
    // than the running one, so the JVM refuses to load it.
    const javaPair = javaPairFromClassVersionError(output);
    if (javaPair) {
      const causeKey = `jvm-too-old:${javaPair.wanted}:${javaPair.found}`;
      if (!reportedGradleFailureCauses.has(causeKey)) {
        reportedGradleFailureCauses.add(causeKey);
        recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISMATCH, {
          ecosystem: "java",
          tool: "java",
          wanted: Number.isNaN(javaPair.wanted)
            ? undefined
            : `${javaPair.wanted}`,
          found: Number.isNaN(javaPair.found) ? undefined : `${javaPair.found}`,
          source: "invocation",
          detail: `The gradle launcher requires Java ${Number.isNaN(javaPair.wanted) ? "a newer release" : javaPair.wanted}; the active JDK is older and refused its class files.`,
        });
      }
      causeDetail = "the gradle launcher requires a newer JDK";
    } else if (output.includes("JAVA_HOME is set to an invalid directory")) {
      const causeKey = "invalid-java-home";
      if (!reportedGradleFailureCauses.has(causeKey)) {
        reportedGradleFailureCauses.add(causeKey);
        recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
          ecosystem: "java",
          tool: "java",
          source: "JAVA_HOME",
          detail:
            "JAVA_HOME names a directory that does not hold a JDK, so the gradle launcher refused to start.",
        });
      }
      causeDetail = "JAVA_HOME does not point at a JDK";
    } else if (
      output.includes("Could not start Gradle Daemon") ||
      output.includes("Daemon could not be started") ||
      output.includes("could not install Gradle distribution")
    ) {
      const causeKey = "daemon-start";
      if (!reportedGradleFailureCauses.has(causeKey)) {
        reportedGradleFailureCauses.add(causeKey);
        recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
          ecosystem: "java",
          tool: "gradle",
          impact: LEDGER_EVENT_IMPACTS.VERSIONS,
          detail:
            "The gradle daemon did not start, so no dependency resolution ran.",
        });
      }
      causeDetail = "the gradle daemon did not start";
    }
  }

  gradleInvocationFailed = true;
  recordDegradation("jvm.gradle.invocation-failed", {
    ecosystem: "java",
    tool: "gradle",
    impact: LEDGER_EVENT_IMPACTS.TRANSITIVE_DEPS,
    command: context.command,
    exitCode,
    detail: causeDetail,
    causeDetail,
    outputExcerpt: commandOutputText(result),
  });
}

/**
 * Method to resolve dependencies from a gradle output
 *
 * @param {string} rawOutput Text output from gradle dependencies task
 * @param {string} rootProjectName Name of the root project
 * @param {map} gradleModules Cache with all gradle modules that have already been read
 * @param {string} gradleRootPath Root path where Gradle is to be run when getting module information
 */
export async function parseGradleDep(
  rawOutput,
  rootProjectName = "root",
  gradleModules = new Map(),
  gradleRootPath = "",
) {
  if (typeof rawOutput === "string") {
    // Bug: 249. Get any sub-projects refered here
    const retMap = parseGradleProjects(rawOutput);
    // Issue #289. Work hard to find the root project name
    if (
      !rootProjectName ||
      (rootProjectName === "root" &&
        retMap &&
        retMap.rootProject &&
        retMap.rootProject !== "root")
    ) {
      rootProjectName = retMap.rootProject;
    }
    let match = "";
    // To render dependency tree we need a root project
    const rootProject = gradleModules.get(rootProjectName);
    const deps = [];
    const dependenciesList = [];
    const keys_cache = {};
    const deps_keys_cache = {};
    let last_level = 0;
    let last_bomref = rootProject["bom-ref"];
    const first_bomref = last_bomref;
    let last_project_bomref = first_bomref;
    const level_trees = {};
    level_trees[last_bomref] = [];
    let scope;
    let profileName;
    if (retMap?.projects) {
      const modulesToSkip = readEnvironmentVariable("GRADLE_SKIP_MODULES")
        ? readEnvironmentVariable("GRADLE_SKIP_MODULES").split(",")
        : [];
      const modulesToScan = retMap.projects.filter(
        (module) => !gradleModules.has(module),
      );
      if (modulesToScan.length > 0) {
        const parallelPropTaskOut = executeParallelGradleProperties(
          gradleRootPath,
          modulesToScan.filter((module) => !modulesToSkip.includes(module)),
        );
        const splitPropTaskOut = splitOutputByGradleProjects(
          parallelPropTaskOut,
          ["properties"],
        );

        for (const module of modulesToScan) {
          const propMap = parseGradleProperties(
            splitPropTaskOut.get(module),
            module,
          );
          const rootSubProject = propMap.rootProject;
          if (rootSubProject) {
            const rootSubProjectObj = await buildObjectForGradleModule(
              rootSubProject === "root" ? module : rootSubProject,
              propMap.metadata,
            );
            gradleModules.set(module, rootSubProjectObj);
          }
        }
      }
      const subDependsOn = [];
      for (const sd of retMap.projects) {
        if (gradleModules.has(sd)) {
          subDependsOn.push(gradleModules.get(sd)["bom-ref"]);
        }
      }
      level_trees[last_bomref] = subDependsOn;
    }
    let stack = [last_bomref];
    const depRegex =
      /^.*?--- +(?<groupspecified>[^\s:]+) ?:(?<namespecified>[^\s:]+)(?::(?:{strictly [[]?)?(?<versionspecified>[^,\s:}]+))?(?:})?(?:[^->]* +-> +(?:(?<groupoverride>[^\s:]+):(?<nameoverride>[^\s:]+):)?(?<versionoverride>[^\s:]+))?/gm;
    for (let rline of rawOutput.split("\n")) {
      if (!rline) {
        continue;
      }
      rline = rline.replaceAll("\r", "");
      const trimmedLine = rline.trim();
      if (
        trimmedLine.endsWith("(n)") ||
        ((rline.startsWith("+--- ") || rline.startsWith("\\--- ")) &&
          rline.includes("{strictly") &&
          rline.includes("(c)"))
      ) {
        continue;
      }
      if (
        trimmedLine === "" ||
        rline.startsWith("+--- ") ||
        rline.startsWith("\\--- ")
      ) {
        last_level = 1;
        last_project_bomref = first_bomref;
        last_bomref = last_project_bomref;
        stack = [first_bomref];
      }
      if (rline.includes(" - ") && !rline.startsWith("Project ':")) {
        profileName = rline.split(" - ")[0];
        if (profileName.toLowerCase().includes("test")) {
          scope = "optional";
        } else if (profileName.toLowerCase().includes("runtime")) {
          scope = "required";
        } else {
          scope = undefined;
        }
      }
      while ((match = depRegex.exec(rline))) {
        const [
          _line,
          groupspecified,
          namespecified,
          versionspecified,
          groupoverride,
          nameoverride,
          versionoverride,
        ] = match;
        let group = groupoverride || groupspecified;
        let name = nameoverride || namespecified;
        let version = versionoverride || versionspecified;
        const prefix = rline.split("---")[0];
        const level = Math.floor(prefix.length / 5) + 1;
        if (version !== undefined || group === "project") {
          // Project line has no version
          // For multi sub-module projects such as :module:dummy:starter the regex is producing incorrect values
          if (rline.includes("project ")) {
            const tmpA = rline.split("project ");
            if (tmpA && tmpA.length > 1) {
              group = rootProject.group;
              name = tmpA[1].split(" ")[0];
              version = undefined;
            }
          }
          let purl;
          let bomRef;
          if (gradleModules.has(name)) {
            purl = gradleModules.get(name)["purl"];
            bomRef = gradleModules.get(name)["bom-ref"];
          } else {
            try {
              purl = build({
                type: "maven",
                namespace:
                  group !== "project" ? group : rootProject.group || null,
                name: name.replace(/^:/, ""),
                version:
                  version !== undefined ? version : rootProject.version || null,
                qualifiers: { type: "jar" },
              });
              bomRef = decodeURIComponent(purl);
            } catch {
              // A purl that cannot be built keeps a name-only bom-ref so the
              // component still lands in the graph.
              purl = undefined;
              bomRef = name.replace(/^:/, "");
            }
          }
          keys_cache[`${bomRef}_${last_bomref}`] = true;
          // Filter duplicates
          if (!deps_keys_cache[bomRef]) {
            deps_keys_cache[bomRef] = true;
            let adep;
            if (gradleModules.has(name)) {
              adep = gradleModules.get(name);
            } else {
              adep = {
                group: group !== "project" ? group : rootProject.group,
                name: name,
                version: version !== undefined ? version : rootProject.version,
                qualifiers: { type: "jar" },
              };
              adep["purl"] = purl;
              adep["bom-ref"] = bomRef;
              if (scope) {
                adep["scope"] = scope;
              }
              adep.properties = [];
              if (profileName) {
                adep.properties.push({
                  name: "internal:GradleProfileName",
                  value: profileName,
                });
              }
              if (gradleRootPath && gradleRootPath !== ".") {
                adep.properties.push({
                  name: "cdx:gradle:GradleRootPath",
                  value: gradleRootPath,
                });
              }
            }
            if (adep?.properties?.length === 0) {
              delete adep.properties;
            }
            deps.push(adep);
          }
          if (!level_trees[bomRef]) {
            level_trees[bomRef] = [];
          }
          if (level === 0) {
            stack = [first_bomref];
            stack.push(bomRef);
          } else if (last_bomref === "") {
            stack.push(bomRef);
          } else if (level > last_level) {
            const cnodes = level_trees[last_bomref] || [];
            if (!cnodes.includes(bomRef)) {
              cnodes.push(bomRef);
            }
            level_trees[last_bomref] = cnodes;
            if (stack[stack.length - 1] !== bomRef) {
              stack.push(bomRef);
            }
          } else {
            for (let i = level; i <= last_level; i++) {
              stack.pop();
            }
            const last_stack =
              stack.length > 0 ? stack[stack.length - 1] : last_project_bomref;
            const cnodes = level_trees[last_stack] || [];
            if (!cnodes.includes(bomRef)) {
              cnodes.push(bomRef);
            }
            level_trees[last_stack] = cnodes;
            stack.push(bomRef);
          }
          last_level = level;
          last_bomref = bomRef;
        }
      }
    }
    for (const lk of Object.keys(level_trees)) {
      dependenciesList.push({
        ref: lk,
        dependsOn: [...new Set(level_trees[lk])].sort(),
      });
    }
    return {
      pkgList: deps,
      dependenciesList,
    };
  }
  return {};
}

/**
 * Method that handles object creation for gradle modules.
 *
 * @param {string} name The simple name of the module
 * @param {object} metadata Object with all other parsed data for the gradle module
 * @returns {object} An object representing the gradle module in SBOM-format
 */
export async function buildObjectForGradleModule(name, metadata) {
  let component;
  if (
    !["false", "0"].includes(
      readEnvironmentVariable("GRADLE_RESOLVE_FROM_NODE"),
    ) &&
    metadata.properties?.find(({ name }) => name === "projectDir")
  ) {
    let tmpDir = metadata.properties?.find(
      ({ name }) => name === "projectDir",
    ).value;
    if (tmpDir.indexOf("node_modules") !== -1) {
      do {
        const npmPackages = await parsePkgJson(join(tmpDir, "package.json"));
        if (npmPackages.length === 1) {
          component = { ...npmPackages[0] };
          component.type = "library";
          component.properties = component.properties.concat(
            metadata.properties,
          );
          tmpDir = undefined;
        } else {
          tmpDir = tmpDir.substring(0, tmpDir.lastIndexOf("/"));
        }
      } while (tmpDir && tmpDir.indexOf("node_modules") !== -1);
    }
  }
  if (!component) {
    component = {
      name: name,
      type: "application",
      ...metadata,
    };
    try {
      const purl = build({
        type: "maven",
        namespace: component.group || null,
        name: component.name,
        version: component.version || null,
        qualifiers: { type: "jar" },
      });
      applyPurl(component, purl);
    } catch {
      // The module component keeps its name identity without a purl.
      applyPurl(component, null);
    }
  }
  return component;
}

/**
 * Extract Gradle repository URLs from the evaluation output properties.
 *
 * @param {string} propertiesOutput Properties command output containing repository lines
 * @returns {Object} Map of repository names to their URLs
 */
export function extractGradleRepositoryUrls(propertiesOutput) {
  const repos = {};
  if (!propertiesOutput) {
    return repos;
  }
  for (const line of propertiesOutput.split("\n")) {
    if (line.includes("<CDXGEN:repository>:")) {
      const parts = line.split("<CDXGEN:repository>:")[1].split(":");
      if (parts.length >= 2) {
        const repoName = parts[0].trim();
        const repoUrl = parts.slice(1).join(":").trim();
        repos[repoName] = repoUrl;
      }
    }
  }
  return repos;
}

/**
 * Parse the distribution URLs resolved by the init script when the
 * `resolve-gradle-distribution` feature flag is enabled. The init script emits lines of
 * the form `<CDXGEN:distribution>:group:name:version -> https://.../name-version.jar`.
 *
 * @param {string} stdout Gradle stdout logs containing the distribution markers
 * @returns {Object} Map of `group:name:version` keys to their resolved distribution URLs
 */
export function parseGradleResolvedDistributions(stdout) {
  const distMap = {};
  if (!stdout) {
    return distMap;
  }
  for (const line of stdout.split("\n")) {
    if (!line.includes("<CDXGEN:distribution>:")) {
      continue;
    }
    const payload = line.split("<CDXGEN:distribution>:")[1];
    const sepIndex = payload.indexOf(" -> ");
    if (sepIndex === -1) {
      continue;
    }
    const key = payload.substring(0, sepIndex).trim();
    const url = payload.substring(sepIndex + 4).trim();
    if (key && url) {
      distMap[key] = url;
    }
  }
  return distMap;
}

/**
 * Parse Gradle info logs to capture HTTP URLs of resolved dependency artifacts.
 *
 * @param {string} stdout Gradle stdout logs under --info
 * @returns {Object} Map of filenames to their resolved distribution URLs
 */
export function parseGradleInfoLogsForUrls(stdout) {
  const fileToUrlMap = {};
  if (!stdout) {
    return fileToUrlMap;
  }
  // Pattern 1: Resource found. [HTTP GET: https://...]
  const getRegex =
    /Resource found\. \[HTTP (?:GET|HEAD): (https?:\/\/[^\s]+?)\.jar\]/g;
  let match;
  while ((match = getRegex.exec(stdout)) !== null) {
    const jarUrl = `${match[1]}.jar`;
    const filename = jarUrl.substring(jarUrl.lastIndexOf("/") + 1);
    fileToUrlMap[filename] = jarUrl;
  }
  // Pattern 2: Cached resource https://... is up-to-date
  const cachedRegex =
    /Cached resource (https?:\/\/[^\s]+?)\.pom is up-to-date/g;
  while ((match = cachedRegex.exec(stdout)) !== null) {
    const pomUrl = `${match[1]}.pom`;
    const base = pomUrl.substring(0, pomUrl.lastIndexOf(".pom"));
    const filename = `${base.substring(base.lastIndexOf("/") + 1)}.jar`;
    const jarUrl = `${base}.jar`;
    fileToUrlMap[filename] = jarUrl;
  }
  // Pattern 3: Cached resource https://...module is up-to-date
  const cachedModuleRegex =
    /Cached resource (https?:\/\/[^\s]+?)\.module is up-to-date/g;
  while ((match = cachedModuleRegex.exec(stdout)) !== null) {
    const moduleUrl = `${match[1]}.module`;
    const base = moduleUrl.substring(0, moduleUrl.lastIndexOf(".module"));
    const filename = `${base.substring(base.lastIndexOf("/") + 1)}.jar`;
    const jarUrl = `${base}.jar`;
    fileToUrlMap[filename] = jarUrl;
  }
  // Pattern 4: Found locally available resource with matching checksum: [https://...pom/jar/module, ...]
  const foundRegex =
    /Found locally available resource with matching checksum: \[(https?:\/\/[^\s]+?)\.(?:pom|jar|module)/g;
  while ((match = foundRegex.exec(stdout)) !== null) {
    const base = match[1];
    const filename = `${base.substring(base.lastIndexOf("/") + 1)}.jar`;
    const jarUrl = `${base}.jar`;
    fileToUrlMap[filename] = jarUrl;
  }
  return fileToUrlMap;
}

/**
 * Collect Gradle project dependencies by scanning the Gradle cache directory for JAR files
 * and their associated POM files.
 *
 * Uses the `GRADLE_CACHE_DIR` or `GRADLE_USER_HOME` environment variables to locate the
 * Gradle files-2.1 cache, then delegates to {@link collectJarNS} to extract namespace
 * and purl information from those JARs.
 *
 * @param {string} _gradleCmd Gradle command (unused; reserved for future use)
 * @param {string} _basePath Base project path (unused; reserved for future use)
 * @param {boolean} _cleanup Whether to clean up temporary files (unused; reserved for future use)
 * @param {boolean} _includeCacheDir Whether to include cache directory (unused; reserved for future use)
 * @returns {Promise<Object>} JAR namespace mapping object returned by collectJarNS
 */
export async function collectGradleDependencies(
  _gradleCmd,
  _basePath,
  _cleanup = true, // eslint-disable-line no-unused-vars
  _includeCacheDir = false, // eslint-disable-line no-unused-vars
) {
  // Construct gradle cache directory
  let GRADLE_CACHE_DIR =
    readEnvironmentVariable("GRADLE_CACHE_DIR") ||
    join(homedir(), ".gradle", "caches", "modules-2", "files-2.1");
  if (readEnvironmentVariable("GRADLE_USER_HOME")) {
    GRADLE_CACHE_DIR = join(
      readEnvironmentVariable("GRADLE_USER_HOME"),
      "caches",
      "modules-2",
      "files-2.1",
    );
  }
  if (DEBUG_MODE) {
    console.log("Collecting jars from", GRADLE_CACHE_DIR);
    console.log(
      "To improve performance, ensure only the project dependencies are present in this cache location.",
    );
  }
  const pomPathMap = {};
  const pomFiles = getAllFiles(GRADLE_CACHE_DIR, "**/*.pom");
  for (const apom of pomFiles) {
    pomPathMap[basename(apom)] = apom;
  }
  return await collectJarNS(GRADLE_CACHE_DIR, pomPathMap);
}

/**
 * Method to return the mill command to use.
 *
 * The project-local `mill` script is an attacker-controlled file in the
 * scanned project, so it is only used when dependency tooling is allowed
 * (`options.installDeps !== false`).
 *
 * @param {string} srcPath Path to look for mill wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export function getMillCommand(srcPath, options = {}) {
  let millCmd = `mill${platform() === "win32" ? ".bat" : ""}`;
  if (options.installDeps !== false && safeExistsSync(join(srcPath, millCmd))) {
    // Use local mill wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, millCmd), 0o775);
    } catch (_e) {
      // The mill wrapper stays un-chmod'ed; the spawn below still reports any
      // permission failure as a normal command failure.
    }
    millCmd = resolve(join(srcPath, millCmd));
  }
  return millCmd;
}

/**
 * Determine the Mill version of a build.
 *
 * The version is read from the `.mill-version` file, from the
 * `//| mill-version:` header of the build file, or from the launcher itself.
 *
 * @param {string} millRootPath Root of the Mill build
 * @param {string} millCmd Mill command to use for the fallback probe
 * @returns {string|null} The Mill version, or null when it cannot be determined
 */
export function getMillVersion(millRootPath, millCmd) {
  const millVersionFile = join(millRootPath, ".mill-version");
  if (safeExistsSync(millVersionFile)) {
    const version = (readFileSync(millVersionFile, "utf-8") || "").trim();
    if (valid(version)) {
      return version;
    }
  }
  for (const buildFile of ["build.mill", "build.sc"]) {
    const buildFilePath = join(millRootPath, buildFile);
    if (!safeExistsSync(buildFilePath)) {
      continue;
    }
    const headerMatch = /^\/\/[|\s]\s*mill-version:\s*(\S+)/m.exec(
      readFileSync(buildFilePath, "utf-8"),
    );
    if (headerMatch?.[1] && valid(headerMatch[1])) {
      return headerMatch[1];
    }
  }
  const versionResult = safeSpawnSync(millCmd, ["--no-server", "--version"], {
    cwd: millRootPath,
    shell: isWin,
  });
  const versionMatch = /version\s+(\S+)/.exec(`${versionResult.stdout || ""}`);
  return versionMatch?.[1] && valid(versionMatch[1]) ? versionMatch[1] : null;
}

/**
 * Find the Mill daemons running under a tree.
 *
 * Daemons record their process id in `out/mill-daemon*` (Mill 1.x) or
 * `out/mill-server*` directories, directly or one level below (Mill 0.12
 * keeps one subdirectory per server). Only processes that are still alive
 * are returned.
 *
 * @param {string} rootPath Tree to search
 * @returns {Map<string, Set<number>>} Live daemon process ids by the root of
 *   the build they belong to
 */
export function findMillDaemons(rootPath) {
  const daemons = new Map();
  const readPid = (dir) => {
    for (const candidate of [dir, ...safeSubdirs(dir)]) {
      try {
        const pid = Number.parseInt(
          readFileSync(join(candidate, "processId"), "utf-8").trim(),
          10,
        );
        if (pid > 0 && isProcessAlive(pid)) {
          return pid;
        }
      } catch (_err) {
        // no process id recorded in this directory
      }
    }
    return undefined;
  };
  const visit = (dir, depth) => {
    if (depth > 4) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === "out") {
        for (const name of safeSubdirs(join(dir, entry.name))) {
          const base = basename(name);
          if (
            !base.startsWith("mill-daemon") &&
            !base.startsWith("mill-server")
          ) {
            continue;
          }
          const pid = readPid(name);
          if (pid) {
            if (!daemons.has(dir)) {
              daemons.set(dir, new Set());
            }
            daemons.get(dir).add(pid);
          }
        }
      } else if (!["target", "node_modules", ".git"].includes(entry.name)) {
        visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  visit(rootPath, 0);
  return daemons;
}

function safeSubdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch (_err) {
    return [];
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Stop the Mill daemons that started under the scanned tree during the scan.
 *
 * cdxgen's own Mill calls run with --no-server, but a project build cdxgen
 * runs can shell out to Mill without it and leave a daemon behind. Daemons
 * that were already running when the scan started belong to the user, for
 * example to an IDE, and are left alone; every other live daemon is shut
 * down through the launcher of the build it belongs to.
 *
 * @param {string} rootPath Scanned tree
 * @param {Map<string, Set<number>>} [runningBefore] Result of
 *   {@link findMillDaemons} taken before the scan
 */
export function stopMillDaemons(rootPath, runningBefore = new Map()) {
  for (const [buildRoot, pids] of findMillDaemons(rootPath)) {
    const before = runningBefore.get(buildRoot) || new Set();
    if ([...pids].every((pid) => before.has(pid))) {
      continue;
    }
    const launcher = safeExistsSync(join(buildRoot, "mill"))
      ? join(buildRoot, "mill")
      : "mill";
    console.log("Stopping the Mill daemon the scan started in", buildRoot);
    safeSpawnSync(launcher, ["shutdown"], {
      cwd: buildRoot,
      shell: isWin,
    });
  }
}

/**
 * Method to return the maven command to use.
 *
 * Project-local wrapper scripts (`mvnw`) are attacker-controlled files in the
 * scanned project, so they are only used when dependency tooling is allowed
 * (`options.installDeps !== false`); otherwise the installed Maven is used.
 *
 * @param {string} srcPath Path to look for maven wrapper
 * @param {string} rootPath Root directory to look for maven wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export function getMavenCommand(srcPath, rootPath, options = {}) {
  let mavenCmd = "mvn";
  // Check if the wrapper script is both available and functional
  let isWrapperReady = false;
  let isWrapperFound = false;
  const pinnedToolSelected = isJvmToolPinned();
  // Introspection mode exists to observe the project's own toolchain, so it
  // keeps using wrappers even when dependency installation is disabled.
  const allowProjectWrappers =
    options.installDeps !== false || options.introspect === true;
  let findMavenFile = "mvnw";
  let mavenWrapperCmd = null;
  if (platform() === "win32") {
    findMavenFile = "mvnw.bat";
    if (
      !safeExistsSync(join(srcPath, findMavenFile)) &&
      safeExistsSync(join(srcPath, "mvnw.cmd"))
    ) {
      findMavenFile = "mvnw.cmd";
    }
  }

  if (
    allowProjectWrappers &&
    !pinnedToolSelected &&
    safeExistsSync(join(srcPath, findMavenFile))
  ) {
    // Use local maven wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, findMavenFile), 0o775);
    } catch (_e) {
      // The wrapper stays un-chmod'ed; the spawn below still reports any
      // permission failure as a normal command failure.
    }
    mavenWrapperCmd = resolve(join(srcPath, findMavenFile));
    isWrapperFound = true;
    recordDecisionActivity(mavenWrapperCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: "project-wrapper-candidate",
        tool: "maven",
      },
      reason: `Found Maven wrapper candidate ${mavenWrapperCmd}.`,
    });
  } else if (
    allowProjectWrappers &&
    !pinnedToolSelected &&
    rootPath &&
    safeExistsSync(join(rootPath, findMavenFile))
  ) {
    // Check if the root directory has a wrapper script
    try {
      chmodSync(join(rootPath, findMavenFile), 0o775);
    } catch (_e) {
      // The wrapper stays un-chmod'ed; the spawn below still reports any
      // permission failure as a normal command failure.
    }
    mavenWrapperCmd = resolve(join(rootPath, findMavenFile));
    isWrapperFound = true;
    recordDecisionActivity(mavenWrapperCmd, {
      metadata: {
        decisionType: "path-resolution",
        selectedSource: "root-wrapper-candidate",
        tool: "maven",
      },
      reason: `Found root-level Maven wrapper candidate ${mavenWrapperCmd}.`,
    });
  }
  if (isWrapperFound) {
    if (DEBUG_MODE) {
      console.log("Testing the wrapper script by invoking --version");
    }
    const result = safeSpawnSync(mavenWrapperCmd, ["--version"], {
      cdxgenActivity: {
        kind: "probe",
        metadata: {
          tool: "maven",
        },
        probeType: "wrapper-readiness",
      },
      cwd: rootPath,
      shell: isWin,
    });
    if (!result.error && !result.status) {
      isWrapperReady = true;
      mavenCmd = mavenWrapperCmd;
      recordDecisionActivity(mavenCmd, {
        metadata: {
          decisionType: "path-resolution",
          selectedSource: "wrapper",
          tool: "maven",
        },
        reason: `Selected Maven wrapper ${mavenCmd} after readiness probe.`,
      });
    } else {
      if (DEBUG_MODE) {
        console.log(
          "Maven wrapper script test has failed. Will use the installed version of maven.",
        );
      }
      recordDecisionActivity(mavenWrapperCmd, {
        metadata: {
          decisionType: "fallback",
          selectedSource: "PATH",
          skippedSource: "wrapper",
          tool: "maven",
        },
        reason: `Maven wrapper readiness probe failed for ${mavenWrapperCmd}; falling back to installed Maven.`,
      });
    }
  }
  if (!isWrapperFound || !isWrapperReady) {
    if (
      readEnvironmentVariable("MVN_CMD") ||
      readEnvironmentVariable("MAVEN_CMD")
    ) {
      mavenCmd =
        readEnvironmentVariable("MVN_CMD") ||
        readEnvironmentVariable("MAVEN_CMD");
      recordDecisionActivity(mavenCmd, {
        metadata: {
          decisionType: "path-resolution",
          selectedSource: pinnedToolSelected
            ? "pinned-cli"
            : readEnvironmentVariable("MVN_CMD")
              ? "MVN_CMD"
              : "MAVEN_CMD",
          tool: "maven",
        },
        reason: pinnedToolSelected
          ? `Selected Maven command ${mavenCmd} pinned via the CLI project type.`
          : `Selected Maven command from environment (${mavenCmd}).`,
      });
    } else if (readEnvironmentVariable("MAVEN_HOME")) {
      mavenCmd = join(readEnvironmentVariable("MAVEN_HOME"), "bin", "mvn");
      recordDecisionActivity(mavenCmd, {
        metadata: {
          decisionType: "path-resolution",
          selectedSource: "MAVEN_HOME",
          tool: "maven",
        },
        reason: `Selected Maven command from MAVEN_HOME (${mavenCmd}).`,
      });
    } else {
      recordDecisionActivity(mavenCmd, {
        metadata: {
          decisionType: "path-resolution",
          selectedSource: "PATH",
          tool: "maven",
        },
        reason: "Falling back to Maven from PATH.",
      });
      // A Maven from PATH is a sound outcome whenever its version satisfies
      // the wrapper pin, so the fallback is recorded as costing nothing.
      recordLedgerEvent(LEDGER_EVENT_KINDS.FALLBACK_ENGAGED, {
        ecosystem: "java",
        tool: "maven",
        source: "PATH",
        impact: LEDGER_EVENT_IMPACTS.NONE,
        detail:
          "No wrapper, MVN_CMD/MAVEN_CMD, or MAVEN_HOME was found; Maven will run from PATH.",
      });
    }
  }
  return mavenCmd;
}

/**
 * Parse a Gradle version catalog (`gradle/libs.versions.toml`).
 *
 * A catalog declares coordinates the build scripts then reference by alias.
 * It is a declaration, not a resolution: entries may go unused, and their
 * versions may be references into the `[versions]` table. Because of that,
 * catalog components are emitted only as a fallback when Gradle itself
 * produced no dependency information, and every component carries a
 * `cdx:gradle:catalog=true` property so consumers can tell declared catalog
 * entries from a resolved graph.
 *
 * Only libraries whose version resolves to a literal (inline or via
 * `version.ref`) are emitted; rich or unresolved versions would produce purls
 * that identify no artifact. Plugins are skipped because they are build-time
 * only.
 *
 * @param {string} catalogFile Path to `libs.versions.toml`
 * @returns {Object[]} Package records for resolvable library entries
 */
export function parseGradleVersionCatalog(catalogFile) {
  let catalog;
  try {
    catalog = toml.parse(readFileSync(catalogFile, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${catalogFile}: ${error.message}`);
    return [];
  }
  const versions =
    catalog?.versions && typeof catalog.versions === "object"
      ? catalog.versions
      : {};
  const libraries =
    catalog?.libraries && typeof catalog.libraries === "object"
      ? catalog.libraries
      : {};
  const pkgList = [];
  for (const entry of Object.values(libraries)) {
    const coordinate = catalogCoordinate(entry);
    if (!coordinate) {
      continue;
    }
    const version = resolveCatalogVersion(entry, versions);
    if (!version) {
      continue;
    }
    const { group, name } = coordinate;
    // A catalog is authored input, but a malformed coordinate must cost the
    // one entry, not the whole scan.
    const purl = tryBuildPurl({
      type: "maven",
      namespace: group,
      name,
      version,
    });
    if (!purl) {
      continue;
    }
    pkgList.push({
      group,
      name,
      version,
      type: "library",
      scope: "required",
      purl,
      "bom-ref": decodeURIComponent(purl),
      properties: [
        { name: "internal:SrcFile", value: catalogFile },
        { name: "cdx:gradle:catalog", value: "true" },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0.5,
              value: `Filename ${catalogFile}`,
            },
          ],
        },
      },
    });
  }
  return pkgList;
}

/**
 * Read the Maven coordinate of one catalog entry.
 *
 * A catalog writes the coordinate either as `module = "group:name"` or as a
 * separate `group` and `name` pair; both forms are equivalent and both appear
 * in real catalogs.
 *
 * @param {object} entry Catalog library entry
 * @returns {{group: string, name: string}|undefined} Coordinate, or undefined
 */
function catalogCoordinate(entry) {
  const module = typeof entry?.module === "string" ? entry.module : undefined;
  if (module?.includes(":")) {
    const separator = module.indexOf(":");
    return {
      group: module.slice(0, separator),
      name: module.slice(separator + 1),
    };
  }
  if (typeof entry?.group === "string" && typeof entry?.name === "string") {
    return { group: entry.group, name: entry.name };
  }
  return undefined;
}

/**
 * Resolve the version of one catalog entry.
 *
 * An entry may pin `version = "1.2.3"` directly or reference the versions
 * table with `version.ref = "alias"`. Version references that are missing, or
 * that carry Gradle rich-version syntax (ranges, `!!`, separators), resolve
 * to nothing and the entry is skipped.
 *
 * @param {object} entry Catalog library entry
 * @param {object} versions Parsed `[versions]` table
 * @returns {string|undefined} Concrete version, or undefined
 */
function resolveCatalogVersion(entry, versions) {
  const raw =
    typeof entry?.version === "string"
      ? entry.version
      : typeof entry?.version?.ref === "string"
        ? versions[entry.version.ref]
        : undefined;
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  if (/[[\](),!]|->|\.\./u.test(raw)) {
    return undefined;
  }
  return raw;
}
