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
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import { createOccurrenceEvidence } from "../inventory/evidenceUtils.js";
import {
  indexModuleNames,
  isNpmOptionalDependency,
  isPkgTypeOnlyImport,
  setNpmTypeOnlyProperty,
} from "./npmutils.js";
import {
  createNpmVersionChooser,
  npmPackageName,
  projectRootRefs,
} from "./npmVersionResolution.js";
import { parseLocalPkgJsonOnce } from "./parsers-js.js";

const NPM_BIN_IMPORT_PREFIX = "cdx:npm:bin/";
// The long form `<specifier>/<name>` repeats the module specifier once per
// imported or exported name, so a statement with many names and a very long
// specifier would inflate the property quadratically. An npm package name is
// limited to 214 characters; longer specifiers keep only the short form.
const MAX_LONG_FORM_SPECIFIER_LENGTH = 256;
const URL_SPECIFIER_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Module specifier in the form that may be written to a BOM. A module loaded
 * by URL (deno, browser ES modules, wasm) can carry userinfo or a signed query
 * string, neither of which may reach the BOM, so a URL with an authority,
 * protocol-relative ones included, loses both and its fragment. Anything else,
 * such as a bare package name or a Windows path, is returned as it is.
 *
 * @param {string} specifier Module specifier found in the sources.
 * @returns {string|undefined} The specifier, a URL without userinfo, query and
 *   fragment, or undefined for a URL that cannot be parsed.
 */
export function bomSafeSpecifier(specifier) {
  if (!specifier || typeof specifier !== "string") {
    return specifier;
  }
  if (specifier.startsWith("//")) {
    const withScheme = `https:${specifier}`;
    return URL.canParse(withScheme)
      ? sanitizeBomUrl(withScheme).slice("https:".length)
      : undefined;
  }
  if (!URL_SPECIFIER_PATTERN.test(specifier)) {
    return specifier;
  }
  // sanitizeBomUrl() returns a URL it cannot parse unchanged, so it is dropped
  return URL.canParse(specifier) ? sanitizeBomUrl(specifier) : undefined;
}

// An import names a package, and a script a bin command, without a version, so
// every component that answers to the name and that the version chooser cannot
// rule out takes its evidence. A real lock file leaves a handful of them; the
// cap keeps a crafted one, with thousands of versions or scopes of one name,
// from copying every import site onto every one of its entries.
const MAX_COMPONENTS_PER_IMPORT_NAME = 32;

/**
 * Decide whether a component takes the evidence recorded under a name.
 *
 * The first MAX_COMPONENTS_PER_IMPORT_NAME components asking for a name take
 * it. A component listed again (package-lock.json lists one per install
 * location, a monorepo one per lock file) is the same component in the BOM: it
 * shares the occurrences of the first listing instead of collecting a copy.
 *
 * @param {Map<string, Map<string, object>>} creditedByName Components credited so far, by name and component identity; changed in place
 * @param {string} name Package alias or `cdx:npm:bin/<command>` key
 * @param {object} pkg Package component, changed in place when it is a repeat
 * @returns {boolean} Whether the evidence has to be collected for `pkg`
 */
function takesEvidenceOf(creditedByName, name, pkg) {
  let credited = creditedByName.get(name);
  if (!credited) {
    credited = new Map();
    creditedByName.set(name, credited);
  }
  const pkgKey =
    pkg.purl ||
    pkg["bom-ref"] ||
    `${pkg.group || ""}/${pkg.name}@${pkg.version}`;
  const creditedPkg = credited.get(pkgKey);
  if (creditedPkg) {
    if (creditedPkg.evidence?.occurrences) {
      pkg.evidence = pkg.evidence || {};
      pkg.evidence.occurrences = creditedPkg.evidence.occurrences;
    }
    return false;
  }
  if (credited.size >= MAX_COMPONENTS_PER_IMPORT_NAME) {
    return false;
  }
  credited.set(pkgKey, pkg);
  return true;
}

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
  return Array.from(
    getNpmPackageBinCommandNames(pkg),
    (commandName) => `${NPM_BIN_IMPORT_PREFIX}${commandName}`,
  ).filter((importName) => Object.hasOwn(allImports || {}, importName));
}

/**
 * Credit a package with the `cdx:npm:bin/<command>` evidence of its bin
 * commands, limited to the files that resolve to this version when several are
 * installed. A package past the bound of `takesEvidenceOf` for a command is
 * scoped by it and takes none of its occurrences.
 *
 * @param {object} pkg Package component, changed in place
 * @param {object} allImports Map of import specifier to usage evidence objects
 * @param {object} versionChooser Chooser from `createNpmVersionChooser`
 * @param {Map<string, Map<string, object>>} creditedByImportName Components credited so far, see `takesEvidenceOf`
 * @returns {boolean} Whether a bin command of this version is used
 */
function applyNpmBinCommandEvidence(
  pkg,
  allImports,
  versionChooser,
  creditedByImportName,
) {
  const binEvidenceKeys = getNpmBinCommandEvidenceKeys(allImports, pkg);
  if (!binEvidenceKeys.length) {
    return false;
  }
  const isAmbiguous = versionChooser.isAmbiguous(pkg);
  const evidencesOf = (key) =>
    Array.from(allImports[key] || []).filter(
      (evidence) =>
        !isAmbiguous ||
        (evidence?.fileName && versionChooser.allows(pkg, evidence.fileName)),
    );
  const usedKeys = isAmbiguous
    ? binEvidenceKeys.filter((key) => evidencesOf(key).length)
    : binEvidenceKeys;
  if (!usedKeys.length) {
    return false;
  }
  // A bin command of an optional dependency records where it is invoked from,
  // but the manifest said npm may leave the package uninstalled, so the usage
  // keeps the optional scope (discussion 4070).
  if (!isNpmOptionalDependency(pkg)) {
    pkg.scope = "required";
  }
  const binEvidences = usedKeys
    .filter((key) => takesEvidenceOf(creditedByImportName, key, pkg))
    .flatMap(evidencesOf);
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
  const lnmPkgList = await parseLocalPkgJsonOnce(pkgJsonFile);
  const lnmMetadata = lnmPkgList?.length === 1 ? lnmPkgList[0] : undefined;
  if (
    !lnmMetadata ||
    npmPackageName(lnmMetadata) !== npmPackageName(pkg) ||
    lnmMetadata.version !== pkg.version
  ) {
    return;
  }
  // The parsed manifest is shared, so object values are copied
  const copyOf = (value) =>
    value && typeof value === "object" ? structuredClone(value) : value;
  if (!pkg.description && lnmMetadata.description) {
    pkg.description = lnmMetadata.description;
  }
  if (!pkg.author && lnmMetadata.author) {
    pkg.author = copyOf(lnmMetadata.author);
  }
  if (!pkg.license && lnmMetadata.license) {
    pkg.license = copyOf(lnmMetadata.license);
  }
  if (!pkg.homepage && lnmMetadata.homepage) {
    pkg.homepage = copyOf(lnmMetadata.homepage);
  }
  if (!pkg.repository && lnmMetadata.repository) {
    pkg.repository = copyOf(lnmMetadata.repository);
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
 * Every component an import is evidence for is scoped by it, but no more than
 * MAX_COMPONENTS_PER_IMPORT_NAME of them carry its occurrences and modules
 * (see `takesEvidenceOf`), so the evidence grows with the sources and the
 * lock files, not with their product.
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
  // Sorted once here, because a walk over every import and export for each
  // package makes a scan cost packages x modules, both set by the scanned tree.
  const findImportNames = indexModuleNames(allImports);
  const findExportNames = indexModuleNames(allExports);
  const versionChooser = createNpmVersionChooser(pkgList, {
    srcDir: context.srcDir,
    dependencies: context.dependencies,
    rootRefs: projectRootRefs(context.parentComponent),
  });
  const creditedByImportName = new Map();
  const creditedByExportName = new Map();
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
    // Node.js never resolves the bare name of a scoped package, so an import
    // written with it belongs to another package or to a builtin, never to
    // this one (discussion 4458). The aliases carry the scope joined with the
    // name stripped of any scope prefix, so both shapes a parser records
    // (name "fs" with group "@npmcli", or the full "@npmcli/fs") resolve to
    // the same specifier; a group without its leading @ matches in both
    // spellings.
    let aliases;
    if (group?.length) {
      const nameWithoutScope = name.includes("/")
        ? name.split("/").pop()
        : name;
      aliases = group.startsWith("@")
        ? [`${group}/${nameWithoutScope}`]
        : [`${group}/${nameWithoutScope}`, `@${group}/${nameWithoutScope}`];
    } else {
      aliases = [name];
    }
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
      const isWasmAlias = /\.wasm([?#][\s\S]*)?$/i.test(alias);
      // The package itself and the modules below it
      const all_includes = findImportNames(`${alias}/`, alias);
      // A wasm component is named after a file, so the query and fragment of
      // the specifier as written are left out as well.
      const specifierFor = (importedAs) => {
        const safe = bomSafeSpecifier(importedAs);
        return safe && isWasmAlias ? safe.split(/[?#]/, 1)[0] : safe;
      };
      // Same boundary as the imports above, so that `https` is not credited
      // with every `https://` URL and `lodash` not with `lodash-es`. A wasm
      // alias has its query and fragment removed, so a re-export of
      // `calc.wasm?init` still belongs to the `calc.wasm` component.
      const all_exports = [
        ...findExportNames(`${alias}/`, alias),
        ...findExportNames(`${alias}?`),
        ...findExportNames(`${alias}#`),
      ];
      if (
        all_exports?.length &&
        takesEvidenceOf(creditedByExportName, alias, pkg)
      ) {
        let exportedModules = new Set(
          isWasmAlias ? [] : all_exports.map(bomSafeSpecifier).filter(Boolean),
        );
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
              const exportedFrom = specifierFor(evidence.importedAs);
              if (exportedFrom && evidence.exportedModules.length > 1) {
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
                    if (exportedFrom.length <= MAX_LONG_FORM_SPECIFIER_LENGTH) {
                      exportedModules.add(
                        `${exportedFrom.replace("./", "")}/${aexpsubm}`,
                      );
                    }
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
      if (
        (!isAmbiguous && Object.hasOwn(allImports, alias)) ||
        usedIncludes.length
      ) {
        creditedByImports = true;
        let importedModules = new Set();
        let wasmExportedModules = new Set();
        const seenOccurrenceLocations = new Set();
        // A package imported only for its types is erased at compile time.
        // Scoping it excluded here, rather than when the BOM is assembled,
        // keeps propagateRequiredScopeFromDependencies from promoting what it
        // depends on. A package whose bin command is used is still required.
        if (
          isPkgTypeOnlyImport(allImports, group, name, findImportNames) &&
          !getNpmBinCommandEvidenceKeys(allImports, pkg).length
        ) {
          pkg.scope = "excluded";
          setNpmTypeOnlyProperty(pkg);
        } else if (!isNpmOptionalDependency(pkg)) {
          // An optional dependency keeps its scope despite the usage: npm may
          // leave it uninstalled, so the import is not proof it ships
          // (discussion 4070). The occurrences are still recorded.
          pkg.scope = "required";
        }
        // Past the bound, the component keeps the scope and takes no evidence.
        if (!takesEvidenceOf(creditedByImportName, alias, pkg)) {
          break;
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
              const importedFrom = specifierFor(evidence.importedAs);
              if (!importedFrom) {
                continue;
              }
              importedModules.add(importedFrom);
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
                if (importedFrom.length <= MAX_LONG_FORM_SPECIFIER_LENGTH) {
                  importedModules.add(`${importedFrom}/${importedSm}`);
                }
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
    if (
      applyNpmBinCommandEvidence(
        pkg,
        allImports,
        versionChooser,
        creditedByImportName,
      )
    ) {
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
