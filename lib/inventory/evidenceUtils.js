import { platform } from "node:os";
import { extname } from "node:path";

import { build } from "@cdxgen/cdx-purl";

import { safeExistsSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
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
import {
  createOsQueryFallbackBomRef,
  createOsQueryPurl,
  deriveOsQueryDescription,
  deriveOsQueryName,
  deriveOsQueryPublisher,
  deriveOsQueryVersion,
  sanitizeOsQueryIdentity,
  shouldCreateOsQueryPurl,
} from "./osqueryTransform.js";

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
          dosaiCallSiteLocation(amethodCall),
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
  const pkgList = [];
  if (results?.length) {
    for (const res of results) {
      const version = deriveOsQueryVersion(res);
      let name = deriveOsQueryName(res, results.length === 1, queryObj.name);
      if (queryObj.purlType === "chrome-extension") {
        name = (res.identifier || res.extension_id || name || "").toLowerCase();
      }
      let group = "";
      const subpath = res.path || res.admindir || res.source;
      const publisher = deriveOsQueryPublisher(res);
      // For vscode-extension purl type, the publisher is used as the namespace
      if (queryObj.purlType === "vscode-extension" && publisher) {
        group = publisher.toLowerCase();
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
      }
      if (name) {
        name = sanitizeOsQueryIdentity(name);
        group = sanitizeOsQueryIdentity(group);
        const isCryptoAsset = queryObj.componentType === "cryptographic-asset";
        const purl = shouldCreateOsQueryPurl(queryObj.componentType)
          ? createOsQueryPurl(
              queryObj.purlType,
              group,
              name,
              version,
              qualifiers,
              subpath,
            )
          : undefined;
        const props = [{ name: "cdx:osquery:category", value: queryCategory }];
        props.push(...createLolbasProperties(queryCategory, res));
        if (platform() === "linux") {
          props.push(...createGtfoBinsPropertiesFromRow(queryCategory, res));
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
          "bom-ref": createOsQueryBomRef(
            queryCategory,
            queryObj.componentType,
            res,
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
        for (const k of Object.keys(res).filter((p) => {
          if (["version", "description", "publisher"].includes(p)) {
            return false;
          }
          return !(queryObj.purlType !== "chrome-extension" && p === "name");
        })) {
          if (res[k] && res[k] !== "null") {
            props.push({
              name: k,
              value: res[k],
            });
          }
        }
        apkg.properties = props;
        pkgList.push(apkg);
      }
    }
  }
  return pkgList;
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
