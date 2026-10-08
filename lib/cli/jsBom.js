import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { platform as _platform, arch } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";

import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
  recordSensitiveFileRead,
} from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { deferFailOnError } from "../core/deferredExit.js";
import {
  hasAnyProjectType,
  isPackageManagerAllowed,
  shouldFetchPackageMetadata,
} from "../core/env.js";
import { getAllFiles, safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import {
  cleanupAsarTempDir,
  extractAsarToTempDir,
  isAsarArchiveSync,
  parseAsarArchive,
  rewriteExtractedArchivePaths,
} from "../ecosystems/asarutils.js";
import { parseBunLock } from "../ecosystems/bunutils.js";
import {
  enrichCaxaMetadataFromApp,
  parseCaxaMetadata,
} from "../ecosystems/caxa.js";
import {
  CHROME_EXTENSION_PURL_TYPE,
  collectChromeExtensionsFromPath,
  collectInstalledChromeExtensions,
  discoverChromiumExtensionDirs,
} from "../ecosystems/chromextutils.js";
import {
  findDenoJson,
  parseDenoJsonFile,
  parseDenoLock,
} from "../ecosystems/denoutils.js";
import { getNpmMetadata } from "../ecosystems/ecosystems.js";
import { addEvidenceForImports } from "../ecosystems/jsEvidence.js";
import {
  createNpmWorkspacePurl,
  loadNpmrcConfig,
} from "../ecosystems/npmutils.js";
import {
  parseBowerJson,
  parseMinJs,
  parseNodeShrinkwrap,
  parsePkgJson,
  parsePkgLock,
  parsePnpmLock,
  parsePnpmWorkspace,
  parseYarnLock,
  parseYarnWorkspace,
} from "../ecosystems/parsers-js.js";
import {
  fetchHuggingFaceAssetInventory,
  normalizeHuggingFaceReference,
} from "../ecosystems/remote/huggingface.js";
import {
  AGENTIC_TOOL_PURL_TYPE,
  collectAgenticTools,
} from "../helpers/agenticToolutils.js";
import {
  cleanupTempDir,
  collectInstalledExtensions,
  discoverIdeExtensionDirs,
  extractVsixToTempDir,
  parseVsixFile,
  VSCODE_EXTENSION_PURL_TYPE,
} from "../helpers/vsixutils.js";
import {
  collectAiInventory,
  filterInventoryDependencies,
  filterInventorySubjectsByTypes,
  summarizeAiInventory,
} from "../inventory/aiInventory.js";
import {
  detectMcpInventory,
  findJSImportsExports,
} from "../inventory/analyzer.js";
import {
  markNpmTypesPackagesAsExcluded,
  markTypeOnlyDependenciesOptional,
  mergeDependencies,
  mergeServices,
  propagateRequiredScopeFromDependencies,
  trimComponents,
} from "../inventory/depsUtils.js";
import { GIT_COMMAND } from "../inventory/envcontext.js";
import { tryBuildPurl } from "../inventory/purl.js";
import { DEFAULT_NPMRC_BLOCKLIST, parseNpmrc } from "../parsers/npmrc.js";
import {
  buildBomNSData,
  createDefaultParentComponent,
  filterIncludedAiInventoryTypes,
  getExactAiInventoryType,
  getExcludedAiInventoryTypes,
  getIncludedAiInventoryTypes,
  getRequestedAiInventoryTypes,
  hasExplicitProjectTypeSelection,
  shouldDetectMcpInventory,
} from "./bomAssembly.js";

const isWin = _platform() === "win32";

/**
 * Detects an exact AI inventory type from a direct HuggingFace reference or a
 * local Modelfile/`.gguf` file input. Returns the explicit selection from
 * `getExactAiInventoryType` when one is present.
 *
 * Direct HuggingFace interpretation of the source path is opt-in: only
 * unambiguous references (`pkg:huggingface/...` purls and huggingface.co
 * URLs) are recognized on their own. Bare `owner/repo`-shaped values are
 * ordinary relative paths (eg: `repotests/sveltejs-realworld`) unless an AI
 * inventory type such as `-t ai` is explicitly selected, in which case
 * `getExactAiInventoryType` already returned it above.
 *
 * @param {string} path Project or file path
 * @param {object} options CLI options
 * @returns {string|undefined} The detected AI inventory type (`"ai"`) or undefined
 */
export function getDirectAiInventoryType(path, options) {
  const exactAiInventoryType = getExactAiInventoryType(options);
  if (exactAiInventoryType) {
    return exactAiInventoryType;
  }
  if (normalizeHuggingFaceReference(path, { explicitOnly: true })) {
    return "ai";
  }
  try {
    const stat = lstatSync(path);
    if (
      stat.isFile() &&
      (basename(path) === "Modelfile" ||
        basename(path).startsWith("Modelfile.") ||
        path.toLowerCase().endsWith(".gguf"))
    ) {
      return "ai";
    }
  } catch {
    // ignore invalid local direct inputs
  }
  return undefined;
}

/**
 * Main Node.js/npm BOM generator. Parses manifests, lockfiles, and import
 * evidence to assemble components, dependencies, formulation data, AI inventory,
 * and the parent component for a Node.js project.
 *
 * @param {string} path Path to the project
 * @param {object} options CLI options
 * @returns {Promise<object>} Promise resolving to a BOM namespace data object
 */
export async function createNodejsBom(path, options) {
  let pkgList = [];
  let manifestFiles = [];
  let dependencies = [];
  let parentComponent = {};
  const parentSubComponents = [];
  let ppurl = "";
  const exactAiInventoryType = getDirectAiInventoryType(path, options);
  const requestedAiInventoryTypes = getRequestedAiInventoryTypes(options);
  const excludedAiInventoryTypes = getExcludedAiInventoryTypes(options);
  const includedAiInventoryTypes = exactAiInventoryType
    ? filterIncludedAiInventoryTypes(
        [exactAiInventoryType],
        excludedAiInventoryTypes,
      )
    : filterIncludedAiInventoryTypes(
        [...getIncludedAiInventoryTypes(options), ...requestedAiInventoryTypes],
        excludedAiInventoryTypes,
      );
  let aiInventory = { components: [], dependencies: [], services: [] };
  // A value that exists on the local filesystem is always a project path -
  // never a remote model id - so existing inputs skip remote resolution.
  const directHuggingFaceSource =
    exactAiInventoryType === "ai" && !safeExistsSync(path)
      ? normalizeHuggingFaceReference(path)
      : undefined;
  if (directHuggingFaceSource?.repoId) {
    const inventory = await fetchHuggingFaceAssetInventory(
      directHuggingFaceSource.assetType,
      directHuggingFaceSource.repoId,
      {
        ...options,
        resolveHuggingFaceRemote: true,
        version: directHuggingFaceSource.version,
      },
    );
    if (inventory?.primaryComponent) {
      parentComponent = createDefaultParentComponent(path, "generic", options);
      return buildBomNSData(options, inventory.components, "generic", {
        dependencies: inventory.dependencies || [],
        filename: path,
        parentComponent,
        projectType: exactAiInventoryType,
        services: [],
        src: path,
      });
    }
  }
  if (exactAiInventoryType === "ai" || exactAiInventoryType === "ai-skill") {
    aiInventory = collectAiInventory(path, options, includedAiInventoryTypes);
    const exactComponents = trimComponents([...(aiInventory.components || [])]);
    const exactDependencies = mergeDependencies([], aiInventory.dependencies);
    const exactServices = mergeServices([], aiInventory.services);
    parentComponent = createDefaultParentComponent(path, "generic", options);
    return buildBomNSData(options, exactComponents, "generic", {
      dependencies: exactDependencies,
      filename: path,
      parentComponent,
      projectType: exactAiInventoryType,
      services: exactServices,
      src: path,
    });
  }
  // Docker mode requires special handling
  if (hasAnyProjectType(["docker", "oci", "container", "os"], options, false)) {
    const pkgJsonFiles = getAllFiles(path, "**/package.json", options);
    // Are there any package.json files in the container?
    if (pkgJsonFiles.length) {
      // Every manifest is read locally first, and the registry is asked about
      // the ones still missing fields in one round, rather than once per file.
      const npmrcConfig = loadNpmrcConfig(path);
      for (const pj of pkgJsonFiles) {
        const dlist = await parsePkgJson(pj, false, false, {
          fetchMetadata: false,
        });
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
      if (shouldFetchPackageMetadata() && pkgList.length) {
        pkgList = await getNpmMetadata(pkgList, undefined, { npmrcConfig });
      }
      if (includedAiInventoryTypes.length) {
        aiInventory = collectAiInventory(
          path,
          options,
          includedAiInventoryTypes,
        );
      }
      if (aiInventory.components?.length) {
        pkgList = trimComponents(pkgList.concat(aiInventory.components));
      }
      return buildBomNSData(options, pkgList, "npm", {
        allImports: {},
        src: path,
        filename: "package.json",
        dependencies: mergeDependencies(
          [],
          aiInventory.dependencies,
          parentComponent,
        ),
        parentComponent,
        services: aiInventory.services,
      });
    }
  }
  let allImports = {};
  let allExports = {};
  let mcpInventory = {};
  if (
    !hasAnyProjectType(["docker", "oci", "container", "os"], options, false) &&
    !options.noBabel
  ) {
    if (DEBUG_MODE) {
      console.log(
        `Performing babel-based package usage analysis with source code at ${path}`,
      );
    }
    const retData = await findJSImportsExports(path, options);
    allImports = retData.allImports;
    allExports = retData.allExports;
    if (shouldDetectMcpInventory(includedAiInventoryTypes)) {
      mcpInventory = detectMcpInventory(path, options.deep);
    }
  }
  if (includedAiInventoryTypes.length) {
    aiInventory = collectAiInventory(path, options, includedAiInventoryTypes);
  }
  const aiInventorySummary = summarizeAiInventory(aiInventory);
  if (!exactAiInventoryType) {
    if (
      aiInventorySummary.aiComponentCount ||
      aiInventorySummary.aiServiceCount
    ) {
      thoughtLog(
        `I found ${aiInventorySummary.aiComponentCount} AI asset component(s) and ${aiInventorySummary.aiServiceCount} AI service(s) from JavaScript usage signals. Use --exclude-type ai to drop them from the BOM.`,
      );
    }
    if (aiInventorySummary.instructionCount || aiInventorySummary.skillCount) {
      thoughtLog(
        `I found ${aiInventorySummary.instructionCount + aiInventorySummary.skillCount} AI skill/instruction file component(s). Use '--exclude-type ai-skill' for a package-only BOM, or '--bom-audit --bom-audit-categories ai-inventory' for review-friendly reporting.`,
      );
    }
    if (aiInventorySummary.mcpConfigCount) {
      thoughtLog(
        `I found ${aiInventorySummary.mcpConfigCount} MCP config component(s). Use '--exclude-type mcp' to drop them, or '--bom-audit --bom-audit-categories ai-inventory --tlp-classification AMBER' to keep and flag them.`,
      );
    }
  }
  // Committed lockfiles and their manifests can live under dot-directories
  // (eg: .github/scripts), so include hidden paths when discovering them -
  // otherwise the dependencies of those nested projects are silently dropped
  // from the BOM (see #4224). node_modules and .git stay ignored by getAllFiles.
  const lockSearchOptions = { ...options, includeDot: true };
  let yarnLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}yarn.lock`,
    lockSearchOptions,
  );
  const shrinkwrapFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}npm-shrinkwrap.json`,
    lockSearchOptions,
  );
  let pkgLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}package-lock.json`,
    lockSearchOptions,
  );
  if (shrinkwrapFiles.length) {
    pkgLockFiles = pkgLockFiles.concat(shrinkwrapFiles);
  }
  let pnpmLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pnpm-lock.yaml`,
    lockSearchOptions,
  );
  const bunLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}bun.lock`,
    lockSearchOptions,
  );
  // Warn about the binary bun lockfile which cdxgen cannot parse. Users should
  // regenerate a text lockfile with `bun install --save-text-lockfile`.
  const bunBinaryLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}bun.lockb`,
    lockSearchOptions,
  );
  if (bunBinaryLockFiles.length && !bunLockFiles.length) {
    console.log(
      "Found a binary bun lockfile (bun.lockb) which cdxgen cannot parse. Regenerate a text lockfile with 'bun install --save-text-lockfile' (bun >= 1.2) and try again.",
    );
  }
  const denoLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}deno.lock`,
    lockSearchOptions,
  );
  if (
    !denoLockFiles?.length &&
    isPackageManagerAllowed("deno", ["npm", "pnpm", "yarn", "bun"], options)
  ) {
    const denoManifestFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}deno.{json,jsonc}`,
      lockSearchOptions,
    );
    if (denoManifestFiles?.length) {
      console.log(
        "Found a Deno manifest (deno.json/deno.jsonc) without a deno.lock. Run 'deno install' to generate a lockfile so cdxgen can capture the resolved dependencies.",
      );
    }
  }
  let pnpmWorkspaceFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pnpm-workspace.yaml`,
    lockSearchOptions,
  );
  const rootPnpmLockFile = resolve(path, "pnpm-lock.yaml");
  const rootPnpmWorkspaceFile = resolve(path, "pnpm-workspace.yaml");
  const workspaceFilesCache = new Map();
  if (
    safeExistsSync(rootPnpmLockFile) &&
    safeExistsSync(rootPnpmWorkspaceFile) &&
    pnpmLockFiles.includes(rootPnpmLockFile)
  ) {
    // The root pnpm-lock.yaml resolves the dependencies of every declared
    // workspace member, so their nested lockfiles are redundant. However,
    // independent nested projects that are NOT listed in pnpm-workspace.yaml
    // keep their own committed lockfile, and those must still be parsed -
    // otherwise their dependencies go missing from the BOM.
    const workspaceObj = parsePnpmWorkspace(rootPnpmWorkspaceFile);
    const workspaceMemberDirs = new Set();
    const workspacePackages = workspaceObj?.packagePatterns || [];
    const workspaceSearchOptions = {
      ...options,
      exclude: [
        ...(options.exclude || []),
        ...(workspaceObj?.excludePackages || []),
      ],
      includeNodeModulesDir: false,
    };
    for (const awp of workspacePackages) {
      const workspacePackagePattern = awp.endsWith("package.json")
        ? awp
        : `${awp.replace(/\/+$/, "")}/package.json`;
      const wpkgJsonFiles = getAllFiles(
        path,
        workspacePackagePattern,
        workspaceSearchOptions,
      );
      workspaceFilesCache.set(workspacePackagePattern, wpkgJsonFiles);
      for (const apj of wpkgJsonFiles || []) {
        workspaceMemberDirs.add(resolve(dirname(apj)));
      }
    }
    // A nested lockfile is redundant only when it sits in a declared workspace
    // member directory. The root lockfile itself is always retained.
    const isRedundantNestedLock = (lockFile) => {
      const resolvedLockFile = resolve(lockFile);
      if (resolvedLockFile === rootPnpmLockFile) {
        return false;
      }
      return workspaceMemberDirs.has(resolve(dirname(lockFile)));
    };
    pnpmLockFiles = pnpmLockFiles.filter((f) => !isRedundantNestedLock(f));
    yarnLockFiles = yarnLockFiles.filter((f) => !isRedundantNestedLock(f));
    pkgLockFiles = pkgLockFiles.filter((f) => !isRedundantNestedLock(f));
    pnpmWorkspaceFiles = [rootPnpmWorkspaceFile];
  }
  const minJsFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*min.js`,
    options,
  );
  const bowerFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}bower.json`,
    options,
  );
  if (DEBUG_MODE) {
    const wasmFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}*.wasm`,
      {
        ...options,
        includeNodeModulesDir: true,
      },
    );
    if (wasmFiles?.length) {
      console.log(
        `Found ${wasmFiles.length} wasm files in this project. cdxgen will make a best attempt to identify the exports and imports from these files.`,
      );
    }
  }
  // Parse min js files
  if (minJsFiles?.length) {
    manifestFiles = manifestFiles.concat(minJsFiles);
    for (const f of minJsFiles) {
      const dlist = await parseMinJs(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  // Parse bower json files
  if (bowerFiles?.length) {
    manifestFiles = manifestFiles.concat(bowerFiles);
    for (const f of bowerFiles) {
      const dlist = await parseBowerJson(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  const pkgJsonLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}package-lock.json`,
    lockSearchOptions,
  );
  const pkgJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}package.json`,
    lockSearchOptions,
  );
  const npmInstallCount =
    Number.parseInt(readEnvironmentVariable("NPM_INSTALL_COUNT"), 10) || 2;
  let anyInstallSuccess = false;
  // Automatic npm install logic.
  // Only perform npm install for smaller projects (< 2 package.json) without the correct number of lock files
  if (
    (pkgJsonLockFiles?.length === 0 ||
      pkgJsonLockFiles?.length < pkgJsonFiles?.length - 1) &&
    yarnLockFiles?.length === 0 &&
    pnpmLockFiles?.length === 0 &&
    bunLockFiles?.length === 0 &&
    denoLockFiles?.length === 0 &&
    pkgJsonFiles?.length <= npmInstallCount &&
    options.installDeps
  ) {
    for (const apkgJson of pkgJsonFiles) {
      let pkgMgr = "npm";
      const supPkgMgrs = ["npm", "yarn", "yarnpkg", "pnpm", "pnpx"];
      const pkgData = JSON.parse(readFileSync(apkgJson, "utf8"));
      const mgrData = pkgData.packageManager;
      let mgr = "";
      if (mgrData) {
        mgr = mgrData.split("@")[0];
      }
      // Try harder to identify the correct package manager
      if (options?.projectType?.includes("npm")) {
        pkgMgr = "npm";
      } else if (supPkgMgrs.includes(mgr)) {
        pkgMgr = mgr;
      } else if (pkgData?.engines?.yarn) {
        pkgMgr = "yarn";
      } else if (
        isPackageManagerAllowed("npm", ["yarn", "pnpm", "rush"], options)
      ) {
        pkgMgr = "npm";
      } else if (
        isPackageManagerAllowed("yarn", ["npm", "pnpm", "rush"], options)
      ) {
        pkgMgr = "yarn";
      } else if (
        isPackageManagerAllowed("pnpm", ["npm", "yarn", "rush"], options)
      ) {
        pkgMgr = "pnpm";
      }
      let installCommand = "install";
      if (pkgMgr === "npm" && isSecureMode && pkgJsonLockFiles?.length > 0) {
        installCommand = "ci";
      }
      let installArgs = [installCommand];
      // Support for passing additional args to the install command
      if (readEnvironmentVariable(`${pkgMgr.toUpperCase()}_INSTALL_ARGS`)) {
        const addArgs = readEnvironmentVariable(
          `${pkgMgr.toUpperCase()}_INSTALL_ARGS`,
        ).split(" ");
        installArgs = installArgs.concat(addArgs);
      }
      // Always invoke the install command with ignore-scripts to guard against version spoofing
      if (["npm", "pnpm", "yarn"].includes(pkgMgr)) {
        if (!installArgs.includes("--ignore-scripts")) {
          installArgs.push("--ignore-scripts");
        }
        if (pkgMgr === "pnpm") {
          installArgs.push("--ignore-pnpmfile");
        }
        if (pkgMgr === "npm") {
          for (const c of ["--no-audit", "--no-bin-links"]) {
            if (!installArgs.includes(c)) {
              installArgs.push(c);
            }
          }
          installArgs.push(`--git=${GIT_COMMAND}`);
        }
      }
      if (
        pkgMgr === "npm" &&
        isSecureMode &&
        !installArgs.join(" ").includes("--allow-git")
      ) {
        recordDegradation("js.git-dependency", {
          ecosystem: "npm",
          tool: pkgMgr,
          impact: "integrity",
          command: `${pkgMgr} ${installArgs.join(" ")}`,
          detail:
            "Secure mode npm install may still fetch and install git dependencies.",
        });
        console.log(
          "Consider passing '--allow-git=none' via the environment variable NPM_INSTALL_ARGS to prevent any git dependencies from being fetched and installed via npm.",
        );
      }
      const basePath = dirname(apkgJson);
      let npmrcData;
      const npmrcFile = join(basePath, ".npmrc");
      if (safeExistsSync(npmrcFile)) {
        thoughtLog(
          "Wait, there is a .npmrc file here! I'm going to check if it has anything malicious.",
        );
        npmrcData = readFileSync(npmrcFile, "utf-8");
        recordSensitiveFileRead(npmrcFile, {
          label: "npm registry configuration",
        });
        let npmrcObj = {};
        try {
          npmrcObj = parseNpmrc(npmrcData);
        } catch (e) {
          // A malformed .npmrc must degrade to a warning, never abort the scan.
          console.warn(
            `Unable to parse ${npmrcFile}. Continuing without it. ${e?.message || ""}`,
          );
          npmrcObj = {};
        }
        for (const [key, value] of Object.entries(npmrcObj)) {
          const baseKey = key.replace(/^(?:\/\/[^/]+\/|@[^:]+:)/, "");
          if (
            DEFAULT_NPMRC_BLOCKLIST.has(baseKey) ||
            DEFAULT_NPMRC_BLOCKLIST.has(key)
          ) {
            console.warn(
              `\x1b[1;35mSECURE MODE: Dangerous configuration ${key}=${value} detected in .npmrc! Verify if this is a trusted project. Remove this setting or any other problematic configurations to proceed.\x1b[0m`,
            );
            process.exit(1);
          }
        }
      }
      // juice-shop mode
      // Projects such as juice-shop prevent lockfile creations using .npmrc files
      // Plus, they might require specific npm install args such as --legacy-peer-deps that could lead to strange node_modules structure
      // To keep life simple, let's look for any .npmrc file that has package-lock=false to toggle before npm install
      if (pkgMgr === "npm") {
        if (
          npmrcData?.includes("package-lock=false") &&
          !installArgs.includes("--package-lock")
        ) {
          installArgs.push("--package-lock");
        }
      }
      if (pkgMgr === "npm" && yarnLockFiles.length) {
        thoughtLog(
          `Wait, there are ${yarnLockFiles.length} yarn.lock files in this project; however, I'm about to invoke the '${pkgMgr} ${installArgs[0]}' command.`,
        );
      }
      if (pkgMgr !== "npm") {
        thoughtLog(
          `**PACKAGE MANAGER**: Let's run the '${pkgMgr}' command with the arguments '${installArgs.join(" ")}' to generate the needed lock files.`,
        );
      }
      recordDegradation("js.no-lockfile", {
        ecosystem: "npm",
        tool: pkgMgr,
        impact: "versions",
        detail:
          "No lockfile was found for this project, so the SBOM is generated without pinned dependency versions.",
      });
      console.warn(
        "\x1b[1;35mNotice: Generating an SBOM without a lockfile is risky and non-deterministic. Consider generating and committing the lockfile to your repository to ensure reproducible builds and SBOMs.\x1b[0m",
      );
      console.log(
        `Executing '${pkgMgr} ${installArgs.join(" ")}' in`,
        basePath,
      );
      const result = safeSpawnSync(pkgMgr, installArgs, {
        cwd: basePath,
        shell: isWin,
      });
      if (result.status !== 0 || result.error) {
        console.error(
          `${pkgMgr} install has failed. Generated SBOM will be empty or with a lower precision.`,
        );
        thoughtLog(
          "It looks like the install command has failed. I'm considering some troubleshooting ideas.",
        );
        if (DEBUG_MODE && result.stdout) {
          if (result.stdout.includes("EBADENGINE Unsupported engine")) {
            console.log(
              "TIP: The current version of node.js is incompatible with this project. Re-run cdxgen with an install-version type to install a matching node.js for the project. Eg: `-t node20`",
            );
          }
          console.log("---------------");
          console.log(result.stdout);
        }
        if (result.stderr) {
          if (result.stderr.includes("--legacy-peer-deps")) {
            console.log(
              "Set the environment variable `NPM_INSTALL_ARGS=--legacy-peer-deps` to resolve the dependency resolution issue reported.",
            );
          }
          if (
            result.stderr.includes(
              "npm error command sh -c node-pre-gyp install",
            )
          ) {
            console.log(
              "cdxgen has detected errors with the native build using node-gyp.",
            );
            if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
              if (arch() !== "x64") {
                console.log(
                  `INFO: Many npm packages have limited support for ${arch()} architecture. Run the cdxgen container image with --platform=linux/amd64 for best experience.`,
                );
              } else {
                console.log(
                  "TIP: The default image bundles node >= 24, which might be incompatible with this project. Re-run cdxgen with an install-version type to install an older node.js for the project. Eg: `-t node20`",
                );
              }
            } else {
              console.log(
                "TIP: Try running the cdxgen container image with --platform=linux/amd64, and pass an install-version type such as `-t node20` to build the project with an older node.js.",
              );
            }
          }
          console.log("---------------");
          console.log(result.stderr);
        }
        deferFailOnError(options, {
          ecosystem: "npm",
          tool: "npm",
          detail: "the npm command failed",
        });
      } else {
        anyInstallSuccess = true;
      }
    }
    pkgLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}package-lock.json`,
      options,
    );
    pnpmLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}pnpm-lock.yaml`,
      options,
    );
    yarnLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}yarn.lock`,
      options,
    );
    if (
      anyInstallSuccess &&
      !pkgLockFiles.length &&
      !pnpmLockFiles.length &&
      !yarnLockFiles.length
    ) {
      thoughtLog(
        `Despite a successful installation step, I didn't find any lock files. Perhaps they're being created elsewhere, such as in the root directory. I am currently checking the directory at ${path}.`,
      );
    }
  }
  if (
    pnpmLockFiles?.length &&
    isPackageManagerAllowed("pnpm", ["npm", "yarn", "rush"], options)
  ) {
    manifestFiles = manifestFiles.concat(pnpmLockFiles);
    const workspacePackages = [];
    const workspaceSrcFiles = {};
    const workspaceDirectDeps = {};
    const depsWorkspaceRefs = {};
    let workspaceCatalogs = {};
    const seenPkgJsonFiles = {};
    // Is this a pnpm workspace?
    for (const f of pnpmWorkspaceFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing workspace definition ${f}`);
      }
      const workspaceObj = parsePnpmWorkspace(f);
      if (workspaceObj?.packages) {
        const workspaceBasePath = dirname(f);
        const workspacePatterns =
          workspaceObj.packagePatterns || workspaceObj.packages;
        // We need the precise purl for all workspace packages and their direct dependencies
        for (const awp of workspacePatterns) {
          const workspaceExcludes = [...(workspaceObj.excludePackages || [])];
          const workspaceSearchOptions = {
            ...options,
            exclude: [...(options.exclude || []), ...workspaceExcludes],
            includeNodeModulesDir: false,
          };
          const workspacePackagePattern = awp.endsWith("package.json")
            ? awp
            : `${awp.replace(/\/+$/, "")}/package.json`;
          let wpkgJsonFiles = workspaceFilesCache.get(workspacePackagePattern);
          if (!wpkgJsonFiles) {
            wpkgJsonFiles = getAllFiles(
              workspaceBasePath,
              workspacePackagePattern,
              workspaceSearchOptions,
            );
          }
          if (!wpkgJsonFiles?.length) {
            continue;
          }
          for (const apj of wpkgJsonFiles) {
            if (seenPkgJsonFiles[apj]) {
              continue;
            }
            seenPkgJsonFiles[apj] = true;
            let pkgData;
            try {
              pkgData = JSON.parse(readFileSync(apj, "utf-8"));
            } catch (_err) {
              continue;
            }
            if (pkgData?.name) {
              const relativePkgJsonFile = relative(path, apj);
              let workspaceRef = `pkg:npm/${pkgData.name}`;
              if (pkgData?.version) {
                workspaceRef = `${workspaceRef}@${pkgData.version}`;
              }
              // Track all workspace purls. When we face duplicates, let's try to expand the purl to
              // include the subpath.
              if (!workspacePackages.includes(workspaceRef)) {
                workspacePackages.push(workspaceRef);
              } else {
                console.log(
                  `Found a duplicate workspace with the name: ${pkgData.name}, ref: ${workspaceRef} at ${relativePkgJsonFile} and ${workspaceSrcFiles[workspaceRef]}. This is likely an error in the project that needs fixing.`,
                );
                workspaceRef = `${workspaceRef}#${relativePkgJsonFile.replace(`${sep}package.json`, "")}`;
                if (!workspacePackages.includes(workspaceRef)) {
                  workspacePackages.push(workspaceRef);
                  console.log(
                    `Duplicate workspace tracked as ${workspaceRef} under metadata.component.components`,
                  );
                }
              }
              workspaceSrcFiles[workspaceRef] = relativePkgJsonFile;
              // Track the direct dependencies of each workspace and workspace refs for each direct deps.
              const allDeps = {
                ...(pkgData.dependencies || {}),
                ...(pkgData.devDependencies || {}),
                ...(pkgData.peerDependencies || {}),
              };
              for (const adep of Object.keys(allDeps)) {
                if (!workspaceDirectDeps[workspaceRef]) {
                  workspaceDirectDeps[workspaceRef] = new Set();
                }
                const apkgRef = `pkg:npm/${adep}`;
                workspaceDirectDeps[workspaceRef].add(apkgRef);
                if (!depsWorkspaceRefs[apkgRef]) {
                  depsWorkspaceRefs[apkgRef] = [];
                }
                depsWorkspaceRefs[apkgRef].push(workspaceRef);
              }
            }
          }
        }
      }
      workspaceCatalogs = {
        ...workspaceCatalogs,
        ...(workspaceObj.catalogs || {}),
      };
    }
    if (DEBUG_MODE && Object.keys(seenPkgJsonFiles).length) {
      console.log(
        `${Object.keys(seenPkgJsonFiles).length} package.json files were parsed to identify workspace names. Total number of package.json files: ${pkgJsonFiles.length}`,
      );
    }
    for (const f of pnpmLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      // Determine the parent component
      const packageJsonF = join(basePath, "package.json");
      const pnpmCjsHooks = join(basePath, ".pnpmfile.cjs");
      const pnpmMjsHooks = join(basePath, ".pnpmfile.mjs");
      if (safeExistsSync(pnpmMjsHooks) || safeExistsSync(pnpmCjsHooks)) {
        thoughtLog("Wait, this pnpm project uses install hooks.");
      }
      if (!Object.keys(parentComponent).length) {
        if (safeExistsSync(packageJsonF)) {
          const pcs = await parsePkgJson(packageJsonF, true, true);
          if (pcs.length && Object.keys(pcs[0]).length) {
            parentComponent = { ...pcs[0] };
            parentComponent.type = "application";
            ppurl = build({
              type: "npm",
              namespace: options.projectGroup || parentComponent.group || null,
              name: parentComponent.name,
              version:
                options.projectVersion || parentComponent.version || null,
            });
            parentComponent["bom-ref"] = decodeURIComponent(ppurl);
            parentComponent["purl"] = ppurl;
          }
        } else {
          let dirName = dirname(f);
          const tmpA = dirName.split(sep);
          dirName = tmpA[tmpA.length - 1];
          parentComponent = {
            group: "",
            name: dirName,
            type: "application",
          };
          ppurl = build({
            type: "npm",
            namespace: options.projectGroup || parentComponent.group || null,
            name:
              "project-name" in options
                ? options.projectName
                : parentComponent.name,
            version: options.projectVersion || parentComponent.version || null,
          });
          parentComponent["bom-ref"] = decodeURIComponent(ppurl);
          parentComponent["purl"] = ppurl;
        }
      }
      // Parse the pnpm file
      const parsedList = await parsePnpmLock(
        f,
        parentComponent,
        workspacePackages,
        workspaceSrcFiles,
        workspaceCatalogs,
        workspaceDirectDeps,
        depsWorkspaceRefs,
        path,
      );
      const dlist = parsedList.pkgList;
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (parsedList?.parentSubComponents?.length) {
        parentComponent.components = parsedList.parentSubComponents;
      }
      if (parsedList?.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          parentComponent,
        );
      }
    }
  }
  if (
    pkgLockFiles?.length &&
    isPackageManagerAllowed("npm", ["pnpm", "yarn"], options)
  ) {
    if (anyInstallSuccess) {
      thoughtLog(
        `I have ${pkgLockFiles.length} package-lock.json file(s) now after a successful npm install.`,
      );
    }
    manifestFiles = manifestFiles.concat(pkgLockFiles);
    for (const f of pkgLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      // Parse package-lock.json if available
      const parsedList = await parsePkgLock(f, options);
      const dlist = parsedList.pkgList;
      let tmpParentComponent = dlist.splice(0, 1)[0] || {};
      if (!Object.keys(parentComponent).length) {
        const basePath = dirname(f);
        const packageJsonF = join(basePath, "package.json");
        if (safeExistsSync(packageJsonF)) {
          const pcs = await parsePkgJson(packageJsonF, true, true);
          if (pcs.length && Object.keys(pcs[0]).length) {
            tmpParentComponent = { ...pcs[0] };
            tmpParentComponent.type = "application";
            tmpParentComponent.name =
              "project-name" in options
                ? options.projectName
                : tmpParentComponent.name;
            ppurl = build({
              type: "npm",
              namespace:
                options.projectGroup || tmpParentComponent.group || null,
              name:
                "project-name" in options
                  ? options.projectName
                  : tmpParentComponent.name,
              version:
                options.projectVersion || tmpParentComponent.version || null,
            });
            tmpParentComponent["bom-ref"] = decodeURIComponent(ppurl);
            tmpParentComponent["purl"] = ppurl;
          }
        }
        parentComponent = tmpParentComponent;
      } else {
        parentSubComponents.push(tmpParentComponent);
      }
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (parsedList?.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          parentComponent,
        );
      }
    }
  }
  if (
    safeExistsSync(join(path, "rush.json")) &&
    isPackageManagerAllowed("rush", ["npm", "yarn", "pnpm"], options)
  ) {
    // Rush.js creates node_modules inside common/temp directory
    const nmDir = join(path, "common", "temp", "node_modules");
    // Do rush install if we don't have node_modules directory. `rush install`
    // drives pnpm without cdxgen's --ignore-scripts hardening and
    // --bypass-policy disables rush's own policy gate, so it must respect
    // --no-install-deps and the pre-build lifecycle like every other
    // installer.
    if (!safeExistsSync(nmDir) && options.installDeps !== false) {
      console.log("Executing 'rush install --no-link'", path);
      const result = safeSpawnSync(
        "rush",
        ["install", "--no-link", "--bypass-policy"],
        {
          cwd: path,
          shell: isWin,
        },
      );
      if (result.status === 1 || result.error) {
        console.error(result.stdout, result.stderr);
        deferFailOnError(options, {
          ecosystem: "npm",
          tool: "npm",
          detail: "the yarn or pnpm command failed",
        });
      }
    }
    // Look for shrinkwrap file
    const swFile = join(
      path,
      "tools",
      "build-tasks",
      ".rush",
      "temp",
      "shrinkwrap-deps.json",
    );
    const pnpmLock = join(path, "common", "config", "rush", "pnpm-lock.yaml");
    if (safeExistsSync(swFile)) {
      let pkgList = await parseNodeShrinkwrap(swFile);
      pkgList = addWasmComponentsFromImports(pkgList, allImports);
      if (allImports && Object.keys(allImports).length) {
        pkgList = await addEvidenceForImports(
          pkgList,
          allImports,
          allExports,
          options.deep,
        );
      }
      return buildBomNSData(options, pkgList, "npm", {
        allImports,
        src: path,
        filename: "shrinkwrap-deps.json",
      });
    }
    if (safeExistsSync(pnpmLock)) {
      const pnpmLockObj = await parsePnpmLock(
        pnpmLock,
        null,
        [],
        {},
        {},
        {},
        {},
        path,
      );
      let pkgList = addWasmComponentsFromImports(
        pnpmLockObj.pkgList,
        allImports,
      );
      let dependencies = [];
      if (pnpmLockObj?.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          pnpmLockObj.dependenciesList,
        );
      }
      if (allImports && Object.keys(allImports).length) {
        pkgList = await addEvidenceForImports(
          pkgList,
          allImports,
          allExports,
          options.deep,
        );
      }
      pkgList = propagateRequiredScopeFromDependencies(pkgList, dependencies);
      pkgList = markNpmTypesPackagesAsExcluded(pkgList);
      pkgList = markTypeOnlyDependenciesOptional(pkgList, dependencies);
      return buildBomNSData(options, pkgList, "npm", {
        allImports,
        allExports,
        dependencies,
        src: path,
        filename: "pnpm-lock.yaml",
      });
    }
    console.log(
      "Neither shrinkwrap file: ",
      swFile,
      " nor pnpm lockfile",
      pnpmLock,
      "was found!",
    );
    deferFailOnError(options, {
      ecosystem: "npm",
      tool: "npm",
      detail: "no JavaScript dependency evidence could be collected",
    });
  }
  if (
    yarnLockFiles?.length &&
    isPackageManagerAllowed("yarn", ["npm", "pnpm"], options)
  ) {
    manifestFiles = manifestFiles.concat(yarnLockFiles);
    const workspacePackages = [];
    const workspaceSrcFiles = {};
    const workspaceDirectDeps = {};
    const depsWorkspaceRefs = {};
    const seenPkgJsonFiles = {};

    // Check if this is a yarn workspace by examining package.json files for workspace definitions
    const packageJsonFilesWithWorkspaces = yarnLockFiles
      .map((f) => join(dirname(f), "package.json"))
      .filter((pkgFile) => safeExistsSync(pkgFile));

    for (const packageJsonFile of packageJsonFilesWithWorkspaces) {
      const workspaceObj = parseYarnWorkspace(packageJsonFile);
      if (workspaceObj?.packages) {
        if (DEBUG_MODE) {
          console.log(`Found yarn workspace definition in ${packageJsonFile}`);
        }
        // We need the precise purl for all workspace packages and their direct dependencies
        const workspaceBasePath = dirname(packageJsonFile);
        for (const awp of workspaceObj.packages) {
          let wpkgJsonFiles = [];

          // Handle different yarn workspace patterns
          if (awp.includes("*")) {
            // Replace all '*' with '**' for recursive glob matching and ensure package.json suffix
            const pattern =
              awp.replaceAll("*", "**") +
              (awp.endsWith(".json") ? "" : "/package.json");
            wpkgJsonFiles = getAllFiles(workspaceBasePath, pattern, {
              ...options,
              includeNodeModulesDir: false,
            });
          } else {
            // Direct path pattern
            wpkgJsonFiles = getAllFiles(
              join(workspaceBasePath, awp),
              "**/package.json",
              {
                ...options,
                includeNodeModulesDir: false,
              },
            );
          }
          for (const apj of wpkgJsonFiles) {
            if (seenPkgJsonFiles[apj]) {
              continue;
            }
            seenPkgJsonFiles[apj] = true;
            const pkgData = JSON.parse(readFileSync(apj, "utf-8"));
            if (pkgData?.name) {
              const relativePkgJsonFile = relative(path, apj);
              // Create properly encoded PURL using helper function
              const workspaceRef = createNpmWorkspacePurl(
                pkgData.name,
                pkgData.version,
              );
              workspacePackages.push(workspaceRef);
              workspaceSrcFiles[workspaceRef] = relativePkgJsonFile;
              // The declared name and range of each direct dependency, which
              // parseYarnLock resolves against the lock file to link the
              // member into the dependency tree.
              const declaredDeps = {
                ...(pkgData.dependencies || {}),
                ...(pkgData.optionalDependencies || {}),
                ...(pkgData.devDependencies || {}),
              };
              if (Object.keys(declaredDeps).length) {
                workspaceDirectDeps[workspaceRef] = declaredDeps;
              }
              for (const [k, v] of Object.entries(declaredDeps)) {
                const dep = /^\d/.test(String(v))
                  ? `pkg:npm/${k}@${v}`
                  : `pkg:npm/${k}`;
                if (!depsWorkspaceRefs[dep]) {
                  depsWorkspaceRefs[dep] = [];
                }
                depsWorkspaceRefs[dep].push(workspaceRef);
              }
            }
          }
        }
      }
    }
    for (const f of yarnLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      // Determine the parent component
      const packageJsonF = join(basePath, "package.json");
      if (safeExistsSync(packageJsonF)) {
        const pcs = await parsePkgJson(packageJsonF, true, true);
        if (pcs.length && Object.keys(pcs[0]).length) {
          const tmpParentComponent = { ...pcs[0] };
          tmpParentComponent.type = "application";
          ppurl = build({
            type: "npm",
            namespace: options.projectGroup || tmpParentComponent.group || null,
            name: tmpParentComponent.name,
            version:
              options.projectVersion || tmpParentComponent.version || null,
          });
          tmpParentComponent["bom-ref"] = decodeURIComponent(ppurl);
          tmpParentComponent["purl"] = ppurl;
          if (!Object.keys(parentComponent).length) {
            parentComponent = tmpParentComponent;
          } else {
            parentSubComponents.push(tmpParentComponent);
          }
        }
      } else {
        let dirName = dirname(f);
        const tmpA = dirName.split(sep);
        dirName = tmpA[tmpA.length - 1];
        const tmpParentComponent = {
          group: options.projectGroup || "",
          name: "project-name" in options ? options.projectName : dirName,
          type: "application",
        };
        ppurl = build({
          type: "npm",
          namespace: tmpParentComponent.group || null,
          name: tmpParentComponent.name,
          version: options.projectVersion || tmpParentComponent.version || null,
        });
        tmpParentComponent["bom-ref"] = decodeURIComponent(ppurl);
        tmpParentComponent["purl"] = ppurl;
        if (!Object.keys(parentComponent).length) {
          parentComponent = tmpParentComponent;
        } else {
          parentSubComponents.push(tmpParentComponent);
        }
      }
      // Parse yarn.lock if available. This check is after rush.json since
      // rush.js could include yarn.lock :(
      const parsedList = await parseYarnLock(
        f,
        parentComponent,
        workspacePackages,
        workspaceSrcFiles,
        workspaceDirectDeps,
        depsWorkspaceRefs,
      );
      const dlist = parsedList.pkgList;
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      const rdeplist = [];
      if (parsedList?.dependenciesList?.length) {
        // Inject parent component to the dependency tree to make it complete
        // In case of yarn, yarn list command lists every root package as a direct dependency
        // The same logic is matched with this for loop although this is incorrect since even dev dependencies would get included here
        for (const dobj of parsedList.dependenciesList) {
          rdeplist.push(dobj.ref);
        }
        // Fixes: 212. Handle case where there are no package.json to determine the parent package
        // Bug fix: We need to consistently override the parent component group, name and version here
        if (Object.keys(parentComponent).length && parentComponent.name) {
          const ppurl = build({
            type: "npm",
            namespace: options.projectGroup || parentComponent.group || null,
            name: parentComponent.name,
            version: options.projectVersion || parentComponent.version || null,
          });
          parsedList.dependenciesList.push({
            ref: decodeURIComponent(ppurl),
            dependsOn: [...new Set(rdeplist)].sort(),
          });
        }
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          parentComponent,
        );
      }
    }
  }
  if (
    bunLockFiles?.length &&
    isPackageManagerAllowed("bun", ["npm", "pnpm", "yarn"], options)
  ) {
    manifestFiles = manifestFiles.concat(bunLockFiles);
    for (const f of bunLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      // Determine the parent component from the adjacent package.json.
      const packageJsonF = join(basePath, "package.json");
      let bunParentComponent = {};
      if (safeExistsSync(packageJsonF)) {
        const pcs = await parsePkgJson(packageJsonF, true, true);
        if (pcs.length && Object.keys(pcs[0]).length) {
          bunParentComponent = { ...pcs[0] };
          bunParentComponent.type = "application";
          ppurl = build({
            type: "npm",
            namespace: options.projectGroup || bunParentComponent.group || null,
            name: bunParentComponent.name,
            version:
              options.projectVersion || bunParentComponent.version || null,
          });
          bunParentComponent["bom-ref"] = decodeURIComponent(ppurl);
          bunParentComponent["purl"] = ppurl;
        }
      } else {
        let dirName = dirname(f);
        const tmpA = dirName.split(sep);
        dirName = tmpA[tmpA.length - 1];
        bunParentComponent = {
          group: options.projectGroup || "",
          name: "project-name" in options ? options.projectName : dirName,
          type: "application",
        };
        ppurl = build({
          type: "npm",
          namespace: bunParentComponent.group || null,
          name: bunParentComponent.name,
          version: options.projectVersion || bunParentComponent.version || null,
        });
        bunParentComponent["bom-ref"] = decodeURIComponent(ppurl);
        bunParentComponent["purl"] = ppurl;
      }
      if (Object.keys(bunParentComponent).length) {
        if (!Object.keys(parentComponent).length) {
          parentComponent = bunParentComponent;
        } else if (
          bunParentComponent["bom-ref"] !== parentComponent["bom-ref"]
        ) {
          parentSubComponents.push(bunParentComponent);
        }
      }
      const parsedList = await parseBunLock(f, {
        ...options,
        projectRoot: basePath,
        parentComponent: bunParentComponent,
      });
      if (parsedList.pkgList?.length) {
        pkgList = pkgList.concat(parsedList.pkgList);
      }
      if (parsedList.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          bunParentComponent,
        );
      }
    }
  }
  if (
    denoLockFiles?.length &&
    isPackageManagerAllowed("deno", ["npm", "pnpm", "yarn", "bun"], options)
  ) {
    manifestFiles = manifestFiles.concat(denoLockFiles);
    for (const f of denoLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      // Derive the parent component from the adjacent deno.json(c), falling
      // back to the directory name like the bun block does.
      const denoJsonFile = findDenoJson(basePath);
      let denoParentComponent = {};
      if (denoJsonFile) {
        const denoConfig = parseDenoJsonFile(denoJsonFile);
        if (denoConfig?.name) {
          // deno.json names are frequently scoped (e.g. "@demo/deno-app").
          // Split the scope into the purl group so the name does not end up
          // carrying an encoded slash.
          let denoGroup = options.projectGroup || "";
          let denoName = denoConfig.name;
          if (!denoGroup && denoName.startsWith("@")) {
            const slashIndex = denoName.indexOf("/");
            if (slashIndex > 0) {
              denoGroup = denoName.substring(0, slashIndex);
              denoName = denoName.substring(slashIndex + 1);
            }
          }
          denoParentComponent = {
            group: denoGroup,
            name: denoName,
            version: options.projectVersion || denoConfig.version || "",
            type: "application",
          };
          ppurl = build({
            type: "npm",
            namespace: denoParentComponent.group || null,
            name: denoParentComponent.name,
            version: denoParentComponent.version || null,
          });
          denoParentComponent["bom-ref"] = decodeURIComponent(ppurl);
          denoParentComponent["purl"] = ppurl;
        }
      }
      if (!Object.keys(denoParentComponent).length) {
        let dirName = basePath;
        const tmpA = dirName.split(sep);
        dirName = tmpA[tmpA.length - 1];
        denoParentComponent = {
          group: options.projectGroup || "",
          name: "project-name" in options ? options.projectName : dirName,
          type: "application",
        };
        ppurl = build({
          type: "npm",
          namespace: denoParentComponent.group || null,
          name: denoParentComponent.name,
          version: denoParentComponent.version || null,
        });
        denoParentComponent["bom-ref"] = decodeURIComponent(ppurl);
        denoParentComponent["purl"] = ppurl;
      }
      if (Object.keys(denoParentComponent).length) {
        if (!Object.keys(parentComponent).length) {
          parentComponent = denoParentComponent;
        } else if (
          denoParentComponent["bom-ref"] !== parentComponent["bom-ref"]
        ) {
          parentSubComponents.push(denoParentComponent);
        }
      }
      const parsedList = await parseDenoLock(f, {
        ...options,
        projectRoot: basePath,
        parentComponent: denoParentComponent,
      });
      if (parsedList.pkgList?.length) {
        pkgList = pkgList.concat(parsedList.pkgList);
      }
      if (parsedList.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          denoParentComponent,
        );
      }
    }
  }
  // We might reach here if the project has no lock files
  // Eg: juice-shop
  if (!pkgList.length && safeExistsSync(join(path, "node_modules"))) {
    // Collect all package.json files from all node_modules directory
    const pkgJsonFiles = getAllFiles(
      path,
      "**/node_modules/**/package.json",
      options,
    );
    manifestFiles = manifestFiles.concat(pkgJsonFiles);
    // The installed manifests answer locally; one round asks the registry only
    // about the packages still missing fields, instead of one round per file.
    for (const pkgjf of pkgJsonFiles) {
      const dlist = await parsePkgJson(pkgjf, false, false, {
        fetchMetadata: false,
      });
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    if (shouldFetchPackageMetadata() && pkgList.length) {
      pkgList = await getNpmMetadata(pkgList, undefined, {
        npmrcConfig: loadNpmrcConfig(path),
      });
    }
    if (!parentComponent || !Object.keys(parentComponent).length) {
      if (safeExistsSync(join(path, "package.json"))) {
        const pcs = await parsePkgJson(join(path, "package.json"), true, true);
        if (pcs.length && Object.keys(pcs[0]).length) {
          parentComponent = { ...pcs[0] };
          parentComponent.type = "application";
          ppurl = build({
            type: "npm",
            namespace: options.projectGroup || parentComponent.group || null,
            name: parentComponent.name,
            version: options.projectVersion || parentComponent.version || null,
          });
          parentComponent["bom-ref"] = decodeURIComponent(ppurl);
          parentComponent["purl"] = ppurl;
        }
      }
    }
  }
  if (
    !pkgList.length &&
    (yarnLockFiles.length ||
      pkgLockFiles.length ||
      bunLockFiles.length ||
      denoLockFiles.length)
  ) {
    if (options.projectType?.length) {
      thoughtLog(
        `Despite seeing some lock files, I didn't find any components in this Node.js project. Is there an issue with the project type '${options.projectType?.join(", ")}' used 🤔? I recommend trying again with a different type.`,
      );
    } else {
      thoughtLog(
        "Despite seeing some lock files, I didn't find any components in this Node.js project. Feels like a bug.",
      );
    }
  }
  // Retain the components of parent component
  if (parentSubComponents.length) {
    parentComponent.components = parentSubComponents;
  }
  // We need to set this to force our version to be used rather than the directory name based one.
  // Fix #1550. Do not blindly force the npm parent to always become the overall parent.
  if ("project-name" in options && !options.parentComponent) {
    options.parentComponent = parentComponent;
  }
  if (allImports && Object.keys(allImports).length) {
    pkgList = addWasmComponentsFromImports(pkgList, allImports);
    pkgList = await addEvidenceForImports(
      pkgList,
      allImports,
      allExports,
      options.deep,
    );
  }
  if (mcpInventory.components?.length) {
    pkgList = trimComponents(pkgList.concat(mcpInventory.components));
  }
  if (mcpInventory.dependencies?.length) {
    dependencies = mergeDependencies(
      dependencies,
      mcpInventory.dependencies,
      parentComponent,
    );
  }
  if (aiInventory.components?.length) {
    pkgList = trimComponents(pkgList.concat(aiInventory.components));
  }
  if (aiInventory.dependencies?.length) {
    dependencies = mergeDependencies(
      dependencies,
      aiInventory.dependencies,
      parentComponent,
    );
  }
  const inventoryServices = mergeServices(
    mergeServices([], mcpInventory.services || []),
    aiInventory.services || [],
  );
  pkgList = propagateRequiredScopeFromDependencies(pkgList, dependencies);
  pkgList = markNpmTypesPackagesAsExcluded(pkgList);
  pkgList = markTypeOnlyDependenciesOptional(pkgList, dependencies);
  if (exactAiInventoryType === "mcp") {
    pkgList = trimComponents(filterInventorySubjectsByTypes(pkgList, ["mcp"]));
    dependencies = filterInventoryDependencies(
      dependencies,
      pkgList,
      inventoryServices,
    );
    if (!parentComponent || !Object.keys(parentComponent).length) {
      parentComponent = createDefaultParentComponent(path, "generic", options);
    }
  }
  return buildBomNSData(options, pkgList, "npm", {
    allImports,
    allExports,
    src: path,
    filename: manifestFiles.join(", "),
    dependencies,
    parentComponent,
    services: inventoryServices,
  });
}

/**
 * Regex matching `.wasm` import paths in analyzer output, including optional
 * query/fragment suffixes.
 *
 * @type {RegExp}
 */
export const WASM_IMPORT_PATTERN = /\.wasm([?#].*)?$/i;

/**
 * Adds generic wasm components from discovered source imports.
 *
 * @param {Array<Object>} pkgList Node.js package list
 * @param {Object} allImports analyzer imports map
 * @returns {Array<Object>} pkgList enriched with wasm components
 */
export const addWasmComponentsFromImports = (pkgList, allImports) => {
  if (!allImports || !Object.keys(allImports).length) {
    return pkgList;
  }
  const existingPurls = new Set();
  for (const pkg of pkgList) {
    if (pkg?.purl) {
      existingPurls.add(pkg.purl);
    }
  }
  for (const [importPath, occurrences] of Object.entries(allImports)) {
    if (!WASM_IMPORT_PATTERN.test(importPath)) {
      continue;
    }
    const cleanImportPath = importPath.replace(/[?#].*$/, "");
    const normalizedImportPath = cleanImportPath
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    const wasmComponentName = normalizedImportPath || cleanImportPath;
    const wasmFileName = basename(cleanImportPath);
    if (!allImports[wasmComponentName]) {
      allImports[wasmComponentName] = new Set();
    }
    for (const occurrence of occurrences) {
      allImports[wasmComponentName].add(occurrence);
    }
    // The import path is the file's location within the project, which is what a
    // purl subpath means. It was previously passed as a `path` qualifier, which
    // the generic type does not allow (it permits only checksum, download_url,
    // repository_url and vcs_url) — that threw out of createBom for any project
    // with a wasm import.
    const wasmPurl = tryBuildPurl({
      type: "generic",
      name: wasmFileName,
      subpath: normalizedImportPath
        ? normalizedImportPath.replace(/^\/+/, "")
        : null,
    });
    if (existingPurls.has(wasmPurl)) {
      continue;
    }
    const firstOccurrence = Array.from(occurrences)[0];
    const srcFile = firstOccurrence?.importedAs || importPath;
    pkgList.push({
      name: wasmComponentName,
      type: "library",
      ...(wasmPurl ? { purl: wasmPurl, "bom-ref": wasmPurl } : {}),
      properties: [
        {
          name: "internal:SrcFile",
          value: srcFile,
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.3,
          methods: [
            {
              technique: "filename",
              confidence: 0.3,
              value: srcFile,
            },
          ],
        },
      },
    });
    existingPurls.add(wasmPurl);
  }
  return pkgList;
};

/**
 * Function to create bom string for caxa SEA binaries
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createCaxaBom(path, options) {
  let pkgList = [];
  let allDependencies = [];
  let finalParentComponent;
  const caxaMetadataFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*metadata.json`,
    { ...options, includeDot: true },
  );
  for (const mfile of caxaMetadataFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${mfile}`);
    }
    let mdata = await parseCaxaMetadata(mfile);
    if (options.caxaAppDir) {
      mdata = await enrichCaxaMetadataFromApp(
        mdata,
        resolve(options.caxaAppDir),
      );
    }
    const { parentComponent, components, dependencies } = mdata;
    if (parentComponent) {
      if (!finalParentComponent) {
        finalParentComponent = parentComponent;
        if (!finalParentComponent.type) {
          finalParentComponent.type = "application";
        }
      } else {
        finalParentComponent.components = finalParentComponent.components || [];
        finalParentComponent.components.push(parentComponent);
      }
    }
    if (components?.length) {
      pkgList = pkgList.concat(components);
    }
    if (dependencies?.length) {
      allDependencies = mergeDependencies(
        allDependencies,
        dependencies,
        finalParentComponent,
      );
    }
  }
  return buildBomNSData(options, pkgList, "npm", {
    src: path,
    filename: caxaMetadataFiles.join(", "),
    dependencies: allDependencies,
    parentComponent: finalParentComponent,
  });
}

/**
 * Function to create BOM for VS Code / IDE extensions.
 * Supports two modes:
 * 1. Directory scan: Discovers `.vsix` files and installed extension directories
 * 2. IDE discovery: Automatically finds extensions installed by known IDEs
 *
 * @param {string} path to the project or directory to scan
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createVscodeExtensionBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  const tempDirs = [];
  const shouldDiscoverInstalledIdeExtensions = hasExplicitProjectTypeSelection(
    options,
    "vscode-extension",
  );

  // Mode 1: Scan for .vsix files in the given directory, or treat the input
  // path as a single .vsix file.
  let vsixFiles = [];
  if (path.endsWith(".vsix")) {
    vsixFiles = [resolve(path)];
  } else {
    vsixFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}*.vsix`,
      options,
    );
  }
  if (vsixFiles.length) {
    if (DEBUG_MODE) {
      console.log(`Found ${vsixFiles.length} .vsix file(s) to parse`);
    }
    for (const f of vsixFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      // Get the extension component metadata
      const component = await parseVsixFile(f);
      if (component) {
        pkgList.push(component);
      }
      // Extract the vsix to a temp dir and run deep analysis
      const extractedDir = await extractVsixToTempDir(f);
      if (extractedDir) {
        tempDirs.push(extractedDir);
        const deepResult = await analyzeExtensionDir(extractedDir, options);
        if (deepResult.pkgList.length) {
          pkgList = pkgList.concat(deepResult.pkgList);
        }
        if (deepResult.dependencies.length) {
          dependencies = mergeDependencies(
            dependencies,
            deepResult.dependencies,
          );
        }
      }
    }
  }

  // Mode 2: Auto-discover extensions from known IDE locations
  if (shouldDiscoverInstalledIdeExtensions) {
    const ideDirs = discoverIdeExtensionDirs();
    if (ideDirs.length) {
      if (DEBUG_MODE) {
        console.log(
          `Discovered IDE extension directories: ${ideDirs.map((d) => `${d.name}: ${d.dir}`).join(", ")}`,
        );
      }
      const ideExtensions = collectInstalledExtensions(ideDirs);
      if (ideExtensions.length) {
        if (DEBUG_MODE) {
          console.log(
            `Found ${ideExtensions.length} IDE extension(s) from ${ideDirs.length} IDE location(s)`,
          );
        }
        pkgList = pkgList.concat(ideExtensions);
        // Deep analysis for IDE extension directories
        for (const ideDir of ideDirs) {
          await analyzeInstalledExtensionDirs(
            ideDir.dir,
            options,
            pkgList,
            dependencies,
          );
        }
      }
    }
  }

  // Clean up temp directories from vsix extraction
  for (const td of tempDirs) {
    cleanupTempDir(td);
  }
  pkgList = trimComponents(pkgList);
  return buildBomNSData(options, pkgList, VSCODE_EXTENSION_PURL_TYPE, {
    src: path,
    filename: vsixFiles.join(", "),
    nsMapping: {},
    dependencies,
  });
}

/**
 * Create a BOM that catalogs agentic CLI tools installed for the current user
 * (for example Kiro CLI, zcode, opencode, and Claude Code), along with the
 * agents, plugins, and providers they define.
 *
 * The scan is read-only and value-redacting: it records tool versions where a
 * declarative source exists, plus structural counts, but never reads
 * credentials, transcripts, session logs, or telemetry.
 *
 * @param {string} path Positional input. A host scan does not read a project
 *   tree, so an explicit path other than the current directory is rejected
 *   rather than silently ignored.
 * @param {Object} options Parse options from the CLI
 * @returns {Promise<Object>} Promise resolving to BOM data
 */
export async function createAgenticBom(path, options) {
  // Guard against a surprising host-wide scan masquerading as a project scan.
  // cdxgen always supplies a positional path (defaulting to "."), so only an
  // explicit path that resolves somewhere other than the current directory is
  // treated as a mistake.
  const resolvedPath = path ? resolve(path) : process.cwd();
  if (resolvedPath !== process.cwd()) {
    throw new Error(
      "The 'agentic' project type performs a host-wide scan of installed " +
        "agentic CLI tool directories and does not accept a path argument. " +
        `Re-run without the path (received '${path}').`,
    );
  }
  // Must not go to stdout: every entry point keeps stdout reserved for the BOM
  // payload so `cdxgen -t agentic -o -` stays pipeable.
  thoughtLog(
    "Scanning the current user's home directory for installed agentic CLI tools.",
  );
  const inventory = collectAgenticTools(options);
  const pkgList = trimComponents(inventory.components || []);
  return buildBomNSData(options, pkgList, AGENTIC_TOOL_PURL_TYPE, {
    src: "~",
    filename: "agentic-cli-tools",
    nsMapping: {},
    dependencies: inventory.dependencies || [],
    services: inventory.services || [],
  });
}

/**
 * Function to create BOM for Electron ASAR archives.
 *
 * @param {string} path to a single archive or a directory to scan
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createAsarBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};
  const tempDirs = [];
  const processedArchives = new Set();
  const maxNestedAsarDepth = 4;
  const explicitAsarPath = path.endsWith(".asar") ? resolve(path) : undefined;
  let asarFiles = explicitAsarPath
    ? [explicitAsarPath]
    : getAllFiles(path, `${options.multiProject ? "**/" : ""}*.asar`, options);

  if (!explicitAsarPath) {
    asarFiles = asarFiles.filter((f) => isAsarArchiveSync(f));
  }

  const aggregateArchiveResults = (
    archiveAnalysis,
    isPrimaryArchive = false,
  ) => {
    if (
      archiveAnalysis.parentComponent &&
      Object.keys(archiveAnalysis.parentComponent).length
    ) {
      if (isPrimaryArchive && !Object.keys(parentComponent).length) {
        parentComponent = archiveAnalysis.parentComponent;
      } else {
        pkgList.push(archiveAnalysis.parentComponent);
      }
    }
    if (archiveAnalysis.components?.length) {
      pkgList = pkgList.concat(archiveAnalysis.components);
    }
    if (archiveAnalysis.dependencies?.length) {
      dependencies = mergeDependencies(
        dependencies,
        archiveAnalysis.dependencies,
        parentComponent,
      );
    }
  };

  const analyzeExtractedArchive = async (
    extractedDir,
    archiveAnalysis,
    archiveIdentityPath,
  ) => {
    if (!archiveAnalysis.packageManifestPaths?.length) {
      return undefined;
    }
    const nodeBomOptions = {
      ...options,
      installDeps: false,
      multiProject: true,
      noBabel: false,
      path: extractedDir,
      projectType: ["js"],
    };
    const nodeBomData = await createNodejsBom(extractedDir, nodeBomOptions);
    if (nodeBomData?.bomJson?.components?.length) {
      rewriteExtractedArchivePaths(
        nodeBomData.bomJson.components,
        extractedDir,
        archiveIdentityPath,
      );
      pkgList = pkgList.concat(nodeBomData.bomJson.components);
    }
    if (nodeBomData?.bomJson?.dependencies?.length) {
      dependencies = mergeDependencies(
        dependencies,
        nodeBomData.bomJson.dependencies,
      );
    }
    if (
      archiveAnalysis.parentComponent?.["bom-ref"] &&
      nodeBomData?.parentComponent?.["bom-ref"] &&
      archiveAnalysis.parentComponent["bom-ref"] !==
        nodeBomData.parentComponent["bom-ref"]
    ) {
      rewriteExtractedArchivePaths(
        nodeBomData.parentComponent,
        extractedDir,
        archiveIdentityPath,
      );
      dependencies = mergeDependencies(dependencies, [
        {
          ref: archiveAnalysis.parentComponent["bom-ref"],
          dependsOn: [nodeBomData.parentComponent["bom-ref"]],
        },
      ]);
    }
    return nodeBomData;
  };

  const processAsarArchive = async (
    archivePath,
    archiveIdentityPath,
    isPrimaryArchive = false,
    depth = 0,
  ) => {
    const processedKey = archiveIdentityPath;
    if (processedArchives.has(processedKey)) {
      return undefined;
    }
    processedArchives.add(processedKey);
    const archiveAnalysis = await parseAsarArchive(archivePath, {
      ...options,
      asarVirtualPath: archiveIdentityPath,
    });
    aggregateArchiveResults(archiveAnalysis, isPrimaryArchive);
    const shouldExtract =
      archiveAnalysis.packageManifestPaths?.length ||
      (depth < maxNestedAsarDepth &&
        archiveAnalysis.summary?.nestedArchiveCount > 0);
    if (!shouldExtract) {
      return archiveAnalysis.parentComponent?.["bom-ref"];
    }
    const extractedDir = await extractAsarToTempDir(archivePath);
    if (!extractedDir) {
      return archiveAnalysis.parentComponent?.["bom-ref"];
    }
    tempDirs.push(extractedDir);
    await analyzeExtractedArchive(
      extractedDir,
      archiveAnalysis,
      archiveIdentityPath,
    );
    if (depth < maxNestedAsarDepth) {
      const nestedAsarFiles = getAllFiles(extractedDir, "**/*.asar", options);
      for (const nestedArchivePath of nestedAsarFiles) {
        const relativeNestedArchivePath = relative(
          extractedDir,
          nestedArchivePath,
        ).replaceAll("\\", "/");
        if (
          !relativeNestedArchivePath ||
          relativeNestedArchivePath.startsWith("..")
        ) {
          continue;
        }
        const nestedArchiveIdentityPath = `${archiveIdentityPath}#/${relativeNestedArchivePath}`;
        let nestedParentRef;
        try {
          nestedParentRef = await processAsarArchive(
            nestedArchivePath,
            nestedArchiveIdentityPath,
            false,
            depth + 1,
          );
        } catch (err) {
          if (options.failOnError) {
            console.error(
              `Error processing nested ASAR archive ${nestedArchivePath}: ${err.message}`,
            );
            process.exit(1);
          }
          console.warn(
            `Skipping nested ASAR archive ${nestedArchivePath}: ${err.message}`,
          );
        }
        if (
          archiveAnalysis.parentComponent?.["bom-ref"] &&
          nestedParentRef &&
          archiveAnalysis.parentComponent["bom-ref"] !== nestedParentRef
        ) {
          dependencies = mergeDependencies(dependencies, [
            {
              ref: archiveAnalysis.parentComponent["bom-ref"],
              dependsOn: [nestedParentRef],
            },
          ]);
        }
      }
    }
    return archiveAnalysis.parentComponent?.["bom-ref"];
  };
  try {
    for (const archivePath of asarFiles) {
      const isPrimaryArchive =
        explicitAsarPath && resolve(archivePath) === explicitAsarPath;
      try {
        await processAsarArchive(
          archivePath,
          resolve(archivePath),
          isPrimaryArchive,
          0,
        );
      } catch (err) {
        if (options.failOnError) {
          console.error(
            `Error processing ASAR archive ${archivePath}: ${err.message}`,
          );
          process.exit(1);
        }
        console.warn(`Skipping ASAR archive ${archivePath}: ${err.message}`);
      }
    }
  } finally {
    for (const tempDir of tempDirs) {
      cleanupAsarTempDir(tempDir);
    }
  }
  pkgList = trimComponents(pkgList);
  return buildBomNSData(options, pkgList, "asar", {
    src: path,
    filename: asarFiles.join(", "),
    nsMapping: {},
    dependencies,
    parentComponent,
  });
}

/**
 * Function to create BOM for installed Chrome and Chromium-based browser extensions.
 *
 * @param {string} path to the project path or a directly provided extension path
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createChromeExtensionBom(path, options) {
  let dependencies = [];
  let sourcePaths = [];
  const directResult = collectChromeExtensionsFromPath(path);
  const shouldDiscoverInstalledChromeExtensions =
    hasExplicitProjectTypeSelection(options, "chrome-extension");
  let pkgList = directResult.components || [];
  if (directResult.extensionDirs?.length) {
    sourcePaths = directResult.extensionDirs.slice();
    for (const extDir of directResult.extensionDirs) {
      const deepResult = await analyzeExtensionDir(extDir, options);
      if (deepResult.pkgList.length) {
        pkgList = pkgList.concat(deepResult.pkgList);
      }
      if (deepResult.dependencies.length) {
        dependencies = mergeDependencies(dependencies, deepResult.dependencies);
      }
    }
  }
  if (pkgList.length && DEBUG_MODE) {
    thoughtLog(
      `Found ${pkgList.length} component(s) from direct Chrome extension path scan`,
    );
  }
  if (shouldDiscoverInstalledChromeExtensions) {
    const chromeDirs = discoverChromiumExtensionDirs();
    if (chromeDirs.length) {
      if (DEBUG_MODE) {
        thoughtLog(
          `Discovered Chromium extension directories: ${chromeDirs.map((d) => `${d.browser} (${d.channel}): ${d.dir}`).join(", ")}`,
        );
      }
      if (!pkgList.length) {
        pkgList = collectInstalledChromeExtensions(chromeDirs);
        sourcePaths = chromeDirs.map((d) => d.dir);
      }
      if (DEBUG_MODE && pkgList.length && !directResult.components?.length) {
        thoughtLog(
          `Found ${pkgList.length} Chrome/Chromium extension(s) from ${chromeDirs.length} browser location(s)`,
        );
      }
    }
  }
  pkgList = trimComponents(pkgList);
  return buildBomNSData(options, pkgList, CHROME_EXTENSION_PURL_TYPE, {
    src: path,
    filename: sourcePaths.join(", "),
    nsMapping: {},
    dependencies,
  });
}

/**
 * Analyze an extracted extension directory for bundled dependencies.
 * Looks for npm lock files, node_modules, package.json files, minified JS,
 * and runs the babel-based analyzer on the source.
 *
 * @param {string} extDir Path to the extracted extension directory
 * @param {Object} options CLI options
 * @returns {Promise<{pkgList: Object[], dependencies: Object[]}>}
 */
export async function analyzeExtensionDir(extDir, options) {
  const pkgList = [];
  let dependencies = [];
  // Check if the extension directory contains node.js project artifacts
  const hasPackageJson = safeExistsSync(join(extDir, "package.json"));
  const hasNodeModules = safeExistsSync(join(extDir, "node_modules"));
  const hasLockFile =
    safeExistsSync(join(extDir, "package-lock.json")) ||
    safeExistsSync(join(extDir, "yarn.lock")) ||
    safeExistsSync(join(extDir, "pnpm-lock.yaml"));

  // If there are lock files or node_modules, run the full Node.js BOM generator
  if (hasPackageJson && (hasLockFile || hasNodeModules)) {
    if (DEBUG_MODE) {
      console.log(
        `Running Node.js BOM analysis on extension directory: ${extDir}`,
      );
    }
    const nodeBomOptions = {
      ...options,
      path: extDir,
      multiProject: true,
      installDeps: false,
      noBabel: false,
      projectType: ["js"],
    };
    const bomData = await createNodejsBom(extDir, nodeBomOptions);
    if (bomData?.bomJson?.components?.length) {
      for (const comp of bomData.bomJson.components) {
        pkgList.push(comp);
      }
    }
    if (bomData?.bomJson?.dependencies?.length) {
      dependencies = mergeDependencies(
        dependencies,
        bomData.bomJson.dependencies,
      );
    }
    return { pkgList, dependencies };
  }
  return { pkgList, dependencies };
}

/**
 * Run deep analysis on installed extension subdirectories within a parent
 * extensions directory. Each subdirectory represents an installed extension.
 *
 * @param {string} extensionsDir Parent directory containing extension subdirs
 * @param {Object} options CLI options
 * @param {Object[]} pkgList Mutable array to push discovered components into
 * @param {Object[]} dependencies Mutable array to merge dependencies into
 */
export async function analyzeInstalledExtensionDirs(
  extensionsDir,
  options,
  pkgList,
  dependencies,
) {
  let entries;
  try {
    entries = readdirSync(extensionsDir, { withFileTypes: true });
  } catch (_e) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const extDir = join(extensionsDir, entry.name);
    const deepResult = await analyzeExtensionDir(extDir, options);
    if (deepResult.pkgList.length) {
      pkgList.push(...deepResult.pkgList);
    }
    if (deepResult.dependencies.length) {
      const merged = mergeDependencies(dependencies, deepResult.dependencies);
      dependencies.splice(0, dependencies.length, ...merged);
    }
  }
}
