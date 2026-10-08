import { Buffer } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";
import { parse as loadYaml } from "yaml";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { deferFailOnError } from "../core/deferredExit.js";
import {
  CARGO_CMD,
  CARGO_TARGET,
  CLJ_CMD,
  hasAnyProjectType,
  LEIN_CMD,
  SWIFT_CMD,
  shouldFetchLicense,
  shouldFetchPackageMetadata,
} from "../core/env.js";
import {
  checksumFile,
  getAllFiles,
  safeExistsSync,
  safeSpawnSync,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { dirNameStr, isMac } from "../core/paths.js";
import {
  buildDependentPurl,
  collapseCmakeVersions,
  preferFetchedCmakeDependencies,
  resolveCmakeContext,
  withoutScrapedFetchDependency,
} from "../ecosystems/cmakeResolver.js";
import {
  emptyCppBuildContext,
  resolveCppBuildContext,
} from "../ecosystems/cppBuildContext.js";
import { getCppModules, hasCppSources } from "../ecosystems/cppEvidence.js";
import {
  getCratesMetadata,
  getSwiftPackageMetadata,
} from "../ecosystems/ecosystems.js";
import { parseShardsProject } from "../ecosystems/parsers-crystal.js";
import {
  createElmCacheReader,
  getElmMetadata,
  isElmProjectFile,
  parseElmProject,
  parseLegacyElmProject,
} from "../ecosystems/parsers-elm.js";
import { parseGleamProject } from "../ecosystems/parsers-gleam.js";
import {
  isGoModWhyNotNeeded,
  parseGoListDep,
  parseGoModData,
  parseGoModGraph,
  parseGoModulesTxt,
  parseGoModWhy,
  parseGopkgData,
  parseGosumData,
  parseGosumHashes,
} from "../ecosystems/parsers-go.js";
import { parseJuliaProject } from "../ecosystems/parsers-julia.js";
import {
  parseCljDep,
  parseEdnData,
  parseLeinDep,
  parseLeiningenData,
} from "../ecosystems/parsers-jvm.js";
import {
  parseLuaRocksLock,
  parseRockspecFile,
} from "../ecosystems/parsers-lua.js";
import {
  buildObjectForCocoaPod,
  classifySwiftDependencyScopes,
  executeAlpmList,
  executeApkList,
  executeDpkgList,
  executeEqueryList,
  executePodCommand,
  executeRpmList,
  parseCabalData,
  parseCmakeLikeFile,
  parseCocoaDependency,
  parseColliderLockData,
  parseConanData,
  parseConanLockData,
  parseFlakeLock,
  parseFlakeNix,
  parseMakeDFile,
  parseMixLockData,
  parsePodfileLock,
  parsePodfileTargets,
  parsePubLockData,
  parsePubYamlData,
  parseSwiftJsonTree,
  parseSwiftResolved,
  prefetchCocoaPodspecs,
} from "../ecosystems/parsers-misc.js";
import { parseNimProject } from "../ecosystems/parsers-nim.js";
import { parseOpamLockedFile } from "../ecosystems/parsers-opam.js";
import { parseRebarLock } from "../ecosystems/parsers-rebar.js";
import {
  applyCargoDependencyKindMetadata,
  buildCargoLockDependencyGraph,
  buildCargoNativeLibraryComponents,
  cargoComponentKey,
  parseCargoData,
  parseCargoDependencyData,
  parseCargoManifestDependencyData,
  parseCargoManifestDependencyKinds,
  parseCargoMetadataResolve,
  parseCargoTomlData,
  rollupCargoDependencyKinds,
} from "../ecosystems/parsers-rust.js";
import { parseSpackLock } from "../ecosystems/parsers-spack.js";
import { parseStackProject } from "../ecosystems/parsers-stack.js";
import { findVendoredCode } from "../ecosystems/vendoredCode.js";
import { resolveZigGraph } from "../ecosystems/zigResolver.js";
import { cmakeBuildDirCandidates } from "../inventory/cmakeBuildDirs.js";
import { mergeDependencies, trimComponents } from "../inventory/depsUtils.js";
import { convertOSQueryResults } from "../inventory/evidenceUtils.js";
import { applyPurl, nixBomRef, tryBuildPurl } from "../inventory/purl.js";
import {
  classifyProbeResult,
  classifySpawnRestriction,
} from "../inventory/toolRequirements.js";
import { executeOsQuery } from "../managers/binary.js";
import {
  buildBomNSData,
  createBinaryBom,
  createDefaultParentComponent,
} from "./bomAssembly.js";

const isWin = process.platform === "win32";

const cosDbQueries = JSON.parse(
  readFileSync(join(dirNameStr, "data", "cosdb-queries.json"), "utf-8"),
);

/**
 * Strip an unresolved CMake/MSBuild variable from a component's version and purl.
 *
 * A variable defined in a parent `CMakeLists.txt` (`project(foo VERSION
 * ${PARENT_VERSION})`) cannot be resolved from the file that references it, and
 * percent-encoding one into a purl publishes the variable name as the version
 * (`pkg:generic/foo@%24%7B...%7D`). The scrapers drop such versions at the
 * point they are read; this is the final check over everything reaching the
 * BOM, covering components contributed by `cppEvidence` and the CMake cache
 * resolver as well.
 *
 * @param {object} component Component to sanitise in place
 */
function sanitizeUnresolvedPurl(component) {
  if (!component) {
    return;
  }
  const hasUnresolvedVar =
    component.version?.includes("${") ||
    (component.purl &&
      (component.purl.includes("%24%7B") || component.purl.includes("${")));
  if (!hasUnresolvedVar) {
    return;
  }
  if (component.version?.includes("${")) {
    component.version = "";
  }
  applyPurl(
    component,
    tryBuildPurl({
      type: "generic",
      namespace: component.group || null,
      name: component.name,
      version: null,
    }),
  );
}

/**
 * Resolves the local Cargo registry cache directory from the `CARGO_CACHE_DIR`
 * or `CARGO_HOME` environment variables, falling back to `~/.cargo/registry/cache`.
 *
 * @returns {string|undefined} Absolute path to the Cargo cache directory
 */
export function getCargoCacheDir() {
  return readEnvironmentVariable("CARGO_CACHE_DIR")
    ? resolve(readEnvironmentVariable("CARGO_CACHE_DIR"))
    : resolve(
        readEnvironmentVariable("CARGO_HOME") || join(homedir(), ".cargo"),
        "registry",
        "cache",
      );
}

/**
 * Function to create bom string for Go projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object | undefined>} Promise resolving to a BOM object or `undefined`
 */
export async function createGoBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = createDefaultParentComponent(path, "golang", options);
  // Is this a binary file
  let maybeBinary;
  try {
    maybeBinary = statSync(path).isFile();
  } catch (_err) {
    maybeBinary = false;
  }
  if (maybeBinary || options?.lifecycle?.includes("post-build")) {
    return createBinaryBom(path, options);
  }

  // Read in go.sum and merge all go.sum files.
  const gosumFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}go.sum`,
    options,
  );

  // If USE_GOSUM is true|1, generate BOM components only using go.sum.
  const useGosum =
    readEnvironmentVariable("USE_GOSUM") &&
    ["true", "1"].includes(readEnvironmentVariable("USE_GOSUM"));
  if (useGosum && gosumFiles.length) {
    console.warn(
      "Using go.sum to generate BOMs for go projects may return an inaccurate representation of transitive dependencies.\nSee: https://github.com/golang/go/wiki/Modules#is-gosum-a-lock-file-why-does-gosum-include-information-for-module-versions-i-am-no-longer-using\n",
      "Set USE_GOSUM=false to generate BOMs using go.mod as the dependency source of truth.",
    );
    for (const f of gosumFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gosumData = readFileSync(f, { encoding: "utf-8" });
      const dlist = await parseGosumData(gosumData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    const doneList = {};
    const requiredModules = new Set();
    const unneededModules = new Set();
    let circuitBreak = false;
    if (DEBUG_MODE) {
      console.log(
        `Attempting to detect required packages using "go mod why" command for ${pkgList.length} packages`,
      );
    }
    // Using go mod why detect required packages
    for (const apkg of pkgList) {
      if (circuitBreak) {
        break;
      }
      const pkgFullName = `${apkg.name}`;
      if (apkg.scope === "required") {
        requiredModules.add(pkgFullName);
        continue;
      }
      if (
        apkg.scope === "optional" ||
        requiredModules.has(pkgFullName) ||
        doneList[pkgFullName]
      ) {
        continue;
      }
      if (DEBUG_MODE) {
        console.log(`go mod why -m -vendor ${pkgFullName}`);
      }
      const mresult = safeSpawnSync(
        "go",
        ["mod", "why", "-m", "-vendor", pkgFullName],
        {
          cwd: path,
        },
      );
      if (mresult.status !== 0 || mresult.error) {
        if (DEBUG_MODE) {
          if (mresult.stdout) {
            console.log(mresult.stdout);
          }
          if (mresult.stderr) {
            console.log(mresult.stderr);
          }
        }
        circuitBreak = true;
      } else {
        const mstdout = mresult.stdout;
        if (mstdout) {
          const cmdOutput = Buffer.from(mstdout).toString();
          if (isGoModWhyNotNeeded(cmdOutput)) {
            unneededModules.add(pkgFullName);
          } else {
            // The last line of the import chain is a package of the module:
            // github.com/golang/protobuf/proto for github.com/golang/protobuf
            const whyPkg = parseGoModWhy(cmdOutput);
            if (
              whyPkg === pkgFullName ||
              whyPkg?.startsWith(`${pkgFullName}/`)
            ) {
              requiredModules.add(pkgFullName);
            }
          }
          doneList[pkgFullName] = true;
        }
      }
    }
    // A module go reports as unneeded is optional, but only when every module
    // was checked: once go mod why fails, the answers are incomplete, and a
    // tool failure is not evidence that a module is unused.
    for (const apkg of pkgList) {
      if (apkg.scope) {
        continue;
      }
      if (requiredModules.has(apkg.name)) {
        apkg.scope = "required";
      } else if (!circuitBreak && unneededModules.has(apkg.name)) {
        apkg.scope = "optional";
      }
    }
    if (DEBUG_MODE) {
      console.log(
        `Required packages: ${requiredModules.size}, not needed: ${circuitBreak ? "unknown" : unneededModules.size}`,
      );
    }
    return buildBomNSData(options, pkgList, "golang", {
      src: path,
      dependencies,
      parentComponent,
      filename: gosumFiles.join(", "),
    });
  }

  // If USE_GOSUM is false, generate BOM components using go.mod.
  const gosumMap = {};
  if (gosumFiles.length) {
    for (const f of gosumFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gosumData = readFileSync(f, { encoding: "utf-8" });
      // Only the hashes are needed here; reading them costs no registry
      // round trip. The components come from go.mod and the go list output.
      Object.assign(gosumMap, parseGosumHashes(gosumData));
    }
  }

  // Read in data from Gopkg.lock files if they exist
  const gopkgLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gopkg.lock`,
    options,
  );

  // Read in go.mod files and parse BOM components with checksums from gosumData
  const gomodFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}go.mod`,
    options,
  );
  // Collect any vendored dependencies
  const modulesTxtFiles = getAllFiles(path, "vendor/**/modules.txt", options);
  for (const f of modulesTxtFiles) {
    const dlist = await parseGoModulesTxt(f, gosumMap);
    pkgList = pkgList.concat(dlist);
  }
  if (gomodFiles.length) {
    let shouldManuallyParse = false;
    // Sort go.mod files by depth (shallowest first) to prioritize root modules
    const sortedGomodFiles = gomodFiles.sort((a, b) => {
      const relativePathA = relative(path, a);
      const relativePathB = relative(path, b);
      const depthA = relativePathA.split("/").length;
      const depthB = relativePathB.split("/").length;
      return depthA - depthB;
    });

    let rootParentComponent = null;
    // Use the go list -deps and go mod why commands to generate a good quality BOM for non-docker invocations
    if (
      !hasAnyProjectType(["docker", "oci", "container", "os"], options, false)
    ) {
      for (const f of sortedGomodFiles) {
        const basePath = dirname(f);
        // Ignore vendor packages and test fixtures
        if (
          basePath.includes("/vendor/") ||
          basePath.includes("/build/") ||
          basePath.includes("/test-fixtures/")
        ) {
          continue;
        }
        // First we execute the go list -deps command which gives the correct list of dependencies
        if (DEBUG_MODE) {
          console.log("Executing go list -deps in", basePath);
        }
        // TODO: Replacing this with -json gives us more interesting data points such as GoFiles, Imports, and Deps
        let result = safeSpawnSync(
          "go",
          [
            "list",
            "-deps",
            "-f",
            "'{{with .Module}}{{.Path}}|{{.Version}}|{{.Indirect}}|{{.GoMod}}|{{.GoVersion}}|{{.Main}}|{{.Time}}|{{.Deprecated}}|{{.GoModSum}}|{{.Dir}}{{end}}'",
            "./...",
          ],
          {
            cwd: basePath,
          },
        );
        if (result.status !== 0 || result.error) {
          // go list -deps command may not work when private packages are involved
          // So we support a fallback to only operate with go mod graph command output in such instances
          console.log("go list -deps command has failed for", basePath);
          shouldManuallyParse = true;
          // A spawn the runtime or a policy denied is neither a missing
          // toolchain nor an engaged fallback; the version probes report
          // that as degraded evidence and the policy entries name the fix.
          if (
            !classifySpawnRestriction("go") &&
            result.error &&
            classifyProbeResult(result) === "missing"
          ) {
            recordDegradation("go.toolchain.missing", {
              ecosystem: "go",
              tool: "go",
              impact: "transitive-deps",
              command: "go list -deps ./...",
              detail:
                "The go executable could not be run, so the module graph was not resolved.",
            });
          }
          if (DEBUG_MODE && result.stdout) {
            console.log(result.stdout);
          }
          if (DEBUG_MODE && result.stderr) {
            console.log(result.stderr);
          }
          deferFailOnError(options, {
            ecosystem: "go",
            tool: "go",
            detail: "the go module graph command failed",
          });
        }
        const stdout = result.stdout;
        if (stdout) {
          let cmdOutput = Buffer.from(stdout).toString();
          const retMap = await parseGoListDep(cmdOutput, gosumMap);
          if (retMap.pkgList?.length) {
            pkgList = pkgList.concat(retMap.pkgList);
          }
          // Prioritize the shallowest module as the root component
          if (
            retMap.parentComponent &&
            Object.keys(retMap.parentComponent).length
          ) {
            if (!rootParentComponent) {
              // First (shallowest) module becomes the root
              rootParentComponent = retMap.parentComponent;
              rootParentComponent.type = "application";
              parentComponent = rootParentComponent;
            } else {
              // Subsequent modules become subcomponents
              if (!parentComponent.components) {
                parentComponent.components = [];
              }
              parentComponent.components.push(retMap.parentComponent);
            }
          }
          if (DEBUG_MODE) {
            console.log("Executing go mod graph in", basePath);
          }
          // Next we use the go mod graph command to construct the dependency tree
          result = safeSpawnSync("go", ["mod", "graph"], {
            cwd: basePath,
          });
          // Check if got a mod graph successfully
          if (result.status !== 0 || result.error) {
            console.log("go mod graph command has failed.");
            if (DEBUG_MODE && result.stdout) {
              console.log(result.stdout);
              if (result?.stdout.includes("unrecognized import path")) {
                console.log(
                  "go couldn't download all the modules, including any private modules. Dependency tree would be missing.",
                );
              }
            }
            if (DEBUG_MODE && result.stderr) {
              console.log(result.stderr);
            }
            deferFailOnError(options, {
              ecosystem: "go",
              tool: "go",
              detail: "the go list command failed",
            });
          }
          if (result.stdout) {
            cmdOutput = Buffer.from(result.stdout).toString();
            const retMap = await parseGoModGraph(
              cmdOutput,
              f,
              gosumMap,
              pkgList,
              parentComponent,
            );
            if (retMap.pkgList?.length) {
              pkgList = pkgList.concat(retMap.pkgList);
              pkgList = trimComponents(pkgList);
            }
            if (retMap.dependenciesList?.length) {
              dependencies = mergeDependencies(
                dependencies,
                retMap.dependenciesList,
                parentComponent,
              );
            }
            // Retain the parent component hierarchy
            if (Object.keys(retMap.parentComponent).length) {
              parentComponent.components = parentComponent.components || [];
              parentComponent.components.push(retMap.parentComponent);
            }
          }
        } else {
          if (DEBUG_MODE) {
            console.log("Executing go mod graph in", basePath);
          }
          // Next we use the go mod graph command to construct the dependency tree
          result = safeSpawnSync("go", ["mod", "graph"], {
            cwd: basePath,
            shell: isWin,
          });
          if (result.stdout) {
            const cmdOutput = Buffer.from(result.stdout).toString();
            // The arguments to parseGoModGraph are slightly different to force inclusion of all packages
            const retMap = await parseGoModGraph(
              cmdOutput,
              f,
              gosumMap,
              [],
              {},
            );
            if (retMap.pkgList?.length) {
              pkgList = pkgList.concat(retMap.pkgList);
              pkgList = trimComponents(pkgList);
            }
            if (retMap.dependenciesList?.length) {
              dependencies = mergeDependencies(
                dependencies,
                retMap.dependenciesList,
                parentComponent,
              );
            }
            // Retain the parent component hierarchy, prioritizing the shallowest module
            if (Object.keys(retMap.parentComponent).length) {
              if (!rootParentComponent) {
                // First (shallowest) module becomes the root
                rootParentComponent = retMap.parentComponent;
                parentComponent = rootParentComponent;
              } else {
                // Subsequent modules become subcomponents
                parentComponent.components = parentComponent.components || [];
                parentComponent.components.push(retMap.parentComponent);
              }
            }
          } else {
            shouldManuallyParse = true;
            console.log(
              "1. Check if the correct version of golang is installed. Try building the application using go build or make command to troubleshoot.",
            );
            console.log(
              "2. If the application uses private go modules, ensure the environment variable GOPRIVATE is set with the comma-separated repo names.\nEnsure $HOME/.netrc file contains a valid username and password for the private repos.",
            );
            console.log(
              "3. Alternatively, consider generating a post-build SBOM from the built binary using blint. Use the official container image and invoke cdxgen with the arguments `-t binary --lifecycle post-build`.",
            );
            deferFailOnError(options, {
              ecosystem: "go",
              tool: "go",
              detail: "no go dependency evidence could be collected",
            });
          }
        }
      }
      if (pkgList.length && !shouldManuallyParse) {
        return buildBomNSData(options, pkgList, "golang", {
          dependencies,
          parentComponent,
          src: path,
          filename: sortedGomodFiles.join(", "),
        });
      }
    }
    // Parse the gomod files manually. The resultant BOM would be incomplete
    if (
      !hasAnyProjectType(["docker", "oci", "container", "os"], options, false)
    ) {
      // When the environment itself denies the go command, the version
      // probes record the restriction as degraded evidence and the policy
      // entries name the fix; the fallback is the finding only when the
      // toolchain was free to run and could not resolve the graph.
      if (!classifySpawnRestriction("go")) {
        recordDegradation("go.mod-only-fallback", {
          ecosystem: "go",
          tool: "go",
          impact: "transitive-deps",
          detail:
            "The go toolchain could not resolve the module graph, so go.mod was parsed manually and components carry only the declared requires.",
        });
      }
      console.log(
        "Manually parsing go.mod files. The resultant BOM would be incomplete.",
      );
    }
    for (const f of sortedGomodFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gomodData = readFileSync(f, { encoding: "utf-8" });
      const retMap = await parseGoModData(gomodData, gosumMap);
      if (retMap?.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      // Retain the parent component hierarchy, prioritizing the shallowest module
      if (
        retMap?.parentComponent &&
        Object.keys(retMap.parentComponent).length
      ) {
        if (!rootParentComponent) {
          // First (shallowest) module becomes the root
          rootParentComponent = retMap.parentComponent;
          parentComponent = rootParentComponent;
        } else {
          // Subsequent modules become subcomponents
          parentComponent.components = parentComponent.components || [];
          parentComponent.components.push(retMap.parentComponent);
        }
        if (retMap?.rootList?.length) {
          const thisParentDependsOn = [
            {
              ref: retMap.parentComponent["bom-ref"],
              dependsOn: [
                ...new Set(retMap.rootList.map((c) => c["bom-ref"])),
              ].sort(),
            },
          ];
          dependencies = mergeDependencies(
            dependencies,
            thisParentDependsOn,
            parentComponent,
          );
        }
      }
    }
    return buildBomNSData(options, pkgList, "golang", {
      src: path,
      dependencies,
      parentComponent,
      filename: sortedGomodFiles.join(", "),
    });
  }
  if (gopkgLockFiles.length) {
    for (const f of gopkgLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gopkgData = readFileSync(f, {
        encoding: "utf-8",
      });
      const dlist = await parseGopkgData(gopkgData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "golang", {
      src: path,
      dependencies,
      parentComponent,
      filename: gopkgLockFiles.join(", "),
    });
  }
  return {};
}

/**
 * Whether the cargo executable answers a version probe.
 *
 * A cargo command run through a shell — the Windows path — reports an absent
 * executable as a non-zero exit with the shell's own complaint on stderr, not
 * as a spawn error, so a failed build alone cannot tell a missing toolchain
 * from a broken project. The probe answers that question directly.
 *
 * @param {string} cwd Directory to probe from.
 * @returns {boolean} True when cargo answered.
 */
function cargoAnswersVersion(cwd) {
  const probe = safeSpawnSync(CARGO_CMD, ["--version"], {
    cdxgenActivity: {
      kind: "probe",
      metadata: { tool: "cargo" },
      probeType: "build-tool-availability",
    },
    cwd,
    encoding: "utf-8",
    shell: isWin,
  });
  return classifyProbeResult(probe) === "found";
}

/**
 * Function to create bom string for Rust projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object|undefined>} Promise resolving to a BOM object or undefined
 */
/**
 * Run `cargo metadata` for a manifest and return its parsed resolve graph.
 *
 * The lock file is the union of every dependency kind and every target triple,
 * so it cannot answer which crates are dev-only or platform-gated. Only
 * `cargo metadata` carries that, per dependency edge, in `resolve.nodes[].deps[].dep_kinds`.
 *
 * @param {string} cargoTomlFile Manifest path
 * @param {string} [filterPlatform] Target triple to resolve the graph for
 * @returns {object|undefined} Parsed `cargo metadata` output
 */
function runCargoMetadata(cargoTomlFile, filterPlatform) {
  const basePath = dirname(cargoTomlFile);
  const platformArgs = filterPlatform
    ? ["--filter-platform", filterPlatform]
    : [];
  // `--locked` keeps the user's lock file untouched; a workspace that is out of
  // date with its lock file needs the retry without it.
  for (const lockArgs of [["--locked"], []]) {
    const cargoArgs = [
      "metadata",
      "--format-version",
      "1",
      "--manifest-path",
      cargoTomlFile,
      ...platformArgs,
      ...lockArgs,
    ];
    if (DEBUG_MODE) {
      console.log("Executing", CARGO_CMD, cargoArgs.join(" "), "in", basePath);
    }
    const result = safeSpawnSync(CARGO_CMD, cargoArgs, {
      cwd: basePath,
      shell: isWin,
    });
    if (result.status === 0 && !result.error && result.stdout) {
      try {
        return JSON.parse(result.stdout);
      } catch (err) {
        if (DEBUG_MODE) {
          console.log(`Unable to parse the cargo metadata output: ${err}`);
        }
        return undefined;
      }
    }
    if (DEBUG_MODE) {
      console.log(result.error, result.stderr);
    }
  }
  return undefined;
}

/**
 * Annotate cargo components with their dependency kind, platform gate and
 * scope.
 *
 * With `--deep`, the edge kinds come from `cargo metadata` and are exact at
 * every depth. Otherwise they are recovered from the manifests, which is exact
 * for the dependencies a workspace member declares and inherited below them.
 *
 * @param {object[]} pkgList Components to annotate
 * @param {object[]} dependencyTree Lockfile dependency relationships
 * @param {string[]} cargoFiles Manifest paths
 * @param {Map<string, string>} manifestRootKeys Manifest path to root component key
 * @param {object} options CLI options
 */
function annotateCargoDependencyKinds(
  pkgList,
  dependencyTree,
  cargoFiles,
  manifestRootKeys,
  options,
) {
  if (!pkgList?.length) {
    return;
  }
  const allEdges = new Map();
  if (options?.deep) {
    const rollups = new Map();
    const packageInfo = new Map();
    const visitedWorkspaceRoots = new Set();
    // The keys that survive resolution for the requested target triple. The
    // unfiltered graph still supplies the kinds, because a crate's kind does
    // not change with the triple.
    const targetIncludedKeys = CARGO_TARGET ? new Set() : undefined;
    let targetFilterApplied = !CARGO_TARGET;
    let anyMetadata = false;
    let everyMetadata = true;
    for (const cargoTomlFile of cargoFiles) {
      const metadata = runCargoMetadata(cargoTomlFile);
      if (!metadata) {
        everyMetadata = false;
        continue;
      }
      // Every member of a workspace answers with the same resolve graph.
      const workspaceRoot = metadata.workspace_root || cargoTomlFile;
      if (visitedWorkspaceRoots.has(workspaceRoot)) {
        anyMetadata = true;
        continue;
      }
      visitedWorkspaceRoots.add(workspaceRoot);
      anyMetadata = true;
      if (CARGO_TARGET) {
        const targetMetadata = runCargoMetadata(cargoTomlFile, CARGO_TARGET);
        if (targetMetadata) {
          for (const key of parseCargoMetadataResolve(targetMetadata)
            .resolvedKeys) {
            targetIncludedKeys.add(key);
          }
          targetFilterApplied = true;
        } else {
          console.warn(
            `cargo metadata could not resolve the dependency graph for the target ${CARGO_TARGET}. The components are not filtered by target.`,
          );
        }
      }
      const graph = parseCargoMetadataResolve(metadata);
      for (const [key, value] of graph.packageInfo) {
        packageInfo.set(key, value);
      }
      for (const [key, value] of graph.edges) {
        allEdges.set(key, [...(allEdges.get(key) || []), ...value]);
      }
      for (const [key, value] of rollupCargoDependencyKinds(graph)) {
        const existing = rollups.get(key);
        if (!existing) {
          rollups.set(key, value);
          continue;
        }
        // A crate that is a runtime dependency of any workspace in the scan is
        // a runtime dependency of the BOM.
        for (const kind of value.kinds) {
          existing.kinds.add(kind);
        }
        for (const target of value.targets) {
          existing.targets.add(target);
        }
        const precedence = ["root", "runtime", "build", "dev"];
        if (
          precedence.indexOf(value.kind) < precedence.indexOf(existing.kind)
        ) {
          existing.kind = value.kind;
          existing.targetGated = value.targetGated;
        } else if (value.kind === existing.kind && !value.targetGated) {
          existing.targetGated = false;
        }
      }
    }
    if (anyMetadata && rollups.size) {
      applyCargoDependencyKindMetadata(pkgList, rollups, packageInfo, {
        resolveIsComplete: everyMetadata,
        filterPlatform: targetFilterApplied ? CARGO_TARGET : undefined,
        targetIncludedKeys: targetFilterApplied
          ? targetIncludedKeys
          : undefined,
      });
      // A `-sys` crate puts a C library into the artifact that the cargo
      // dependency graph itself cannot describe.
      const nativeLibraries = buildCargoNativeLibraryComponents(
        packageInfo,
        allEdges,
        rollups,
      );
      if (nativeLibraries.components.length) {
        pkgList.push(...nativeLibraries.components);
        if (dependencyTree) {
          dependencyTree.push(...nativeLibraries.dependencies);
        }
      }
      return;
    }
    recordDegradation("rust.cargo-metadata-unavailable", {
      ecosystem: "rust",
      tool: "cargo",
      impact: "components",
      command: `${basename(CARGO_CMD)} metadata`,
      detail:
        "cargo metadata could not be executed, so dependency kinds and platform gates were recovered from the manifests alone.",
    });
  }
  if (!dependencyTree?.length || !manifestRootKeys.size) {
    return;
  }
  const declaredEdgesByRoot = new Map();
  for (const [cargoTomlFile, rootKey] of manifestRootKeys) {
    if (!rootKey) {
      continue;
    }
    const declaredEdges = parseCargoManifestDependencyKinds(cargoTomlFile, {
      includeWorkspaceMembers: !options.multiProject,
    });
    const existing = declaredEdgesByRoot.get(rootKey);
    if (!existing) {
      declaredEdgesByRoot.set(rootKey, declaredEdges);
      continue;
    }
    for (const [name, value] of declaredEdges) {
      const knownEdge = existing.get(name);
      if (!knownEdge) {
        existing.set(name, value);
        continue;
      }
      for (const kind of value.kinds) {
        knownEdge.kinds.add(kind);
      }
      for (const target of value.targets) {
        knownEdge.targets.add(target);
      }
    }
  }
  const graph = buildCargoLockDependencyGraph(
    dependencyTree,
    declaredEdgesByRoot,
  );
  applyCargoDependencyKindMetadata(pkgList, rollupCargoDependencyKinds(graph));
}

export async function createRustBom(path, options) {
  let pkgList = [];
  let parentComponent = {};
  // Is this a binary file
  let maybeBinary;
  try {
    maybeBinary = statSync(path).isFile();
  } catch (_err) {
    maybeBinary = false;
  }
  if (maybeBinary || options?.lifecycle?.includes("post-build")) {
    return createBinaryBom(path, options);
  }

  // This function assumes that the given path is prioritized, i.e that the
  // Cargo.toml-file directly inside the directory `path` (or the one in the
  // shortest distance from the `path` directory) will be the first returned
  // object. If that assumption is broken, the parent component may be
  // inaccurate.
  const cargoFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Cargo.toml`,
    options,
  );
  // Attempt to build or generate lock files automatically
  for (const f of cargoFiles) {
    // If there are no cargo.lock files, we can attempt a cargo install when
    //    options.deep is true or options.lifecycle == build or post-build with installDeps
    // Why the need for installDeps? It currently defaults to true, so let's obey if someone wants no installs
    if (
      (options.deep && !hasAnyProjectType(["oci"], options, false)) ||
      (options.installDeps &&
        !safeExistsSync(f.replace(".toml", ".lock")) &&
        ["build", "post-build"].includes(options.lifecycle))
    ) {
      const basePath = dirname(f);
      const cargoArgs = options.deep
        ? ["check", "--all-features", "--manifest-path", f]
        : ["generate-lockfile", "--manifest-path", f];
      if (!DEBUG_MODE) {
        cargoArgs.push("--quiet");
      }
      if (DEBUG_MODE) {
        console.log(
          "Executing ",
          CARGO_CMD,
          cargoArgs.join(" "),
          "in",
          basePath,
        );
      }
      const cargoInstallResult = safeSpawnSync(CARGO_CMD, cargoArgs, {
        cwd: basePath,
        shell: isWin,
      });
      if (cargoInstallResult.status !== 0 || cargoInstallResult.error) {
        console.error("Error running the cargo command");
        console.log(cargoInstallResult.error, cargoInstallResult.stderr);
        // A spawn the runtime or a policy denied is neither a missing
        // toolchain nor an engaged fallback; the version probes record
        // that as degraded evidence.
        const toolchainMissing = cargoInstallResult.error
          ? classifyProbeResult(cargoInstallResult) === "missing"
          : !cargoAnswersVersion(basePath);
        if (!classifySpawnRestriction(CARGO_CMD) && toolchainMissing) {
          recordDegradation("rust.toolchain.missing", {
            ecosystem: "rust",
            tool: "cargo",
            impact: "transitive-deps",
            command: `${basename(CARGO_CMD)} ${cargoArgs.join(" ")}`,
            detail:
              "The cargo executable could not be run, so the lock file could not be generated.",
          });
        }
        deferFailOnError(options, {
          ecosystem: "rust",
          tool: "cargo",
          detail: "the cargo command failed",
        });
      }
    }
  }
  // After running cargo check, .d files would get created
  let pkgFilesMap = {};
  if (options.deep || ["build", "post-build"].includes(options.lifecycle)) {
    const makeDFiles = getAllFiles(path, "target/**/*.d", options);
    for (const dfile of makeDFiles) {
      pkgFilesMap = { ...pkgFilesMap, ...parseMakeDFile(dfile) };
    }
  }
  const cargoLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Cargo.lock`,
    options,
  );
  const cargoLockMode = cargoLockFiles.length;
  if (cargoFiles.length && !cargoLockMode) {
    recordDegradation("rust.cargo-lock-missing", {
      ecosystem: "rust",
      tool: "cargo",
      impact: "transitive-deps",
      detail:
        "No Cargo.lock was found beside the manifest, so components carry the declared dependencies without locked versions or the resolved crate graph.",
    });
  }
  const manifestRootKeys = new Map();
  for (const f of cargoFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${f}`);
    }
    const dlist = await parseCargoTomlData(f, cargoLockMode, pkgFilesMap, {
      includeWorkspaceMembers: !options.multiProject,
    });
    if (dlist?.length) {
      manifestRootKeys.set(f, cargoComponentKey(dlist[0]));
      if (!cargoLockMode) {
        pkgList = pkgList.concat(dlist);
      } else {
        if (!Object.keys(parentComponent).length) {
          parentComponent = dlist[0];
          parentComponent.type = "application";
          parentComponent.components = [];
          if (DEBUG_MODE) {
            console.log(
              `Assigning parent component "${parentComponent.name}" from ${f}`,
            );
          }
        } else {
          parentComponent.components.push(dlist[0]);
        }
      }
    }
  }
  let dependencyTree = [];
  if (cargoLockMode) {
    for (const f of cargoLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const dlist = await parseCargoData(f, false, pkgFilesMap);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }

      if (DEBUG_MODE) {
        console.log(`Constructing dependency tree from ${f}`);
      }
      const cargoLockData = readFileSync(f, { encoding: "utf-8" });
      const fileDependencylist = parseCargoDependencyData(cargoLockData);
      if (fileDependencylist?.length) {
        dependencyTree = mergeDependencies(
          dependencyTree,
          fileDependencylist,
          parentComponent,
        );
      }
    }
  }
  for (const f of cargoFiles) {
    const manifestDependencyList = parseCargoManifestDependencyData(f, {
      includeWorkspaceMembers: !options.multiProject,
    });
    if (manifestDependencyList?.length) {
      dependencyTree = mergeDependencies(
        dependencyTree,
        manifestDependencyList,
        parentComponent,
      );
    }
  }
  if (cargoLockMode) {
    annotateCargoDependencyKinds(
      pkgList,
      dependencyTree,
      cargoFiles,
      manifestRootKeys,
      options,
    );
  }
  return buildBomNSData(options, pkgList, "cargo", {
    src: path,
    filename: cargoLockFiles.join(", "),
    dependencies: dependencyTree,
    parentComponent,
  });
}

/**
 * Parses a `.crate` file name into a CycloneDX component (name, version, purl,
 * bom-ref, and source/cache properties). Returns undefined when the file name
 * does not match the `name-version` convention.
 *
 * @param {string} crateFile Absolute path to a `.crate` archive
 * @returns {object|undefined} Component object or undefined
 */
export function buildCargoCacheComponent(crateFile) {
  const crateFileName = basename(crateFile, ".crate");
  const nameVersionMatch = crateFileName.match(/^(.+)-([0-9][A-Za-z0-9.+-]*)$/);
  if (!nameVersionMatch) {
    return undefined;
  }
  const [, name, version] = nameVersionMatch;
  const purl = build({
    type: "cargo",
    namespace: "" || null,
    name: name,
    version: version || null,
  });
  return {
    "bom-ref": decodeURIComponent(purl),
    group: "",
    name,
    properties: [
      {
        name: "internal:SrcFile",
        value: crateFile,
      },
      {
        name: "cdx:cargo:cacheSource",
        value: "registry-cache",
      },
    ],
    purl,
    type: "library",
    version,
  };
}

/**
 * Enriches a cargo cache component with a SHA-256 hash and filename-based
 * identity evidence (confidence 0.5). Hash computation failures are ignored.
 *
 * @param {string} crateFile Absolute path to the `.crate` archive
 * @param {object} [component] Component produced by `buildCargoCacheComponent`
 * @returns {Promise<object|undefined>} The enriched component or undefined
 */
export async function enrichCargoCacheComponent(crateFile, component) {
  if (!component) {
    return undefined;
  }
  try {
    component.hashes = [
      {
        alg: "SHA-256",
        content: await checksumFile("sha256", crateFile),
      },
    ];
  } catch {
    // continue without hashes
  }
  component.evidence = {
    identity: {
      field: "purl",
      confidence: 0.5,
      methods: [
        {
          technique: "filename",
          confidence: 0.5,
          value: crateFile,
        },
      ],
    },
  };
  return component;
}

/**
 * Builds a BOM from `.crate` files found in the Cargo registry cache (or from a
 * single `.crate` path). Optionally fetches crates.io license metadata when
 * license fetching is enabled.
 *
 * @param {string} path Directory or `.crate` file path
 * @param {object} options CLI options
 * @returns {Promise<object>} Promise resolving to a BOM namespace data object
 */
export async function createCargoCacheBom(path, options) {
  const parentComponent = createDefaultParentComponent(path, "cargo", options);
  const crateFiles = path.endsWith(".crate")
    ? [resolve(path)]
    : getAllFiles(path, "**/*.crate", options);
  let pkgList = [];
  for (const crateFile of crateFiles) {
    const component = await enrichCargoCacheComponent(
      crateFile,
      buildCargoCacheComponent(crateFile),
    );
    if (component) {
      pkgList.push(component);
    }
  }
  if (pkgList.length && shouldFetchLicense()) {
    pkgList = await getCratesMetadata(pkgList);
  }
  return buildBomNSData(options, pkgList, "cargo", {
    src: path,
    parentComponent,
  });
}

/**
 * Function to create bom string for Dart projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createDartBom(path, options) {
  const pubFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pubspec.lock`,
    options,
  );
  const pubSpecYamlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pubspec.yaml`,
    options,
  );
  if (pubSpecYamlFiles.length && !pubFiles.length) {
    recordDegradation("dart.pub-get-needed", {
      ecosystem: "dart",
      tool: "dart",
      impact: "versions",
      detail:
        "pubspec.yaml was parsed without pubspec.lock, so components carry version constraints instead of the locked versions.",
    });
  }
  let dependencies = [];
  let pkgList = [];
  let parentComponent;
  if (pubSpecYamlFiles.length) {
    for (const f of pubSpecYamlFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const pubYamlData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parsePubYamlData(pubYamlData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
        if (!parentComponent) {
          parentComponent = pkgList[0];
          parentComponent.type = "application";
        }
      }
    }
  }
  if (pubFiles.length) {
    for (const f of pubFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const pubLockData = readFileSync(f, { encoding: "utf-8" });
      const retMap = await parsePubLockData(pubLockData, f);
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      if (retMap?.rootList?.length) {
        const thisParentDependsOn = [
          {
            ref: parentComponent["bom-ref"],
            dependsOn: [
              ...new Set(retMap.rootList.map((c) => c["bom-ref"])),
            ].sort(),
          },
        ];
        dependencies = mergeDependencies(
          dependencies,
          thisParentDependsOn,
          parentComponent,
        );
      }
    }
  }
  return buildBomNSData(options, pkgList, "pub", {
    src: path,
    dependencies,
    parentComponent,
    filename: pubFiles.join(", "),
  });
}

/**
 * Function to create bom string for cpp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createCppBom(path, options) {
  let parentComponent;
  let dependencies = [];
  const addedParentComponentsMap = {};
  const colliderLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}collider.lock`,
    options,
  );
  const conanLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}conan.lock`,
    options,
  );
  const conanFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}conanfile.txt`,
    options,
  );
  let cmakeLikeFiles = [];
  const mesonBuildFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}meson.build`,
    options,
  );
  if (mesonBuildFiles?.length) {
    cmakeLikeFiles = cmakeLikeFiles.concat(mesonBuildFiles);
  }
  cmakeLikeFiles = cmakeLikeFiles.concat(
    getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}CMakeLists.txt`,
      options,
    ),
  );
  const cmakeFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.cmake`,
    options,
  );
  if (cmakeFiles?.length) {
    cmakeLikeFiles = cmakeLikeFiles.concat(cmakeFiles);
  }
  let pkgList = [];
  let parentComponentDependencies = [];
  const subProjects = [];
  if (conanLockFiles.length) {
    for (const f of conanLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const conanLockData = readFileSync(f, { encoding: "utf-8" });
      const {
        pkgList: conanPkgList,
        dependencies: conanDependencies,
        parentComponentDependencies: parentCompDeps,
      } = parseConanLockData(conanLockData);

      if (conanPkgList.length) {
        pkgList = pkgList.concat(conanPkgList);
      }

      if (Object.keys(conanDependencies).length) {
        dependencies = mergeDependencies(
          dependencies,
          Object.keys(conanDependencies).map((dependentBomRef) => ({
            ref: dependentBomRef,
            dependsOn: conanDependencies[dependentBomRef],
          })),
        );
      }

      parentComponentDependencies = parentCompDeps;
    }
  } else if (conanFiles.length) {
    for (const f of conanFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const conanData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseConanData(conanData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  if (colliderLockFiles.length) {
    for (const f of colliderLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const colliderLockData = readFileSync(f, { encoding: "utf-8" });
      const {
        pkgList: colliderPkgList,
        dependencies: colliderDependencies,
        parentComponentDependencies: parentCompDeps,
      } = parseColliderLockData(colliderLockData, f);

      if (colliderPkgList.length) {
        pkgList = pkgList.concat(colliderPkgList);
      }

      if (Object.keys(colliderDependencies).length) {
        dependencies = mergeDependencies(
          dependencies,
          Object.keys(colliderDependencies).map((dependentBomRef) => ({
            ref: dependentBomRef,
            dependsOn: colliderDependencies[dependentBomRef],
          })),
        );
      }

      if (parentCompDeps.length) {
        parentComponentDependencies = [
          ...new Set(parentComponentDependencies.concat(parentCompDeps)),
        ];
      }
    }
  }
  if (cmakeLikeFiles.length) {
    const beforeCmake = pkgList.length;
    // The files at the scan root name the project, so they are read before
    // the files of any sub-project (the sort is stable otherwise). The scan
    // root may be given as a relative path while the files come back absolute.
    const scanRoot = resolve(path);
    const atScanRoot = (f) => resolve(dirname(f)) === scanRoot;
    cmakeLikeFiles.sort(
      (a, b) => (atScanRoot(a) ? 0 : 1) - (atScanRoot(b) ? 0 : 1),
    );
    for (const f of cmakeLikeFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const retMap = parseCmakeLikeFile(f, "generic");
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      if (
        atScanRoot(f) &&
        retMap.parentComponent &&
        Object.keys(retMap.parentComponent).length
      ) {
        if (!parentComponent) {
          parentComponent = retMap.parentComponent;
          // a sub-project reusing the root project's name is the root itself
          addedParentComponentsMap[retMap.parentComponent.name] = true;
        } else {
          parentComponent.components = parentComponent.components || [];
          if (!addedParentComponentsMap[retMap.parentComponent.name]) {
            parentComponent.components.push(retMap.parentComponent);
            addedParentComponentsMap[retMap.parentComponent.name] = true;
          }
        }
      } else if (
        retMap.parentComponent &&
        Object.keys(retMap.parentComponent).length &&
        !addedParentComponentsMap[retMap.parentComponent.name]
      ) {
        // a project() below the scan root is a part of this project, not a
        // dependency of it
        retMap.parentComponent.type = "library";
        const subprojectDir = relative(scanRoot, resolve(dirname(f)))
          .split(sep)
          .join("/");
        retMap.parentComponent.properties = [
          ...(retMap.parentComponent.properties || []),
          { name: "cdx:cmake:subprojectDir", value: subprojectDir || "." },
        ];
        subProjects.push(retMap.parentComponent);
        addedParentComponentsMap[retMap.parentComponent.name] = true;
      }
      // Retain the dependency tree from cmake
      if (retMap.dependenciesList) {
        if (dependencies.length) {
          dependencies = mergeDependencies(
            dependencies,
            retMap.dependenciesList,
            parentComponent,
          );
        } else {
          dependencies = retMap.dependenciesList;
        }
      }
    }
    // Only the entries this loop appended state version *requirements* that
    // several files may repeat. The conan and collider entries above name
    // resolved versions and are left as they are.
    pkgList = pkgList
      .slice(0, beforeCmake)
      .concat(
        collapseCmakeVersions(
          preferFetchedCmakeDependencies(pkgList.slice(beforeCmake)),
        ),
      );
  }
  // CMake describes how a project is built from source. An image or an OS
  // installation carries build output, not a build tree, so resolving CMake
  // context over every directory of an exploded rootfs finds nothing and costs
  // a filesystem walk and a git invocation per directory.
  const cmakeContext = hasAnyProjectType(
    ["docker", "oci", "container", "os"],
    options,
    false,
  )
    ? {
        rootProject: undefined,
        findPackages: new Map(),
        submodules: [],
        fetchDeps: [],
        boundaries: new Map(),
      }
    : resolveCmakeContext(path, options);
  // How the project is built: its presets and compilers (formulation), its
  // hardening options (project properties) and its own include directories.
  const isImageScan = hasAnyProjectType(
    ["docker", "oci", "container", "os"],
    options,
    false,
  );
  // Code carried in the tree under a license of its own, outside the sources
  // of the dependencies CMake already knows and the build trees
  const vendored = isImageScan
    ? { components: [], dirs: [] }
    : findVendoredCode(path, options, [
        ...[...(cmakeContext.boundaries || new Map())]
          .filter(([, e]) => e?.kind === "fetch" || e?.kind === "submodule")
          .map(([dir]) => resolve(path, dir)),
        ...cmakeBuildDirCandidates(path, options),
      ]);
  if (vendored.components.length) {
    pkgList = pkgList.concat(vendored.components);
  }
  const buildContext = isImageScan
    ? emptyCppBuildContext()
    : resolveCppBuildContext(path, options, cmakeContext, vendored.dirs);
  if (cmakeContext.rootProject?.version && parentComponent) {
    const resolvedVersion = cmakeContext.rootProject.version;
    const scrapedVersion = parentComponent.version;
    if (!scrapedVersion || scrapedVersion.includes("${")) {
      parentComponent.version = resolvedVersion;
      applyPurl(
        parentComponent,
        tryBuildPurl({
          type: "generic",
          namespace: parentComponent.group || null,
          name: parentComponent.name,
          version: resolvedVersion,
        }),
      );
    }
  }
  if (cmakeContext.findPackages.size) {
    for (const pkg of pkgList) {
      if (pkg.version) {
        continue;
      }
      const resolved =
        cmakeContext.findPackages.get(pkg.name) ||
        cmakeContext.findPackages.get(pkg.name.toUpperCase());
      if (resolved) {
        pkg.version = resolved;
        applyPurl(
          pkg,
          tryBuildPurl({
            type: "generic",
            name: pkg.name,
            version: resolved,
          }),
        );
        pkg.properties = pkg.properties || [];
        pkg.properties.push({
          name: "cdx:cmake:resolvedVia",
          value: "cmake-cache",
        });
      }
    }
  }
  for (const dep of cmakeContext.fetchDeps) {
    const depPurl = buildDependentPurl(dep.url, dep.version);
    const depRef = depPurl
      ? decodeURIComponent(depPurl)
      : `library:${dep.name}:${dep.version || ""}`;
    const depComponent = {
      name: dep.name,
      version: dep.version || "",
      type: "library",
      purl: depPurl,
      "bom-ref": depRef,
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.6,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.6,
              value: "FetchContent gitclone script",
            },
          ],
        },
      },
      properties: [
        { name: "cdx:cmake:depKind", value: "fetch" },
        { name: "cdx:cmake:resolvedVia", value: "gitclone-script" },
      ],
    };
    pkgList = withoutScrapedFetchDependency(pkgList, dep.name);
    if (dep.sourceDir) {
      depComponent.properties.push({
        name: "cdx:cmake:sourceDir",
        value: dep.sourceDir,
      });
    }
    pkgList.push(depComponent);
  }
  for (const sub of cmakeContext.submodules) {
    const subPurl = buildDependentPurl(sub.url, sub.version);
    const subRef = subPurl
      ? decodeURIComponent(subPurl)
      : `library:${sub.name}:${sub.version || ""}`;
    const props = [
      { name: "cdx:cmake:depKind", value: "submodule" },
      { name: "cdx:cmake:resolvedVia", value: "git-submodule" },
    ];
    if (sub.uninitialised) {
      props.push({ name: "cdx:cmake:uninitialised", value: "true" });
    }
    if (sub.path) {
      props.push({ name: "cdx:cmake:sourceDir", value: sub.path });
    }
    pkgList.push({
      name: sub.name,
      version: sub.version || "",
      type: "library",
      purl: subPurl,
      "bom-ref": subRef,
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.6,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.6,
              value: "git submodule status",
            },
          ],
        },
      },
      properties: props,
    });
  }
  // The need for java >= 21 with atom is causing confusions since there could be C projects
  // inside of other project types. So we currently limit this analyis only when -t argument
  // is used.
  if (
    !hasAnyProjectType(["docker", "oci", "container", "os"], options, false) &&
    (!options.createMultiXBom || options.deep)
  ) {
    let osPkgsList = [];
    // Case 1: Development libraries installed in this OS environment might be used for build
    // We collect OS packages with the word dev in the name using osquery here
    // rpm, deb and ebuild are supported
    // TODO: For archlinux and alpine users we need a different mechanism to collect this information
    // The packages only resolve the headers named by the usages slice, so
    // they are not queried when there is neither a slice to reuse nor a C or
    // C++ source for atom to read.
    if (
      (options.usagesSlicesFile && safeExistsSync(options.usagesSlicesFile)) ||
      hasCppSources(path, options)
    ) {
      for (const queryCategory of Object.keys(cosDbQueries)) {
        const queryObj = cosDbQueries[queryCategory];
        const results = executeOsQuery(queryObj.query);
        const dlist = convertOSQueryResults(
          queryCategory,
          queryObj,
          results,
          true,
          {
            deb: executeDpkgList,
            rpm: executeRpmList,
            apk: executeApkList,
            ebuild: executeEqueryList,
            alpm: executeAlpmList,
          },
        );
        if (dlist?.length) {
          osPkgsList = osPkgsList.concat(dlist);
        }
      }
    }
    // Now we check with atom and attempt to detect all external modules via usages
    // We pass the current list of packages so that we enhance the current list and replace
    // components inadvertently. For example, we might resolved a name, version and url information already via cmake
    const retMap = getCppModules(
      path,
      options,
      osPkgsList,
      pkgList,
      buildContext.isFirstPartyHeader,
    );
    if (retMap.pkgList?.length) {
      pkgList = pkgList.concat(retMap.pkgList);
    }
    if (retMap.dependenciesList) {
      if (dependencies.length) {
        dependencies = mergeDependencies(
          dependencies,
          retMap.dependenciesList,
          parentComponent,
        );
      } else {
        dependencies = retMap.dependenciesList;
      }
    }
    if (!parentComponent) {
      parentComponent = retMap.parentComponent;
    } else {
      parentComponent.components = parentComponent.components || [];
      if (
        retMap?.parentComponent?.name &&
        !addedParentComponentsMap[retMap.parentComponent.name]
      ) {
        parentComponent.components.push(retMap.parentComponent);
        addedParentComponentsMap[retMap.parentComponent.name] = true;
      }
    }
  }
  if (!options.createMultiXBom) {
    if (!parentComponent) {
      parentComponent = createDefaultParentComponent(path, "generic", options);
    }
    options.parentComponent = parentComponent;
  }

  if (parentComponent && parentComponentDependencies.length) {
    dependencies = mergeDependencies(dependencies, [
      {
        ref: parentComponent["bom-ref"],
        dependsOn: parentComponentDependencies,
      },
    ]);
  }

  if (subProjects.length) {
    if (parentComponent) {
      parentComponent.components = parentComponent.components || [];
      for (const sub of subProjects) {
        if (
          !parentComponent.components.some(
            (c) => c["bom-ref"] === sub["bom-ref"],
          ) &&
          sub["bom-ref"] !== parentComponent["bom-ref"]
        ) {
          parentComponent.components.push(sub);
        }
      }
    } else {
      // with no project at the scan root there is nothing to nest them under
      pkgList = pkgList.concat(subProjects);
    }
  }
  if (parentComponent && buildContext.parentProperties.length) {
    parentComponent.properties = (parentComponent.properties || []).filter(
      (p) =>
        !buildContext.parentProperties.some(
          (bp) => bp.name === p.name && bp.value === p.value,
        ),
    );
    parentComponent.properties.push(...buildContext.parentProperties);
  }
  if (parentComponent) {
    sanitizeUnresolvedPurl(parentComponent);
    if (parentComponent.components) {
      for (const sub of parentComponent.components) {
        sanitizeUnresolvedPurl(sub);
      }
    }
  }
  for (const pkg of pkgList) {
    sanitizeUnresolvedPurl(pkg);
  }

  return buildBomNSData(options, pkgList, "generic", {
    src: path,
    parentComponent,
    dependencies,
    formulationList: buildContext.formulationComponents,
  });
}

/**
 * Function to create bom string for clojure projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createClojureBom(path, options) {
  const ednFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}deps.edn`,
    options,
  );
  const leinFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}project.clj`,
    options,
  );
  let pkgList = [];
  if (leinFiles.length) {
    let LEIN_ARGS = ["deps", ":tree-data"];
    if (readEnvironmentVariable("LEIN_ARGS")) {
      LEIN_ARGS = readEnvironmentVariable("LEIN_ARGS").split(" ");
    }
    for (const f of leinFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      console.log("Executing", LEIN_CMD, "in", basePath);
      const result = safeSpawnSync(LEIN_CMD, LEIN_ARGS, {
        cwd: basePath,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr) {
          console.error(result.stdout, result.stderr);
          deferFailOnError(options, {
            ecosystem: "clojure",
            tool: "lein",
            detail: "the leiningen command failed",
          });
        }
        recordDegradation("clojure.lein.missing", {
          ecosystem: "clojure",
          tool: "lein",
          impact: "transitive-deps",
          command: `${LEIN_CMD} ${LEIN_ARGS.join(" ")}`,
          exitCode:
            typeof result.status === "number" ? result.status : undefined,
          detail:
            "lein did not produce a dependency list, so the project.clj manifest is parsed manually.",
        });
        console.log(
          "Check if the correct version of lein is installed and available in PATH. Falling back to manual parsing.",
        );
        if (DEBUG_MODE) {
          console.log(`Parsing ${f}`);
        }
        const leinData = readFileSync(f, { encoding: "utf-8" });
        const dlist = parseLeiningenData(leinData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      } else {
        const stdout = result.stdout;
        if (stdout) {
          const cmdOutput = Buffer.from(stdout).toString();
          const dlist = parseLeinDep(cmdOutput);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        } else {
          console.error("lein unexpectedly didn't return any output");
          deferFailOnError(options, {
            ecosystem: "clojure",
            tool: "lein",
            detail: "the leiningen command produced no output",
          });
        }
      }
    }
    return buildBomNSData(options, pkgList, "clojars", {
      src: path,
      filename: leinFiles.join(", "),
    });
  }
  if (ednFiles.length && !hasAnyProjectType(["oci"], options, false)) {
    let CLJ_ARGS = ["-Stree"];
    if (readEnvironmentVariable("CLJ_ARGS")) {
      CLJ_ARGS = readEnvironmentVariable("CLJ_ARGS").split(" ");
    }
    for (const f of ednFiles) {
      const basePath = dirname(f);
      console.log("Executing", CLJ_CMD, "in", basePath);
      const result = safeSpawnSync(CLJ_CMD, CLJ_ARGS, {
        cwd: basePath,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr) {
          console.error(result.stdout, result.stderr);
          deferFailOnError(options, {
            ecosystem: "clojure",
            tool: "clj",
            detail: "the clojure cli command failed",
          });
        }
        recordDegradation("clojure.cli.missing", {
          ecosystem: "clojure",
          tool: "clojure",
          impact: "transitive-deps",
          command: `${CLJ_CMD} ${CLJ_ARGS.join(" ")}`,
          exitCode:
            typeof result.status === "number" ? result.status : undefined,
          detail:
            "The clojure CLI did not produce a dependency tree, so the deps.edn manifest is parsed manually.",
        });
        console.log(
          "Check if the correct version of clojure cli is installed and available in PATH. Falling back to manual parsing.",
        );
        if (DEBUG_MODE) {
          console.log(`Parsing ${f}`);
        }
        const ednData = readFileSync(f, { encoding: "utf-8" });
        const dlist = parseEdnData(ednData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      } else {
        const stdout = result.stdout;
        if (stdout) {
          const cmdOutput = Buffer.from(stdout).toString();
          const dlist = parseCljDep(cmdOutput);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        } else {
          console.error("clj unexpectedly didn't return any output");
          deferFailOnError(options, {
            ecosystem: "clojure",
            tool: "clj",
            detail: "the clojure cli command produced no output",
          });
        }
      }
    }
    return buildBomNSData(options, pkgList, "clojars", {
      src: path,
      filename: ednFiles.join(", "),
    });
  }

  return {};
}

/**
 * Locate the Stack lock files under a path.
 *
 * Stack names the lock after the configuration file it completes, so the
 * default `stack.yaml` produces `stack.yaml.lock` and a project with several
 * configurations produces one lock per configuration. `stack.lock` is also
 * accepted because tooling and documentation examples have used that name.
 *
 * @param {string} path Project path
 * @param {Object} options Parse options from the cli
 * @returns {string[]} Lock file paths, deduplicated
 */
export function findStackLockFiles(path, options) {
  const prefix = options.multiProject ? "**/" : "";
  const candidates = new Set([
    ...getAllFiles(path, `${prefix}*.yaml.lock`, options),
    ...getAllFiles(path, `${prefix}stack.lock`, options),
  ]);
  return [...candidates].filter((lockFile) => {
    if (/(^|[\\/])stack\.(yaml\.)?lock$/u.test(lockFile)) {
      return true;
    }
    // `*.yaml.lock` is not a name Stack owns, so a custom configuration is
    // accepted only when the file it completes names a snapshot.
    const configFile = lockFile.replace(/\.lock$/u, "");
    if (!safeExistsSync(configFile)) {
      return false;
    }
    try {
      return /^\s*(snapshot|resolver)\s*:/mu.test(
        readFileSync(configFile, "utf-8"),
      );
    } catch {
      return false;
    }
  });
}

/**
 * Function to create bom string for Haskell projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createHaskellBom(path, options) {
  const cabalFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}cabal.project.freeze`,
    options,
  );
  let pkgList = [];
  if (cabalFiles.length) {
    for (const f of cabalFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const cabalData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseCabalData(cabalData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "hackage", {
      src: path,
      filename: cabalFiles.join(", "),
    });
  }
  // Stack projects keep the resolved extra-deps in a lock file named after
  // the configuration file, so `stack.yaml` locks to `stack.yaml.lock`.
  const stackLockFiles = findStackLockFiles(path, options);
  if (stackLockFiles.length) {
    const dependencies = [];
    let parentComponent = {};
    for (const stackLockFile of stackLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${stackLockFile}`);
      }
      const stackYamlFile = stackLockFile.replace(/\.lock$/u, "");
      const result = parseStackProject(
        stackLockFile,
        safeExistsSync(stackYamlFile) ? stackYamlFile : undefined,
      );
      if (result.pkgList?.length) {
        pkgList = pkgList.concat(result.pkgList);
      }
      if (!Object.keys(parentComponent).length) {
        parentComponent = result.parentComponent;
        attachRootEdge(result, parentComponent, dependencies);
      }
    }
    if (pkgList.length) {
      return buildBomNSData(options, pkgList, "hackage", {
        src: path,
        filename: stackLockFiles.join(", "),
        dependencies,
        parentComponent,
      });
    }
  }
  recordDegradation("haskell.freeze-missing", {
    ecosystem: "haskell",
    tool: "cabal",
    impact: "components",
    detail:
      "No cabal.project.freeze or stack.yaml.lock was found; those lock files are the sources the parsers read for the package set.",
  });
  return {};
}

/**
 * Function to create bom string for Elixir projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createElixirBom(path, options) {
  const mixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}mix.lock`,
    options,
  );
  let pkgList = [];
  if (mixFiles.length) {
    for (const f of mixFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const mixData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseMixLockData(mixData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "hex", {
      src: path,
      filename: mixFiles.join(", "),
    });
  }
  recordDegradation("elixir.deps-not-fetched", {
    ecosystem: "elixir",
    tool: "mix",
    impact: "components",
    detail:
      "No mix.lock was found, and the lock file written by fetching the dependencies is the source the parser reads.",
  });
  return {};
}

/**
 * Function to create bom string for swift projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createSwiftBom(path, options) {
  const swiftFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Package*.swift`,
    options,
  );
  const pkgResolvedFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Package.resolved`,
    options,
  );
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};
  const completedPath = [];
  let packageArgsMessageShown = false;
  // Packages that only the root package's tests use are scoped optional so
  // that `--required-only` can narrow the BOM. A package some project (or
  // some production path) needs stays required.
  const swiftScopes = {
    optionalRefs: new Set(),
    requiredRefs: new Set(),
    optionalNames: new Set(),
    requiredNames: new Set(),
  };
  const classifiedPaths = new Set();
  const classifyScopes = (basePath, swiftCommand, treeData) => {
    if (classifiedPaths.has(basePath)) {
      return;
    }
    classifiedPaths.add(basePath);
    const dumpArgs =
      swiftCommand === "xcrun"
        ? ["swift", "package", "dump-package"]
        : ["package", "dump-package"];
    const dumpResult = safeSpawnSync(swiftCommand, dumpArgs, {
      cwd: basePath,
    });
    if (!dumpResult?.stdout) {
      return;
    }
    let dumpJson;
    let treeJson;
    try {
      dumpJson = JSON.parse(Buffer.from(dumpResult.stdout).toString());
    } catch (_e) {
      return;
    }
    try {
      treeJson = treeData ? JSON.parse(treeData) : undefined;
    } catch (_e) {
      treeJson = undefined;
    }
    const scopes = classifySwiftDependencyScopes(dumpJson, treeJson);
    for (const key of Object.keys(swiftScopes)) {
      for (const value of scopes[key]) {
        swiftScopes[key].add(value);
      }
    }
  };
  if (pkgResolvedFiles.length) {
    for (const f of pkgResolvedFiles) {
      if (!parentComponent || !Object.keys(parentComponent).length) {
        parentComponent = createDefaultParentComponent(f, "swift", options);
      }
      if (DEBUG_MODE) {
        console.log("Parsing", f);
      }
      const dlist = parseSwiftResolved(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    thoughtLog(
      `It looks like we have ${pkgResolvedFiles.length} Package.resolved files, which is good. To compute the dependency tree, let's try using the swift package command 📦.`,
    );
  }
  if (swiftFiles.length) {
    for (const f of swiftFiles) {
      const basePath = dirname(f);
      if (completedPath.includes(basePath)) {
        continue;
      }
      let treeData;
      let packageArgs = ["package"];
      // Additional arguments to pass to the swift package command.
      // Example: --swift-sdks-path <swift-sdks-path> --jobs <jobs>
      if (readEnvironmentVariable("SWIFT_PACKAGE_ARGS")) {
        packageArgs = packageArgs.concat(
          readEnvironmentVariable("SWIFT_PACKAGE_ARGS").split(" "),
        );
        if (!packageArgsMessageShown) {
          thoughtLog(
            `Wait, let's use the additional arguments '${readEnvironmentVariable("SWIFT_PACKAGE_ARGS")}' for the swift package command.`,
          );
          packageArgsMessageShown = true;
        }
      }
      packageArgs = packageArgs.concat([
        "show-dependencies",
        "--format",
        "json",
      ]);
      let swiftCommand = SWIFT_CMD;
      if (swiftCommand.startsWith("xcrun")) {
        swiftCommand = "xcrun";
        packageArgs = ["swift"].concat(packageArgs);
      }
      if (DEBUG_MODE) {
        console.log(
          `Executing '${swiftCommand} ${packageArgs.join(" ")}' in ${basePath}. Please wait ...`,
        );
      }
      const result = safeSpawnSync(swiftCommand, packageArgs, {
        cwd: basePath,
      });
      if (result.stdout) {
        completedPath.push(basePath);
        treeData = Buffer.from(result.stdout).toString();
        const retData = parseSwiftJsonTree(treeData, f);
        if (retData.rootList?.length) {
          if (!Object.keys(parentComponent).length) {
            parentComponent = retData.rootList[0];
            if (retData.rootList.length > 1) {
              if (!parentComponent.components) {
                parentComponent.components = [];
              }
              for (const p of retData.rootList.splice(0, 1)) {
                parentComponent.components.push(p);
              }
            }
          } else {
            if (!parentComponent.components) {
              parentComponent.components = [];
            }
            parentComponent.components.concat(retData.rootList);
          }
        }
        pkgList = pkgList.concat(retData.pkgList);
        if (retData.dependenciesList) {
          dependencies = mergeDependencies(
            dependencies,
            retData.dependenciesList,
            parentComponent,
          );
        }
      }
      if (result.status !== 0 || result.error) {
        if (result?.stderr?.includes("Source files for target")) {
          console.log(
            "The Sources directory is missing. Please run cdxgen from the directory that contains the complete source code.",
          );
          thoughtLog(
            `It looks like the 'Sources' directory is missing, so we are missing the components and dependencies for '${basename(basePath)}'.`,
          );
        } else if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
          recordDegradation("swift.toolchain.missing", {
            ecosystem: "swift",
            tool: "swift",
            impact: "transitive-deps",
            command: `${swiftCommand} ${packageArgs.join(" ")}`,
            exitCode:
              typeof result.status === "number" ? result.status : undefined,
            detail:
              "The swift package command did not succeed, so the swift package graph was not resolved.",
          });
          console.log(
            "Consider using the cdxgen container image (`ghcr.io/cdxgen/cdxgen`), which includes Swift and additional build tools.",
          );
          if (!isMac) {
            console.log("Alternatively, try building this project from a Mac.");
            thoughtLog(
              "I'm wondering if the results might be better on a Mac 🤔.",
            );
          }
        }
        console.error(result.stderr);
        deferFailOnError(options, {
          ecosystem: "swift",
          tool: "swift",
          detail: "the swift package command failed",
        });
      }
      // Scope classification also works without the dependency graph
      classifyScopes(basePath, swiftCommand, treeData);
    }
  }
  // Scope packages that only tests use as optional. A package some project or
  // production path needs keeps its default (required) scope; evidence-based
  // filtering after generation can still promote an optional package when
  // the sources are found to use it.
  for (const apkg of pkgList) {
    if (apkg?.scope || !apkg?.name) {
      continue;
    }
    const refs = [apkg["bom-ref"], apkg.purl].filter(Boolean);
    const names = [String(apkg.name).toLowerCase()];
    for (const aproperty of apkg.properties || []) {
      if (aproperty?.name === "cdx:swift:packageName" && aproperty.value) {
        names.push(String(aproperty.value).toLowerCase());
      }
    }
    const isOptional =
      refs.some((r) => swiftScopes.optionalRefs.has(r)) ||
      names.some((n) => swiftScopes.optionalNames.has(n));
    const isRequired =
      refs.some((r) => swiftScopes.requiredRefs.has(r)) ||
      names.some((n) => swiftScopes.requiredNames.has(n));
    if (isOptional && !isRequired) {
      apkg.scope = "optional";
    }
  }
  if (shouldFetchLicense()) {
    pkgList = await getSwiftPackageMetadata(pkgList);
  }
  return buildBomNSData(options, pkgList, "swift", {
    src: path,
    filename: swiftFiles.join(", "),
    parentComponent,
    dependencies,
  });
}

/**
 * Function to create bom string for cocoa projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object | undefined>} Promise resolving to a BOM object, or `undefined` when no Podfiles are found
 */
export async function createCocoaBom(path, options) {
  const cocoaFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Podfile`,
    options,
  );
  if (cocoaFiles.length > 1) {
    thoughtLog(
      `There are ${cocoaFiles.length} pod files. I will carefully process each one.`,
    );
  }
  let excludeMessageShown = false;
  for (const podFile of cocoaFiles) {
    const projectPath = dirname(podFile);
    const lockFile = `${podFile}.lock`;
    let missingLockWarningShown = false;
    if (!safeExistsSync(lockFile)) {
      if (options.installDeps) {
        executePodCommand(["install"], projectPath, options);
      } else {
        console.log(
          "No 'Podfile.lock' found and '--no-install-deps' is set -- A Podfile.lock is needed to parse dependencies!",
        );
        missingLockWarningShown = true;
        deferFailOnError(options, {
          ecosystem: "cocoa",
          tool: "pod",
          detail: "no Podfile.lock was found",
        });
      }
    } else if (options.deep && options.installDeps) {
      executePodCommand(["install"], projectPath, options);
    }
    if (!safeExistsSync(lockFile)) {
      if (!missingLockWarningShown) {
        console.log(
          `No 'Podfile.lock' found for ${projectPath}. Skipping CocoaPods dependency parsing for this project.`,
        );
      }
      continue;
    }
    const parentComponent = await buildObjectForCocoaPod(
      {
        name: basename(projectPath),
        version: "latest",
      },
      undefined,
      "application",
    );
    const podfileLock = loadYaml(readFileSync(lockFile, "utf-8"));
    const pods = await parsePodfileLock(podfileLock, projectPath);
    const allObjects = new Map();
    if (options) {
      // Every remote podspec the scan below reads is known from the lockfile,
      // so they are fetched in batched rounds rather than one at a time inside
      // the loop.
      await prefetchCocoaPodspecs(
        [...pods.values()].map((pod) => pod.metadata),
      );
    }
    for (const [name, pod] of pods) {
      allObjects.set(name, await buildObjectForCocoaPod(pod.metadata, options));
    }
    const allDependencies = new Map();
    for (const [name, pod] of pods) {
      const podDependencies = new Set();
      if (pod.dependencies) {
        for (const podDependency of pod.dependencies) {
          podDependencies.add(podDependency.name);
        }
      }
      allDependencies.set(name, podDependencies);
    }
    const targetDependencies = new Map();
    if (
      !readEnvironmentVariable("COCOA_INCLUDED_TARGETS") &&
      !readEnvironmentVariable("COCOA_EXCLUDED_TARGETS")
    ) {
      targetDependencies.set("Pods", podfileLock["DEPENDENCIES"]);
    } else {
      const result = executePodCommand(
        ["ipc", "podfile-json", "--silent", podFile],
        projectPath,
        options,
      );
      const resolvedPodFile = JSON.parse(result.stdout);
      parsePodfileTargets(
        resolvedPodFile["target_definitions"][0],
        targetDependencies,
      );
    }
    const usedTargets = new Set(
      readEnvironmentVariable("COCOA_INCLUDED_TARGETS")
        ? readEnvironmentVariable("COCOA_INCLUDED_TARGETS").split(",")
        : targetDependencies.keys(),
    );
    if (readEnvironmentVariable("COCOA_EXCLUDED_TARGETS")) {
      readEnvironmentVariable("COCOA_EXCLUDED_TARGETS")
        .split(",")
        .forEach((excludedTarget) => {
          usedTargets.delete(excludedTarget);
        });
      if (!excludeMessageShown) {
        thoughtLog(
          "Wait, the user wants me to exclude certain targets from this CocoaPods project. Perhaps they don't want dev and test projects included in the SBOM 🤔?",
        );
        excludeMessageShown = true;
      }
    }
    let addedObjects = new Set();
    for (const target of usedTargets) {
      if (targetDependencies.has(target)) {
        for (const dependency of targetDependencies.get(target)) {
          let dependencyName = parseCocoaDependency(dependency, false).name;
          if (
            !["false", "0"].includes(
              readEnvironmentVariable("COCOA_MERGE_SUBSPECS"),
            )
          ) {
            dependencyName = dependencyName.split("/")[0];
          }
          addedObjects.add(dependencyName);
        }
      }
    }
    // A Podfile target can name a pod that the lockfile does not resolve (a
    // subspec collapsed by COCOA_MERGE_SUBSPECS, or a pod declared but never
    // locked). Those names have no entry in allObjects/allDependencies, so every
    // lookup here is filtered rather than dereferenced — the unguarded version
    // threw "allDependencies.get(...) is not iterable" and aborted the scan.
    const bomRefFor = (name) => allObjects.get(name)?.["bom-ref"];
    const dependenciesOf = (name) => allDependencies.get(name) ?? [];
    let includedDependencies = [
      {
        ref: parentComponent["bom-ref"],
        dependsOn: [
          ...new Set([...addedObjects].map(bomRefFor).filter(Boolean)),
        ],
      },
    ];
    const includedObjects = new Set(addedObjects);
    while (addedObjects.size !== 0) {
      const newlyAddedObjects = new Set();
      for (const addedObject of addedObjects) {
        for (const dependency of dependenciesOf(addedObject)) {
          if (!includedObjects.has(dependency)) {
            includedObjects.add(dependency);
            newlyAddedObjects.add(dependency);
          }
        }
      }
      addedObjects = newlyAddedObjects;
    }
    for (const object of includedObjects) {
      const ref = bomRefFor(object);
      if (!ref) {
        continue;
      }
      includedDependencies = mergeDependencies(includedDependencies, [
        {
          ref,
          dependsOn: [
            ...new Set(
              [...dependenciesOf(object)].map(bomRefFor).filter(Boolean),
            ),
          ],
        },
      ]);
    }
    return buildBomNSData(
      options,
      [...includedObjects].map((obj) => allObjects.get(obj)).filter(Boolean),
      "cocoapods",
      {
        src: path,
        filename: lockFile,
        dependencies: includedDependencies,
        parentComponent,
      },
    );
  }
}

/**
 * Function to create bom string for Nix flakes
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createNixBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  const flakeNixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}flake.nix`,
    options,
  );
  const flakeLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}flake.lock`,
    options,
  );

  for (const flakeNixFile of flakeNixFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${flakeNixFile}`);
    }
    const { pkgList: nixPkgs, dependencies: nixDeps } =
      parseFlakeNix(flakeNixFile);
    if (nixPkgs?.length) {
      pkgList = pkgList.concat(nixPkgs);
    }
    if (nixDeps?.length) {
      dependencies = dependencies.concat(nixDeps);
    }
  }

  for (const flakeLockFile of flakeLockFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${flakeLockFile}`);
    }
    const {
      pkgList: lockPkgs,
      dependencies: lockDeps,
      rootInputs,
    } = parseFlakeLock(flakeLockFile);
    if (lockPkgs?.length) {
      const mergedPkgs = [];
      const existingNames = new Set();

      for (const lockPkg of lockPkgs) {
        mergedPkgs.push(lockPkg);
        existingNames.add(lockPkg.name);
      }

      for (const nixPkg of pkgList) {
        if (!existingNames.has(nixPkg.name)) {
          mergedPkgs.push(nixPkg);
        }
      }

      pkgList = mergedPkgs;
    }
    if (lockDeps?.length) {
      dependencies = dependencies.concat(lockDeps);
    }

    // Create parent component from flake.lock if found
    if (!Object.keys(parentComponent).length) {
      const flakeDir = dirname(flakeLockFile);
      const projectName = basename(flakeDir);
      parentComponent = {
        type: "application",
        name: projectName,
        version: "latest",
        description: `Nix flake project: ${projectName}`,
        "bom-ref": nixBomRef(projectName),
        properties: [
          {
            name: "internal:SrcFile",
            value: flakeLockFile,
          },
          {
            name: "cdx:nix:flake_dir",
            value: flakeDir,
          },
        ],
      };
    }

    // Build the root dependency edge here, where the parent component's real
    // bom-ref is known. parseFlakeLock returns the root's direct inputs as
    // bom-refs rather than synthesising an edge with a guessed (and dangling)
    // root ref.
    if (rootInputs?.length && parentComponent?.["bom-ref"]) {
      dependencies.push({
        ref: parentComponent["bom-ref"],
        dependsOn: [...new Set(rootInputs)],
      });
    }
  }

  // If no parent component was created from flake.lock, create one from flake.nix
  if (!Object.keys(parentComponent).length && flakeNixFiles.length > 0) {
    const flakeDir = dirname(flakeNixFiles[0]);
    const projectName = basename(flakeDir);
    parentComponent = {
      type: "application",
      name: projectName,
      version: "latest",
      description: `Nix flake project: ${projectName}`,
      "bom-ref": nixBomRef(projectName),
      properties: [
        {
          name: "internal:SrcFile",
          value: flakeNixFiles[0],
        },
        {
          name: "cdx:nix:flake_dir",
          value: flakeDir,
        },
      ],
    };
  }

  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "nix", {
      src: path,
      filename: [...flakeNixFiles, ...flakeLockFiles].join(", "),
      dependencies,
      parentComponent,
    });
  }

  return {};
}

/**
 * Function to create bom string for Zig projects.
 *
 * Zig moved package management into the build system, so the dependency list
 * lives in `build.zig.zon` (ZON, not JSON). The resolver walks the full
 * dependency graph by locating each dependency's manifest through the in-tree
 * `zig-pkg/` directory or the global cache, producing both a flat component
 * list and a CycloneDX `dependencies[]` edge list.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createZigBom(path, options) {
  const pkgList = [];
  const seenRefs = new Set();
  let parentComponent = {};
  let dependencies = [];

  const zonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}build.zig.zon`,
    options,
  ).filter((f) => !/[\\/]zig-pkg[\\/]/.test(f));

  // Vendored manifests under zig-pkg/ describe dependencies, not projects. The
  // resolver reaches them through their hash, so treating one as a root would
  // duplicate the component and invent a second parent component.
  for (const zonFile of zonFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${zonFile}`);
    }
    const {
      pkgList: resolvedPkgs,
      dependencies: resolvedDeps,
      parentComponent: zonParent,
      unresolvedCount,
    } = await resolveZigGraph(zonFile, path, options);
    // Each root manifest is resolved independently, so a dependency shared by
    // two workspace members arrives twice. Both the component and its edges
    // are keyed on bom-ref, so merging on that key is what keeps a
    // multi-project scan from emitting duplicates.
    for (const pkg of resolvedPkgs || []) {
      if (!seenRefs.has(pkg["bom-ref"])) {
        seenRefs.add(pkg["bom-ref"]);
        pkgList.push(pkg);
      }
    }
    if (resolvedDeps?.length) {
      dependencies = mergeDependencies(dependencies, resolvedDeps);
    }
    if (!Object.keys(parentComponent).length && Object.keys(zonParent).length) {
      parentComponent = zonParent;
    }
    if (unresolvedCount && DEBUG_MODE) {
      console.log(
        `${unresolvedCount} Zig package hash(es) could not be resolved — dependency graph may be partial.`,
      );
    }
  }

  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "zig", {
      src: path,
      filename: zonFiles.join(", "),
      parentComponent,
      dependencies,
    });
  }

  return {};
}

/**
 * Function to create bom string for Gleam projects.
 *
 * Gleam resolves through Hex, so packages carry `pkg:hex/...` purls and no new
 * purl type is introduced. The `manifest.toml` lock is the source of truth for
 * resolved versions and the direct/transitive distinction; `gleam.toml` is the
 * manifest.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createGleamBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  const gleamTomlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}gleam.toml`,
    options,
  );

  for (const gleamTomlFile of gleamTomlFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${gleamTomlFile}`);
    }
    const baseDir = dirname(gleamTomlFile);
    const manifestTomlFile = join(baseDir, "manifest.toml");
    const lockPath = safeExistsSync(manifestTomlFile)
      ? manifestTomlFile
      : undefined;
    const result = parseGleamProject(gleamTomlFile, lockPath);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (
      !Object.keys(parentComponent).length &&
      Object.keys(result.parentComponent).length
    ) {
      parentComponent = result.parentComponent;
      // Attach the root dependency edge to the real parent bom-ref.
      if (result.rootInputs?.length && parentComponent.name) {
        const rootRef = `application:${parentComponent.name}:${parentComponent.version || "latest"}`;
        parentComponent["bom-ref"] = rootRef;
        dependencies.push({
          ref: rootRef,
          dependsOn: [...new Set(result.rootInputs)],
        });
      }
    }
  }

  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "gleam", {
      src: path,
      filename: gleamTomlFiles.join(", "),
      dependencies,
      parentComponent,
    });
  }

  return {};
}

/**
 * Function to create bom string for Julia projects.
 *
 * The resolved `Manifest.toml` is preferred over the declared `Project.toml`
 * so the BOM carries pinned versions and the package graph.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createJuliaBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  const projectTomlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Project.toml`,
    options,
  );
  const manifestOnly = !projectTomlFiles.length;

  for (const projectTomlFile of projectTomlFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${projectTomlFile}`);
    }
    const baseDir = dirname(projectTomlFile);
    const manifestTomlFile = join(baseDir, "Manifest.toml");
    const result = parseJuliaProject(
      projectTomlFile,
      safeExistsSync(manifestTomlFile) ? manifestTomlFile : undefined,
    );
    collectProjectResult(result);
  }
  if (manifestOnly) {
    for (const manifestTomlFile of getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}Manifest.toml`,
      options,
    )) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${manifestTomlFile}`);
      }
      // Gleam also writes a `manifest.toml`; on case-insensitive filesystems
      // the lookup above can surface it, so only accept files that parse as
      // a Julia manifest.
      const parsed = parseJuliaProject(undefined, manifestTomlFile);
      if (parsed.pkgList.length) {
        collectProjectResult(parsed);
      }
    }
  }

  function collectProjectResult(result) {
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (
      !Object.keys(parentComponent).length &&
      Object.keys(result.parentComponent).length
    ) {
      parentComponent = result.parentComponent;
      attachRootEdge(result, parentComponent, dependencies);
    }
  }

  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "julia", {
      src: path,
      filename: projectTomlFiles.join(", "),
      dependencies,
      parentComponent,
    });
  }
  return {};
}

/**
 * Attach a root dependency edge from the parent component to its direct
 * dependencies, following the shape used by the Gleam and Nix flows.
 *
 * @param {{rootInputs?: string[]}} result Parser result with root inputs
 * @param {Object} parentComponent Parent component to give a bom-ref
 * @param {Object[]} dependencies Dependency edge list to append to
 */
function attachRootEdge(result, parentComponent, dependencies) {
  if (result.rootInputs?.length && parentComponent.name) {
    const rootRef = `application:${parentComponent.name}:${parentComponent.version || "latest"}`;
    parentComponent["bom-ref"] = rootRef;
    dependencies.push({
      ref: rootRef,
      dependsOn: [...new Set(result.rootInputs)],
    });
  }
}

/**
 * Function to create bom string for Erlang projects using rebar3.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createErlangBom(path, options) {
  let pkgList = [];
  const rebarLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}rebar.lock`,
    options,
  );
  for (const rebarLockFile of rebarLockFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${rebarLockFile}`);
    }
    const result = parseRebarLock(rebarLockFile);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
  }
  if (pkgList.length) {
    return buildBomNSData(options, pkgList, "erlang", {
      src: path,
      filename: rebarLockFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for OCaml projects using opam.
 *
 * Resolved `.opam.locked` files are preferred; a plain `.opam` file is used
 * as a declared fallback with unpinned versions.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createOCamlBom(path, options) {
  let pkgList = [];
  const opamLockedFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.opam.locked`,
    options,
  );
  const opamFiles = opamLockedFiles.length
    ? []
    : getAllFiles(path, `${options.multiProject ? "**/" : ""}*.opam`, options);
  for (const opamFile of [...opamLockedFiles, ...opamFiles]) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${opamFile}`);
    }
    const result = parseOpamLockedFile(opamFile);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
  }
  if (pkgList.length) {
    return buildBomNSData(options, pkgList, "ocaml", {
      src: path,
      filename: [...opamLockedFiles, ...opamFiles].join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for Elm projects.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createElmBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  const elmJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}elm.json`,
    options,
  ).filter(isElmProjectFile);
  // A single reader memoises the cache lookups shared by every manifest.
  const cacheReader = createElmCacheReader();
  for (const elmJsonFile of elmJsonFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${elmJsonFile}`);
    }
    const result = parseElmProject(elmJsonFile, cacheReader);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (!Object.keys(parentComponent).length) {
      parentComponent = result.parentComponent;
      attachRootEdge(result, parentComponent, dependencies);
    }
  }
  const legacyFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}elm-package.json`,
    options,
  );
  for (const legacyFile of legacyFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${legacyFile}`);
    }
    const baseDir = dirname(legacyFile);
    const exactDepsFile = join(baseDir, "elm-stuff", "exact-dependencies.json");
    const result = parseLegacyElmProject(
      legacyFile,
      safeExistsSync(exactDepsFile) ? exactDepsFile : undefined,
    );
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (!Object.keys(parentComponent).length) {
      parentComponent = result.parentComponent;
      attachRootEdge(result, parentComponent, dependencies);
    }
  }
  if (pkgList.length && shouldFetchPackageMetadata()) {
    pkgList = await getElmMetadata(pkgList, dependencies);
  }
  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "elm", {
      src: path,
      filename: [...elmJsonFiles, ...legacyFiles].join(", "),
      dependencies,
      parentComponent,
    });
  }
  return {};
}

/**
 * Function to create bom string for Crystal projects using shards.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createCrystalBom(path, options) {
  let pkgList = [];
  const dependencies = [];
  let parentComponent = {};

  const shardYmlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}shard.yml`,
    options,
  );
  for (const shardYmlFile of shardYmlFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${shardYmlFile}`);
    }
    const baseDir = dirname(shardYmlFile);
    const shardLockFile = join(baseDir, "shard.lock");
    const result = parseShardsProject(
      shardYmlFile,
      safeExistsSync(shardLockFile) ? shardLockFile : undefined,
    );
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (!Object.keys(parentComponent).length) {
      parentComponent = result.parentComponent;
      attachRootEdge(result, parentComponent, dependencies);
    }
  }
  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "crystal", {
      src: path,
      filename: shardYmlFiles.join(", "),
      dependencies,
      parentComponent,
    });
  }
  return {};
}

/**
 * Function to create bom string for Nim projects using nimble.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createNimBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  const nimbleFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.nimble`,
    options,
  );
  for (const nimbleFile of nimbleFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${nimbleFile}`);
    }
    const baseDir = dirname(nimbleFile);
    const nimbleLockFile = join(baseDir, "nimble.lock");
    const result = parseNimProject(
      nimbleFile,
      safeExistsSync(nimbleLockFile) ? nimbleLockFile : undefined,
    );
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (!Object.keys(parentComponent).length) {
      parentComponent = result.parentComponent;
      attachRootEdge(result, parentComponent, dependencies);
    }
  }
  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "nim", {
      src: path,
      filename: nimbleFiles.join(", "),
      dependencies,
      parentComponent,
    });
  }
  return {};
}

/**
 * Function to create bom string for Lua projects using LuaRocks.
 *
 * When a `luarocks.lock` is present next to a rockspec it supplies the
 * resolved versions; otherwise the rockspec's declared dependencies are
 * inventoried without versions.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createLuaBom(path, options) {
  let pkgList = [];
  let parentComponent = {};
  const seenLockFiles = new Set();
  const rockspecFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.rockspec`,
    options,
  );
  for (const rockspecFile of rockspecFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${rockspecFile}`);
    }
    const baseDir = dirname(rockspecFile);
    const lockFile = join(baseDir, "luarocks.lock");
    // The rockspec names the project and its declared set either way; the
    // lock, when present, supplies the resolved versions.
    const declared = parseRockspecFile(rockspecFile);
    if (!Object.keys(parentComponent).length) {
      parentComponent = declared.parentComponent;
    }
    let resolved;
    if (safeExistsSync(lockFile)) {
      seenLockFiles.add(lockFile);
      resolved = parseLuaRocksLock(lockFile, rockspecFile);
    }
    const chosen = resolved?.pkgList?.length ? resolved : declared;
    if (chosen.pkgList?.length) {
      pkgList = pkgList.concat(chosen.pkgList);
    }
  }
  // A lock can also stand alone, in a project whose rockspec is generated at
  // release time rather than committed.
  for (const lockFile of getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}luarocks.lock`,
    options,
  )) {
    if (seenLockFiles.has(lockFile)) {
      continue;
    }
    if (DEBUG_MODE) {
      console.log(`Parsing ${lockFile}`);
    }
    const result = parseLuaRocksLock(lockFile);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
  }
  if (pkgList.length) {
    return buildBomNSData(options, pkgList, "lua", {
      src: path,
      filename: rockspecFiles.join(", "),
      parentComponent,
    });
  }
  return {};
}

/**
 * Function to create bom string for Spack environments.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createSpackBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let rootInputs = [];
  const spackLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}spack.lock`,
    options,
  );
  for (const spackLockFile of spackLockFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${spackLockFile}`);
    }
    const result = parseSpackLock(spackLockFile);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (result.rootInputs?.length) {
      rootInputs = rootInputs.concat(result.rootInputs);
    }
  }
  if (!pkgList.length) {
    return {};
  }
  // The lock names no project component, so the environment directory is the
  // name the environment is already known by. Its roots are the specs the
  // lock records as requested, which is why they are linked explicitly rather
  // than inferred from which nodes have no incoming edge: a build-only tool
  // such as gmake also has none, and it is not a root.
  const envName = basename(resolve(path));
  const parentComponent = {
    type: "application",
    name: envName,
    "bom-ref": `application:${envName}:latest`,
    description: `Spack environment: ${envName}`,
    properties: [
      { name: "internal:SrcFile", value: spackLockFiles.join(", ") },
    ],
  };
  if (rootInputs.length) {
    dependencies.push({
      ref: parentComponent["bom-ref"],
      dependsOn: [...new Set(rootInputs)].sort(),
    });
  }
  return buildBomNSData(options, pkgList, "spack", {
    src: path,
    filename: spackLockFiles.join(", "),
    dependencies,
    parentComponent,
  });
}
