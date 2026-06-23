import { Buffer } from "node:buffer";
import { chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";

import { PackageURL } from "packageurl-js";

import { thoughtLog } from "./logger.js";
import {
  collectJarNS,
  DEBUG_MODE,
  getAllFiles,
  isWin,
  parsePkgJson,
  readEnvironmentVariable,
  recordDecisionActivity,
  safeExistsSync,
  safeSpawnSync,
} from "./utils.js";

/**
 * Method to return the gradle command to use.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 */
export function getGradleCommand(srcPath, rootPath) {
  let gradleCmd = "gradle";

  let findGradleFile = "gradlew";
  if (platform() === "win32") {
    findGradleFile = "gradlew.bat";
  }

  if (safeExistsSync(join(srcPath, findGradleFile))) {
    // Use local gradle wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, findGradleFile), 0o775);
    } catch (_e) {
      // continue regardless of error
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
  } else if (rootPath && safeExistsSync(join(rootPath, findGradleFile))) {
    // Check if the root directory has a wrapper script
    try {
      chmodSync(join(rootPath, findGradleFile), 0o775);
    } catch (_e) {
      // continue regardless of error
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
        selectedSource: "GRADLE_CMD",
        tool: "gradle",
      },
      reason: `Selected Gradle command from GRADLE_CMD (${gradleCmd}).`,
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
  }
  return gradleCmd;
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
 * Method to split the output produced by Gradle using parallel processing by project
 *
 * @param {string} rawOutput Full output produced by Gradle using parallel processing
 * @param {string[]} relevantTasks The list of gradle tasks whose output need to be considered.
 * @returns {map} Map with subProject names as keys and corresponding dependency task outputs as values.
 */
export function splitOutputByGradleProjects(rawOutput, relevantTasks) {
  const outputSplitBySubprojects = new Map();
  let subProjectOut = "";
  const outSplitByLine = rawOutput.split("\n");
  let currentProjectName = "root";
  const regexPatternForRelevantTasks = `.*:(${relevantTasks.join("|")})(?=s|\r|$)`;
  const regexForRelevantTasks = new RegExp(regexPatternForRelevantTasks);
  for (const [i, line] of outSplitByLine.entries()) {
    //filter out everything before first task output
    if (!line.startsWith("> Task :") && subProjectOut === "") {
      continue;
    }

    //ignore output of irrelevant tasks
    if (line.startsWith("> Task :") && !regexForRelevantTasks.test(line)) {
      continue;
    }

    if (line.startsWith("Root project '") || line.startsWith("Project ':")) {
      currentProjectName = line.split("'")[1];
      outputSplitBySubprojects.set(currentProjectName, "");
    }
    // if previous subProject has ended, push to array and reset subProject string
    if (line.startsWith("> Task :") && subProjectOut !== "") {
      outputSplitBySubprojects.set(currentProjectName, subProjectOut);
      subProjectOut = "";
    }
    //if in subproject block, keep appending to string
    subProjectOut += `${line}\n`;
    //if end of last dependencies output block, push to array
    if (i === outSplitByLine.length - 1) {
      outputSplitBySubprojects.set(currentProjectName, subProjectOut);
    }
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
      l = l.replace("\r", "");
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
    metadata.properties.push({ name: "GradleModule", value: gradleModuleName });
  }
  if (typeof rawOutput === "string") {
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replace("\r", "");
      if (
        !gradleModuleName &&
        (l.startsWith("Root project '") || l.startsWith("Project '"))
      ) {
        metadata.properties.push({
          name: "GradleModule",
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
) {
  const gradleCmd = getGradleCommand(dir, null);
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
          "2. Try running cdxgen with the custom JDK11-based image `ghcr.io/cyclonedx/cdxgen-java11:v12`.",
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
      rline = rline.replace("\r", "");
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
            purl = new PackageURL(
              "maven",
              group !== "project" ? group : rootProject.group,
              name.replace(/^:/, ""),
              version !== undefined ? version : rootProject.version,
              { type: "jar" },
              null,
            ).toString();
            bomRef = decodeURIComponent(purl);
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
                  name: "GradleProfileName",
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
    const purl = new PackageURL(
      "maven",
      component.group,
      component.name,
      component.version,
      { type: "jar" },
      null,
    ).toString();
    component["purl"] = purl;
    component["bom-ref"] = decodeURIComponent(purl);
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
