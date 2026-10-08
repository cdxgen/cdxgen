import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";
import { gte, lte } from "semver";

import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { commandOutputText, recordDegradation } from "../core/buildLedger.js";
import {
  deferFailOnError,
  isDeferredFailOnError,
} from "../core/deferredExit.js";
import {
  hasAnyProjectType,
  includeMavenTestScope,
  isFeatureEnabled,
  isPackageManagerAllowed,
  PREFER_MAVEN_DEPS_TREE,
  parseMavenArgs,
} from "../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  MAX_BUFFER,
  safeExistsSync,
  safeMkdirSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeUnlinkSync,
  safeWriteSync,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { dirNameStr } from "../core/paths.js";
import { extractJarArchive, getMvnMetadata } from "../ecosystems/ecosystems.js";
import {
  buildGradleCommandArguments,
  buildObjectForGradleModule,
  collectGradleDependencies,
  executeParallelGradleProperties,
  findMillDaemons,
  getGradleCommand,
  getMavenCommand,
  getMillCommand,
  getMillVersion,
  hasGradleInvocationFailure,
  parseGradleDep,
  parseGradleInfoLogsForUrls,
  parseGradleProperties,
  parseGradleResolvedDistributions,
  parseGradleVersionCatalog,
  recordGradleInvocationFailure,
  splitOutputByGradleProjects,
  stopMillDaemons,
} from "../ecosystems/gradleutils.js";
import {
  parseModuleBazel,
  parseModuleBazelLock,
} from "../ecosystems/parsers-bazel.js";
import {
  parseBazelActionGraph,
  parseBazelSkyframe,
  parseMavenTree,
  parseMavenTreeJson,
  parseMillDependency,
  parsePom,
  resolveReactorPomFiles,
} from "../ecosystems/parsers-jvm.js";
import {
  addPlugin,
  cleanupPlugin,
  determineSbtVersion,
  discoverSbtProjects,
  parseSbtLock,
  parseSbtProjects,
  parseSbtRootProject,
  parseSbtTree,
  sbt2DependencyTreeCommand,
  sbtSpawnSync,
  splitSbtDependencyTrees,
} from "../ecosystems/sbtutils.js";
import { collectScalaCliComponents } from "../ecosystems/scalacliutils.js";
import { collectScalaJsNpmComponents } from "../ecosystems/scalasem.js";
import {
  isBuildToolRateLimited,
  noteBuildToolRateLimit,
} from "../inventory/buildToolRateLimit.js";
import {
  collectJarNS,
  collectMvnDependencies,
  convertJarNSToPackages,
} from "../inventory/deps.js";
import { mergeDependencies, trimComponents } from "../inventory/depsUtils.js";
import {
  attachIdentityTools,
  extractToolRefs,
} from "../inventory/evidenceUtils.js";
import {
  coursierCacheDir,
  findLocalMavenArtifact,
  locateInCoursierCache,
  projectSettingsArgs,
} from "../inventory/jvmLocalRepos.js";
import { readGradleWrapperVersion } from "../inventory/jvmToolEnv.js";
import { applyPurl, mavenPurl } from "../inventory/purl.js";
import { publishedArtifactId } from "../inventory/scalaCoords.js";
import {
  buildBomNSData,
  createDefaultParentComponent,
  shouldIncludeNodeModulesDir,
} from "./bomAssembly.js";

const isWin = process.platform === "win32";

/**
 * Resolved path to the Gradle modules cache directory, derived from
 * `GRADLE_CACHE_DIR`, `GRADLE_USER_HOME`, or `~/.gradle/caches/modules-2/files-2.1`.
 *
 * @type {string}
 */
export let GRADLE_CACHE_DIR =
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

/**
 * Absolute path to the bundled `init.gradle` helper script under `data/helpers`.
 *
 * @type {string}
 */
// Construct path to gradle init script
export const GRADLE_INIT_SCRIPT = resolve(
  dirNameStr,
  "data",
  "helpers",
  "init.gradle",
);

/**
 * Resolved path to the sbt/Ivy2 cache directory, derived from `SBT_CACHE_DIR`
 * or `~/.ivy2/cache`.
 *
 * @type {string}
 */
// Construct sbt cache directory
export const SBT_CACHE_DIR =
  readEnvironmentVariable("SBT_CACHE_DIR") || join(homedir(), ".ivy2", "cache");

/**
 * Collect the jars in the caches sbt uses: the Coursier cache, which sbt 1.3
 * and later resolve into, and the Ivy cache named by SBT_CACHE_DIR, which
 * older builds used.
 *
 * @returns {Promise<Object>} Jar namespace mapping, as collectJarNS returns.
 */
async function collectSbtCacheDependencies() {
  let nsMapping = {};
  for (const cacheDir of [coursierCacheDir(), SBT_CACHE_DIR]) {
    if (cacheDir && safeExistsSync(cacheDir)) {
      nsMapping = { ...nsMapping, ...(await collectJarNS(cacheDir)) };
    }
  }
  return nsMapping;
}

/**
 * The jar of a resolved sbt dependency in the user's own caches: the Coursier
 * cache sbt 1.3 and later resolve into, the other local Maven caches, and the
 * Ivy cache older builds used.
 *
 * @param {Object} pkg Package with group, name and version.
 * @returns {string|undefined} Path of the jar.
 */
function localSbtDependencyJar(pkg) {
  // Scala components are named without their binary suffix; the jar has it.
  const name = publishedArtifactId(pkg);
  const coursierDir = locateInCoursierCache(pkg.group, name, pkg.version)?.dir;
  const coursierJar =
    coursierDir && join(coursierDir, `${name}-${pkg.version}.jar`);
  if (coursierJar && safeExistsSync(coursierJar)) {
    return coursierJar;
  }
  const jarPath = findLocalMavenArtifact(pkg.group, name, pkg.version)?.jarPath;
  if (jarPath) {
    return jarPath;
  }
  for (const typeDir of ["jars", "bundles"]) {
    const ivyJar = join(
      SBT_CACHE_DIR,
      pkg.group,
      name,
      typeDir,
      `${name}-${pkg.version}.jar`,
    );
    if (safeExistsSync(ivyJar)) {
      return ivyJar;
    }
  }
  return undefined;
}

/**
 * Collect the namespaces of the jars of resolved sbt dependencies. sbt has
 * just downloaded them into the user's caches, so each is read from there;
 * the rest of the cache is never walked.
 *
 * @param {Object[]} pkgList Packages from the sbt dependency trees.
 * @param {Object} [known] Jar namespace mapping already collected. Packages
 *   it covers are skipped.
 * @returns {Promise<Object>} Jar namespace mapping keyed by package purl.
 */
export async function collectSbtDependencyJars(pkgList, known = {}) {
  const nsMapping = {};
  for (const pkg of pkgList || []) {
    // Applications are the build's own projects, which no cache holds.
    if (
      !pkg?.purl ||
      !pkg.group ||
      !pkg.name ||
      !pkg.version ||
      pkg.type === "application" ||
      known[pkg.purl] ||
      nsMapping[pkg.purl]
    ) {
      continue;
    }
    const jarPath = localSbtDependencyJar(pkg);
    if (!jarPath) {
      continue;
    }
    const [entry] = Object.values(await collectJarNS(jarPath));
    if (entry) {
      nsMapping[pkg.purl] = entry;
    }
  }
  return nsMapping;
}

/**
 * The purls and bom-refs of a parent component and the module components
 * nested under it.
 *
 * @param {Object} parentComponent Parent component.
 * @returns {Set<string>} Purls and bom-refs.
 */
export function ownComponentRefs(parentComponent) {
  const refs = new Set();
  // The Gradle path nests modules that can point back at the parent, so the
  // walk remembers what it has seen.
  const seen = new Set();
  const stack = parentComponent ? [parentComponent] : [];
  while (stack.length) {
    const component = stack.pop();
    if (!component || typeof component !== "object" || seen.has(component)) {
      continue;
    }
    seen.add(component);
    for (const ref of [component.purl, component["bom-ref"]]) {
      if (ref) {
        refs.add(ref);
      }
    }
    if (Array.isArray(component.components)) {
      stack.push(...component.components);
    }
  }
  return refs;
}

/**
 * Function to create bom string for Java jars
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 *
 * @returns {Object} BOM with namespace mapping
 */
export async function createJarBom(path, options) {
  let pkgList = [];
  let jarFiles;
  let nsMapping = {};
  const searchOptions = {
    ...options,
    exclude: [...(options.exclude || [])],
  };
  if (typeof searchOptions.includeNodeModulesDir === "undefined") {
    searchOptions.includeNodeModulesDir = shouldIncludeNodeModulesDir(options, [
      "jar",
      "war",
      "ear",
    ]);
  }
  // Exclude certain directories during oci sbom generation
  if (hasAnyProjectType(["oci"], options, false)) {
    searchOptions.exclude.push("**/android-sdk*/**");
    searchOptions.exclude.push("**/.sdkman/**");
  }
  const parentComponent = createDefaultParentComponent(path, "maven", options);
  if (options.useGradleCache) {
    nsMapping = await collectGradleDependencies(
      getGradleCommand(path, null, options),
      path,
      false,
      true,
    );
  } else if (options.useMavenCache) {
    nsMapping = await collectMvnDependencies(
      getMavenCommand(path, null, options),
      null,
      false,
      true,
    );
  } else if (options.useSbtCache) {
    nsMapping = await collectSbtCacheDependencies();
  }
  if (path.endsWith(".jar")) {
    jarFiles = [resolve(path)];
  } else {
    jarFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}*.[jw]ar`,
      searchOptions,
    );
  }
  // Jenkins plugins
  const hpiFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.hpi`,
    searchOptions,
  );
  if (hpiFiles.length) {
    jarFiles = jarFiles.concat(hpiFiles);
  }
  for (const jar of jarFiles) {
    const tempDir = safeMkdtempSync(join(getTmpDir(), "jar-deps-"));
    if (DEBUG_MODE) {
      console.log(`Parsing ${jar}`);
    }
    const dlist = await extractJarArchive(jar, tempDir);
    if (dlist?.length) {
      pkgList = pkgList.concat(dlist);
    }
    // Clean up
    if (tempDir?.startsWith(getTmpDir())) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
  // Metadata is resolved once for the whole scan. Inside the loop every jar
  // re-resolved the packages of all the jars before it, and lookups that had
  // failed were sent again each time.
  if (pkgList.length) {
    pkgList = await getMvnMetadata(pkgList);
  }
  pkgList = pkgList.concat(await convertJarNSToPackages(nsMapping));
  return buildBomNSData(options, pkgList, "maven", {
    src: path,
    parentComponent,
  });
}

/**
 * Whether a project keeps source directories of its own. Used to keep the
 * root project of an sbt build: a root with sources is usually the
 * application itself and merely aggregates the modules for convenience,
 * while a root without sources is a pure aggregator whose own resolution
 * adds nothing.
 *
 * @param {string} basePath Directory of the sbt build
 * @returns {boolean} True when the build root has main sources
 */
function sbtRootHasOwnSources(basePath) {
  for (const language of ["scala", "java", "kotlin"]) {
    if (safeExistsSync(join(basePath, "src", "main", language))) {
      return true;
    }
  }
  // A Play application keeps its sources in app/ instead of src/main
  const appDir = join(basePath, "app");
  if (safeExistsSync(appDir)) {
    try {
      const entries = readdirSync(appDir, { withFileTypes: true });
      return entries.some(
        (entry) => entry.isDirectory() || entry.name.endsWith(".scala"),
      );
    } catch (_err) {
      return false;
    }
  }
  return false;
}

/**
 * Discover the real sbt project ids for a build by invoking sbt's own
 * `projects` command. This is more reliable than scraping the build files with
 * a regex, since it uses sbt's project resolution and avoids false positives
 * (commented-out code, examples, values that merely resemble project defs) that
 * can lead to hangs when those bogus scopes are later passed to `dependencyTree`.
 *
 * The root project is kept when it has sources of its own, since it is then
 * the application rather than a pure aggregator.
 *
 * Falls back to the regex-based {@link discoverSbtProjects} heuristic when the
 * sbt invocation fails or yields nothing useful.
 *
 * @param {string} basePath Directory of the sbt build
 * @param {string} sbtCmd sbt executable
 * @param {Object} env Environment for the spawned process
 * @param {string[]} [launcherArgs] Launcher options placed before the sbt arguments
 * @returns {string[]} List of sbt project ids
 */
export function discoverSbtProjectsFromCmd(
  basePath,
  sbtCmd,
  env,
  launcherArgs = [],
) {
  try {
    const result = sbtSpawnSync(
      sbtCmd,
      [...launcherArgs, "-batch", "-no-colors", '"projects"'],
      {
        cwd: basePath,
        shell: true,
        // The quotes around the sbt command are for the shell to strip.
        cdxgenRawShellArgs: true,
        env,
        encoding: "utf-8",
      },
      true,
    );
    if (result.status === 0 && !result.error) {
      const { projects, root } = parseSbtProjects(result.stdout || "");
      // Exclude the aggregating root project unless it has sources of its
      // own: its dependencyTree is then the application's own dependencies
      // and not a subset of the aggregated subprojects.
      const subprojects = sbtRootHasOwnSources(basePath)
        ? projects
        : projects.filter((p) => p !== root);
      if (subprojects.length > 0) {
        if (DEBUG_MODE) {
          console.log(
            `Discovered sbt projects via sbt: ${subprojects.join(", ")}`,
          );
        }
        return subprojects;
      }
      // Single-project builds (root only): resolve at the root scope.
      if (projects.length > 0) {
        return [];
      }
    } else if (DEBUG_MODE) {
      console.log(
        "sbt projects command did not succeed. Falling back to heuristic project discovery.",
      );
    }
    // Reached only when the sbt projects command did not yield usable
    // subprojects; both success paths above returned early.
    recordDegradation("jvm.sbt.project-discovery", {
      ecosystem: "java",
      tool: "sbt",
      impact: "components",
      command: `${basename(sbtCmd)} -batch -no-colors "projects"`,
      detail:
        "The sbt projects command did not yield usable project ids, so project discovery falls back to the build-file heuristic.",
    });
  } catch (err) {
    recordDegradation("jvm.sbt.project-discovery", {
      ecosystem: "java",
      tool: "sbt",
      kind: "command.failed",
      impact: "components",
      command: `${basename(sbtCmd)} -batch -no-colors "projects"`,
      detail: "The sbt projects command could not be executed.",
    });
    if (DEBUG_MODE) {
      console.log("Unable to run sbt projects command.", err);
    }
  }
  // Fallback to the regex-based heuristic.
  return discoverSbtProjects(basePath);
}

/**
 * Function to create bom string for Java projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createJavaBom(path, options) {
  let jarNSMapping = {};
  let pkgList = [];
  let dependencies = [];
  // cyclone-dx-maven plugin creates a component for the app under metadata
  // This is subsequently referred to in the dependencies list
  let parentComponent = {};
  // Support for tracking all the tools that created the BOM
  // For java, this would correctly include the cyclonedx maven plugin.
  let tools;
  let possible_misses = false;
  let parallelPropTaskOut = "";
  // Mill daemons already running belong to the user and outlive the scan
  const millDaemonsBefore = findMillDaemons(path);
  try {
    // war/ear mode
    if (path.endsWith(".war") || path.endsWith(".jar")) {
      // Check if the file exists
      if (safeExistsSync(path)) {
        if (DEBUG_MODE) {
          console.log(`Retrieving packages from ${path}`);
        }
        const tempDir = safeMkdtempSync(join(getTmpDir(), "war-deps-"));
        // The nested jars are read from the extraction directory and their
        // namespaces attached to each component there; the directory is
        // removed afterwards, so no jar paths are kept for evinse.
        pkgList = await extractJarArchive(path, tempDir);
        if (pkgList.length) {
          pkgList = await getMvnMetadata(pkgList);
        }
        // Clean up
        if (tempDir?.startsWith(getTmpDir())) {
          console.log(`Cleaning up ${tempDir}`);
          safeRmSync(tempDir, { recursive: true, force: true });
        }
      } else {
        console.log(`${path} doesn't exist`);
      }
      return buildBomNSData(options, pkgList, "maven", {
        src: dirname(path),
        filename: path,
        nsMapping: jarNSMapping,
        dependencies,
        parentComponent,
      });
    }
    // -t quarkus is supported
    let isQuarkus = options?.projectType?.includes("quarkus");
    let useMavenDepsTree = isQuarkus ? false : PREFER_MAVEN_DEPS_TREE;
    // Is this a multi-module project
    let rootModules;
    // maven - pom.xml
    const pomFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}pom.xml`,
      options,
    );
    // gradle
    const gradleFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}build.gradle*`,
      options,
    );
    // mill
    const millFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}build.mill`,
      options,
    );
    let bomJsonFiles = [];
    if (
      pomFiles?.length &&
      isPackageManagerAllowed(
        "maven",
        ["bazel", "sbt", "gradle", "mill"],
        options,
      )
    ) {
      if (gradleFiles.length) {
        thoughtLog(
          `Is this a Gradle project? I recommend invoking cdxgen with the "-t gradle" option if you're encountering build errors.`,
        );
      }
      if (!isQuarkus) {
        // Quarkus projects require special treatment. To detect quarkus, we parse the first 3 maven file to look for a hit
        for (const pf of pomFiles.slice(0, 3)) {
          const pomMap = parsePom(pf);
          if (!rootModules && pomMap?.modules?.length) {
            rootModules = pomMap.modules;
          }
          // In quarkus mode, we cannot use the maven deps tree
          if (pomMap.isQuarkus) {
            isQuarkus = true;
            useMavenDepsTree = false;
            break;
          }
        }
      }
      let result;
      let mvnArgs;
      // FIXME: How do we motivate everyone to upgrade to 1.7?
      const toolsSpecVersion = 1.6;
      if (isQuarkus) {
        thoughtLog(
          "This appears to be a Quarkus project. Let's use the right Maven plugin.",
        );
        // disable analytics. See: https://quarkus.io/usage/
        mvnArgs = [
          "-fn",
          "quarkus:dependency-sbom",
          "-Dquarkus.analytics.disabled=true",
        ];
        if (options.specVersion >= 1.6) {
          mvnArgs = mvnArgs.concat(
            `-Dquarkus.dependency.sbom.schema-version=${toolsSpecVersion}`,
          );
        }
      } else {
        // FIXME: The last maven plugin release was on November 28th, 2024.
        // Should we fork this repo and maintain it ourselves?
        const cdxMavenPlugin =
          readEnvironmentVariable("CDX_MAVEN_PLUGIN") ||
          "org.cyclonedx:cyclonedx-maven-plugin:2.9.1";
        const cdxMavenGoal =
          readEnvironmentVariable("CDX_MAVEN_GOAL") || "makeAggregateBom";
        mvnArgs = [
          "-fn",
          `${cdxMavenPlugin}:${cdxMavenGoal}`,
          "-DoutputName=bom",
        ];
        if (includeMavenTestScope) {
          mvnArgs.push("-DincludeTestScope=true");
        }
        // By using quiet mode we can reduce the maxBuffer used and avoid crashes
        if (!DEBUG_MODE) {
          mvnArgs.push("-q");
        }
        // Support for passing additional settings and profile to maven
        if (readEnvironmentVariable("MVN_ARGS")) {
          const addArgs = parseMavenArgs(readEnvironmentVariable("MVN_ARGS"));
          mvnArgs = mvnArgs.concat(addArgs);
        }
        // specVersion 1.4 doesn't support externalReferences.type=distribution-intake
        // so we need to run the plugin with the correct version
        if (options.specVersion >= 1.6) {
          mvnArgs = mvnArgs.concat(`-DschemaVersion=${toolsSpecVersion}`);
        } else if (options.specVersion > 1.4) {
          mvnArgs = mvnArgs.concat(`-DschemaVersion=${options.specVersion}`);
        }
      }
      const firstPom = pomFiles.length ? pomFiles[0] : undefined;
      let mavenCmd = getMavenCommand(path, path, options);
      // Pom files a successful recursive tree run has already resolved. Each
      // entry is skipped when its turn comes, so a reactor is run once from
      // its aggregator instead of once per member.
      const coveredPomFiles = new Set();
      for (const f of pomFiles) {
        const basePath = dirname(f);
        if (isBuildToolRateLimited("maven")) {
          // Every further Maven run in this scan would pay the same back-off
          // for the same empty answer, so the scan stops asking Maven.
          if (DEBUG_MODE) {
            console.log(
              `Skipping ${basePath}: the repository rate limited Maven in this scan.`,
            );
          }
          break;
        }
        if (coveredPomFiles.has(f)) {
          if (DEBUG_MODE) {
            console.log(
              `Skipped ${basePath}: the recursive dependency:tree run of its aggregator already resolved it.`,
            );
          }
          continue;
        }
        if (
          isQuarkus &&
          !options.deep &&
          rootModules?.includes(basename(basePath))
        ) {
          if (DEBUG_MODE) {
            console.log("Skipped sub-module", basePath);
          }
          continue;
        }
        if (mavenCmd?.endsWith("mvn")) {
          mavenCmd = getMavenCommand(basePath, path, options);
        }
        // A settings.xml beside the pom is passed as global settings, so the
        // user's own settings.xml, with its mirrors and credentials, still
        // applies on top of it.
        const projectSettings = projectSettingsArgs(basePath, {
          secureMode: isSecureMode,
        });
        if (projectSettings.args.length) {
          console.log(
            `Passing ${projectSettings.settingsFile} to Maven as global settings (-gs), so your own settings.xml still applies. Name a settings file in MVN_ARGS to change this.`,
          );
        } else if (projectSettings.skipped === "secure-mode") {
          console.log(
            `Ignoring ${projectSettings.settingsFile} in secure mode. If you trust it, pass it with MVN_ARGS='--global-settings ${projectSettings.settingsFile}'.`,
          );
        }
        // Should we attempt to resolve class names
        if (options.resolveClass || options.deep) {
          const tmpjarNSMapping = await collectMvnDependencies(
            mavenCmd,
            basePath,
            true,
            false,
          );
          if (tmpjarNSMapping && Object.keys(tmpjarNSMapping).length) {
            jarNSMapping = { ...jarNSMapping, ...tmpjarNSMapping };
          }
        }
        // Use the cyclonedx maven plugin if there is no preference for maven deps tree
        if (!useMavenDepsTree && !isBuildToolRateLimited("maven")) {
          thoughtLog("The user wants me to use the cyclonedx-maven plugin.");
          console.log(`Executing '${mavenCmd}' in`, basePath);
          result = safeSpawnSync(mavenCmd, mvnArgs, {
            cwd: basePath,
            shell: isWin,
          });
          noteBuildToolRateLimit("maven", commandOutputText(result), {
            command: `${basename(mavenCmd)} ${mvnArgs.join(" ")}`,
            exitCode:
              typeof result.status === "number" ? result.status : undefined,
          });
          // Check if the cyclonedx plugin created the required bom.json file
          // Sometimes the plugin fails silently for complex maven projects
          bomJsonFiles = getAllFiles(
            path,
            "**/target/*{cdx,bom,cyclonedx}*.json",
            options,
          );
          // Check if the bom json files got created in a directory other than target
          if (!bomJsonFiles.length) {
            bomJsonFiles = getAllFiles(
              path,
              "target/**/*{cdx,bom,cyclonedx}*.json",
              options,
            );
          }
        }
        // Also check if the user has a preference for maven deps tree command
        if (
          useMavenDepsTree ||
          !bomJsonFiles.length ||
          result?.status !== 0 ||
          result?.error
        ) {
          const tempRoot = getTmpDir();
          const tempDir = safeMkdtempSync(join(tempRoot, "cdxgen-mvn-"));
          const tempMvnTree = join(tempDir, "cdxgen-mvn-tree.json");
          const tempMvnTreeText = join(tempDir, "cdxgen-mvn-tree.txt");
          const tempMvnParentTree = join(
            tempDir,
            "cdxgen-mvn-parent-tree.json",
          );
          const tempMvnParentTreeText = join(
            tempDir,
            "cdxgen-mvn-parent-tree.txt",
          );
          try {
            let mvnTreeArgs = [
              "dependency:tree",
              `-DoutputFile=${tempMvnTree}`,
              "-DoutputType=json",
            ];
            let addArgs = [];
            if (readEnvironmentVariable("MVN_ARGS")) {
              addArgs = parseMavenArgs(readEnvironmentVariable("MVN_ARGS"));
              mvnTreeArgs = mvnTreeArgs.concat(addArgs);
            }
            mvnTreeArgs = mvnTreeArgs.concat(projectSettings.args);
            // For the first pom alone, we need to execute first in non-recursive mode to capture
            // the parent component. Then, we execute all of them in recursive mode
            if (f === firstPom) {
              thoughtLog(
                "What is the parent component here? Let's use maven command to find out.",
              );
              let findParentComponentArgs = [
                "dependency:tree",
                "-N",
                `-DoutputFile=${tempMvnParentTree}`,
                "-DoutputType=json",
              ];
              findParentComponentArgs = findParentComponentArgs.concat(
                addArgs,
                projectSettings.args,
              );
              result = safeSpawnSync(mavenCmd, findParentComponentArgs, {
                cwd: basePath,
                shell: isWin,
              });
              noteBuildToolRateLimit("maven", commandOutputText(result), {
                command: `${basename(mavenCmd)} ${findParentComponentArgs.join(" ")}`,
                exitCode:
                  typeof result.status === "number" ? result.status : undefined,
              });
              // If json is empty or unparseable, fallback to text parsing
              let emptyJson = !safeExistsSync(tempMvnParentTree);
              if (safeExistsSync(tempMvnParentTree)) {
                const mvnTreeString = readFileSync(tempMvnParentTree, {
                  encoding: "utf-8",
                });
                const parsedList = parseMavenTreeJson(mvnTreeString, f);
                if (!parsedList?.pkgList?.length) {
                  emptyJson = true;
                  // Remove the invalid json file so text output is preferred below.
                  if (safeExistsSync(tempMvnParentTree)) {
                    safeUnlinkSync(tempMvnParentTree);
                  }
                }
              }
              if (
                !isBuildToolRateLimited("maven") &&
                (result.status !== 0 || result.error || emptyJson)
              ) {
                findParentComponentArgs = [
                  "dependency:tree",
                  "-N",
                  `-DoutputFile=${tempMvnParentTreeText}`,
                ].concat(addArgs, projectSettings.args);
                result = safeSpawnSync(mavenCmd, findParentComponentArgs, {
                  cwd: basePath,
                  shell: isWin,
                });
              }
              if (result.status === 0) {
                const parentTreeFile = safeExistsSync(tempMvnParentTreeText)
                  ? tempMvnParentTreeText
                  : tempMvnParentTree;
                if (safeExistsSync(parentTreeFile)) {
                  const mvnTreeString = readFileSync(parentTreeFile, {
                    encoding: "utf-8",
                  });
                  const parsedList = parentTreeFile.endsWith(".json")
                    ? parseMavenTreeJson(mvnTreeString, f)
                    : parseMavenTree(mvnTreeString, f);
                  const dlist = parsedList.pkgList || [];
                  if (dlist.length) {
                    const tmpParentComponent = dlist.splice(0, 1)[0];
                    tmpParentComponent.type = "application";
                    parentComponent = tmpParentComponent;
                    parentComponent.components = [];
                    if (parentComponent.name) {
                      thoughtLog(
                        `Parent component is called ${parentComponent.name}!`,
                      );
                    }
                  }
                }
              }
            }
            thoughtLog(
              `**MAVEN**: Let's use Maven to collect packages from ${basePath}.`,
            );
            if (DEBUG_MODE) {
              console.log(
                `Executing '${basename(mavenCmd)} dependency:tree ...' in ${basePath}`,
              );
            }
            if (isBuildToolRateLimited("maven")) {
              // The parent or plugin run already met the rate limit, so the
              // tree run is skipped rather than repeated for the same answer.
              result = { status: 1 };
            } else {
              result = safeSpawnSync(mavenCmd, mvnTreeArgs, {
                cwd: basePath,
                shell: isWin,
              });
              noteBuildToolRateLimit("maven", commandOutputText(result), {
                command: `${basename(mavenCmd)} ${mvnTreeArgs.join(" ")}`,
                exitCode:
                  typeof result.status === "number" ? result.status : undefined,
              });
              let emptyJson = !safeExistsSync(tempMvnTree);
              if (safeExistsSync(tempMvnTree)) {
                const mvnTreeString = readFileSync(tempMvnTree, {
                  encoding: "utf-8",
                });
                const parsedList = parseMavenTreeJson(mvnTreeString, f);
                if (!parsedList?.pkgList?.length) {
                  emptyJson = true;
                  // Remove the invalid json file so text output is preferred below.
                  if (safeExistsSync(tempMvnTree)) {
                    safeUnlinkSync(tempMvnTree);
                  }
                }
              }
              if (
                !isBuildToolRateLimited("maven") &&
                (result.status !== 0 || result.error || emptyJson)
              ) {
                mvnTreeArgs = [
                  "dependency:tree",
                  `-DoutputFile=${tempMvnTreeText}`,
                ].concat(addArgs, projectSettings.args);
                result = safeSpawnSync(mavenCmd, mvnTreeArgs, {
                  cwd: basePath,
                  shell: isWin,
                });
                noteBuildToolRateLimit("maven", commandOutputText(result), {
                  command: `${basename(mavenCmd)} ${mvnTreeArgs.join(" ")}`,
                  exitCode:
                    typeof result.status === "number"
                      ? result.status
                      : undefined,
                });
              }
            }
            if (result.status !== 0 || result.error) {
              possible_misses = true;
              // Our approach to recursively invoking the maven plugin for each sub-module is bound to result in failures
              // These could be due to a range of reasons that are covered below.
              if (
                !isBuildToolRateLimited("maven") &&
                (pomFiles.length === 1 || DEBUG_MODE || PREFER_MAVEN_DEPS_TREE)
              ) {
                if (result.stdout) {
                  console.log(result.stdout);
                }
                if (result.stderr) {
                  console.log(result.stderr);
                  console.log("The above build errors could be due to:\n");
                }
                if (
                  result.stdout &&
                  (result.stdout.includes("Non-resolvable parent POM") ||
                    result.stdout.includes("points at wrong local POM"))
                ) {
                  console.log(
                    "1. Check if the pom.xml contains valid settings for parent and modules. Some projects can be built only from a specific directory.",
                  );
                } else if (
                  result.stdout &&
                  (result.stdout.includes("Could not resolve dependencies") ||
                    result.stdout.includes(
                      "no dependency information available",
                    ) ||
                    result.stdout.includes(
                      "The following artifacts could not be resolved",
                    ))
                ) {
                  recordDegradation("jvm.maven.build-first", {
                    ecosystem: "java",
                    tool: "maven",
                    impact: "transitive-deps",
                    command: `${basename(mavenCmd)} ${mvnTreeArgs.join(" ")}`,
                    exitCode:
                      typeof result.status === "number"
                        ? result.status
                        : undefined,
                    detail:
                      "Maven could not resolve the project dependencies, so the dependency tree is incomplete.",
                    outputExcerpt: commandOutputText(result),
                  });
                  console.log(
                    "1. Try building the project with 'mvn package -Dmaven.test.skip=true' using the correct version of Java and maven before invoking cdxgen.",
                  );
                } else if (
                  result.stdout?.includes(
                    "Could not resolve target platform specification",
                  )
                ) {
                  console.log(
                    "1. Some projects can be built only from the root directory. Invoke cdxgen with --no-recurse option",
                  );
                } else {
                  console.log(
                    "1. Java version requirement: cdxgen container image bundles Java 24 with maven 3.9 which might be incompatible. Try running cdxgen with the custom JDK11-based image `ghcr.io/cdxgen/cdxgen-java11:v13`.",
                  );
                }
                console.log(
                  "2. Private dependencies cannot be downloaded: Check if any additional arguments must be passed to maven and set them via MVN_ARGS environment variable.",
                );
                console.log(
                  "3. Check if all required environment variables including any maven profile arguments are passed correctly to this tool.",
                );
              }
              // The degradation is recorded before the fail-on-error handling
              // below, so the run that stops here still reports why maven
              // failed and what fixes it.
              recordDegradation("jvm.maven.manifest-fallback", {
                ecosystem: "java",
                tool: "maven",
                impact: "transitive-deps",
                command: `${basename(mavenCmd)} ${mvnTreeArgs.join(" ")}`,
                exitCode:
                  typeof result.status === "number" ? result.status : undefined,
                detail:
                  "The maven dependency tree did not succeed, so at best the direct dependencies parsed from pom.xml are available.",
                outputExcerpt: commandOutputText(result),
              });
              // Do not fall back to methods that can produce incomplete results when failOnError is set
              deferFailOnError(options, {
                ecosystem: "java",
                tool: "maven",
                exitCode:
                  typeof result.status === "number" ? result.status : undefined,
                command: `${mavenCmd} ${mvnTreeArgs.join(" ")}`,
                outputExcerpt: commandOutputText(result),
                detail: "the maven dependency tree command failed",
              });
              console.log(
                "\nFalling back to parsing pom.xml files. Only direct dependencies would get included!",
              );
              thoughtLog(
                "**MAVEN**: There appear to be build errors, so the SBOM will be incomplete.",
              );
              const pomMap = parsePom(f);
              const dlist = pomMap?.dependencies || [];
              if (dlist.length) {
                pkgList = pkgList.concat(dlist);
              }
              if (isBuildToolRateLimited("maven")) {
                // The repository that refused this pom refuses the rest the
                // same way, so no further pom file is run in this scan.
                break;
              }
            } else {
              const treeFile = safeExistsSync(tempMvnTreeText)
                ? tempMvnTreeText
                : tempMvnTree;
              if (safeExistsSync(treeFile)) {
                const mvnTreeString = readFileSync(treeFile, {
                  encoding: "utf-8",
                });
                const parsedList = treeFile.endsWith(".json")
                  ? parseMavenTreeJson(mvnTreeString, f)
                  : parseMavenTree(mvnTreeString, f);
                // The recursive run this output came from resolved the whole
                // reactor this pom aggregates, so its member poms are not run
                // on their own.
                for (const modulePom of resolveReactorPomFiles(f)) {
                  coveredPomFiles.add(modulePom);
                }
                const dlist = parsedList.pkgList || [];
                const tmpParentComponent = dlist.splice(0, 1)[0];
                if (tmpParentComponent) {
                  tmpParentComponent.type = "application";
                }
                if (dlist.length) {
                  pkgList = pkgList.concat(dlist);
                  if (dlist.length > 1) {
                    thoughtLog(
                      `Obtained ${dlist.length} components from maven.`,
                    );
                  } else {
                    thoughtLog(
                      `"Received very few components from the maven dependency tree command for ${basePath}."`,
                    );
                  }
                }
                // Retain the parent hierarchy
                if (!tmpParentComponent) {
                  thoughtLog(
                    `No parseable components were found after executing '${basename(mavenCmd)}'.`,
                  );
                } else if (!Object.keys(parentComponent).length) {
                  parentComponent = tmpParentComponent;
                  parentComponent.components = [];
                } else {
                  parentComponent.components.push(tmpParentComponent);
                }
                if (parsedList?.dependenciesList?.length) {
                  dependencies = mergeDependencies(
                    dependencies,
                    parsedList.dependenciesList,
                    tmpParentComponent,
                  );
                } else {
                  if (dlist?.length) {
                    thoughtLog(
                      `Hmm, I didn't find any dependencies after executing '${basename(mavenCmd)}'. However, I did get ${dlist.length} components, which is confusing.`,
                    );
                  }
                }
              }
            }
          } finally {
            if (!DEBUG_MODE && tempDir?.startsWith(tempRoot)) {
              safeRmSync(tempDir, { recursive: true, force: true });
            }
          }
        }
      } // for
      // Locate and parse all bom.json files from the maven plugin
      if (!useMavenDepsTree) {
        for (const abjson of bomJsonFiles) {
          let bomJsonObj;
          try {
            if (DEBUG_MODE) {
              console.log(`Extracting data from generated bom file ${abjson}`);
            }
            bomJsonObj = JSON.parse(
              readFileSync(abjson, {
                encoding: "utf-8",
              }),
            );
            if (bomJsonObj) {
              if (
                !tools &&
                bomJsonObj.metadata &&
                bomJsonObj.metadata.tools &&
                (Array.isArray(bomJsonObj.metadata.tools) ||
                  bomJsonObj.metadata.tools.components ||
                  bomJsonObj.metadata.tools.services)
              ) {
                tools = bomJsonObj.metadata.tools;
              }
              const toolRefs = extractToolRefs(
                bomJsonObj?.metadata?.tools,
                (tool) => tool?.name !== "cdxgen",
              );
              if (
                bomJsonObj.metadata?.component &&
                !Object.keys(parentComponent).length
              ) {
                parentComponent = bomJsonObj.metadata.component;
                options.parentComponent = parentComponent;
              }
              if (bomJsonObj.components) {
                // Inject evidence into the components. #994
                if (options.specVersion >= 1.5) {
                  // maven would usually generate a target directory closest to the pom.xml
                  // I am sure there would be cases where this assumption is not true :)
                  const srcPomFile = join(dirname(abjson), "..", "pom.xml");
                  for (const acomp of bomJsonObj.components) {
                    if (!acomp.evidence) {
                      acomp.evidence = {
                        identity: {
                          field: "purl",
                          confidence: 0.8,
                          methods: [
                            {
                              technique: "manifest-analysis",
                              confidence: 0.8,
                              value: srcPomFile,
                            },
                          ],
                        },
                      };
                    }
                    if (!acomp.properties) {
                      acomp.properties = [];
                    }
                    acomp.properties.push({
                      name: "internal:SrcFile",
                      value: srcPomFile,
                    });
                    attachIdentityTools(acomp, toolRefs);
                  }
                }
                pkgList = pkgList.concat(bomJsonObj.components);
              }
              if (bomJsonObj.dependencies) {
                dependencies = mergeDependencies(
                  dependencies,
                  bomJsonObj.dependencies,
                  parentComponent,
                );
              }
            }
          } catch (err) {
            if (options.failOnError || DEBUG_MODE) {
              console.log(err);
            }
            deferFailOnError(options, {
              ecosystem: "java",
              tool: "maven",
              detail:
                "reading the BOM generated by the cyclonedx maven plugin failed",
            });
          }
        }
      }
      if (possible_misses) {
        if (gradleFiles.length) {
          console.log(
            "Is this a gradle project? Try running cdxgen with `-t gradle`.",
          );
        } else if (!DEBUG_MODE) {
          console.warn(
            "Multiple errors occurred while building this project with maven. The SBOM is therefore incomplete!",
          );
        }
      }
    }
    const allProjects = [];
    const allProjectsAddedPurls = [];
    const rootDependsOn = new Set();
    const gradleModules = new Map();
    // Determine the root path for gradle
    // Fixes gradle invocation for microservices-demo
    let gradleRootPath = path;
    if (
      gradleFiles?.length &&
      !safeExistsSync(join(path, "settings.gradle")) &&
      !safeExistsSync(join(path, "settings.gradle.kts")) &&
      !safeExistsSync(join(path, "build.gradle")) &&
      !safeExistsSync(join(path, "build.gradle.kts"))
    ) {
      gradleRootPath = dirname(gradleFiles[0]);
    }
    if (safeExistsSync(join(gradleRootPath, "gradle.properties"))) {
      thoughtLog(
        "Hmm, there is a gradle.properties file. Do we need any private modules or custom JVM arguments for this project 🤔?",
      );
    }
    // Execute gradle properties
    if (
      gradleFiles?.length &&
      isPackageManagerAllowed(
        "gradle",
        ["maven", "bazel", "sbt", "mill"],
        options,
      )
    ) {
      const wrapperInfo = readGradleWrapperVersion(gradleRootPath);
      if (wrapperInfo) {
        try {
          const { version: gradleVersion, distributionUrl } = wrapperInfo;
          thoughtLog(
            `Found Gradle wrapper with distributionUrl: ${distributionUrl}, version: ${gradleVersion}`,
          );
          if (!tools) {
            tools = [];
          }
          let toolsArr = tools;
          if (!Array.isArray(toolsArr)) {
            if (toolsArr.components) {
              toolsArr = toolsArr.components;
            } else {
              toolsArr = [];
            }
          }
          if (!toolsArr.find((c) => c.name === "gradle")) {
            let hashes;
            if (wrapperInfo.distributionSha256Sum) {
              hashes = [
                {
                  alg: "SHA-256",
                  content: wrapperInfo.distributionSha256Sum,
                },
              ];
            }
            const gradleComponent = {
              type: "application",
              group: "org.gradle",
              name: "gradle",
              version: gradleVersion,
              externalReferences: [
                {
                  type: "distribution",
                  url: distributionUrl,
                },
              ],
              isExternal: true,
            };
            applyPurl(
              gradleComponent,
              mavenPurl("org.gradle", "gradle", gradleVersion, {
                type: "bin",
              }),
            );
            if (hashes) {
              gradleComponent.hashes = hashes;
            }
            toolsArr.push(gradleComponent);
          }
          if (Array.isArray(tools)) {
            tools = toolsArr;
          } else {
            tools.components = toolsArr;
          }
        } catch (_err) {
          // ignore
        }
      }
      let includedBuilds = [];
      let allProjectsStr = [];
      if (readEnvironmentVariable("GRADLE_INCLUDED_BUILDS")) {
        includedBuilds = readEnvironmentVariable("GRADLE_INCLUDED_BUILDS")
          .split(",")
          .map((b) => (!b.startsWith(":") ? `:${b}` : b));
      }
      const resolveGradleDistribution = isFeatureEnabled(
        options,
        "resolve-gradle-distribution",
      );
      const gradleInitArgs = readEnvironmentVariable("GRADLE_INCLUDED_BUILDS")
        ? []
        : ["--init-script", GRADLE_INIT_SCRIPT];
      if (resolveGradleDistribution && gradleInitArgs.length) {
        gradleInitArgs.push("-PcdxgenResolveDistribution=true");
      }
      // `gradle properties` evaluates the project's build scripts, so it is
      // part of the dependency-tooling surface gated by --no-install-deps
      // (and the pre-build lifecycle).
      const gradleToolingAllowed =
        options.installDeps !== false || options.introspect === true;
      if (gradleToolingAllowed) {
        parallelPropTaskOut = executeParallelGradleProperties(
          gradleRootPath,
          [null].concat(includedBuilds),
          gradleInitArgs,
          options,
        );
      } else {
        console.log(
          "Skipping 'gradle properties' since dependency installation is disabled. Only statically parsed Gradle metadata will be used.",
        );
      }
      if (readEnvironmentVariable("GRADLE_INCLUDED_BUILDS") === undefined) {
        const outputLines = parallelPropTaskOut.split("\n");
        for (const [_i, line] of outputLines.entries()) {
          if (
            line.startsWith("Root project '") ||
            line.startsWith("Project '")
          ) {
            break;
          }
          if (line.startsWith("<CDXGEN:includedBuild>")) {
            const includedBuild = line.split(">");
            if (!includedBuilds.includes(includedBuild[1].trim())) {
              includedBuilds.push(includedBuild[1].trim());
            }
          }
        }
        if (includedBuilds.length > 0) {
          thoughtLog(
            `Wait, this gradle project uses composite builds. I must carefully process these ${includedBuilds.length} projects, in addition to the root.`,
          );
          if (DEBUG_MODE) {
            console.log(
              `Composite builds: ${includedBuilds.join(" ").trim()}.`,
            );
          }
          parallelPropTaskOut = parallelPropTaskOut.concat(
            "\n",
            gradleToolingAllowed
              ? executeParallelGradleProperties(
                  gradleRootPath,
                  includedBuilds,
                  [],
                  options,
                )
              : "",
          );
        }
      }
      const splitPropTaskOut = splitOutputByGradleProjects(
        parallelPropTaskOut,
        ["properties"],
      );
      for (const [key, propTaskOut] of splitPropTaskOut.entries()) {
        const retMap = parseGradleProperties(propTaskOut);
        const rootProject = retMap.rootProject;
        if (rootProject) {
          const rootComponent = await buildObjectForGradleModule(
            rootProject,
            retMap.metadata,
          );
          if (!includedBuilds.includes(key)) {
            parentComponent = rootComponent;
          }
          gradleModules.set(key, rootComponent);
          if (!allProjectsAddedPurls.includes(rootComponent["purl"])) {
            allProjects.push(rootComponent);
            rootDependsOn.add(rootComponent["bom-ref"]);
            allProjectsAddedPurls.push(rootComponent["purl"]);
          }
          allProjectsStr = allProjectsStr.concat(retMap.projects);
        }
      }
      // Get the sub-project properties and set the root dependencies
      if (allProjectsStr?.length) {
        const modulesToSkip = readEnvironmentVariable("GRADLE_SKIP_MODULES")
          ? readEnvironmentVariable("GRADLE_SKIP_MODULES").split(",")
          : [];
        if (modulesToSkip.length) {
          thoughtLog(
            `Good news. I know there are ${allProjectsStr.length} gradle modules at ${gradleRootPath}. I must skip ${modulesToSkip.length} out of these.`,
          );
        }
        parallelPropTaskOut = executeParallelGradleProperties(
          gradleRootPath,
          allProjectsStr.filter((module) => !modulesToSkip.includes(module)),
          [],
          options,
        );
        const splitPropTaskOut = splitOutputByGradleProjects(
          parallelPropTaskOut,
          ["properties"],
        );

        for (const subProject of allProjectsStr) {
          const retMap = parseGradleProperties(
            splitPropTaskOut.get(subProject),
            subProject,
          );
          const rootSubProject = retMap.rootProject;
          if (rootSubProject) {
            const rootSubProjectObj = await buildObjectForGradleModule(
              rootSubProject === "root" ? subProject : rootSubProject,
              retMap.metadata,
            );
            if (!allProjectsAddedPurls.includes(rootSubProjectObj["purl"])) {
              allProjects.push(rootSubProjectObj);
              rootDependsOn.add(rootSubProjectObj["bom-ref"]);
              allProjectsAddedPurls.push(rootSubProjectObj["purl"]);
            }
            gradleModules.set(subProject, rootSubProjectObj);
          }
        }
        // Bug #317 fix
        parentComponent.components = allProjects.flatMap((s) => {
          delete s.qualifiers;
          delete s.evidence;
          return s;
        });
        dependencies.push({
          ref: parentComponent["bom-ref"],
          dependsOn: [...rootDependsOn].sort(),
        });
      }
    }
    if (
      gradleFiles?.length &&
      options.installDeps &&
      isPackageManagerAllowed(
        "gradle",
        ["maven", "bazel", "sbt", "mill"],
        options,
      )
    ) {
      allProjects.push(parentComponent);
      const gradleCmd = getGradleCommand(gradleRootPath, null, options);
      const gradleDepTask = readEnvironmentVariable("GRADLE_DEPENDENCY_TASK")
        ? readEnvironmentVariable("GRADLE_DEPENDENCY_TASK")
        : "dependencies";

      const gradleSubCommands = [];
      let modulesToSkip = readEnvironmentVariable("GRADLE_SKIP_MODULES")
        ? readEnvironmentVariable("GRADLE_SKIP_MODULES").split(",")
        : [];
      if (readEnvironmentVariable("GRADLE_SKIP_MODULE_DEPENDENCIES")) {
        modulesToSkip = modulesToSkip.concat(
          readEnvironmentVariable("GRADLE_SKIP_MODULE_DEPENDENCIES").split(","),
        );
      }
      if (!modulesToSkip.includes("root")) {
        gradleSubCommands.push(gradleDepTask);
      }
      for (const [key, sp] of gradleModules) {
        //create single command for dependencies tasks on all subprojects
        if (sp.purl !== parentComponent.purl && !modulesToSkip.includes(key)) {
          gradleSubCommands.push(`${key}:${gradleDepTask}`);
        }
      }
      const gradleArguments = buildGradleCommandArguments(
        readEnvironmentVariable("GRADLE_ARGS")
          ? readEnvironmentVariable("GRADLE_ARGS").split(" ")
          : [],
        gradleSubCommands,
        readEnvironmentVariable("GRADLE_ARGS_DEPENDENCIES")
          ? readEnvironmentVariable("GRADLE_ARGS_DEPENDENCIES").split(" ")
          : [],
        gradleCmd.length,
      );
      const allOutputs = [];
      for (const gradleArg of gradleArguments) {
        if (isBuildToolRateLimited("gradle")) {
          if (DEBUG_MODE) {
            console.log(
              "Skipping the remaining gradle dependency tasks: the repository rate limited gradle in this scan.",
            );
          }
          break;
        }
        if (DEBUG_MODE) {
          console.log(
            `Executing ${gradleCmd} with arguments ${gradleArg.join(" ").substring(0, 150)}... in ${gradleRootPath}`,
          );
        }
        thoughtLog(
          `Let's invoke '${basename(gradleCmd)}' with the arguments '${gradleArg.join(" ").substring(0, 100)} ...'.`,
        );
        const finalGradleArg = gradleArg.includes("--info")
          ? gradleArg
          : gradleArg.concat(["--info"]);
        const sresult = safeSpawnSync(gradleCmd, finalGradleArg, {
          cwd: gradleRootPath,
          shell: isWin,
        });
        // The dependencies task exits 0 even when resolution failed under a
        // rate limit, so the output decides, not the status.
        noteBuildToolRateLimit("gradle", commandOutputText(sresult), {
          command: `${basename(gradleCmd)} ${finalGradleArg.join(" ")}`,
          exitCode:
            typeof sresult.status === "number" ? sresult.status : undefined,
        });
        if (sresult.status !== 0 || sresult.error) {
          if (options.failOnError || DEBUG_MODE) {
            console.error(sresult.stdout, sresult.stderr);
          }
          recordGradleInvocationFailure(sresult, {
            command: `${gradleCmd} ${finalGradleArg.join(" ")}`,
          });
          deferFailOnError(options, {
            ecosystem: "java",
            tool: "gradle",
            exitCode:
              typeof sresult.status === "number" ? sresult.status : undefined,
            command: `${gradleCmd} ${finalGradleArg.join(" ")}`,
            detail: "the gradle dependencies task failed",
          });
        }
        if (sresult.stdout !== null) {
          allOutputs.push(sresult.stdout);
        }
      }
      const sstdout = allOutputs.join("\n");
      if (sstdout) {
        const cmdOutput = Buffer.from(sstdout).toString();
        const perProjectOutput = splitOutputByGradleProjects(cmdOutput, [
          gradleDepTask,
        ]);
        for (const key of gradleModules.keys()) {
          const parsedList = await parseGradleDep(
            perProjectOutput.has(key) ? perProjectOutput.get(key) : "",
            key,
            gradleModules,
            gradleRootPath,
          );
          const dlist = parsedList.pkgList;
          if (parsedList?.dependenciesList?.length) {
            dependencies = mergeDependencies(
              dependencies,
              parsedList.dependenciesList,
              parentComponent,
            );
          } else {
            if (dlist?.length) {
              thoughtLog(
                `Hmm, I didn't find any dependencies after executing '${basename(gradleCmd)}' for the project ${key}. However, I did get ${dlist.length} components, which is confusing.`,
              );
            }
          }
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
      }
      if (pkgList.length) {
        const fileToUrlMap = parseGradleInfoLogsForUrls(sstdout);
        // When the `resolve-gradle-distribution` feature flag is enabled, the init script
        // probes each repository for the actual artifact and emits the resolved URL keyed
        // by `group:name:version`. This is more accurate than guessing the first repository.
        const resolvedDistributions =
          parseGradleResolvedDistributions(parallelPropTaskOut);

        for (const p of pkgList) {
          if (!p.externalReferences) {
            p.externalReferences = [];
          }
          if (!p.externalReferences.find((r) => r.type === "distribution")) {
            const groupPath = p.group.replace(/\./g, "/");
            const matchPath = `${groupPath}/${p.name}/${p.version}/`;
            let matchedUrl = Object.values(fileToUrlMap).find((url) =>
              url.includes(matchPath),
            );
            if (!matchedUrl) {
              matchedUrl =
                resolvedDistributions[`${p.group}:${p.name}:${p.version}`];
            }
            if (matchedUrl) {
              p.externalReferences.push({
                type: "distribution",
                url: matchedUrl,
              });
            }
          }
        }
        if (parentComponent.components?.length) {
          for (const subProj of parentComponent.components) {
            pkgList = pkgList.filter(
              (pkg) =>
                pkg["bom-ref"] !== subProj["bom-ref"] &&
                pkg["bom-ref"] !== parentComponent["bom-ref"],
            );
          }
        }
        thoughtLog(
          `Obtained ${pkgList.length} components by executing the '${basename(gradleCmd)}' command.`,
        );
        if (DEBUG_MODE) {
          console.log("Obtained", pkgList.length, "from this gradle project.");
        }
      } else if (hasGradleInvocationFailure()) {
        // The invocation failure is already ranked, and an empty
        // configuration is what that failure looks like from here: reporting
        // both would rank two repairs for one broken toolchain.
        thoughtLog(
          "**GRADLE:** No configuration resolved, which the recorded invocation failure already explains.",
        );
      } else {
        recordDegradation("jvm.gradle.unresolved-config", {
          ecosystem: "java",
          tool: "gradle",
          impact: "transitive-deps",
          command: `${basename(gradleCmd)} ${gradleDepTask}`,
          detail:
            "Gradle did not resolve any dependency configuration, so the gradle components carry no resolved dependencies.",
        });
        thoughtLog(
          "**GRADLE:** SBOM is incomplete. I recommend troubleshooting the issue to improve the BOM precision.",
        );
        if (!DEBUG_MODE) {
          console.log(
            "No packages found. Set the environment variable 'CDXGEN_DEBUG_MODE=debug' to troubleshoot any gradle related errors.",
          );
        }
        deferFailOnError(options, {
          ecosystem: "java",
          tool: "gradle",
          detail: "gradle resolved no dependency configuration",
        });
      }
      if (
        (!readEnvironmentVariable("GRADLE_STOP_DAEMON") &&
          (!readEnvironmentVariable("GRADLE_USE_DAEMON") ||
            ["true", "1"].includes(
              readEnvironmentVariable("GRADLE_USE_DAEMON"),
            ))) ||
        ["true", "1"].includes(readEnvironmentVariable("GRADLE_STOP_DAEMON"))
      ) {
        if (DEBUG_MODE) {
          console.log("Stopping gradle daemon...");
        }
        const sresult = safeSpawnSync(gradleCmd, ["--stop"], {
          cwd: gradleRootPath,
          shell: isWin,
        });
        if (sresult.status !== 0 || sresult.error) {
          if (options.failOnError || DEBUG_MODE) {
            console.error(sresult.stdout, sresult.stderr);
          }
          deferFailOnError(options, {
            ecosystem: "java",
            tool: "gradle",
            exitCode:
              typeof sresult.status === "number" ? sresult.status : undefined,
            detail: "stopping the gradle daemon failed",
          });
        }
      }
      // Should we attempt to resolve class names
      if (options.resolveClass || options.deep) {
        const tmpjarNSMapping = await collectJarNS(GRADLE_CACHE_DIR);
        if (tmpjarNSMapping && Object.keys(tmpjarNSMapping).length) {
          jarNSMapping = { ...jarNSMapping, ...tmpjarNSMapping };
        }
      }

      // A version catalog declares coordinates without resolving them, so it
      // is used only when Gradle produced no dependency information at all.
      // The emitted components carry cdx:gradle:catalog=true to mark them as
      // declared rather than resolved.
      if (!pkgList.length) {
        const catalogFiles = getAllFiles(
          path,
          `${options.multiProject ? "**/" : ""}gradle/libs.versions.toml`,
          options,
        );
        for (const catalogFile of catalogFiles) {
          if (DEBUG_MODE) {
            console.log(`Parsing ${catalogFile}`);
          }
          const dlist = parseGradleVersionCatalog(catalogFile);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
      }
    }

    // Bazel
    // Look for the BUILD file only in the root directory
    // NOTE: This can match BUILD files used by perl, so could lead to errors in some projects
    const bazelFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}{WORKSPACE{,.bazel},MODULE.bazel}`,
      options,
    );
    if (
      bazelFiles?.length &&
      !hasAnyProjectType(
        ["docker", "oci", "container", "os"],
        options,
        false,
      ) &&
      isPackageManagerAllowed(
        "bazel",
        ["maven", "gradle", "sbt", "mill"],
        options,
      )
    ) {
      let BAZEL_CMD = "bazel";
      const bazelHome = readEnvironmentVariable("BAZEL_HOME");
      if (bazelHome) {
        BAZEL_CMD = join(bazelHome, "bin", "bazel");
      }

      // bzlmod: parse MODULE.bazel and MODULE.bazel.lock for BCR modules and
      // ecosystem dependencies (Maven, etc.). This works from the manifest and
      // lock alone, so BCR/Maven packages are extracted even when the bazel
      // toolchain is absent. Resolved third-party deps map to their true
      // ecosystem purl (pkg:maven, ...); only BCR modules use pkg:bazel.
      const moduleBazelFiles = bazelFiles.filter(
        (f) => basename(f) === "MODULE.bazel",
      );
      for (const moduleFile of moduleBazelFiles) {
        const baseDir = dirname(moduleFile);
        const moduleResult = parseModuleBazel(moduleFile);
        if (moduleResult.pkgList?.length) {
          pkgList = pkgList.concat(moduleResult.pkgList);
        }
        if (moduleResult.parentComponent?.name) {
          parentComponent = moduleResult.parentComponent;
        }
        const lockFile = join(baseDir, "MODULE.bazel.lock");
        if (safeExistsSync(lockFile)) {
          const lockResult = parseModuleBazelLock(lockFile);
          if (lockResult.pkgList?.length) {
            pkgList = pkgList.concat(lockResult.pkgList);
          }
          if (lockResult.dependencies?.length) {
            dependencies = mergeDependencies(
              dependencies,
              lockResult.dependencies,
            );
          }
        }
      }

      // Querying bazel means building the project first, which is the most
      // expensive thing cdxgen can do and needs network access. Like every other
      // package-manager invocation it therefore runs only when dependency
      // installation is permitted; `--lifecycle pre-build` and secure mode both
      // turn it off, leaving the manifest and lock as the inventory source.
      for (const f of options.installDeps ? bazelFiles : []) {
        const basePath = dirname(f);
        // Invoke bazel build first
        const bazelTarget = readEnvironmentVariable("BAZEL_TARGET") || "//...";
        let bArgs = [
          ...(readEnvironmentVariable("BAZEL_ARGS")?.split(" ") || []),
          "build",
          bazelTarget,
        ];
        // Automatically load any bazelrc file
        if (
          !readEnvironmentVariable("BAZEL_ARGS") &&
          safeExistsSync(join(basePath, ".bazelrc"))
        ) {
          bArgs = ["--bazelrc=.bazelrc", "build", bazelTarget];
        }
        console.log("Executing", BAZEL_CMD, "in", basePath);
        let result = safeSpawnSync(BAZEL_CMD, bArgs, {
          cwd: basePath,
          shell: isWin,
        });
        if (result.status !== 0 || result.error) {
          if (result.stderr) {
            console.error(result.stdout, result.stderr);
          }
          console.log(
            "1. Check if bazel is installed and available in PATH.\n2. Try building your app with bazel prior to invoking cdxgen",
          );
          deferFailOnError(options, {
            ecosystem: "java",
            tool: "bazel",
            exitCode:
              typeof result.status === "number" ? result.status : undefined,
            detail: "the bazel build failed",
          });
        } else {
          const target = readEnvironmentVariable("BAZEL_TARGET") || "//...";
          let query = [
            ...(readEnvironmentVariable("BAZEL_ARGS")?.split(" ") || []),
          ];
          let bazelParser;
          // Automatically load any bazelrc file
          if (
            !readEnvironmentVariable("BAZEL_ARGS") &&
            safeExistsSync(join(basePath, ".bazelrc"))
          ) {
            query = ["--bazelrc=.bazelrc"];
          }
          if (
            ["true", "1"].includes(
              readEnvironmentVariable("BAZEL_USE_ACTION_GRAPH"),
            )
          ) {
            query = query.concat([
              "query",
              `deps(${target})`,
              "--output=label",
            ]);
            bazelParser = parseBazelActionGraph;
          } else {
            query = query.concat([
              "aquery",
              "--output=textproto",
              "--skyframe_state",
            ]);
            bazelParser = parseBazelSkyframe;
          }
          console.log(
            "Executing",
            BAZEL_CMD,
            `${query.join(" ")} in`,
            basePath,
          );
          result = safeSpawnSync(BAZEL_CMD, query, {
            cwd: basePath,
          });
          if (result.status !== 0 || result.error) {
            console.error(result.stdout, result.stderr);
            deferFailOnError(options, {
              ecosystem: "java",
              tool: "bazel",
              exitCode:
                typeof result.status === "number" ? result.status : undefined,
              detail: "the bazel graph query failed",
            });
          }
          const stdout = result.stdout;
          if (stdout) {
            const cmdOutput = Buffer.from(stdout).toString();
            const dlist = bazelParser(cmdOutput);
            if (dlist?.length) {
              pkgList = pkgList.concat(dlist);
            } else {
              console.log(
                "No packages were detected.\n1. Build your project using bazel build command before running cdxgen\n2. Try running the bazel aquery command manually to see if skyframe state can be retrieved.",
              );
              console.log(
                "If your project requires a different query, please file a bug at cyclonedx/cdxgen repo!",
              );
              deferFailOnError(options, {
                ecosystem: "java",
                tool: "bazel",
                detail: "the bazel graph query produced no packages",
              });
            }
          } else {
            console.log("Bazel unexpectedly didn't produce any output");
            deferFailOnError(options, {
              ecosystem: "java",
              tool: "bazel",
              detail: "the bazel graph query unexpectedly produced no output",
            });
          }
        }
      }
    }

    // scala sbt
    // Identify sbt projects via its `project` directory:
    // - all SBT project _should_ define build.properties file with sbt version info
    // - SBT projects _typically_ have some configs/plugins defined in .sbt files
    // - SBT projects that are still on 0.13.x, can still use the old approach,
    //   where configs are defined via Scala files
    // Detecting one of those should be enough to determine an SBT project.
    let sbtProjectFiles = getAllFiles(
      path,
      `${
        options.multiProject ? "**/" : ""
      }project/{build.properties,*.sbt,*.scala}`,
      options,
    );

    let sbtProjects = [];
    for (const i in sbtProjectFiles) {
      // parent dir of sbtProjectFile is the `project` directory
      // parent dir of `project` is the sbt root project directory
      const baseDir = dirname(dirname(sbtProjectFiles[i]));
      sbtProjects = sbtProjects.concat(baseDir);
    }

    // Fallback in case sbt's project directory is non-existent
    if (!sbtProjects.length) {
      sbtProjectFiles = getAllFiles(
        path,
        `${options.multiProject ? "**/" : ""}*.sbt`,
        options,
      );
      for (const i in sbtProjectFiles) {
        const baseDir = dirname(sbtProjectFiles[i]);
        sbtProjects = sbtProjects.concat(baseDir);
      }
    }
    // eliminate duplicates and ignore project directories
    sbtProjects = [...new Set(sbtProjects)].filter(
      (p) => !p.endsWith(`${sep}project`) && !p.includes(`target${sep}`),
    );
    const sbtLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}build.sbt.lock`,
      options,
    );
    if (
      sbtProjects?.length &&
      isPackageManagerAllowed(
        "sbt",
        ["bazel", "maven", "gradle", "mill"],
        options,
      )
    ) {
      // If the project use sbt lock files
      if (sbtLockFiles?.length) {
        for (const f of sbtLockFiles) {
          const dlist = await parseSbtLock(f);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        }
      } else if (options.installDeps === false && !options.introspect) {
        // Executing sbt evaluates the project's build definition (arbitrary
        // Scala), so it belongs to the dependency-tooling surface disabled
        // by --no-install-deps and the pre-build lifecycle.
        console.log(
          "Skipping sbt dependencyTree since dependency installation is disabled. Only statically parsed sbt metadata will be used.",
        );
      } else {
        const SBT_CMD = readEnvironmentVariable("SBT_CMD") || "sbt";
        let sbtVersion = determineSbtVersion(path);
        // If can't find sbt version at the root of repository then search in
        // sbt project array too because sometimes the project folder isn't at
        // root of repository
        if (sbtVersion == null) {
          for (const i in sbtProjects) {
            sbtVersion = determineSbtVersion(sbtProjects[i]);
            if (sbtVersion != null) {
              break;
            }
          }
        }
        if (DEBUG_MODE) {
          console.log(`Detected sbt version: ${sbtVersion}`);
        }
        // Introduced in 1.2.0 https://www.scala-sbt.org/1.x/docs/sbt-1.2-Release-Notes.html#addPluginSbtFile+command,
        // however working properly for real only since 1.3.4: https://github.com/sbt/sbt/releases/tag/v1.3.4
        const standalonePluginFile =
          sbtVersion != null &&
          gte(sbtVersion, "1.3.4") &&
          lte(sbtVersion, "1.4.0");
        const useSlashSyntax = !sbtVersion || gte(sbtVersion, "1.5.0");
        const isDependencyTreeBuiltIn =
          sbtVersion != null && gte(sbtVersion, "1.4.0");
        const tempDir = safeMkdtempSync(join(getTmpDir(), "cdxsbt-"));
        const tempSbtgDir = safeMkdtempSync(join(getTmpDir(), "cdxsbtg-"));
        safeMkdirSync(tempSbtgDir, { recursive: true });
        // Create temporary plugins file
        const tempSbtPlugins = join(tempSbtgDir, "dep-plugins.sbt");

        // Requires a custom version of `sbt-dependency-graph` that
        // supports `--append` for `toFile` subtask.
        let sbtPluginDefinition = `\naddSbtPlugin("io.shiftleft" % "sbt-dependency-graph" % "0.10.0-append-to-file3")\n`;
        if (isDependencyTreeBuiltIn) {
          sbtPluginDefinition = "\naddDependencyTreePlugin\n";
          if (DEBUG_MODE) {
            console.log("Using addDependencyTreePlugin as the custom plugin");
          }
        }
        safeWriteSync(tempSbtPlugins, sbtPluginDefinition);
        // sbt resolves into the user's own caches, so a project that has been
        // built resolves without the network. The dependency trees download
        // the jar of every dependency they list, which is all --deep reads.
        const env = { ...process.env };
        for (const i in sbtProjects) {
          if (isBuildToolRateLimited("sbt")) {
            // Every remaining sbt build in this scan resolves from the same
            // rate limited repository.
            if (DEBUG_MODE) {
              console.log(
                `Skipping ${sbtProjects[i]}: the repository rate limited sbt in this scan.`,
              );
            }
            break;
          }
          const basePath = sbtProjects[i];
          const dlFile = join(tempDir, `dl-${i}.tmp`);
          // The sbt version of the project itself decides the invocation
          // form: sbt 2 both joins separate command-line arguments into a
          // single command line and no longer offers `dependencyTree / toFile`.
          const projectSbtVersion = determineSbtVersion(basePath) || sbtVersion;
          const isSbt2 =
            projectSbtVersion != null && gte(projectSbtVersion, "2.0.0");
          // The sbt 2 launcher runs a thin client by default. When a server is
          // already running for the build, an IDE's for example, the client
          // prints neither the project list nor the trees, so sbt runs
          // in-process instead. sbt.bat has no `--server` option.
          const sbtLauncherArgs = isSbt2 && !isWin ? ["--server"] : [];
          const sbtServerFile = join(
            basePath,
            "project",
            "target",
            "active.json",
          );
          const sbtServerWasRunning = isSbt2 && safeExistsSync(sbtServerFile);
          let sbtArgs = [];
          let pluginFile = null;
          const subDlFiles = [];
          const failedSubprojects = [];
          let subprojects = [];
          if (standalonePluginFile) {
            sbtArgs = [
              `-addPluginSbtFile=${tempSbtPlugins}`,
              `"dependencyList::toFile ${dlFile} --force"`,
            ];
            subDlFiles.push(dlFile);
          } else {
            // write to the existing plugins file
            // Discover the real sbt project ids by asking sbt itself, falling
            // back to the regex-based heuristic if that fails. A per-subproject
            // `dependencyTree` fan-out yields a far more complete tree than a
            // single root resolution (which only captures the root project's own
            // libraryDependencies). See https://github.com/cdxgen/cdxgen/issues/4291
            subprojects = discoverSbtProjectsFromCmd(
              basePath,
              SBT_CMD,
              env,
              sbtLauncherArgs,
            );
            if (isSbt2) {
              // The trees are read from the captured stdout of one session.
              sbtArgs = [sbt2DependencyTreeCommand(subprojects)];
            } else if (subprojects.length > 0 && useSlashSyntax) {
              sbtArgs = ["'set ThisBuild / asciiGraphWidth := 800'"];
              for (const sp of subprojects) {
                const subDlFile = join(tempDir, `dl-${i}-${sp}.tmp`);
                subDlFiles.push(subDlFile);
                sbtArgs.push(
                  `"${sp}/dependencyTree / toFile ${subDlFile} --force"`,
                );
              }
            } else if (useSlashSyntax) {
              sbtArgs = [
                `'set ThisBuild / asciiGraphWidth := 800' "dependencyTree / toFile ${dlFile} --force"`,
              ];
              subDlFiles.push(dlFile);
            } else {
              sbtArgs = [
                `'set asciiGraphWidth in ThisBuild := 800' "dependencyTree::toFile ${dlFile} --force"`,
              ];
              subDlFiles.push(dlFile);
            }
            pluginFile = addPlugin(basePath, sbtPluginDefinition);
          }
          // Run sbt in non-interactive batch mode so it never blocks waiting for
          // input on stdin (which can otherwise appear as an indefinite hang) and
          // does not emit ANSI colour codes into the dependency tree output.
          sbtArgs = [...sbtLauncherArgs, "-batch", "-no-colors", ...sbtArgs];
          console.log(
            "Executing",
            SBT_CMD,
            sbtArgs.join(" "),
            "in",
            basePath,
            "using plugins",
            tempSbtgDir,
          );
          // Note that the command has to be invoked with `shell: true` to properly execut sbt
          // sbt 2 is the exception: its ;-joined command argument contains a
          // semicolon, so on POSIX the launcher is spawned directly and the
          // argument reaches sbt verbatim.
          const result = sbtSpawnSync(
            SBT_CMD,
            sbtArgs,
            {
              cwd: basePath,
              shell: isWin || !isSbt2 || standalonePluginFile,
              // The sbt commands below embed their own shell quoting, which the
              // shell must strip for sbt to see separate commands.
              cdxgenRawShellArgs: true,
              env,
            },
            !isSbt2 || standalonePluginFile,
          );
          noteBuildToolRateLimit("sbt", commandOutputText(result), {
            command: `${SBT_CMD} ${sbtArgs.join(" ")}`,
            exitCode:
              typeof result.status === "number" ? result.status : undefined,
          });
          if (result.status !== 0 || result.error) {
            if (!isBuildToolRateLimited("sbt")) {
              console.error(result.stdout, result.stderr);
            }
            recordDegradation("jvm.sbt.no-lockfile", {
              ecosystem: "java",
              tool: "sbt",
              impact: "versions",
              command: `${SBT_CMD} ${sbtArgs.join(" ")}`,
              exitCode:
                typeof result.status === "number" ? result.status : undefined,
              detail:
                "The sbt dependencyTree command did not succeed, so the declared sbt dependencies are the only evidence available.",
            });
            if (!isBuildToolRateLimited("sbt")) {
              console.log(
                "1. Check if scala and sbt is installed and available in PATH. Only scala 2.10 + sbt 0.13.6+ and 2.12 + sbt 1.0+ is supported for now.",
              );
              console.log(
                "2. Check if the plugin net.virtual-void:sbt-dependency-graph 0.10.0-RC1 can be used in the environment",
              );
              console.log(
                "3. Consider creating a lockfile using sbt-dependency-lock plugin. See https://github.com/stringbean/sbt-dependency-lock",
              );
            }
            deferFailOnError(options, {
              ecosystem: "java",
              tool: "sbt",
              exitCode:
                typeof result.status === "number" ? result.status : undefined,
              command: `${SBT_CMD} ${sbtArgs.join(" ")}`,
              detail: "the sbt dependencyTree command failed",
            });
          } else if (!standalonePluginFile && isSbt2) {
            // Write the captured session stdout and split it into one file
            // per project tree, so every subproject keeps its own root.
            safeWriteSync(dlFile, result.stdout || "");
            const treeChunks = splitSbtDependencyTrees(result.stdout || "");
            for (const [ci, chunk] of treeChunks.entries()) {
              const chunkFile = join(tempDir, `dl-${i}-${ci}.tmp`);
              safeWriteSync(chunkFile, chunk);
              subDlFiles.push(chunkFile);
            }
          }
          // One failing subproject (for example an unresolvable SNAPSHOT)
          // fails the combined command and would zero the whole SBOM. Retry
          // each subproject on its own and keep the trees that succeed. A rate
          // limited repository ends the retries as well: each would download
          // the same artifacts against the same 429.
          if (
            !standalonePluginFile &&
            subprojects.length > 0 &&
            (result.status !== 0 || result.error) &&
            !isBuildToolRateLimited("sbt")
          ) {
            for (const sp of subprojects) {
              const subDlFile = join(tempDir, `dl-${i}-${sp}.tmp`);
              if (!isSbt2 && safeExistsSync(subDlFile)) {
                // The combined run produced this tree before it failed.
                continue;
              }
              if (DEBUG_MODE) {
                console.log(`Retrying the sbt tree of ${sp} on its own.`);
              }
              let retryArgs;
              if (isSbt2) {
                retryArgs = [
                  ...sbtLauncherArgs,
                  "-batch",
                  "-no-colors",
                  sbt2DependencyTreeCommand([sp]),
                ];
              } else if (useSlashSyntax) {
                retryArgs = [
                  "-batch",
                  "-no-colors",
                  "'set ThisBuild / asciiGraphWidth := 800'",
                  `"${sp}/dependencyTree / toFile ${subDlFile} --force"`,
                ];
              } else {
                continue;
              }
              const retryResult = sbtSpawnSync(
                SBT_CMD,
                retryArgs,
                {
                  cwd: basePath,
                  shell: isWin || !isSbt2,
                  cdxgenRawShellArgs: true,
                  env,
                },
                !isSbt2,
              );
              if (isSbt2) {
                const retryChunks = splitSbtDependencyTrees(
                  retryResult.stdout || "",
                );
                if (retryResult.status === 0 && !retryResult.error) {
                  for (const [ci, chunk] of retryChunks.entries()) {
                    const chunkFile = join(
                      tempDir,
                      `dl-${i}-retry-${sp}-${ci}.tmp`,
                    );
                    safeWriteSync(chunkFile, chunk);
                    subDlFiles.push(chunkFile);
                  }
                }
                if (!retryChunks.length) {
                  failedSubprojects.push(sp);
                }
              } else if (safeExistsSync(subDlFile)) {
                subDlFiles.push(subDlFile);
              } else {
                failedSubprojects.push(sp);
              }
            }
            if (failedSubprojects.length) {
              console.log(
                `The sbt dependency trees of ${failedSubprojects.join(", ")} could not be resolved.`,
              );
            }
          }
          // Where the thin client still runs, it leaves the server it started
          // behind. A server that was running before the scan is not ours to
          // stop.
          if (isSbt2 && !sbtServerWasRunning && safeExistsSync(sbtServerFile)) {
            sbtSpawnSync(SBT_CMD, ["-batch", "-no-colors", "shutdown"], {
              cwd: basePath,
              shell: isWin,
              env,
            });
          }
          if (!standalonePluginFile) {
            cleanupPlugin(basePath, pluginFile);
          }
          const sbtSubprojectRoots = [];
          for (const subDlFile of subDlFiles) {
            if (safeExistsSync(subDlFile)) {
              // The trees are temporary files that go away with the scan, so
              // the components name the build definition they were resolved
              // from instead: build.sbt, or for a build written only in
              // project/*.scala, the build.properties beside it.
              const sbtBuildFile =
                [
                  join(basePath, "build.sbt"),
                  join(basePath, "project", "build.properties"),
                ].find((f) => safeExistsSync(f)) || basePath;
              const retMap = await parseSbtTree(subDlFile, sbtBuildFile);
              if (retMap.pkgList?.length) {
                const tmpParentComponent = retMap.pkgList.splice(0, 1)[0];
                tmpParentComponent.type = "application";
                pkgList = pkgList.concat(retMap.pkgList);
                pkgList.push(tmpParentComponent);
                sbtSubprojectRoots.push(tmpParentComponent);
              }
              if (retMap.dependenciesList) {
                dependencies = mergeDependencies(
                  dependencies,
                  retMap.dependenciesList,
                  parentComponent,
                );
              }
            } else {
              if (options.failOnError || DEBUG_MODE) {
                console.log(`sbt dependencyList did not yield ${subDlFile}`);
              }
              if (options.failOnError) {
                deferFailOnError(options, {
                  ecosystem: "java",
                  tool: "sbt",
                  detail: "the sbt dependencyList output was missing",
                });
              }
            }
          }
          // Construct a synthetic root component from build.sbt name/org/version
          // that aggregates all subproject roots as its direct dependencies.
          const sbtRoot = parseSbtRootProject(basePath);
          if (sbtRoot && sbtSubprojectRoots.length > 0) {
            const rootPurl = build({
              type: "maven",
              namespace: sbtRoot.group || null,
              name: sbtRoot.name,
              version: sbtRoot.version || null,
              qualifiers: { type: "jar" } || null,
            });
            const rootComponent = {
              group: sbtRoot.group,
              name: sbtRoot.name,
              version: sbtRoot.version,
              type: "application",
              purl: rootPurl,
              "bom-ref": decodeURIComponent(rootPurl),
            };
            parentComponent = rootComponent;
            dependencies.push({
              ref: decodeURIComponent(rootPurl),
              dependsOn: sbtSubprojectRoots
                .map((c) => c["bom-ref"])
                .filter(Boolean),
            });
          } else if (sbtSubprojectRoots.length > 0 && !parentComponent) {
            parentComponent = sbtSubprojectRoots[0];
          }
          if (failedSubprojects.length && parentComponent?.name) {
            parentComponent.properties ??= [];
            parentComponent.properties.push({
              name: "cdx:sbt:failedProjects",
              value: failedSubprojects.join(", "),
            });
          }
        }

        // The trees were parsed inside the loop, so neither directory is
        // needed any more.
        safeRmSync(tempDir, { recursive: true, force: true });
        safeRmSync(tempSbtgDir, { recursive: true, force: true });
      } // else

      if (DEBUG_MODE) {
        console.log(`Found ${pkgList.length} packages`);
      }
      // Should we attempt to resolve class names
      if (options.resolveClass || options.deep) {
        const tmpjarNSMapping = await collectSbtDependencyJars(
          pkgList,
          jarNSMapping,
        );
        if (tmpjarNSMapping && Object.keys(tmpjarNSMapping).length) {
          jarNSMapping = { ...jarNSMapping, ...tmpjarNSMapping };
        }
        // sbt can store jars in the target directory
        const jarNSData = await createJarBom(path, options);
        if (jarNSData?.bomJson?.components) {
          pkgList = pkgList.concat(jarNSData?.bomJson?.components);
          const targetJarNSMapping = {};
          for (const p of jarNSData.bomJson.components) {
            if (!p?.purl || !p?.properties?.length) {
              continue;
            }
            const nsProp = p.properties.filter(
              (prop) => prop.name === "internal:Namespaces",
            );
            if (nsProp.length) {
              targetJarNSMapping[p.purl] = nsProp[0].value;
            }
          }
          jarNSMapping = { ...jarNSMapping, ...targetJarNSMapping };
        }
      }
    }

    if (
      millFiles?.length &&
      (options.installDeps !== false || options.introspect === true) &&
      isPackageManagerAllowed(
        "mill",
        ["bazel", "sbt", "gradle", "maven"],
        options,
      )
    ) {
      const millRootPath = dirname(millFiles[0]);
      parentComponent = createDefaultParentComponent(
        millRootPath,
        "maven",
        options,
      );
      const millCmd = getMillCommand(millRootPath, options);
      // Mill 1.0 replaced the ivyDepsTree task with showMvnDepsTree
      const millVersion = getMillVersion(millRootPath, millCmd);
      const millTreeTask =
        millVersion != null && gte(millVersion, "1.0.0")
          ? "showMvnDepsTree"
          : "ivyDepsTree";
      const millCommonArgs = [
        "--color",
        "false",
        "--disable-callgraph",
        "--disable-prompt",
        "--keep-going",
        "--silent",
      ];
      if (!["true", "1"].includes(readEnvironmentVariable("MILL_USE_SERVER"))) {
        millCommonArgs.unshift("--no-server");
      }
      const millArgs = [...millCommonArgs, `__.${millTreeTask}`];
      if (DEBUG_MODE) {
        console.log("Executing", millCmd, "in", millRootPath);
      }
      let sresult = safeSpawnSync(millCmd, millArgs, {
        cwd: millRootPath,
        shell: isWin,
        maxBuffer: MAX_BUFFER * 10,
      });
      noteBuildToolRateLimit("mill", commandOutputText(sresult), {
        command: `${basename(millCmd)} ${millArgs.join(" ")}`,
        exitCode:
          typeof sresult.status === "number" ? sresult.status : undefined,
      });
      if (sresult.status !== 0 || sresult.error) {
        if (options.failOnError || DEBUG_MODE) {
          console.error(sresult.stdout, sresult.stderr);
        }
        deferFailOnError(options, {
          ecosystem: "java",
          tool: "mill",
          exitCode:
            typeof sresult.status === "number" ? sresult.status : undefined,
          detail: "the mill dependency tree command failed",
        });
      }
      const millResolveArgs = [
        ...millCommonArgs,
        "resolve",
        `__.${millTreeTask}`,
      ];
      if (!isBuildToolRateLimited("mill") && DEBUG_MODE) {
        console.log(
          "Executing",
          millCmd,
          millResolveArgs.join(" "),
          "in",
          millRootPath,
        );
      }
      // The resolve run asks the same repository for the same modules, so a
      // rate limited tree run ends it. Without it there is no module list to
      // parse either.
      if (!isBuildToolRateLimited("mill")) {
        sresult = safeSpawnSync(millCmd, millResolveArgs, {
          cwd: millRootPath,
          shell: isWin,
        });
        noteBuildToolRateLimit("mill", commandOutputText(sresult), {
          command: `${basename(millCmd)} ${millResolveArgs.join(" ")}`,
          exitCode:
            typeof sresult.status === "number" ? sresult.status : undefined,
        });
        if (sresult.status !== 0 || sresult.error) {
          if (options.failOnError || DEBUG_MODE) {
            console.error(sresult.stdout, sresult.stderr);
          }
          deferFailOnError(options, {
            ecosystem: "java",
            tool: "mill",
            exitCode:
              typeof sresult.status === "number" ? sresult.status : undefined,
            detail: "the mill resolve command failed",
          });
        }
      }
      const sstdout = isBuildToolRateLimited("mill")
        ? undefined
        : sresult.stdout;
      if (sstdout) {
        parentComponent.components = [];
        const modules = sstdout
          .trim()
          .split("\n")
          // Mill 1.x prints headers around the module list
          .filter((a) => a.endsWith(`.${millTreeTask}`))
          .map((a) => a.substring(0, a.lastIndexOf(".")))
          .filter((a) =>
            ["true", "1"].includes(readEnvironmentVariable("MILL_EXCLUDE_TEST"))
              ? !a.endsWith(".test")
              : true,
          );
        const moduleBomRefs = [];
        const packages = new Map();
        const relations = new Map();
        relations.set(parentComponent["bom-ref"], []);
        for (const module of modules) {
          moduleBomRefs.push(
            parseMillDependency(
              module,
              packages,
              relations,
              millRootPath,
              `${millTreeTask}.log`,
            ),
          );
        }
        for (const module of moduleBomRefs) {
          parentComponent.components.push(packages.get(module));
          relations.get(parentComponent["bom-ref"]).push(module);
          packages.delete(module);
        }
        const newDependencies = [];
        for (const [ref, dependsOn] of relations.entries()) {
          newDependencies.push({
            ref,
            dependsOn,
          });
        }
        if (DEBUG_MODE) {
          console.log(
            `Obtained ${packages.size} components and ${relations.size} dependencies from mill.`,
          );
        }
        pkgList = pkgList.concat(...packages.values());
        dependencies = mergeDependencies(
          dependencies,
          newDependencies,
          parentComponent,
        );
      }
      if (
        (!readEnvironmentVariable("MILL_SHUTDOWN_SERVER") &&
          ["true", "1"].includes(readEnvironmentVariable("MILL_USE_SERVER"))) ||
        ["true", "1"].includes(readEnvironmentVariable("MILL_SHUTDOWN_SERVER"))
      ) {
        if (DEBUG_MODE) {
          console.log("Shutting down mill server...");
        }
        const sresult = safeSpawnSync(millCmd, ["shutdown"], {
          cwd: millRootPath,
          shell: isWin,
        });
        if (sresult.status !== 0 || sresult.error) {
          if (options.failOnError || DEBUG_MODE) {
            console.error(sresult.stdout, sresult.stderr);
          }
          deferFailOnError(options, {
            ecosystem: "java",
            tool: "mill",
            exitCode:
              typeof sresult.status === "number" ? sresult.status : undefined,
            detail: "shutting down the mill server failed",
          });
        }
      }
    }
    // scala-cli projects declare everything with //> using directives in
    // their sources and have none of the build files handled above.
    if (
      !pomFiles?.length &&
      !gradleFiles?.length &&
      !millFiles?.length &&
      !sbtProjects.length &&
      isPackageManagerAllowed(
        "scala-cli",
        ["bazel", "sbt", "gradle", "maven", "mill"],
        options,
      )
    ) {
      const dlist = collectScalaCliComponents(path, options);
      if (dlist?.length) {
        thoughtLog(
          `**SCALA-CLI**: Found ${dlist.length} declared dependencies.`,
        );
        pkgList = pkgList.concat(dlist);
        if (!parentComponent?.name) {
          parentComponent = createDefaultParentComponent(
            path,
            "maven",
            options,
          );
        }
      }
    }
  } catch (err) {
    if (!isDeferredFailOnError(err)) {
      throw err;
    }
    // The deferred fail-on-error abort kept everything collected so far;
    // the incomplete-result fallbacks stayed skipped.
    thoughtLog(
      "Completing the java BOM with the components collected before the deferred failure.",
    );
  } finally {
    // A build this scan ran can have started a Mill daemon of its own
    // without --no-server; stop those even when a later step failed.
    stopMillDaemons(path, millDaemonsBefore);
  }
  // A Scala.js build bundles npm packages: scalajs-bundler installs them
  // under target, and a bundler workspace keeps its lock file beside the
  // build. Their npm components join the BOM so module imports can be
  // attributed to them, and the project depends on the workspaces' direct
  // dependencies.
  try {
    const scalajsNpm = await collectScalaJsNpmComponents(
      path,
      pkgList,
      options,
    );
    if (scalajsNpm.components.length) {
      pkgList = pkgList.concat(scalajsNpm.components);
      const npmEdges = [...scalajsNpm.dependencies];
      if (parentComponent?.["bom-ref"] && scalajsNpm.roots.length) {
        npmEdges.push({
          ref: parentComponent["bom-ref"],
          dependsOn: scalajsNpm.roots,
        });
      }
      dependencies = mergeDependencies(dependencies, npmEdges, parentComponent);
    }
  } catch (err) {
    if (DEBUG_MODE) {
      console.log("Unable to collect the Scala.js npm dependencies", err);
    }
  }
  // Deduplication and metadata belong to whatever was collected, so they run
  // on the deferred path too.
  pkgList = trimComponents(pkgList);
  // --deep collects namespaces; it does not opt in to remote licence lookups,
  // which FETCH_LICENSE controls. The project's own modules are never looked
  // up remotely: they are not published.
  pkgList = await getMvnMetadata(pkgList, jarNSMapping, false, {
    skipPurls: ownComponentRefs(parentComponent),
  });
  return buildBomNSData(options, pkgList, "maven", {
    src: path,
    nsMapping: jarNSMapping,
    dependencies,
    parentComponent,
    tools,
  });
}
