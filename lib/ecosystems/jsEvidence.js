// JavaScript/TypeScript evidence collection.
//
// This lives in lib/ecosystems/ rather than lib/inventory/evidenceUtils.js
// because it is npm-specific throughout: node_modules resolution, package.json
// parsing, and the `cdx:npm:bin/` import convention. Keeping it here lets it
// import parsers-js directly instead of having parsePkgJson threaded in as an
// injected helper from the CLI.

import { dirname, isAbsolute, join, resolve } from "node:path";

import { safeExistsSync } from "../core/fs.js";
import { isRealPathInsideProject } from "../core/lockPaths.js";
import { createOccurrenceEvidence } from "../inventory/evidenceUtils.js";
import { isPkgTypeOnlyImport, setNpmTypeOnlyProperty } from "./npmutils.js";
import {
  createNpmVersionChooser,
  npmPackageName,
  projectRootRefs,
} from "./npmVersionResolution.js";
import { parsePkgJson } from "./parsers-js.js";

const NPM_BIN_IMPORT_PREFIX = "cdx:npm:bin/";

function getNpmBinPropertyValues(pkg, propertyName) {
  if (!Array.isArray(pkg?.properties)) {
    return [];
  }
  return pkg.properties
    .filter((property) => property.name === propertyName && property.value)
    .map((property) => String(property.value));
}

function splitNpmBinPropertyList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNpmPackageBinCommandNames(pkg) {
  const binNames = new Set();
  if (pkg?.bin && typeof pkg.bin === "object") {
    for (const binName of Object.keys(pkg.bin)) {
      binNames.add(binName);
    }
  } else if (typeof pkg?.bin === "string") {
    binNames.add(pkg.name);
  }
  for (const binValue of getNpmBinPropertyValues(pkg, "cdx:npm:bin")) {
    for (const binName of splitNpmBinPropertyList(binValue)) {
      binNames.add(binName);
    }
  }
  for (const binPathValue of getNpmBinPropertyValues(pkg, "cdx:npm:binPaths")) {
    for (const binPath of splitNpmBinPropertyList(binPathValue)) {
      const normalizedBinPath = binPath.replaceAll("\\", "/");
      const binName = normalizedBinPath.split("/").filter(Boolean).pop();
      if (binName) {
        binNames.add(binName);
      }
    }
  }
  return binNames;
}

function getNpmBinCommandEvidenceKeys(allImports, pkg) {
  const binCommandNames = getNpmPackageBinCommandNames(pkg);
  if (!binCommandNames.size) {
    return [];
  }
  return Object.keys(allImports || {}).filter(
    (importName) =>
      importName.startsWith(NPM_BIN_IMPORT_PREFIX) &&
      binCommandNames.has(importName.slice(NPM_BIN_IMPORT_PREFIX.length)),
  );
}

/**
 * Credit a package with the `cdx:npm:bin/<command>` evidence of its bin
 * commands, limited to the files that resolve to this version when several are
 * installed.
 *
 * @param {object} pkg Package component, changed in place
 * @param {object} allImports Map of import specifier to usage evidence objects
 * @param {object} versionChooser Chooser from `createNpmVersionChooser`
 * @returns {boolean} Whether a bin command of this version is used
 */
function applyNpmBinCommandEvidence(pkg, allImports, versionChooser) {
  const binEvidenceKeys = getNpmBinCommandEvidenceKeys(allImports, pkg);
  if (!binEvidenceKeys.length) {
    return false;
  }
  const binEvidences = binEvidenceKeys.flatMap((key) =>
    Array.from(allImports[key] || []).filter(
      (evidence) =>
        !versionChooser.isAmbiguous(pkg) ||
        (evidence?.fileName && versionChooser.allows(pkg, evidence.fileName)),
    ),
  );
  if (versionChooser.isAmbiguous(pkg) && !binEvidences.length) {
    return false;
  }
  pkg.scope = "required";
  const seenOccurrenceLocations = new Set(
    (pkg.evidence?.occurrences || []).map(
      (occurrence) =>
        `${occurrence.location}${occurrence.line ? `#${occurrence.line}` : ""}`,
    ),
  );
  for (const evidence of binEvidences) {
    if (!evidence?.fileName) {
      continue;
    }
    const occurrence = createOccurrenceEvidence(evidence.fileName, {
      ...(evidence.lineNumber ? { line: evidence.lineNumber } : {}),
    });
    if (!occurrence) {
      continue;
    }
    const occurrenceLocation = `${occurrence.location}${occurrence.line ? `#${occurrence.line}` : ""}`;
    if (seenOccurrenceLocations.has(occurrenceLocation)) {
      continue;
    }
    pkg.evidence = pkg.evidence || {};
    pkg.evidence.occurrences = pkg.evidence.occurrences || [];
    pkg.evidence.occurrences.push(occurrence);
    seenOccurrenceLocations.add(occurrenceLocation);
  }
  return true;
}

/**
 * Fill in a component's missing npm metadata (description, author, license,
 * homepage, repository) from the package.json of its installed copy.
 *
 * `internal:LocalNodeModulesPath` holds either an absolute install directory
 * (pnpm) or an arborist `node.location`. A location that starts with
 * `node_modules/` is relative to the directory of the component's
 * `internal:SrcFile`. Other relative locations, such as a workspace member or a
 * package nested under one, have no recorded base and are skipped; the deep npm
 * parse reads those manifests from the arborist node itself. The manifest is
 * used only when it names the component's package and version, and it fills
 * only the fields the component lacks.
 *
 * @param {object} pkg Package component to enrich in place.
 */
async function fillMissingMetadataFromLocalNodeModules(pkg) {
  if (pkg.description || !Array.isArray(pkg.properties)) {
    return;
  }
  const propValue = (propName) =>
    pkg.properties.find((property) => property.name === propName)?.value;
  const localNodeModulesPath = propValue("internal:LocalNodeModulesPath");
  if (!localNodeModulesPath) {
    return;
  }
  let pkgJsonFile;
  let baseDir;
  if (isAbsolute(localNodeModulesPath)) {
    // pnpmMetadata() checked this directory against the lock file's directory.
    pkgJsonFile = join(localNodeModulesPath, "package.json");
  } else {
    const srcFile = propValue("internal:SrcFile");
    if (!srcFile || !localNodeModulesPath.startsWith("node_modules/")) {
      return;
    }
    baseDir = dirname(srcFile);
    pkgJsonFile = resolve(baseDir, localNodeModulesPath, "package.json");
  }
  if (!safeExistsSync(pkgJsonFile)) {
    return;
  }
  // The installed copy lives below the lock file's directory. A symbolic link
  // shipped with the scanned tree (node_modules, the package folder or
  // package.json itself) can point anywhere on the host, so the file that is
  // really opened is checked with links resolved.
  if (baseDir && !isRealPathInsideProject(pkgJsonFile, baseDir)) {
    return;
  }
  const lnmPkgList = await parsePkgJson(pkgJsonFile, true);
  const lnmMetadata = lnmPkgList?.length === 1 ? lnmPkgList[0] : undefined;
  if (
    !lnmMetadata ||
    npmPackageName(lnmMetadata) !== npmPackageName(pkg) ||
    lnmMetadata.version !== pkg.version
  ) {
    return;
  }
  if (!pkg.description && lnmMetadata.description) {
    pkg.description = lnmMetadata.description;
  }
  if (!pkg.author && lnmMetadata.author) {
    pkg.author = lnmMetadata.author;
  }
  if (!pkg.license && lnmMetadata.license) {
    pkg.license = lnmMetadata.license;
  }
  if (!pkg.homepage && lnmMetadata.homepage) {
    pkg.homepage = lnmMetadata.homepage;
  }
  if (!pkg.repository && lnmMetadata.repository) {
    pkg.repository = lnmMetadata.repository;
  }
}

/**
 * Attach JS/TS import and export usage evidence to matching package components.
 *
 * For each component, resolves its module aliases (including the deno jsr
 * specifier), records imported/exported modules as properties, attaches
 * occurrence evidence, and promotes the component scope to "required" when the
 * package is used. A package with no observed usage keeps the scope its
 * manifest parser assigned: static import analysis cannot see packages loaded
 * from configuration, bundler entrypoints, stylesheets, or plugins, so a
 * missing import is not evidence that a package is optional.
 *
 * When the lock file holds several versions of a package, an import is
 * evidence only for the version the importing file resolves to (see
 * `createNpmVersionChooser`), so a copy nested under another package is not
 * credited with, or promoted to required by, the project's own imports.
 *
 * @param {Array<object>} pkgList Package components to enrich.
 * @param {object} allImports Map of import specifier to usage evidence objects.
 * @param {object} allExports Map of export specifier to export evidence objects.
 * @param {boolean} deep When true, fill in missing description/author/license
 *   metadata from the local node_modules copy of each package.
 * @param {object} [context] Project facts that pick the version a file uses.
 * @param {string} [context.srcDir] Directory the evidence file names are relative to.
 * @param {Array<object>} [context.dependencies] Dependency tree of the packages.
 * @param {object} [context.parentComponent] Project component, with any workspace members as its components.
 * @returns {Promise<Array<object>>} The enriched package list (same reference as pkgList).
 */
export async function addEvidenceForImports(
  pkgList,
  allImports,
  allExports,
  deep,
  context = {},
) {
  const impPkgs = Object.keys(allImports);
  const exportedPkgs = Object.keys(allExports);
  const versionChooser = createNpmVersionChooser(pkgList, {
    srcDir: context.srcDir,
    dependencies: context.dependencies,
    rootRefs: projectRootRefs(context.parentComponent),
  });
  for (const pkg of pkgList) {
    const { group, name } = pkg;
    // Evidence belonging to a type must be associated with the package
    if (group === "@types") {
      continue;
    }
    // Runs ahead of the alias loop, which a matching import ends with a break,
    // so that every component is enriched whichever alias the source imports.
    if (deep) {
      await fillMissingMetadataFromLocalNodeModules(pkg);
    }
    const aliases = group?.length
      ? [name, `${group}/${name}`, `@${group}/${name}`]
      : [name];
    // Deno jsr packages are published under the `@jsr` npm-compat scope
    // (e.g. `@jsr/std__assert`) but are imported in source using their
    // original jsr specifier (e.g. `@std/assert`). Match occurrence evidence
    // against that specifier too, recovered from the `cdx:deno:jsrKey`
    // property recorded during deno.lock parsing.
    const jsrKey = (pkg.properties || []).find(
      (p) => p.name === "cdx:deno:jsrKey",
    )?.value;
    if (jsrKey) {
      const atIndex = jsrKey.lastIndexOf("@");
      const jsrSpecifier = atIndex > 0 ? jsrKey.substring(0, atIndex) : jsrKey;
      if (jsrSpecifier && !aliases.includes(jsrSpecifier)) {
        aliases.push(jsrSpecifier);
      }
    }
    let creditedByImports = false;
    for (const alias of aliases) {
      const isWasmAlias = /\.wasm([?#].*)?$/i.test(alias);
      const all_includes = impPkgs.filter(
        (find_pkg) =>
          find_pkg.startsWith(alias) &&
          (find_pkg.length === alias.length || find_pkg[alias.length] === "/"),
      );
      const all_exports = exportedPkgs.filter((find_pkg) =>
        find_pkg.startsWith(alias),
      );
      if (all_exports?.length) {
        let exportedModules = new Set(isWasmAlias ? [] : all_exports);
        pkg.properties = pkg.properties || [];
        for (const subevidence of all_exports) {
          const evidences = allExports[subevidence];
          for (const evidence of evidences) {
            if (evidence && Object.keys(evidence).length) {
              if (isWasmAlias) {
                for (const wasmImportedModule of evidence.importedModules ||
                  []) {
                  if (wasmImportedModule?.length) {
                    exportedModules.add(wasmImportedModule);
                  }
                }
              }
              if (evidence.exportedModules.length > 1) {
                for (const aexpsubm of evidence.exportedModules) {
                  // Be selective on the submodule names
                  if (
                    !evidence.importedAs
                      .toLowerCase()
                      .includes(aexpsubm.toLowerCase()) &&
                    !alias.endsWith(aexpsubm)
                  ) {
                    // Store both the short and long form of the exported sub modules
                    if (aexpsubm.length > 3) {
                      exportedModules.add(aexpsubm);
                    }
                    exportedModules.add(
                      `${evidence.importedAs.replace("./", "")}/${aexpsubm}`,
                    );
                  }
                }
              }
            }
          }
        }
        exportedModules = Array.from(exportedModules);
        if (exportedModules.length) {
          pkg.properties.push({
            name: "internal:ExportedModules",
            value: exportedModules.join(","),
          });
        }
      }
      // Identify all the imported modules of a component. Of several
      // installed versions, only the one a file resolves to takes its imports.
      const isAmbiguous = versionChooser.isAmbiguous(pkg);
      const evidencesOf = (subevidence) => {
        const evidences = Array.from(allImports[subevidence] || []);
        return isAmbiguous
          ? evidences.filter(
              (evidence) =>
                evidence?.fileName &&
                versionChooser.allows(pkg, evidence.fileName),
            )
          : evidences;
      };
      const usedIncludes = isAmbiguous
        ? all_includes.filter((subevidence) => evidencesOf(subevidence).length)
        : all_includes;
      if ((!isAmbiguous && impPkgs.includes(alias)) || usedIncludes.length) {
        creditedByImports = true;
        let importedModules = new Set();
        let wasmExportedModules = new Set();
        const seenOccurrenceLocations = new Set();
        // A package imported only for its types is erased at compile time.
        // Scoping it excluded here, rather than when the BOM is assembled,
        // keeps propagateRequiredScopeFromDependencies from promoting what it
        // depends on. A package whose bin command is used is still required.
        if (
          isPkgTypeOnlyImport(allImports, group, name) &&
          !getNpmBinCommandEvidenceKeys(allImports, pkg).length
        ) {
          pkg.scope = "excluded";
          setNpmTypeOnlyProperty(pkg);
        } else {
          pkg.scope = "required";
        }
        for (const subevidence of usedIncludes) {
          for (const evidence of evidencesOf(subevidence)) {
            if (evidence && Object.keys(evidence).length && evidence.fileName) {
              const occurrence = createOccurrenceEvidence(evidence.fileName, {
                ...(evidence.lineNumber ? { line: evidence.lineNumber } : {}),
              });
              if (occurrence) {
                pkg.evidence = pkg.evidence || {};
                pkg.evidence.occurrences = pkg.evidence.occurrences || [];
                const occurrenceLocation = `${occurrence.location}${occurrence.line ? `#${occurrence.line}` : ""}`;
                if (!seenOccurrenceLocations.has(occurrenceLocation)) {
                  pkg.evidence.occurrences.push(occurrence);
                  seenOccurrenceLocations.add(occurrenceLocation);
                }
              }
              importedModules.add(evidence.importedAs);
              for (const importedSm of evidence.importedModules || []) {
                if (!importedSm) {
                  continue;
                }
                if (isWasmAlias) {
                  wasmExportedModules.add(importedSm);
                }
                // Store both the short and long form of the imported sub modules
                if (importedSm.length > 3) {
                  importedModules.add(importedSm);
                }
                importedModules.add(`${evidence.importedAs}/${importedSm}`);
              }
            }
          }
        }
        importedModules = Array.from(importedModules);
        wasmExportedModules = Array.from(wasmExportedModules);
        if (importedModules.length) {
          pkg.properties = pkg.properties || [];
          pkg.properties.push({
            name: "internal:ImportedModules",
            value: importedModules.join(","),
          });
        }
        if (isWasmAlias && wasmExportedModules.length) {
          pkg.properties = pkg.properties || [];
          if (
            !pkg.properties.some((p) => p.name === "internal:ExportedModules")
          ) {
            pkg.properties.push({
              name: "internal:ExportedModules",
              value: wasmExportedModules.join(","),
            });
          }
        }
        break;
      }
    } // for alias
    if (applyNpmBinCommandEvidence(pkg, allImports, versionChooser)) {
      creditedByImports = true;
    }
    // Every import of this package's name resolves to another installed
    // version. buildBomNSData reads the flag so that matching by name alone
    // does not promote this copy to required.
    if (versionChooser.isAmbiguous(pkg) && !creditedByImports) {
      pkg._npmImportsResolveElsewhere = true;
    }
    // Trim the properties
    pkg.properties = pkg.properties.filter(
      (p) => p.name !== "internal:LocalNodeModulesPath",
    );
  } // for pkg
  return pkgList;
}
