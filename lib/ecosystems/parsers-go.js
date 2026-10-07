import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Purl } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../core/activity.js";
import { shouldFetchLicense, shouldFetchVCS } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import {
  applyPurl,
  canonicalPurlFromLooseString,
  tryBuildPurl,
  tryParsePurl,
} from "../inventory/purl.js";
import {
  _clearMetadataCache,
  getGoPkgLicense,
  getGoPkgVCSUrl,
  prefetchGoPkgMetadata,
} from "./ecosystems.js";

/**
 * Method to encode hex string to base64 string
 *
 * @param {string} hexString hex string
 * @returns {string} base64 encoded string
 */
function toBase64(hexString) {
  return Buffer.from(hexString, "hex").toString("base64");
}

/**
 * Builds a Go package component object containing purl, bom-ref, integrity hash,
 * and optionally license and VCS external reference information.
 *
 * @param {string} group Package group (module path prefix, may be empty)
 * @param {string} name Package name (full module path when group is empty)
 * @param {string} version Package version string
 * @param {string} hash Integrity hash (e.g. "sha256-…"), used as _integrity
 * @param {Object} [options] Options
 * @param {boolean} [options.skipRegistryLookups] Leave the licence and VCS
 *   URL unset instead of asking pkg.go.dev. Used for the main module, which
 *   no registry holds.
 * @returns {Promise<Object>} Component object ready for inclusion in a BOM package list
 */
export async function getGoPkgComponent(
  group,
  name,
  version,
  hash,
  options = {},
) {
  let license;
  if (shouldFetchLicense() && !options.skipRegistryLookups) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch go package license information for ${group}:${name}`,
      );
    }
    license = await getGoPkgLicense({
      group: group,
      name: name,
    });
  }
  // Split the full module path into namespace and name, since the caller
  // normally passes the whole path in `name`:
  // pkg:golang/github.com/foo/bar → namespace "github.com/foo", name "bar".
  let purlNamespace = group;
  let purlName = name;
  if (!group && name.includes("/")) {
    const slash = name.lastIndexOf("/");
    purlNamespace = name.slice(0, slash);
    purlName = name.slice(slash + 1);
  }
  // Single-segment module paths (`go4.org`, `go.opencensus.io`) are real Go
  // modules with no namespace. cdx-purl 0.0.3 rejected them, which cost them
  // their purl; 0.0.4 relaxed the golang namespace rule, so they are now built
  // like any other module. Replacing %2F with / keeps the namespace readable as
  // the spec intends.
  const purlString =
    tryBuildPurl({
      type: "golang",
      namespace: purlNamespace || null,
      name: purlName,
      version: version || null,
    })?.replace(/%2F/g, "/") || null;
  let vcs;
  if (shouldFetchVCS() && !options.skipRegistryLookups) {
    vcs = await getGoPkgVCSUrl(group, name);
  }
  const packageInfo = {
    group: group,
    name: name,
    version: version,
    _integrity: hash,
    license: license,
  };
  applyPurl(packageInfo, purlString);
  if (vcs) {
    packageInfo.externalReferences = [{ type: "vcs", url: vcs }];
  }
  return packageInfo;
}

/**
 * Method to parse go.mod files
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 *
 * @returns {Object} Object containing parent component, rootList and packages list
 */
export async function parseGoModData(goModData, gosumMap) {
  const pkgComponentsList = [];
  const rootList = [];

  if (!goModData) {
    return {};
  }
  const { parentComponent, entries } = decodeGoModData(goModData, gosumMap);
  await prefetchGoPkgMetadata(entries);
  for (const entry of entries) {
    const component = await getGoPkgComponent(
      "",
      entry.name,
      entry.version,
      entry.hash,
    );
    if (entry.replacement) {
      pkgComponentsList.push(component);
      rootList.push(component);
      continue;
    }
    if (entry.indirect) {
      component.scope = "optional";
    } else {
      rootList.push(component);
    }
    pkgComponentsList.push(component);
  }
  // Clear the cache
  _clearMetadataCache();
  return {
    parentComponent,
    pkgList: pkgComponentsList.sort((a, b) =>
      // Sort on bom-ref, which every component has, rather than falling back
      // from purl to name. A mixed key sorts purl-less components under their
      // bare name and everything else under "pkg:...", so whether a purl could
      // be built silently reorders the output.
      (a["bom-ref"] || "").localeCompare(b["bom-ref"] || ""),
    ),
    rootList,
  };
}

/**
 * Read a go.mod into its parent component and an ordered list of module
 * entries, without touching the network.
 *
 * Separated from {@link parseGoModData} so the whole module set is known before
 * the first licence lookup, which is what makes one batched round possible.
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 * @returns {{parentComponent: Object, entries: Array<Object>}} Parent component
 *   and module entries in file order
 */
function decodeGoModData(goModData, gosumMap) {
  const parentComponent = {};
  const entries = [];
  let isModReplacement = false;
  let isTool = false;

  const pkgs = goModData.split("\n");
  for (let l of pkgs) {
    // Windows of course
    l = l.replaceAll("\r", "").replace(/[\t ]+/g, " ");
    // Capture the parent component name from the module
    if (l.startsWith("module ")) {
      parentComponent.name = l.split(" ").pop().trim();
      parentComponent.type = "application";
      // Single-segment module paths are valid golang purls as of cdx-purl 0.0.4.
      applyPurl(
        parentComponent,
        tryParsePurl(`pkg:golang/${parentComponent.name}`),
      );
      continue;
    }

    // The `tool` block dependency relations will be recorded into `require` block(need run `go mod tidy`), just ignore that
    if (l.includes("tool (")) {
      isTool = !l.includes(")");
      continue;
    }
    if (l.includes(")")) {
      isTool = false;
      continue;
    }
    if (l.includes("tool ") || isTool) {
      continue;
    }
    if (l.startsWith("toolchain ")) {
      const toolchainVer = l.split(" ").pop().trim();
      parentComponent.properties = [
        { name: "cdx:go:toolchain", value: toolchainVer },
      ];
      continue;
    }
    // Skip go.mod file headers, whitespace, and/or comments
    if (
      l.startsWith("go ") ||
      //TODO: should toolchain be considered as a dependency
      l.includes(")") ||
      l.trim() === "" ||
      l.trim().startsWith("//")
    ) {
      continue;
    }

    // Handle required modules separately from replacement modules to ensure accuracy when parsing component data.
    if (l.includes("require (")) {
      isModReplacement = false;
      continue;
    }
    if (l.includes("replace (")) {
      isModReplacement = true;
      continue;
    }
    if (l.includes("replace ")) {
      // If this is an inline replacement, drop the word replace
      // (eg; "replace google.golang.org/grpc => google.golang.org/grpc v1.21.0" becomes " google.golang.org/grpc => google.golang.org/grpc v1.21.0")
      l = l.replace("replace", "");
      isModReplacement = true;
    }
    // require google.golang.org/genproto v0.0.0-20231106174013-bbf56f31fb17
    if (l.startsWith("require ")) {
      l = l.replace("require ", "");
      isModReplacement = false;
    }
    const tmpA = l.trim().split(" ");
    if (!isModReplacement) {
      // Add group, name and version component properties for required modules
      const version = tmpA[1];
      entries.push({
        group: "",
        name: tmpA[0],
        version,
        hash: gosumMap[`${tmpA[0]}@${version}`],
        indirect: l.endsWith("// indirect"),
        replacement: false,
      });
    } else {
      // Add group, name and version component properties for replacement modules
      const version = tmpA[3];
      entries.push({
        group: "",
        name: tmpA[2],
        version,
        hash: gosumMap[`${tmpA[2]}@${version}`],
        indirect: false,
        replacement: true,
      });
    }
  }
  return { parentComponent, entries };
}

/**
 * Parses a Go modules text file (e.g. vendor/modules.txt) and returns a list of
 * Go package components. Cross-references the go.sum map for integrity hashes and
 * sets scope and confidence based on hash availability.
 *
 * @param {string} txtFile Path to the modules.txt file
 * @param {Object} gosumMap Map of "module@version" keys to sha256 hash values from go.sum
 * @returns {Promise<Object[]>} List of Go package component objects with evidence
 */
export async function parseGoModulesTxt(txtFile, gosumMap) {
  const pkgList = [];
  const txtData = readFileSync(txtFile, { encoding: "utf-8" });
  const pkgs = txtData
    .split("\n")
    .filter((p) => p.trim().replace(/["']/g, "").startsWith("# "));
  await prefetchGoPkgMetadata(
    // # cel.dev/expr v0.18.0
    pkgs.map((l) => ({ group: "", name: l.split(" ")[1] })),
  );
  for (const l of pkgs) {
    const tmpA = l.split(" ");
    if (!tmpA.length === 3) {
      continue;
    }
    const version = tmpA[2];
    const gosumHash = gosumMap[`${tmpA[1]}@${version}`];
    const component = await getGoPkgComponent("", tmpA[1], tmpA[2], gosumHash);
    let confidence = 0.7;
    if (gosumHash) {
      component.scope = "required";
    } else {
      confidence = 0.3;
    }
    pkgList.push(_addGoComponentEvidence(component, txtFile, confidence));
  }
  return pkgList;
}

/**
 * Parse go list output
 *
 * @param {string} rawOutput Output from go list invocation
 * @param {Object} gosumMap go.sum data
 * @returns Object with parent component and List of packages
 */
export async function parseGoListDep(rawOutput, gosumMap) {
  let parentComponent = {};
  const deps = [];
  if (typeof rawOutput === "string") {
    const keys_cache = {};
    const pkgs = rawOutput
      .split("\n")
      .filter((p) => p.trim().replace(/["']/g, "").length);
    // Same shape and same duplicate filter as the loop below, so the batch
    // covers every module the loop resolves and nothing else.
    const prefetchSeen = new Set();
    const prefetchModules = [];
    for (const l of pkgs) {
      const verArr = l.trim().replace(/["']/g, "").split("|");
      if (!verArr || verArr.length < 5) {
        continue;
      }
      // The row whose fifth field is true is the main module: the project
      // itself, which no registry holds and which the loop below turns into
      // the parent component.
      if (verArr[5] === "true") {
        continue;
      }
      const key = `${verArr[0]}-${verArr[1]}`;
      if (prefetchSeen.has(key)) {
        continue;
      }
      prefetchSeen.add(key);
      prefetchModules.push({ group: "", name: verArr[0] });
    }
    await prefetchGoPkgMetadata(prefetchModules);
    for (const l of pkgs) {
      const verArr = l.trim().replace(/["']/g, "").split("|");
      if (verArr && verArr.length >= 5) {
        const key = `${verArr[0]}-${verArr[1]}`;
        // Filter duplicates
        if (!keys_cache[key]) {
          keys_cache[key] = key;
          const version = verArr[1];
          let gosumHash = gosumMap[`${verArr[0]}@${version}`];
          if (!gosumHash && verArr.length >= 8 && verArr[8]?.length) {
            gosumHash = `sha256-${verArr[8].replace("h1:", "")}`;
          }
          const isMainModule = verArr[5] === "true";
          const component = await getGoPkgComponent(
            "",
            verArr[0],
            version,
            gosumHash,
            { skipRegistryLookups: isMainModule },
          );
          // This is misusing the scope attribute to represent direct vs indirect
          if (verArr[2] === "false") {
            component.scope = "required";
          } else if (verArr[2] === "true") {
            component.scope = "optional";
          }
          component.properties = [
            {
              name: "internal:SrcGoMod",
              value: verArr[3] || "",
            },
            {
              name: "internal:ModuleGoVersion",
              value: verArr[4] || "",
            },
            {
              name: "cdx:go:indirect",
              value: verArr[2],
            },
          ];
          if (
            verArr.length >= 6 &&
            verArr[6]?.length &&
            verArr[6] !== "<nil>"
          ) {
            component.properties.push({
              name: "cdx:go:creation_time",
              value: verArr[6],
            });
          }
          if (verArr.length >= 7 && verArr[7]?.length) {
            component.properties.push({
              name: "cdx:go:deprecated",
              value: verArr[7],
            });
          }
          if (verArr.length >= 9 && verArr[9]?.length) {
            component.properties.push({
              name: "cdx:go:local_dir",
              value: verArr[9],
            });
            if (safeExistsSync(join(verArr[9], "LICENSE"))) {
              const licenseText = readFileSync(join(verArr[9], "LICENSE"), {
                encoding: "utf-8",
              });
              if (licenseText?.length) {
                component.licenses = [
                  {
                    license: {
                      name: "CUSTOM",
                      text: { contentType: "text/plain", content: licenseText },
                    },
                  },
                ];
              }
            }
          }
          if (verArr.length > 5 && verArr[5] === "true") {
            parentComponent = component;
          } else {
            deps.push(component);
          }
        }
      }
    }
  }
  return {
    parentComponent,
    pkgList: deps.sort((a, b) =>
      // Sort on bom-ref, which every component has, rather than falling back
      // from purl to name. A mixed key sorts purl-less components under their
      // bare name and everything else under "pkg:...", so whether a purl could
      // be built silently reorders the output.
      (a["bom-ref"] || "").localeCompare(b["bom-ref"] || ""),
    ),
  };
}

function _addGoComponentEvidence(component, goModFile, confidence = 0.8) {
  if (goModFile) {
    component.evidence = {
      identity: {
        field: "purl",
        confidence,
        methods: [
          {
            technique: "manifest-analysis",
            confidence,
            value: goModFile,
          },
        ],
      },
    };
    if (!component.properties) {
      component.properties = [];
    }
    component.properties.push({
      name: "internal:SrcFile",
      value: goModFile,
    });
  }
  return component;
}

/**
 * Build the purl of one `module@version` token from `go mod graph` output.
 *
 * The version is written the way Go prints it, so `+incompatible` and the build
 * metadata of a pseudo-version are unescaped. Reading the token strictly would
 * reject it and leave a reference that keeps the module path's upper-case
 * letters, which then never matches the lower-cased component and drops the
 * dependency edge.
 *
 * @param {string} token Module path, optionally followed by `@version`
 * @returns {Purl|null} Parsed purl, or null when the token forms no valid golang purl
 */
function goModGraphTokenPurl(token) {
  const canonical = canonicalPurlFromLooseString(`pkg:golang/${token}`);
  return canonical ? Purl.parse(canonical) : null;
}

/**
 * Parse go mod graph
 *
 * @param {string} rawOutput Output from go mod graph invocation
 * @param {string} goModFile go.mod file
 * @param {Object} gosumMap Hashes from gosum for lookups
 * @param {Array} epkgList Existing package list
 * @param {Object} parentComponent Current parent component
 *
 * @returns Object containing List of packages and dependencies
 */
export async function parseGoModGraph(
  rawOutput,
  goModFile,
  gosumMap,
  epkgList = [],
  parentComponent = {},
) {
  const pkgList = [];
  const dependenciesList = [];
  const addedPkgs = {};
  const depsMap = {};
  // Useful for filtering out invalid components
  const existingPkgMap = {};
  // Package map by manually parsing the go.mod data
  let goModPkgMap = {};
  // Direct dependencies by manually parsing the go.mod data
  const goModDirectDepsMap = {};
  // Indirect dependencies by manually parsing the go.mod data
  const goModOptionalDepsMap = {};
  const excludedRefs = [];
  if (goModFile) {
    goModPkgMap = await parseGoModData(
      readFileSync(goModFile, { encoding: "utf-8" }),
      gosumMap,
    );
    if (goModPkgMap?.rootList) {
      for (const epkg of goModPkgMap.rootList) {
        goModDirectDepsMap[epkg["bom-ref"]] = true;
      }
    }
    if (goModPkgMap?.pkgList) {
      for (const epkg of goModPkgMap.pkgList) {
        if (epkg?.scope === "optional") {
          goModOptionalDepsMap[epkg["bom-ref"]] = true;
        }
      }
    }
  }
  for (const epkg of epkgList) {
    existingPkgMap[epkg["bom-ref"]] = true;
  }
  if (parentComponent && Object.keys(parentComponent).length) {
    existingPkgMap[parentComponent["bom-ref"]] = true;
  }
  if (typeof rawOutput === "string") {
    const lines = rawOutput.split("\n");
    // Each line is of the form ref dependsOn
    // github.com/spf13/afero@v1.2.2 golang.org/x/text@v0.3.0
    for (const l of lines) {
      // To keep the parsing logic simple we prefix pkg:golang/
      // and let packageurl work out the rest
      const tmpA = l.replaceAll("\r", "").split(" ");
      if (tmpA && tmpA.length === 2) {
        try {
          // Some golang modules (e.g. go4.org) have no path separator and
          // cdx-purl requires a namespace. Use the raw ref when parsing fails.
          let sourceRefString;
          let sourceName = tmpA[0].split("@")[0];
          const sourcePurl = goModGraphTokenPurl(tmpA[0]);
          if (sourcePurl) {
            sourceRefString = decodeURIComponent(sourcePurl.toString());
            sourceName = `${sourcePurl.namespace ? `${sourcePurl.namespace}/` : ""}${sourcePurl.name}`;
          } else {
            sourceRefString = `pkg:golang/${tmpA[0]}`;
          }
          let dependsRefString;
          let dependsName = tmpA[1].split("@")[0];
          const dependsPurl = goModGraphTokenPurl(tmpA[1]);
          if (dependsPurl) {
            dependsRefString = decodeURIComponent(dependsPurl.toString());
            dependsName = `${dependsPurl.namespace ? `${dependsPurl.namespace}/` : ""}${dependsPurl.name}`;
          } else {
            dependsRefString = `pkg:golang/${tmpA[1]}`;
          }
          // Since go mod graph over-reports direct dependencies we use the existing list
          // from go deps to filter the result
          if (
            existingPkgMap &&
            Object.keys(existingPkgMap).length &&
            (!existingPkgMap[sourceRefString] ||
              !existingPkgMap[dependsRefString])
          ) {
            continue;
          }
          // Add the source and depends to the pkgList
          if (!addedPkgs[tmpA[0]] && !excludedRefs.includes(sourceRefString)) {
            // The graph's root is the project itself, which no registry
            // holds, so it is never looked up. It still becomes a component,
            // because the graph's edges hang off its versioned ref.
            const isParentSource =
              sourceName === goModPkgMap?.parentComponent?.name ||
              sourceRefString === goModPkgMap?.parentComponent?.["bom-ref"] ||
              (parentComponent &&
                sourceRefString === parentComponent["bom-ref"]);
            const component = await getGoPkgComponent(
              "",
              sourceName,
              sourcePurl?.version || tmpA[0].split("@")[1],
              gosumMap[tmpA[0]],
              { skipRegistryLookups: isParentSource },
            );
            let confidence = 0.7;
            if (goModOptionalDepsMap[component["bom-ref"]]) {
              component.scope = "optional";
              confidence = 0.5;
            } else if (goModDirectDepsMap[component["bom-ref"]]) {
              component.scope = "required";
            }
            // These are likely false positives
            if (
              goModFile &&
              !Object.keys(existingPkgMap).length &&
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              !component.scope
            ) {
              continue;
            }
            // Don't add the parent component to the package list
            if (goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString) {
              pkgList.push(
                _addGoComponentEvidence(component, goModFile, confidence),
              );
            }
            addedPkgs[tmpA[0]] = true;
          }
          if (!addedPkgs[tmpA[1]]) {
            const component = await getGoPkgComponent(
              "",
              dependsName,
              dependsPurl?.version || tmpA[1].split("@")[1],
              gosumMap[tmpA[1]],
            );
            let confidence = 0.7;
            if (goModDirectDepsMap[component["bom-ref"]]) {
              component.scope = "required";
            }
            if (goModOptionalDepsMap[component["bom-ref"]]) {
              component.scope = "optional";
              confidence = 0.5;
            }
            if (
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              goModDirectDepsMap[sourceRefString] &&
              component?.scope !== "required"
            ) {
              // If the parent is required, then ensure the child doesn't accidentally become optional or excluded
              component.scope = undefined;
            }
            // Mark the go toolchain components as excluded
            if (
              dependsRefString.startsWith("pkg:golang/toolchain@") ||
              dependsRefString.startsWith("pkg:golang/go@")
            ) {
              excludedRefs.push(dependsRefString);
              continue;
            }
            // These are likely false positives
            if (
              goModFile &&
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              !Object.keys(existingPkgMap).length &&
              !component.scope
            ) {
              excludedRefs.push(dependsRefString);
              continue;
            }
            // The confidence for the indirect dependencies is lower
            // This is because go mod graph emits module requirements graph, which could be different to module compile graph
            // See https://go.dev/ref/mod#glos-module-graph
            pkgList.push(
              _addGoComponentEvidence(component, goModFile, confidence),
            );
            addedPkgs[tmpA[1]] = true;
          }
          if (!depsMap[sourceRefString]) {
            depsMap[sourceRefString] = new Set();
          }
          if (!depsMap[dependsRefString]) {
            depsMap[dependsRefString] = new Set();
          }
          // Check if the root is really dependent on this component
          if (
            goModPkgMap?.parentComponent?.["bom-ref"] === sourceRefString &&
            Object.keys(goModDirectDepsMap).length &&
            !goModDirectDepsMap[dependsRefString]
          ) {
            // ignore
          } else if (!excludedRefs.includes(dependsRefString)) {
            depsMap[sourceRefString].add(dependsRefString);
          }
        } catch (_e) {
          // pass
        }
      }
    }
  }
  for (const adep of Object.keys(depsMap).sort()) {
    dependenciesList.push({
      ref: adep,
      dependsOn: Array.from(depsMap[adep]).sort(),
    });
  }
  return {
    pkgList: pkgList.sort((a, b) =>
      // Sort on bom-ref, which every component has, rather than falling back
      // from purl to name. A mixed key sorts purl-less components under their
      // bare name and everything else under "pkg:...", so whether a purl could
      // be built silently reorders the output.
      (a["bom-ref"] || "").localeCompare(b["bom-ref"] || ""),
    ),
    dependenciesList,
    parentComponent: goModPkgMap?.parentComponent,
    rootList: goModPkgMap?.rootList,
  };
}

/**
 * Parse go mod why output.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {string|undefined} package name or none
 */
export function parseGoModWhy(rawOutput) {
  if (typeof rawOutput === "string") {
    let pkg_name;
    const lines = rawOutput.split("\n");
    lines.forEach((l) => {
      if (l && !l.startsWith("#") && !l.startsWith("(")) {
        pkg_name = l.trim();
      }
    });
    return pkg_name;
  }
  return undefined;
}

/**
 * Reports whether `go mod why -m` output says the main module does not need
 * the module. go prints `(main module does not need module X)`, or
 * `(main module does not need to vendor module X)` with `-vendor`, and exits
 * with status 0 either way.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {boolean} True when go reports the module as not needed
 */
export function isGoModWhyNotNeeded(rawOutput) {
  if (typeof rawOutput !== "string") {
    return false;
  }
  return rawOutput
    .split("\n")
    .some((line) => line.trim().startsWith("(main module does not need "));
}

/**
 * Parse go sum data
 * @param {string} gosumData Content of go.sum
 * @returns package list
 */
export async function parseGosumData(gosumData) {
  const pkgList = [];
  if (!gosumData) {
    return pkgList;
  }
  // Decoding every line first lets the whole module set be fetched in one
  // batched round before any component is built. One decode function feeds both,
  // so the batch cannot ask for a module the loop does not resolve.
  const entries = [];
  for (const l of gosumData.split("\n")) {
    const m = l.replaceAll("\r", "");
    // look for lines containing go.mod
    if (m.indexOf("go.mod") > -1) {
      const tmpA = m.split(" ");
      entries.push({
        group: "",
        name: tmpA[0],
        version: tmpA[1].replace("/go.mod", ""),
        hash: tmpA[tmpA.length - 1].replace("h1:", "sha256-"),
      });
    }
  }
  await prefetchGoPkgMetadata(entries);
  for (const entry of entries) {
    pkgList.push(
      await getGoPkgComponent("", entry.name, entry.version, entry.hash),
    );
  }
  return pkgList;
}

/**
 * Parses the contents of a Gopkg.lock or Gopkg.toml file (dep tool format) and
 * returns a list of Go package components. Optionally fetches license information
 * for each package when FETCH_LICENSE is enabled.
 *
 * @param {string} gopkgData Raw string contents of the Gopkg lock/toml file
 * @returns {Promise<Object[]>} List of Go package component objects
 */
export async function parseGopkgData(gopkgData) {
  const pkgList = [];
  if (!gopkgData) {
    return pkgList;
  }
  let pkg = null;
  const pkgs = gopkgData.split("\n");
  for (const l of pkgs) {
    let key = null;
    let value = null;
    if (l.indexOf("[[projects]]") > -1) {
      if (pkg) {
        pkgList.push(pkg);
      }
      pkg = {};
    }
    if (l.indexOf("=") > -1) {
      const tmpA = l.split("=");
      key = tmpA[0].trim();
      value = tmpA[1].trim().replace(/"/g, "");
      let digestStr;
      switch (key) {
        case "digest":
          digestStr = value.replace("1:", "");
          pkg._integrity = `sha256-${toBase64(digestStr)}`;
          break;
        case "name":
          pkg.group = "";
          pkg.name = value;
          if (shouldFetchLicense()) {
            pkg.license = await getGoPkgLicense({
              group: pkg.group,
              name: pkg.name,
            });
          }
          break;
        case "version":
          pkg.version = value;
          break;
        case "revision":
          if (!pkg.version) {
            pkg.version = value;
          }
      }
    }
  }
  return pkgList;
}

/**
 * Parses the output of `go version -m` (build info) and returns a list of Go
 * package components for each "dep" line, including name, version, and integrity hash.
 *
 * @param {string} buildInfoData Raw string output from `go version -m`
 * @returns {Promise<Object[]>} List of Go package component objects
 */
export async function parseGoVersionData(buildInfoData) {
  const pkgList = [];
  if (!buildInfoData) {
    return pkgList;
  }
  const entries = [];
  for (const line of buildInfoData.split("\n")) {
    const l = line.trim().replace(/\t/g, " ");
    if (!l.startsWith("dep")) {
      continue;
    }
    const tmpA = l.split(" ");
    if (!tmpA || tmpA.length < 3) {
      continue;
    }
    entries.push({
      group: "",
      name: tmpA[1].trim(),
      version: tmpA[2].trim(),
      hash:
        tmpA.length === 4
          ? tmpA[tmpA.length - 1].replace("h1:", "sha256-")
          : "",
    });
  }
  await prefetchGoPkgMetadata(entries);
  for (const entry of entries) {
    pkgList.push(
      await getGoPkgComponent("", entry.name, entry.version, entry.hash),
    );
  }
  return pkgList;
}
