import { Buffer } from "node:buffer";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";
import { valid } from "semver";

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
import { isProjectToolingAllowed } from "../core/projectTooling.js";
import { parseToml } from "../core/toml.js";
import {
  isBuildToolRateLimited,
  noteBuildToolRateLimit,
} from "../inventory/buildToolRateLimit.js";
import { collectJarNS } from "../inventory/deps.js";
import { minimumGradleVersionForJava } from "../inventory/jvmToolEnv.js";
import { gradleMirrorInitScriptArgs } from "../inventory/mavenCentralMirror.js";
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

// The gate lives in lib/core so that every layer can reach it; it stays
// exported here for existing callers.
export { isProjectToolingAllowed };

/**
 * Method to return the gradle command to use.
 *
 * Project-local wrapper scripts (`gradlew`) are attacker-controlled files in
 * the scanned project, so they are only used when the project's own tooling
 * may run (see isProjectToolingAllowed); otherwise the system Gradle is used.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export function getGradleCommand(srcPath, rootPath, options = {}) {
  let gradleCmd = "gradle";
  const pinnedToolSelected = isJvmToolPinned();
  const allowProjectWrappers = isProjectToolingAllowed(options);

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
    .concat(gradleMirrorInitScriptArgs())
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
      } else {
        for (const marker of ["--- project ", "-> project "]) {
          const markerIndex = l.indexOf(marker);
          if (markerIndex === -1) {
            continue;
          }
          const projName = gradleProjectPath(
            l.slice(markerIndex + marker.length),
          );
          if (projName?.startsWith(":") && projName.length > 1) {
            projects.add(projName);
          }
          break;
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
  // This runs once per properties round, so a rate limit an earlier round met
  // ends the later rounds too.
  if (isBuildToolRateLimited("gradle")) {
    return "";
  }
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
    // A properties invocation needs the same repository the build does, so a
    // 429 answer here ends every further gradle invocation in this scan. The
    // dependencies task can even exit 0 under a rate limit, so the output is
    // read whatever the status is. The properties this invocation did print
    // are kept.
    if (
      noteBuildToolRateLimit("gradle", commandOutputText(result), {
        command: `${basename(gradleCmd)} ${gradleArg.join(" ")}`,
        exitCode: typeof result.status === "number" ? result.status : undefined,
      })
    ) {
      if (result.stdout) {
        allOutputs.push(result.stdout);
      }
      break;
    }
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
 * Configurations whose dependencies never reach the packaged application:
 * code-quality tools, coverage agents and Spring Boot's development-only
 * dependencies.
 */
const GRADLE_TOOL_CONFIGURATIONS = new Set([
  "checkstyle",
  "codenarc",
  "detekt",
  "developmentOnly",
  "errorprone",
  "jacocoAgent",
  "jacocoAnt",
  "ktlint",
  "lintChecks",
  "lintClassPath",
  "pmd",
  "spotbugs",
  "spotbugsPlugins",
]);

/**
 * Parts of a configuration name that mark it as feeding the compiler or a
 * build tool, such as `annotationProcessor`, Android's
 * `debugAnnotationProcessorClasspath` or `kotlinCompilerPluginClasspathMain`.
 */
const GRADLE_TOOL_CONFIGURATION_PARTS = [
  "annotationprocessor",
  "buildtoolsapiclasspath",
  "commonizer",
  "compilerclasspath",
  "compilerpluginclasspath",
];

/**
 * Properties that describe a dependency Gradle could not resolve.
 */
const GRADLE_FAILURE_PROPERTIES = [
  "cdx:gradle:resolutionFailed",
  "cdx:gradle:requestedVersion",
];

/**
 * Markers Gradle appends to a dependency tree line, with the flag each sets.
 */
const GRADLE_TREE_LINE_MARKERS = [
  ["(*)", "omitted"],
  ["(c)", "constraint"],
  ["(n)", "unresolvable"],
  ["FAILED", "failed"],
];

/**
 * Read the name of the configuration a `gradle dependencies` header line
 * introduces, such as `runtimeClasspath - Runtime classpath of source set
 * 'main'.`, `api (n)`, a bare `classpath` or a Groovy name such as
 * `integration-test`.
 *
 * @param {string} line One line of the report
 * @returns {string|undefined} The configuration name, or undefined when the
 *   line is not a configuration header
 */
function parseGradleConfigurationHeader(line) {
  let name = line.split(" - ")[0];
  if (name.endsWith(" (n)")) {
    name = name.slice(0, -" (n)".length);
  }
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) ? name : undefined;
}

/**
 * Map a Gradle configuration to the CycloneDX scope of the dependencies it
 * resolves. Annotation processors, compiler and build-tool classpaths,
 * code-quality tools and development-only dependencies are `excluded`, test
 * configurations `optional`, runtime classpaths `required`, and anything
 * else, such as `compileClasspath`, gets no scope. Test and runtime are
 * matched as whole words of the camel-case name, so `latestRuntimeClasspath`
 * is a runtime classpath, not a test one.
 *
 * @param {string} configurationName Name of the configuration
 * @returns {string|undefined} The CycloneDX scope
 */
function gradleConfigurationScope(configurationName) {
  const lowerName = configurationName.toLowerCase();
  const words = configurationName
    .split(/[-_.]|(?=[A-Z])/)
    .map((word) => word.toLowerCase());
  if (
    GRADLE_TOOL_CONFIGURATIONS.has(configurationName) ||
    ["kapt", "ksp"].includes(words[0]) ||
    GRADLE_TOOL_CONFIGURATION_PARTS.some((part) => lowerName.includes(part))
  ) {
    return "excluded";
  }
  if (words.includes("test") || words.includes("tests")) {
    return "optional";
  }
  if (words.includes("runtime")) {
    return "required";
  }
  return undefined;
}

/**
 * Rank a scope so that a dependency seen in several configurations keeps the
 * strongest one: `required` or no scope (which CycloneDX reads as required),
 * then `optional`, then `excluded`.
 *
 * @param {string|undefined} scope CycloneDX scope
 * @returns {number} The rank, higher being stronger
 */
function gradleScopeRank(scope) {
  if (scope === "required" || scope === undefined) {
    return 2;
  }
  return scope === "optional" ? 1 : 0;
}

/**
 * Read a project path from the text that follows `project ` in a dependency
 * tree line. Gradle 9 quotes the path (`project ':lib'`), Gradle 8 does not
 * (`project :lib`).
 *
 * @param {string} text The text after `project `
 * @returns {string|undefined} The project path, such as `:lib`
 */
function gradleProjectPath(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end > 1 ? trimmed.slice(1, end) : undefined;
  }
  return trimmed.split(" ")[0] || undefined;
}

/**
 * Find the module a project path in a dependency tree names. Subprojects are
 * keyed by their path (`:lib`) and the root project by its name, so the root
 * path `:` resolves to the report's own project when that is the root, or else
 * to the one module keyed by a name.
 *
 * @param {Map} gradleModules Modules keyed by project path or root name
 * @param {string} projectPath Project path from the tree, such as `:lib` or `:`
 * @param {string} reportProjectName Key of the project the report belongs to
 * @returns {Object|undefined} The module component
 */
function gradleModuleForPath(gradleModules, projectPath, reportProjectName) {
  if (projectPath !== ":") {
    return gradleModules.get(projectPath);
  }
  if (!reportProjectName.startsWith(":")) {
    return gradleModules.get(reportProjectName);
  }
  const rootKeys = [...gradleModules.keys()].filter((k) => !k.startsWith(":"));
  return rootKeys.length === 1 ? gradleModules.get(rootKeys[0]) : undefined;
}

/**
 * Pick a concrete version out of the version Gradle printed as requested. A
 * rich version such as `{strictly 1.0}`, `{require 2.2; reject 2.0}` or
 * `{prefer 2.0.9}` gives the version of its first strictly, require or prefer
 * clause. A range or dynamic version gives none.
 *
 * @param {string|undefined} versionText The requested version
 * @returns {string|undefined} The concrete version
 */
function gradleRequestedVersion(versionText) {
  if (!versionText) {
    return undefined;
  }
  // `1.+` and `latest.release` are dynamic and a bracketed range is a
  // range, but `0.92.2+1.20.1` is a concrete version with build metadata.
  const isConcrete = (v) =>
    v &&
    !v.endsWith("+") &&
    !v.startsWith("latest.") &&
    ![..."[](),"].some((ch) => v.includes(ch));
  if (!versionText.startsWith("{")) {
    return isConcrete(versionText) ? versionText : undefined;
  }
  const body = versionText.slice(1, versionText.lastIndexOf("}"));
  for (const clause of body.split(";")) {
    const [keyword, ...rest] = clause.trim().split(" ");
    const value = rest.join(" ").trim();
    if (
      ["strictly", "require", "prefer"].includes(keyword) &&
      isConcrete(value)
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * Split one line of a `gradle dependencies` tree into its depth and the
 * dependency it names. The selected side of `->` wins over the requested
 * side, whether it is a version, other coordinates or a project.
 *
 * @param {string} line One line of the report, without its line ending
 * @returns {Object|undefined} `{ level, group, name, version,
 *   requestedVersion, projectPath, omitted, constraint, unresolvable, failed }`,
 *   `{ level, unknown: true }` for a tree line whose dependency cannot be
 *   read, or undefined when the line is not a tree line
 */
function parseGradleTreeLine(line) {
  const markerIndex = line.indexOf("--- ");
  if (markerIndex < 1) {
    return undefined;
  }
  for (const ch of line.slice(0, markerIndex)) {
    if (!"|+\\ ".includes(ch)) {
      return undefined;
    }
  }
  const parsed = {
    level: Math.floor(markerIndex / 5) + 1,
    omitted: false,
    constraint: false,
    unresolvable: false,
    failed: false,
  };
  let text = line.slice(markerIndex + "--- ".length).trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const [marker, flag] of GRADLE_TREE_LINE_MARKERS) {
      if (text.endsWith(` ${marker}`)) {
        parsed[flag] = true;
        text = text.slice(0, -marker.length - 1).trimEnd();
        stripped = true;
      }
    }
  }
  const [requested, selected] = text.split(" -> ");
  if (requested.startsWith("project ")) {
    parsed.projectPath = gradleProjectPath(requested.slice("project ".length));
  } else {
    const [group, name, ...versionParts] = requested.split(":");
    if (!group || !name || group.includes(" ") || name.includes(" ")) {
      return { level: parsed.level, unknown: true };
    }
    parsed.group = group;
    parsed.name = name;
    parsed.requestedVersion = versionParts.join(":") || undefined;
    parsed.version = gradleRequestedVersion(parsed.requestedVersion);
  }
  if (selected?.startsWith("project ")) {
    parsed.projectPath = gradleProjectPath(selected.slice("project ".length));
  } else if (selected?.includes(":")) {
    // The selected module replaces the requested one, version and all.
    const [group, name, version] = selected.split(":");
    parsed.group = group;
    parsed.name = name;
    parsed.version = version;
    parsed.requestedVersion = undefined;
  } else if (selected) {
    parsed.version = selected;
  }
  if (parsed.projectPath === undefined && !parsed.group) {
    return { level: parsed.level, unknown: true };
  }
  return parsed;
}

/**
 * Read the properties of every project the dependency reports name that
 * `gradleModules` does not have yet, such as a project of an included build,
 * and add a module for each one whose properties task printed a report. One
 * Gradle invocation covers all of them.
 *
 * @param {Iterable<string>} reports Text of the `gradle dependencies` reports
 * @param {Map} gradleModules Modules keyed by project path, updated in place
 * @param {string} gradleRootPath Directory to run Gradle in
 * @param {Object} options CLI options
 * @returns {Promise<string[]>} Paths of the projects added
 */
export async function loadGradleModulesForReports(
  reports,
  gradleModules,
  gradleRootPath,
  options = {},
) {
  const modulesToSkip = readEnvironmentVariable("GRADLE_SKIP_MODULES")
    ? readEnvironmentVariable("GRADLE_SKIP_MODULES").split(",")
    : [];
  const missing = new Set();
  for (const report of reports) {
    for (const projectPath of parseGradleProjects(report).projects) {
      if (
        !gradleModules.has(projectPath) &&
        !modulesToSkip.includes(projectPath)
      ) {
        missing.add(projectPath);
      }
    }
  }
  if (!missing.size || !isProjectToolingAllowed(options)) {
    return [];
  }
  const splitPropTaskOut = splitOutputByGradleProjects(
    executeParallelGradleProperties(gradleRootPath, [...missing], [], options),
    ["properties"],
  );
  const added = [];
  for (const projectPath of missing) {
    // A project whose properties task printed nothing has no metadata to
    // build a module from.
    if (!splitPropTaskOut.has(projectPath)) {
      continue;
    }
    const propMap = parseGradleProperties(
      splitPropTaskOut.get(projectPath),
      projectPath,
    );
    gradleModules.set(
      projectPath,
      await buildObjectForGradleModule(
        propMap.rootProject === "root"
          ? projectPath.split(":").pop()
          : propMap.rootProject,
        propMap.metadata,
      ),
    );
    added.push(projectPath);
  }
  return added;
}

/**
 * Reconcile the copies of a component that several Gradle projects report.
 * Every copy gets the strongest scope any project gave it, so a library one
 * module only tests with stays required when another module compiles against
 * it, and a dependency one project failed to resolve loses its failure
 * properties when another project resolved it.
 *
 * @param {Object[]} pkgList Components from all the projects, updated in place
 * @returns {Object[]} The same list
 */
export function reconcileGradleComponents(pkgList) {
  const strongest = new Map();
  const resolvedSomewhere = new Set();
  const isFailed = (pkg) =>
    pkg.properties?.some((p) => p.name === "cdx:gradle:resolutionFailed");
  for (const pkg of pkgList) {
    const key = pkg?.["bom-ref"];
    if (!key) {
      continue;
    }
    if (
      !strongest.has(key) ||
      gradleScopeRank(pkg.scope) > gradleScopeRank(strongest.get(key))
    ) {
      strongest.set(key, pkg.scope);
    }
    if (!isFailed(pkg)) {
      resolvedSomewhere.add(key);
    }
  }
  for (const pkg of pkgList) {
    const key = pkg?.["bom-ref"];
    if (!key) {
      continue;
    }
    if (strongest.get(key) === undefined) {
      delete pkg.scope;
    } else {
      pkg.scope = strongest.get(key);
    }
    if (resolvedSomewhere.has(key) && isFailed(pkg)) {
      pkg.properties = pkg.properties.filter(
        (p) => !GRADLE_FAILURE_PROPERTIES.includes(p.name),
      );
      if (!pkg.properties.length) {
        delete pkg.properties;
      }
    }
  }
  return pkgList;
}

/**
 * Method to resolve dependencies from a gradle output
 *
 * A constraint line (`(c)`) adds neither a component nor an edge. Gradle
 * prints a nested constraint under the platform or module that declares it,
 * and only when the dependency it affects is resolved elsewhere in the tree,
 * where that dependency gets its component and edges. A top-level
 * `{strictly …}` constraint from consistent resolution can name a module the
 * configuration never resolves. A dependency that failed to resolve carries
 * `cdx:gradle:resolutionFailed`, keeps the version it was requested at when
 * that is a concrete version, and otherwise records the request in
 * `cdx:gradle:requestedVersion`. A dependency seen in several configurations
 * keeps the strongest scope among them.
 *
 * The parser runs no Gradle task. A project the tree names but `gradleModules`
 * lacks gets a component built from the root project's group and version; use
 * `loadGradleModulesForReports` first to read such projects' properties.
 *
 * @param {string} rawOutput Text output from gradle dependencies task
 * @param {string} rootProjectName Key in `gradleModules` of the project the report belongs to
 * @param {map} gradleModules Gradle modules keyed by project path, and the root project by its name
 * @param {string} gradleRootPath Directory Gradle ran in, recorded as `cdx:gradle:GradleRootPath`
 * @returns {{pkgList: Object[], dependenciesList: Object[]}|{}} The components and dependency graph
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
    // To render dependency tree we need a root project
    const rootProject = gradleModules.get(rootProjectName);
    if (!rootProject) {
      thoughtLog(
        `The Gradle report for ${rootProjectName} belongs to no module read from 'gradle properties', so it has no parent to hang its dependency tree from.`,
      );
      return {};
    }
    const deps = [];
    const dependenciesList = [];
    const depsByRef = new Map();
    const firstBomRef = rootProject["bom-ref"];
    const level_trees = {};
    level_trees[firstBomRef] = [];
    let scope;
    let profileName;
    // ancestors[level] is the bom-ref of the line most recently seen at that
    // depth; ancestors[0] is the project the report belongs to.
    const ancestors = [firstBomRef];
    const lines = rawOutput.split("\n").map((l) => l.replaceAll("\r", ""));
    // Modules some configuration resolved to a version, so that a failed,
    // versionless request for one of them adds nothing.
    const resolvedModules = new Set();
    for (const line of lines) {
      const parsed = parseGradleTreeLine(line);
      if (
        parsed?.group &&
        parsed.version !== undefined &&
        !parsed.failed &&
        !parsed.constraint &&
        !parsed.unresolvable
      ) {
        resolvedModules.add(`${parsed.group}:${parsed.name}`);
      }
    }
    for (const rline of lines) {
      const configurationName = parseGradleConfigurationHeader(rline);
      if (configurationName) {
        ancestors.length = 1;
        profileName = configurationName;
        scope = gradleConfigurationScope(configurationName);
      }
      if (rline.trim() === "") {
        ancestors.length = 1;
        continue;
      }
      const parsed = parseGradleTreeLine(rline);
      if (!parsed) {
        continue;
      }
      // A line that names nothing usable still takes its place in the tree,
      // so the lines under it get no parent rather than a wrong one.
      if (parsed.unknown || parsed.unresolvable) {
        ancestors.length = Math.min(ancestors.length, parsed.level);
        continue;
      }
      const { level } = parsed;
      const isProject = parsed.projectPath !== undefined;
      if (parsed.constraint) {
        ancestors.length = Math.min(ancestors.length, level);
        continue;
      }
      // Only a dependency that failed to resolve can lack a version: Gradle
      // prints every resolved one with the version it selected.
      if (
        !isProject &&
        parsed.version === undefined &&
        (!parsed.failed ||
          resolvedModules.has(`${parsed.group}:${parsed.name}`))
      ) {
        ancestors.length = Math.min(ancestors.length, level);
        continue;
      }
      // A project the modules lack is named as Gradle publishes it by
      // default: the last segment of its path, with the root project's group
      // and version.
      const name = isProject
        ? parsed.projectPath.split(":").pop()
        : parsed.name;
      const group = isProject ? rootProject.group : parsed.group;
      const version = isProject ? rootProject.version : parsed.version;
      const gradleModule = isProject
        ? gradleModuleForPath(
            gradleModules,
            parsed.projectPath,
            rootProjectName,
          )
        : undefined;
      if (isProject && !gradleModule && name === "") {
        ancestors.length = Math.min(ancestors.length, level);
        continue;
      }
      let purl;
      let bomRef;
      if (gradleModule) {
        purl = gradleModule["purl"];
        bomRef = gradleModule["bom-ref"];
      } else {
        try {
          purl = build({
            type: "maven",
            namespace: group || null,
            name,
            version: version || null,
            qualifiers: { type: "jar" },
          });
          bomRef = decodeURIComponent(purl);
        } catch {
          // A purl that cannot be built keeps a name-only bom-ref so the
          // component still lands in the graph.
          purl = undefined;
          bomRef = name;
        }
      }
      const existing = depsByRef.get(bomRef);
      // The project the report belongs to is the parent, not a component.
      if (!existing && bomRef !== firstBomRef) {
        let adep;
        if (gradleModule) {
          adep = gradleModule;
        } else {
          adep = {
            group,
            name: name,
            version,
            qualifiers: { type: "jar" },
          };
          if (version === undefined) {
            delete adep.version;
          }
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
          if (parsed.failed) {
            adep.properties.push({
              name: "cdx:gradle:resolutionFailed",
              value: "true",
            });
            if (
              parsed.requestedVersion &&
              parsed.requestedVersion !== version
            ) {
              adep.properties.push({
                name: "cdx:gradle:requestedVersion",
                value: parsed.requestedVersion.slice(0, 256),
              });
            }
          }
        }
        if (adep?.properties?.length === 0) {
          delete adep.properties;
        }
        depsByRef.set(bomRef, { adep, isModule: !!gradleModule });
        deps.push(adep);
      } else if (existing && !existing.isModule) {
        const { adep } = existing;
        if (gradleScopeRank(scope) > gradleScopeRank(adep.scope)) {
          if (scope) {
            adep.scope = scope;
          } else {
            delete adep.scope;
          }
          const profileProp = adep.properties?.find(
            (p) => p.name === "internal:GradleProfileName",
          );
          if (profileProp && profileName) {
            profileProp.value = profileName;
          }
        }
        // A dependency one configuration failed to resolve and another
        // resolved is not a failed dependency.
        if (!parsed.failed && adep.properties) {
          adep.properties = adep.properties.filter(
            (p) => !GRADLE_FAILURE_PROPERTIES.includes(p.name),
          );
          if (!adep.properties.length) {
            delete adep.properties;
          }
        }
      }
      if (!level_trees[bomRef]) {
        level_trees[bomRef] = [];
      }
      // A line whose parent was skipped has no known parent and gets no edge.
      const parentRef =
        ancestors.length >= level ? ancestors[level - 1] : undefined;
      if (parentRef && parentRef !== bomRef) {
        const cnodes = level_trees[parentRef] || [];
        if (!cnodes.includes(bomRef)) {
          cnodes.push(bomRef);
        }
        level_trees[parentRef] = cnodes;
      }
      ancestors.length = Math.min(ancestors.length, level);
      if (ancestors.length === level) {
        ancestors.push(bomRef);
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
 * scanned project, so it is only used when the project's own tooling may run
 * (see isProjectToolingAllowed).
 *
 * @param {string} srcPath Path to look for mill wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export function getMillCommand(srcPath, options = {}) {
  let millCmd = `mill${platform() === "win32" ? ".bat" : ""}`;
  if (
    isProjectToolingAllowed(options) &&
    safeExistsSync(join(srcPath, millCmd))
  ) {
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
 * @param {Object} [options] CLI options
 */
export function stopMillDaemons(
  rootPath,
  runningBefore = new Map(),
  options = {},
) {
  // The daemon PID files live in the scanned tree. When the scan was not
  // allowed to run Mill it started no daemon, and running the build's own
  // launcher here would execute a script from the scanned project.
  if (!isProjectToolingAllowed(options)) {
    return;
  }
  for (const [buildRoot, pids] of findMillDaemons(rootPath)) {
    const before = runningBefore.get(buildRoot) || new Set();
    if ([...pids].every((pid) => before.has(pid))) {
      continue;
    }
    const launcher = getMillCommand(buildRoot, options);
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
 * scanned project, so they are only used when the project's own tooling may
 * run (see isProjectToolingAllowed); otherwise the installed Maven is used.
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
  const allowProjectWrappers = isProjectToolingAllowed(options);
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
    catalog = parseToml(readFileSync(catalogFile, "utf-8"));
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
