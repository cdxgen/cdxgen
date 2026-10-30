import { platform } from "node:os";
import { basename, dirname, extname } from "node:path";

import { build } from "@cdxgen/cdx-purl";

import { safeExistsSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import { vscodeExtensionPlatformFromPath } from "../parsers/vscodeExtensionId.js";
import { isAgentSkillSpecValid } from "./agentSkillSpec.js";
import {
  addDosaiReachabilityProperties,
  readDosaiMethodsReport,
} from "./dosai.js";
import {
  addDosaiSetValue,
  buildDosaiPurlAliasMap,
  dosaiCallSiteLocation,
  dosaiSourceLocation,
  dosaiSourceLocationFromNode,
  pickDosaiComponentByLocation,
  resolveDosaiComponentPurl,
} from "./dosaiParsers.js";
import { createGtfoBinsPropertiesFromRow } from "./gtfobins.js";
import { createLolbasProperties } from "./lolbas.js";
import { isOsPackagePurlType } from "./osPackagePurl.js";
import {
  createOsQueryFallbackBomRef,
  createOsQueryPackageIdentity,
  createOsQueryPurl,
  deriveOsQueryDescription,
  deriveOsQueryName,
  deriveOsQueryPublisher,
  deriveOsQueryVersion,
  OS_PACKAGE_LICENSE_COLUMNS,
  osPackagePropertyName,
  sanitizeOsQueryIdentity,
  shouldCreateOsQueryPurl,
} from "./osqueryTransform.js";
import {
  adjustLicenseInformation,
  findLicenseId,
  isSpdxLicenseExpression,
  spdxLicenses,
} from "./spdx.js";

/**
 * Build a CycloneDX occurrence evidence object from a location string.
 *
 * @param {string} location Location string such as a file path or `file#line`
 * @param {Object} [details] Extra fields (e.g. line, offset) merged into the occurrence; empty values are skipped
 * @returns {Object|undefined} Occurrence evidence object with a location, or undefined when the location is empty
 */
export function createOccurrenceEvidence(location, details = {}) {
  const normalizedLocation = String(location || "").trim();
  if (!normalizedLocation) {
    return undefined;
  }
  const occurrence = {
    location: normalizedLocation,
  };
  for (const [key, value] of Object.entries(details || {})) {
    if (value !== undefined && value !== null && value !== "") {
      occurrence[key] = value;
    }
  }
  return occurrence;
}

/**
 * Parse a location string into a CycloneDX occurrence with file/line/offset fields.
 *
 * Recognizes `file#line`, `file:line:offset`, and `file:line` forms; other
 * strings are kept as a plain location occurrence.
 *
 * @param {string} location Location string to parse
 * @param {Object} [details] Extra fields merged into the occurrence
 * @returns {Object|undefined} Occurrence evidence object, or undefined when the location is empty
 */
export function parseOccurrenceEvidenceLocation(location, details = {}) {
  const normalizedLocation = String(location || "").trim();
  if (!normalizedLocation) {
    return undefined;
  }
  const hashMatch = normalizedLocation.match(/^(.*)#(\d+)$/);
  if (hashMatch) {
    return createOccurrenceEvidence(hashMatch[1], {
      ...details,
      line: Number(hashMatch[2]),
    });
  }
  const lineOffsetMatch = normalizedLocation.match(/^(.*):(\d+):(\d+)$/);
  if (lineOffsetMatch) {
    return createOccurrenceEvidence(lineOffsetMatch[1], {
      ...details,
      line: Number(lineOffsetMatch[2]),
      offset: Number(lineOffsetMatch[3]),
    });
  }
  const lineMatch = normalizedLocation.match(/^(.*):(\d+)$/);
  if (lineMatch) {
    return createOccurrenceEvidence(lineMatch[1], {
      ...details,
      line: Number(lineMatch[2]),
    });
  }
  return createOccurrenceEvidence(normalizedLocation, details);
}

/**
 * Format an occurrence evidence object back into a location string.
 *
 * @param {Object} occurrence Occurrence evidence object with location, and optional line/offset
 * @returns {string} Location string in `file:line:offset`, `file#line`, or plain `file` form; empty when no location
 */
export function formatOccurrenceEvidence(occurrence) {
  if (!occurrence?.location) {
    return "";
  }
  if (typeof occurrence.line === "number") {
    if (typeof occurrence.offset === "number") {
      return `${occurrence.location}:${occurrence.line}:${occurrence.offset}`;
    }
    return `${occurrence.location}#${occurrence.line}`;
  }
  return occurrence.location;
}

/**
 * Collect bom-refs from metadata.tools entries.
 *
 * @param {Object[]|Object} tools CycloneDX metadata.tools section
 * @param {Function} predicate Optional filter function
 * @returns {string[]} Unique tool bom-refs
 */
export function extractToolRefs(tools, predicate) {
  if (!tools) {
    return [];
  }
  const toolRefs = new Set();
  const toolList = Array.isArray(tools)
    ? tools
    : [...(tools.components || []), ...(tools.services || [])];
  for (const tool of toolList) {
    let toolRef = tool?.["bom-ref"];
    if (!toolRef && tool?.purl) {
      toolRef = decodeURIComponent(tool.purl);
    }
    if (!toolRef && tool?.name) {
      try {
        toolRef = build({
          type: "generic",
          namespace:
            tool.group ||
            tool.publisher ||
            tool.manufacturer?.name ||
            undefined ||
            null,
          name: tool.name,
          version: tool.version || undefined || null,
        });
      } catch (_err) {
        thoughtLog("Unable to derive bom-ref for external tool", {
          group: tool.group,
          manufacturer: tool.manufacturer?.name,
          name: tool.name,
          publisher: tool.publisher,
          version: tool.version,
        });
        toolRef = undefined;
      }
    }
    if (!toolRef) {
      continue;
    }
    if (!tool["bom-ref"]) {
      tool["bom-ref"] = toolRef;
    }
    if (predicate && !predicate(tool)) {
      continue;
    }
    toolRefs.add(toolRef);
  }
  return Array.from(toolRefs);
}

/**
 * Attach evidence.identity.tools references to the supplied subjects.
 *
 * @param {Object|Object[]} subjects Component or service objects
 * @param {string[]} toolRefs Tool bom-refs
 * @returns {Object|Object[]} The same mutated subject(s)
 */
export function attachIdentityTools(subjects, toolRefs) {
  if (!subjects || !toolRefs?.length) {
    return subjects;
  }
  const uniqueToolRefs = Array.from(new Set(toolRefs.filter(Boolean)));
  if (!uniqueToolRefs.length) {
    return subjects;
  }
  const subjectList = Array.isArray(subjects) ? subjects : [subjects];
  for (const subject of subjectList) {
    const identities = Array.isArray(subject?.evidence?.identity)
      ? subject.evidence.identity
      : subject?.evidence?.identity
        ? [subject.evidence.identity]
        : [];
    for (const identity of identities) {
      identity.tools = Array.from(
        new Set([...(identity.tools || []), ...uniqueToolRefs]),
      );
    }
  }
  return subjects;
}

function addDotnetIdentityMethod(apkg, value) {
  if (!value) {
    return;
  }
  apkg.evidence = apkg.evidence || {};
  const identityList = Array.isArray(apkg.evidence.identity)
    ? apkg.evidence.identity
    : undefined;
  let identity = identityList
    ? identityList.find((entry) => entry?.field === "purl") ||
      identityList.find((entry) => !entry?.field)
    : apkg.evidence.identity;
  if (!identity) {
    identity = { field: "purl", confidence: 1, methods: [] };
    if (identityList) {
      identityList.push(identity);
    }
  }
  identity.field ??= "purl";
  identity.confidence ??= 1;
  identity.methods ??= [];
  if (
    !identity.methods.some(
      (method) =>
        method.technique === "source-code-analysis" && method.value === value,
    )
  ) {
    identity.methods.push({
      technique: "source-code-analysis",
      confidence: 1,
      value,
    });
  }
  apkg.evidence.identity = identityList || identity;
}

/**
 * Enrich .NET package components with occurrence evidence and imported module/method
 * information from a dosai dependency slices file.
 *
 * Each dosai record names its package by purl, resolved in the project of the
 * record's file, and is attached to the component of that version (see
 * {@link resolveDosaiComponentPurl}). The DLL files of each package
 * (`internal:PackageFiles`) only fill in for a record whose purl names no
 * component, and only when the DLL belongs to one component or the record's
 * location says which: two versions of a package ship the same DLL names.
 *
 * The fallback is needed because dosai names a `System.*` assembly it cannot
 * map to a package with a framework purl (`pkg:nuget/System.Runtime`), as it
 * does whenever the tree has lock files but no restore output: the DLL of
 * System.Data.SQLite.Core is still the package's. A DLL that only a package's
 * build-time folders carry is not listed in `internal:PackageFiles`, so it
 * credits no package with the project's framework calls (issue 4441).
 *
 * @param {Object[]} pkgList Array of .NET package component objects to enrich
 * @param {string} slicesFile Path to the dosai dependency slices JSON file
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed, which its relative locations
 *        and the components' relative manifest paths are relative to
 * @returns {Object[]} The enriched package list (same array, mutated in place)
 */
export function addEvidenceForDotnet(pkgList, slicesFile, options = {}) {
  // We need two datastructures.
  // dll to purl mapping from the pkgList
  // purl to occurrences list using the slicesFile
  if (!slicesFile || !safeExistsSync(slicesFile)) {
    return pkgList;
  }
  const pkgFilePurls = {};
  const purlLocationMap = {};
  const purlModulesMap = {};
  const purlMethodsMap = {};
  const purlReachabilityMap = {};
  const purlAliasMap = buildDosaiPurlAliasMap(pkgList, options);
  const componentPurls = new Set(pkgList.map((apkg) => apkg.purl));
  // A dosai purl that names a component of this list, resolved in the
  // record's project.
  const componentPurlFor = (purl, location) => {
    const resolved = resolveDosaiComponentPurl(purl, purlAliasMap, location);
    return componentPurls.has(resolved) ? resolved : undefined;
  };
  for (const apkg of pkgList) {
    if (apkg.properties && Array.isArray(apkg.properties)) {
      apkg.properties
        .filter((p) => p.name === "internal:PackageFiles")
        .forEach((aprop) => {
          if (aprop.value) {
            const tmpA = aprop.value.split(", ");
            if (tmpA?.length) {
              tmpA.forEach((dllFile) => {
                pkgFilePurls[dllFile] ??= new Set();
                pkgFilePurls[dllFile].add(apkg.purl);
              });
            }
          }
        });
    }
  }
  // The component a DLL belongs to: its only package, else the candidate of the
  // record's project.
  const purlForDll = (dllFile, location) =>
    pkgFilePurls[dllFile]
      ? pickDosaiComponentByLocation(
          pkgFilePurls[dllFile],
          purlAliasMap,
          location,
        )
      : undefined;
  // Only MethodCalls into a package .dll produce evidence below, so a report
  // too large to parse whole keeps just those.
  const slicesData = readDosaiMethodsReport(slicesFile, {
    keepMethodCall: (methodCall) =>
      Boolean(
        methodCall?.Purl ||
          (methodCall?.Module?.endsWith(".dll") &&
            pkgFilePurls[methodCall.Module]),
      ),
  });
  if (!slicesData) {
    return pkgList;
  }
  if (slicesData && Object.keys(slicesData)) {
    thoughtLog(
      "Let's thoroughly inspect the dependency slice to identify where and how the components are used.",
    );
    if (slicesData.Dependencies) {
      for (const adep of slicesData.Dependencies) {
        const location = dosaiSourceLocation(adep);
        const resolvedPurl = adep.Purl
          ? componentPurlFor(adep.Purl, adep.Path)
          : undefined;
        if (resolvedPurl) {
          addDosaiSetValue(purlLocationMap, resolvedPurl, location);
          addDosaiSetValue(
            purlModulesMap,
            resolvedPurl,
            adep.Name || adep.Namespace,
          );
          continue;
        }
        // Case 1: Dependencies slice has the .dll file
        // Case 2: System packages where the .dll information is missing. In
        // this case, the dll file name is the name followed by dll.
        const moduleDll = adep.Module?.endsWith(".dll")
          ? adep.Module
          : adep?.Name &&
              (adep?.Namespace?.startsWith("System") ||
                adep?.Namespace?.startsWith("Microsoft"))
            ? `${adep.Name}.dll`
            : undefined;
        const modPurl = moduleDll && purlForDll(moduleDll, adep.Path);
        if (modPurl) {
          addDosaiSetValue(
            purlLocationMap,
            modPurl,
            `${adep.Path}#${adep.LineNumber}`,
          );
        }
      }
    }
    if (slicesData.PackageReachability) {
      const graphEdges = Object.fromEntries(
        (slicesData.CallGraph?.Edges || []).map((edge) => [edge.Id, edge]),
      );
      const graphNodes = Object.fromEntries(
        (slicesData.CallGraph?.Nodes || []).map((node) => [node.Id, node]),
      );
      // The first fact for a component wins, so a fact that names the
      // component's exact purl goes before one that reached it by name.
      const facts = [...slicesData.PackageReachability].sort(
        (a, b) =>
          Number(!componentPurls.has(a.Purl)) -
          Number(!componentPurls.has(b.Purl)),
      );
      for (const reachability of facts) {
        // A fact can span projects (a versionless purl from unrestored
        // projects), so each location is resolved in its own project, and the
        // fact applies to every component one of its locations reached.
        const factPurls = new Set();
        // Modules and methods of call-graph items that name no source file
        // (frames inside the package), held for the fact's own version.
        const unplaced = [];
        const resolveAt = (location) =>
          resolveDosaiComponentPurl(reachability.Purl, purlAliasMap, location);
        let hasExplicitSourceLocations = false;
        for (const sourceLocation of reachability.SourceLocations || []) {
          const location = dosaiSourceLocation(sourceLocation);
          const modPurl = resolveAt(location);
          addDosaiSetValue(purlLocationMap, modPurl, location);
          if (modPurl) {
            factPurls.add(modPurl);
          }
          hasExplicitSourceLocations ||= Boolean(location);
        }
        for (const edgeId of reachability.EdgeIds || []) {
          const edge = graphEdges[edgeId];
          const location = dosaiSourceLocation(edge);
          const modPurl = resolveAt(location ?? edge?.Path);
          const method = edge?.CalledMethodName || edge?.TargetName;
          if (!modPurl) {
            unplaced.push([purlMethodsMap, method]);
            continue;
          }
          factPurls.add(modPurl);
          if (!hasExplicitSourceLocations) {
            addDosaiSetValue(purlLocationMap, modPurl, location);
          }
          addDosaiSetValue(purlMethodsMap, modPurl, method);
        }
        for (const nodeId of reachability.NodeIds || []) {
          const node = graphNodes[nodeId];
          const location = dosaiSourceLocationFromNode(node);
          const modPurl = resolveAt(location);
          const module = node?.ClassName || node?.Module;
          const method = node?.Name || node?.Identity?.MethodName;
          if (!modPurl) {
            unplaced.push([purlModulesMap, module], [purlMethodsMap, method]);
            continue;
          }
          factPurls.add(modPurl);
          if (!hasExplicitSourceLocations) {
            addDosaiSetValue(purlLocationMap, modPurl, location);
          }
          addDosaiSetValue(purlModulesMap, modPurl, module);
          addDosaiSetValue(purlMethodsMap, modPurl, method);
        }
        if (!factPurls.size) {
          const modPurl = resolveAt(undefined);
          if (modPurl) {
            factPurls.add(modPurl);
          }
        }
        if (factPurls.size === 1) {
          const [modPurl] = factPurls;
          for (const [map, value] of unplaced) {
            addDosaiSetValue(map, modPurl, value);
          }
        }
        // Confidence/evidence facts for this purl, applied to the component below so an
        // unbuilt tree stays distinguishable from an only-imported package.
        for (const modPurl of factPurls) {
          purlReachabilityMap[modPurl] ??= reachability;
        }
      }
    }
    if (slicesData.MethodCalls) {
      for (const amethodCall of slicesData.MethodCalls) {
        // dosai's purl is resolved in the caller's project; the DLL name is the
        // same for every version of the package, and fills in for a purl that
        // names no component, such as the framework purl dosai gives a
        // System.* assembly it cannot map to a package.
        const modPurl =
          (amethodCall.Purl
            ? componentPurlFor(amethodCall.Purl, amethodCall.Path)
            : undefined) ||
          (amethodCall.Module?.endsWith(".dll")
            ? purlForDll(amethodCall.Module, amethodCall.Path)
            : undefined);
        if (!modPurl) {
          continue;
        }
        addDosaiSetValue(
          purlLocationMap,
          modPurl,
          dosaiCallSiteLocation(amethodCall, options.srcPath),
        );
        addDosaiSetValue(purlModulesMap, modPurl, amethodCall.ClassName);
        addDosaiSetValue(purlMethodsMap, modPurl, amethodCall.CalledMethod);
      }
    }
    // AssemblyInformation used to fill in a missing version by assembly name.
    // An assembly version is not the package version (Newtonsoft.Json 13.0.3
    // ships assembly 13.0.0.0), the purl and bom-ref kept no version, and the
    // last same-named assembly won, so the component described two packages.
  }
  if (Object.keys(purlLocationMap).length) {
    for (const apkg of pkgList) {
      if (purlLocationMap[apkg.purl]) {
        const locationOccurrences = Array.from(
          purlLocationMap[apkg.purl],
        ).sort();
        // Add the occurrences evidence
        apkg.evidence = apkg.evidence || {};
        apkg.evidence.occurrences = locationOccurrences.map((l) =>
          parseOccurrenceEvidenceLocation(l),
        );
        addDotnetIdentityMethod(apkg, locationOccurrences[0]);
        // Set the package scope
        apkg.scope = "required";
      }
      // Add the imported modules to properties
      if (purlModulesMap[apkg.purl]) {
        apkg.properties = apkg.properties || [];
        apkg.properties.push({
          name: "internal:ImportedModules",
          value: Array.from(purlModulesMap[apkg.purl]).sort().join(", "),
        });
      }
      // Add the called methods to properties
      if (purlMethodsMap[apkg.purl]) {
        apkg.properties = apkg.properties || [];
        apkg.properties.push({
          name: "internal:CalledMethods",
          value: Array.from(purlMethodsMap[apkg.purl]).sort().join(", "),
        });
      }
    }
  } else if (slicesData?.Dependencies || slicesData?.MethodCalls) {
    thoughtLog(
      "I didn't find any occurrence evidence or detailed imported modules, even though there is good dependency slice data from dosai. This is surprising.",
    );
  }
  // Reachability confidence facts (kind, confidence, evidence, reasons) as properties.
  // Applied outside the location guard: a Low-confidence unbuilt tree must stay
  // distinguishable from an only-imported package even when no locations were found.
  for (const apkg of pkgList) {
    if (purlReachabilityMap[apkg.purl]) {
      addDosaiReachabilityProperties(apkg, purlReachabilityMap[apkg.purl]);
    }
  }
  return pkgList;
}

/**
 * Convert OS query results
 *
 * @param {string} queryCategory Query category
 * @param {Object} queryObj Query Object from the queries.json configuration
 * @param {Array} results Query Results
 * @param {Boolean} enhance Optionally enhance results by invoking additional package manager commands
 */
export function convertOSQueryResults(
  queryCategory,
  queryObj,
  results,
  enhance = false,
  osPackageListers = undefined,
) {
  if (queryCategory === "ai_agent_skills") {
    return convertAgentSkillRows(results);
  }
  const pkgList = [];
  // deb, rpm, apk, pacman, Homebrew, MacPorts, snap and flatpak rows describe a
  // package, not a file or an app: the package manager names them, and nothing
  // in such a row is a path inside the package.
  const isOsPackage = isOsPackagePurlType(queryObj.purlType);
  const isLocatedPackage =
    LOCATED_PACKAGE_PURL_TYPES.has(queryObj.purlType) ||
    LOCATED_PACKAGE_CATEGORIES.has(queryCategory);
  if (results?.length) {
    for (const res of results) {
      let version = deriveOsQueryVersion(res);
      let name = deriveOsQueryName(res, results.length === 1, queryObj.name);
      if (queryObj.purlType === "chrome-extension") {
        // osquery computes identifier from the manifest key, which an
        // unpacked extension may lack; the profile still knows its ID.
        name = (
          res.identifier ||
          res.referenced_identifier ||
          res.extension_id ||
          name ||
          ""
        ).toLowerCase();
      }
      let npmScope;
      if (queryObj.purlType === "npm") {
        const scoped = /^@([^/]+)\/(.+)$/.exec(`${name || ""}`);
        if (scoped) {
          [, npmScope, name] = scoped;
        }
      }
      let group = "";
      const subpath =
        isOsPackage || isLocatedPackage
          ? undefined
          : res.path || res.admindir || res.source;
      const publisher = deriveOsQueryPublisher(res);
      if (queryObj.purlType === "vscode-extension") {
        // osquery names a VS Code extension by its ID, <publisher>.<name>,
        // which the vscode-extension type splits into namespace and name. Its
        // publisher column is the publisher's display name.
        const extensionId = /^([^.]+)\.(.+)$/u.exec(`${name || ""}`);
        if (extensionId) {
          [, group, name] = extensionId;
        } else if (publisher) {
          group = publisher.toLowerCase();
        }
      }
      let scope;
      const compScope = res.priority;
      if (["required", "optional", "excluded"].includes(compScope)) {
        scope = compScope;
      }
      const description =
        deriveOsQueryDescription(res) ||
        (queryObj.purlType === "chrome-extension" ? res.name || "" : "");
      let qualifiers;
      if (res.identifying_number?.length) {
        qualifiers = {
          tag_id: res.identifying_number.replace("{", "").replace("}", ""),
        };
      } else if (queryCategory === "firefox_addons" && res.identifier) {
        // The profile an add-on was found in is not part of its purl, so the
        // add-on ID is what tells apart two add-ons that share a name.
        qualifiers = { tag_id: firefoxAddonTagId(res.identifier) };
      } else if (queryObj.purlType === "vscode-extension") {
        // A platform-specific build is a different artefact from the one for
        // another platform, and the extension scan names it the same way.
        const targetPlatform = vscodeExtensionPlatformFromPath(res.path);
        if (targetPlatform) {
          qualifiers = { platform: targetPlatform };
        }
      }
      if (name) {
        name = sanitizeOsQueryIdentity(name);
        // sanitizeOsQueryIdentity drops a leading @, which an npm scope keeps.
        group = npmScope
          ? `@${sanitizeOsQueryIdentity(npmScope)}`
          : sanitizeOsQueryIdentity(group);
        const isCryptoAsset = queryObj.componentType === "cryptographic-asset";
        let purl;
        if (isOsPackage) {
          // The version of such a row is part of its identity: an rpm's is its
          // version and release, behind its epoch.
          const identity = createOsQueryPackageIdentity(
            queryObj.purlType,
            res,
            name,
          );
          version = identity.version;
          purl = shouldCreateOsQueryPurl(queryObj.componentType)
            ? identity.purl
            : undefined;
        } else if (shouldCreateOsQueryPurl(queryObj.componentType)) {
          purl = createOsQueryPurl(
            queryObj.purlType,
            group,
            name,
            version,
            qualifiers,
            subpath,
          );
        }
        const props = [{ name: "cdx:osquery:category", value: queryCategory }];
        props.push(...createLolbasProperties(queryCategory, res));
        if (platform() === "linux") {
          // The GTFOBins matcher reads a description for command names, and
          // the free text of a package's description matches by chance: zlib's
          // "the deflate compression method found in gzip" is no use of gzip.
          props.push(
            ...createGtfoBinsPropertiesFromRow(
              queryCategory,
              isOsPackage ? { ...res, description: undefined } : res,
            ),
          );
        }
        let providesList;
        if (enhance) {
          // `enhance` is an explicit opt-in and the listers are what it opts
          // into, so a caller that asks for it without supplying them has a
          // wiring bug. Fail loudly rather than silently emitting components
          // with no PkgProvides, which looks like a clean scan.
          if (!osPackageListers) {
            throw new Error(
              "convertOSQueryResults was called with enhance=true but no osPackageListers were injected.",
            );
          }
          const lister = osPackageListers[queryObj.purlType];
          if (typeof lister === "function") {
            providesList = lister(name);
          }
        }
        if (providesList) {
          props.push({
            name: "internal:PkgProvides",
            value: providesList.join(", "),
          });
        }
        const cryptoProperties = isCryptoAsset
          ? createOsQueryCryptoProperties(queryCategory, res, version)
          : undefined;
        const hashes = createOsQueryComponentHashes(res);
        const apkg = {
          name,
          group,
          version: version || "",
          description,
          publisher,
          // Without a purl, the bom-ref is built from the row, and the path of
          // a located package is not part of what it is.
          "bom-ref": createOsQueryBomRef(
            queryCategory,
            queryObj.componentType,
            isLocatedPackage ? { ...res, path: undefined } : res,
            name,
            version,
            purl,
          ),
          scope,
          type: queryObj.componentType,
        };
        // createOsQueryPurl returns null when the row cannot be expressed as a
        // valid purl (e.g. an OS package type on an unrecognised distro). Omit
        // the key entirely rather than emitting `"purl": null`, which is not a
        // valid CycloneDX component.
        if (purl) {
          apkg.purl = purl;
        }
        if (hashes?.length) {
          apkg.hashes = hashes;
        }
        if (cryptoProperties) {
          apkg.cryptoProperties = cryptoProperties;
        }
        const licenseColumns = isOsPackage
          ? OS_PACKAGE_LICENSE_COLUMNS[queryObj.purlType]
          : undefined;
        if (licenseColumns) {
          const licenses = osPackageLicenses(
            res[licenseColumns.license],
            licenseColumns.separator,
          );
          if (licenses.length) {
            apkg.licenses = licenses;
          }
          const website = licenseColumns.website
            ? osPackageWebsite(res[licenseColumns.website])
            : undefined;
          if (website) {
            apkg.externalReferences = [{ type: "website", url: website }];
          }
        }
        for (const k of Object.keys(res).filter((p) => {
          if (["version", "description", "publisher"].includes(p)) {
            return false;
          }
          return !(queryObj.purlType !== "chrome-extension" && p === "name");
        })) {
          const propertyName = isOsPackage
            ? osPackagePropertyName(queryObj.purlType, k)
            : k;
          // (none) is what rpm's database says for a tag a record lacks, such
          // as the source rpm of a key record.
          if (
            propertyName &&
            res[k] &&
            res[k] !== "null" &&
            !(isOsPackage && res[k] === "(none)")
          ) {
            props.push({
              name: propertyName,
              value: res[k],
            });
          }
        }
        if (isLocatedPackage) {
          // osquery writes a JSON null as "null", which is the path Firefox
          // gives its default theme.
          const occurrence = createOccurrenceEvidence(
            [res.path, res.directory].find(
              (value) => value && value !== "null",
            ),
          );
          if (occurrence) {
            apkg.evidence = { occurrences: [occurrence] };
          }
        }
        apkg.properties = props;
        pkgList.push(apkg);
      }
    }
  }
  return isLocatedPackage ? mergeLocatedPackages(pkgList) : pkgList;
}

// npm and pypi rows name a package found at a path on the host, Chromium and
// VS Code extension rows an extension found in a browser profile or an editor's
// extensions folder, and a firefox_addons row an add-on found in a Firefox
// profile. Where it was found is not part of what it is, so the path is an
// occurrence rather than a subpath: a home directory stays out of the purl, and
// one package installed in two places is one component with two occurrences.
// Chocolatey rows carry the absolute path of the package's .nuspec, which a
// purl subpath cannot hold, so it is kept as an occurrence like these.
const LOCATED_PACKAGE_PURL_TYPES = new Set([
  "npm",
  "pypi",
  "chrome-extension",
  "vscode-extension",
  "chocolatey",
]);
const LOCATED_PACKAGE_CATEGORIES = new Set(["firefox_addons"]);

const FIREFOX_ADDON_GUID =
  /^\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}$/iu;

// A Firefox add-on ID is an email-like string or a GUID in braces. A swid
// tag_id that is a GUID must be in lower case, and is written without braces.
function firefoxAddonTagId(identifier) {
  const id = `${identifier}`.trim();
  const guid = FIREFOX_ADDON_GUID.exec(id);
  return guid ? guid[1].toLowerCase() : id;
}

function mergeLocatedPackages(components) {
  const byRef = new Map();
  for (const component of components) {
    const existing = byRef.get(component["bom-ref"]);
    if (!existing) {
      byRef.set(component["bom-ref"], component);
      continue;
    }
    const occurrences = existing.evidence?.occurrences || [];
    for (const occurrence of component.evidence?.occurrences || []) {
      if (
        !occurrences.some((known) => known.location === occurrence.location)
      ) {
        occurrences.push(occurrence);
      }
    }
    if (occurrences.length) {
      existing.evidence = { ...existing.evidence, occurrences };
    }
    for (const property of component.properties) {
      if (
        !existing.properties.some(
          (known) =>
            known.name === property.name && known.value === property.value,
        )
      ) {
        existing.properties.push(property);
      }
    }
  }
  for (const component of byRef.values()) {
    component.evidence?.occurrences?.sort((a, b) =>
      a.location.localeCompare(b.location),
    );
  }
  return [...byRef.values()];
}

// The licence an OS package declares. An apk `L:` field is a list of SPDX ids
// separated by spaces on older packages and an SPDX expression on newer ones;
// pacman keeps one licence per entry, each an SPDX id or expression, which
// osquery joins with commas; a snap or a flatpak declares one expression. Only
// an explicit operator or a parenthesis makes a text an expression: the SPDX
// parser's own check takes the `or` inside `LGPL-2.0-or-later` for an operator,
// and would turn a plain list into one expression. A token is an id only when
// the SPDX list has what it maps to; any other is kept by name rather than
// dropped.
const MAX_OS_PACKAGE_LICENSES = 64;
const SPDX_OPERATORS = new Set(["AND", "OR", "WITH"]);

function isExplicitSpdxExpression(text) {
  // No SPDX expression holds a comma, but the expression parser lets one
  // through, which would take a whole pacman licence list for one expression.
  return (
    !text.includes(",") &&
    (text.split(/\s+/u).some((token) => SPDX_OPERATORS.has(token)) ||
      text.includes("(")) &&
    isSpdxLicenseExpression(text)
  );
}

function osPackageLicenses(text, separator) {
  const license = `${text ?? ""}`.split(/\s+/u).filter(Boolean).join(" ");
  if (!license) {
    return [];
  }
  if (isExplicitSpdxExpression(license)) {
    return [{ expression: license }];
  }
  const entries = [];
  const items = separator ? license.split(separator) : [license];
  for (const item of items.slice(0, MAX_OS_PACKAGE_LICENSES)) {
    const entry = item.trim();
    if (!entry || SPDX_OPERATORS.has(entry)) {
      continue;
    }
    if (isExplicitSpdxExpression(entry)) {
      entries.push({ expression: entry });
      continue;
    }
    const id = findLicenseId(entry);
    entries.push(
      spdxLicenses.includes(id)
        ? { license: { id } }
        : { license: { name: entry } },
    );
  }
  // A list that holds an expression must become one expression, since a
  // component's licenses are either licences or a single expression. Every
  // entry applies, so they are joined with AND.
  if (entries.length > 1 && entries.some((entry) => entry.expression)) {
    const parts = entries.map((entry) =>
      entry.expression ? `(${entry.expression})` : entry.license.id,
    );
    const expression = parts.join(" AND ");
    if (parts.every(Boolean) && isSpdxLicenseExpression(expression)) {
      return [{ expression }];
    }
  }
  return adjustLicenseInformation(entries);
}

// The home page of a package. A URL a package carries is untrusted text: only
// an http(s) URL is kept, without credentials, query or fragment.
function osPackageWebsite(value) {
  const cleaned = sanitizeBomUrl(`${value ?? ""}`.trim());
  try {
    const { protocol } = new URL(cleaned);
    return protocol === "http:" || protocol === "https:" ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert the packages of an apk installed database into components.
 *
 * The packages are named as the container scan names an Alpine, Wolfi or
 * Chainguard package, and grouped with the other OS package categories under
 * `cdx:osquery:category` = `apk_packages`. Beyond what an osquery package row
 * gives, an apk record knows its licence and home page, which become
 * `licenses` and a `website` external reference.
 *
 * @param {Object[]} packages Packages from readApkInstalledDb()
 * @returns {Object[]} Components
 */
export function convertApkPackages(packages) {
  const components = [];
  for (const pkg of packages || []) {
    const row = { name: pkg.name, version: pkg.version };
    for (const column of ["arch", "origin", "maintainer"]) {
      if (pkg[column]) {
        row[column] = pkg[column];
      }
    }
    const [component] = convertOSQueryResults(
      "apk_packages",
      { purlType: "apk" },
      [row],
    );
    if (!component) {
      continue;
    }
    // The description is set here and not in the row. The GTFOBins matcher reads
    // a row's description for command names, which a deb or rpm row has no
    // column for, and the free text of an apk description matches by chance:
    // "Alpine base dir structure" is no use of the alpine mail client.
    if (pkg.description) {
      component.description = pkg.description;
    }
    const licenses = osPackageLicenses(pkg.license, /\s+/u);
    if (licenses.length) {
      component.licenses = licenses;
    }
    const website = osPackageWebsite(pkg.url);
    if (website) {
      component.externalReferences = [{ type: "website", url: website }];
    }
    components.push(component);
  }
  return components;
}

// The frontmatter and osquery columns of a skill row that become properties,
// named as the ai-skill project scan names them where it has a name.
const AGENT_SKILL_PROPERTY_NAMES = [
  ["name", "cdx:skill:name"],
  ["description", "cdx:skill:description"],
  ["license", "cdx:skill:license"],
  ["compatibility", "cdx:skill:compatibility"],
  ["agent", "cdx:skill:agent"],
  ["scope", "cdx:skill:scope"],
  ["allowed_tools", "cdx:skill:allowedTools"],
  ["resource_count", "cdx:skill:resourceCount"],
  ["script_count", "cdx:skill:scriptCount"],
  ["username", "username"],
];
const SHA256_HEX = /^[0-9a-f]{64}$/u;

// A skill's licence is free text ("Complete terms in LICENSE.txt"), so it
// becomes `licenses` only when it is an SPDX id or expression.
function agentSkillLicenses(text) {
  const license = `${text ?? ""}`.trim();
  if (!license) {
    return [];
  }
  if (isExplicitSpdxExpression(license)) {
    return [{ expression: license }];
  }
  const id = findLicenseId(license);
  return spdxLicenses.includes(id) ? [{ license: { id } }] : [];
}

/**
 * Convert the rows of the `ai_agent_skills` query into components.
 *
 * A skill installed on the host is what the `ai-skill` project scan finds in a
 * repository, so it is a `file` component with the same `cdx:file:kind` and
 * `cdx:skill:*` properties, and no purl: a skill has no package identity. Its
 * bom-ref is the SHA-256 of its SKILL.md rather than the path, which is under a
 * home directory, and where it was found is an occurrence. The same skill
 * found under several roots, such as a plugin marketplace checkout and the
 * plugin cache, is one component with one occurrence for each.
 *
 * @param {Object[]} results Rows of `ai_agent_skills` joined with `hash`
 * @returns {Object[]} Components
 */
export function convertAgentSkillRows(results) {
  const components = [];
  for (const row of results || []) {
    const skillFile = `${row.path ?? ""}`;
    const directory = `${row.directory ?? ""}` || dirname(skillFile);
    // A SKILL.md whose frontmatter osquery cannot read has no name; the
    // project scan names such a skill after its directory too.
    const name = sanitizeOsQueryIdentity(row.name || basename(directory));
    if (!skillFile || !name) {
      continue;
    }
    const version = row.version || "";
    const sha256 = SHA256_HEX.test(`${row.sha256 ?? ""}`)
      ? row.sha256
      : undefined;
    const properties = [
      { name: "cdx:osquery:category", value: "ai_agent_skills" },
      { name: "cdx:file:kind", value: "skill-file" },
      { name: "cdx:agent:inventorySource", value: "osquery" },
    ];
    for (const [column, propertyName] of AGENT_SKILL_PROPERTY_NAMES) {
      const value = `${row[column] ?? ""}`.trim();
      if (value && value !== "null") {
        properties.push({ name: propertyName, value });
      }
    }
    if (Number(row.script_count) > 0) {
      properties.push({ name: "cdx:skill:hasScripts", value: "true" });
    }
    properties.push({
      name: "cdx:skill:specValid",
      value: isAgentSkillSpecValid(row) ? "true" : "false",
    });
    const component = {
      name,
      version,
      description: row.description || "",
      type: "file",
      "bom-ref": createOsQueryFallbackBomRef(
        "ai_agent_skills",
        "file",
        name,
        version,
        sha256 ? "sha256" : "scope",
        sha256 || `${row.agent || ""}/${row.scope || ""}`,
      ),
      properties,
    };
    if (sha256) {
      component.hashes = [{ alg: "SHA-256", content: sha256 }];
    }
    const licenses = agentSkillLicenses(row.license);
    if (licenses.length) {
      component.licenses = licenses;
    }
    const occurrence = createOccurrenceEvidence(skillFile);
    if (occurrence) {
      component.evidence = { occurrences: [occurrence] };
    }
    components.push(component);
  }
  return mergeLocatedPackages(components);
}
function createOsQueryCryptoProperties(queryCategory, res, version) {
  switch (queryCategory) {
    case "trusted_gpg_keys":
      return {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: {
          type: "public-key",
          id: res?.sha256 || version || res?.path || res?.name || "unknown",
          state: "active",
        },
      };
    case "kernel_keys":
      return {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: {
          type: "key",
          id:
            res?.serial_number ||
            version ||
            res?.description ||
            res?.name ||
            "unknown",
          state: res?.timeout === "expd" ? "deactivated" : "active",
        },
      };
    case "certificates":
    case "secureboot_certificates": {
      const certificateFileExtension = extname(res?.path || "")
        .replace(/^\./, "")
        .toLowerCase();
      const certificateFormat =
        queryCategory === "secureboot_certificates"
          ? "X.509"
          : deriveCertificateFormat(certificateFileExtension);
      return {
        assetType: "certificate",
        algorithmProperties: {
          executionEnvironment: "unknown",
          implementationPlatform: "unknown",
        },
        certificateProperties: {
          serialNumber: res?.serial || undefined,
          subjectName: res?.subject || res?.common_name || undefined,
          issuerName: res?.issuer || undefined,
          notValidBefore: normalizeCertificateDate(res?.not_valid_before),
          notValidAfter: normalizeCertificateDate(res?.not_valid_after),
          certificateFormat,
          certificateFileExtension: certificateFileExtension || undefined,
          fingerprint: res?.sha1
            ? { alg: "SHA-1", content: res.sha1 }
            : undefined,
        },
      };
    }
    default:
      return {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: {
          type: "unknown",
          id: version || res?.path || res?.name || "unknown",
        },
      };
  }
}

function createOsQueryComponentHashes(res) {
  const hashes = [];
  if (res?.md5) {
    hashes.push({ alg: "MD5", content: res.md5 });
  }
  if (res?.sha1) {
    hashes.push({ alg: "SHA-1", content: res.sha1 });
  }
  if (res?.sha256) {
    hashes.push({ alg: "SHA-256", content: res.sha256 });
  }
  return hashes.length ? hashes : undefined;
}

function createOsQueryBomRef(
  queryCategory,
  componentType,
  res,
  name,
  version,
  purl,
) {
  if (purl) {
    return decodeURIComponent(purl);
  }
  if (componentType === "cryptographic-asset") {
    return createOsQueryCryptoBomRef(queryCategory, res, name, version);
  }
  const identityEntry = [
    ["path", res?.path],
    ["key_file", res?.key_file],
    ["history_file", res?.history_file],
    ["fragment_path", res?.fragment_path],
    ["source_path", res?.source_path],
    ["source", res?.source],
    ["key", res?.key],
    ["label", res?.label],
    ["identifier", res?.identifier],
    ["uuid", res?.uuid],
    ["device_id", res?.device_id],
    ["sid", res?.sid],
    ["logon_id", res?.logon_id],
    ["pid", res?.pid],
    ["uid", res?.uid],
  ].find(
    ([, value]) =>
      value !== undefined && value !== null && String(value).length,
  );
  return createOsQueryFallbackBomRef(
    queryCategory,
    componentType,
    name,
    version,
    identityEntry?.[0],
    identityEntry?.[1],
  );
}

function createOsQueryCryptoBomRef(queryCategory, res, name, version) {
  const encodedName = encodeURIComponent(
    name || queryCategory || "crypto-asset",
  );
  switch (queryCategory) {
    case "trusted_gpg_keys":
      return `crypto/related-crypto-material/public-key/${encodedName}@sha256:${res?.sha256 || version || "unknown"}`;
    case "kernel_keys":
      return `crypto/related-crypto-material/key/${encodedName}@${version || res?.serial_number || "unknown"}`;
    case "certificates":
    case "secureboot_certificates":
      return `crypto/certificate/${encodedName}@${res?.sha256 ? `sha256:${res.sha256}` : version || "unknown"}`;
    default:
      return `crypto/related-crypto-material/unknown/${encodedName}@${version || "unknown"}`;
  }
}
function deriveCertificateFormat(certificateFileExtension) {
  switch ((certificateFileExtension || "").toLowerCase()) {
    case "pem":
      return "PEM";
    case "der":
      return "DER";
    case "cer":
    case "crt":
      return "X.509";
    default:
      return undefined;
  }
}

function normalizeCertificateDate(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const stringValue = `${value}`.trim();
  if (!stringValue) {
    return undefined;
  }
  const numericValue = Number(stringValue);
  if (Number.isFinite(numericValue)) {
    const millis = stringValue.length > 10 ? numericValue : numericValue * 1000;
    const parsedDate = new Date(millis);
    return Number.isNaN(parsedDate.getTime())
      ? undefined
      : parsedDate.toISOString();
  }
  const parsedDate = new Date(stringValue);
  return Number.isNaN(parsedDate.getTime())
    ? undefined
    : parsedDate.toISOString();
}
