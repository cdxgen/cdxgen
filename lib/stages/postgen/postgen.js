import { readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import process from "node:process";

import { Purl } from "@cdxgen/cdx-purl";

import {
  DEBUG_MODE,
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
  resetActivityContext,
  setActivityContext,
} from "../../core/activity.js";
import { getRemediationCatalog } from "../../core/buildLedger.js";
import { hasAnyProjectType } from "../../core/env.js";
import {
  getTimestamp,
  getTmpDir,
  safeExistsSync,
  safeRmSync,
} from "../../core/fs.js";
import { thoughtLog } from "../../core/logger.js";
import { dirNameStr } from "../../core/paths.js";
import { sanitizeBomPropertyValue } from "../../core/propertySanitizer.js";
import { CDXGEN_TOOL_GROUP, CDXGEN_TOOL_NAME } from "../../core/state.js";
import {
  AI_INVENTORY_PROJECT_TYPES,
  matchesAiInventoryExcludeType,
  optionIncludesAiInventoryProjectType,
} from "../../inventory/aiInventory.js";
import {
  DEFAULT_CDX_SPEC_VERSION,
  normalizeCycloneDxComponentTypeFilter,
  normalizeCycloneDxSpecVersion,
} from "../../inventory/bomUtils.js";
import {
  attachCitations,
  buildInventoryCitation,
  createCitation,
  findCdxgenToolBomRef,
} from "../../inventory/citations.js";
import { mergeDependencies, mergeServices } from "../../inventory/depsUtils.js";
import { addFormulationSection } from "../../inventory/formulationParsers.js";
import { getContainerFileInventoryStats } from "../../inventory/inventoryStats.js";
import { enhanceBom } from "../../inventory/licenseEnhancer.js";
import { applyMcpPinningState } from "../../inventory/mcpPinning.js";
import { buildReleaseNotesFromGit } from "../../inventory/source.js";
import { extractTags, findBomType, textualMetadata } from "./annotator.js";
import {
  applyFormulationRunIdMarker,
  applyIntrospectionToBom,
  hasIntrospectionVerdict,
} from "./introspection/annotate.js";
import { collectCommandFacts } from "./introspection/commandFacts.js";
import {
  blockRemediationsForDryRun,
  emitIntrospectionReports,
  printIntrospectionSummary,
} from "./introspection/emit.js";
import {
  isIntrospectionEnabled,
  reflectOnRun,
} from "./introspection/reflect.js";
import { scoreReflection } from "./introspection/score.js";
import { repairParentDependencyEdge } from "./parentEdge.js";
import { sortBomCollections } from "./sortBom.js";
import {
  applyComponentTypeFilter,
  applySpecVersionCompatibility,
} from "./specVersionCompat.js";

/**
 * Convert directories to relative dir format carefully avoiding arbitrary relativization for unrelated directories.
 *
 * @param d Directory to convert
 * @param options CLI options
 *
 * @returns {string} Relative directory
 */
function relativeDir(d, options) {
  // Container images might have such directories
  if (/^\/(usr|lib|root|bin)/.test(d)) {
    return d;
  }
  const tmpDir = getTmpDir();
  if (d.startsWith(tmpDir)) {
    const rd = relative(tmpDir, d);
    return rd.includes("all-layers") ? rd.split("all-layers").pop() : rd;
  }
  const baseDir = options.filePath || process.cwd();
  if (safeExistsSync(baseDir)) {
    const rdir = relative(baseDir, d);
    return rdir.startsWith(join("..", "..")) ? d : rdir;
  }
  return d;
}

/**
 * Attach the CycloneDX formulation section to an already-built BOM JSON object.
 *
 * This is intentionally called once, from {@link postProcess}, so that the
 * formulation section is added exactly once regardless of how many per-language
 * `buildBomNSData` calls were made during BOM generation.
 *
 * @param {Object} bomJson       The assembled BOM JSON object (mutated in place).
 * @param {Object} options       CLI options.
 * @param {string} filePath      File path.
 * @param {Array}  [formulationList]  Optional language-specific formulation
 *                               data (e.g. from Pixi) carried on `bomNSData`.
 * @returns {Object} The same `bomJson` with `formulation` populated.
 */
function applyFormulation(bomJson, options, filePath, formulationList) {
  if (
    !options.includeFormulation ||
    options.specVersion < 1.5 ||
    !bomJson ||
    bomJson.formulation !== undefined
  ) {
    return bomJson;
  }
  const context = formulationList?.length ? { formulationList } : {};
  context.executeOsQuery = options.executeOsQuery;
  setActivityContext({
    bomMutation: "formulation",
    capability: "bom-mutation",
    projectType: "Formulation",
    sourcePath: filePath || options.filePath || process.cwd(),
  });
  let formulationData;
  try {
    formulationData = addFormulationSection(filePath, options, context);
  } finally {
    resetActivityContext();
  }
  if (!formulationData) {
    return bomJson;
  }
  bomJson.formulation = formulationData.formulation;
  const formulationServices = formulationData.formulation.flatMap(
    (entry) => entry?.services || [],
  );
  if (formulationServices.length) {
    bomJson.services = mergeServices(
      bomJson.services || [],
      formulationServices,
    );
  }
  if (formulationData.dependencies?.length) {
    bomJson.dependencies = mergeDependencies(
      bomJson.dependencies || [],
      formulationData.dependencies,
    );
  }
  return bomJson;
}

const WEAK_TLP_CLASSIFICATIONS = new Set(["CLEAR", "GREEN", "AMBER"]);
const SENSITIVE_PROPERTY_NAMES = new Set([
  "cdx:agent:description",
  "cdx:agent:hiddenMcpUrls",
  "cdx:agent:permission",
  "cdx:mcp:command",
  "cdx:mcp:configuredEndpoints",
  "cdx:mcp:description",
  "cdx:mcp:resourceUri",
  "cdx:skill:metadata",
]);
const SENSITIVE_PROPERTY_PREFIXES = ["cdx:crewai:", "cdx:mcp:auth:"];
const SECRET_ASSIGNMENT_PATTERN =
  /(?:^|[\s,{\[])(?:authorization|password|passwd|pwd|token|access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret|session(?:id)?|cookie)\s*(?:[:=]|=>)\s*["'`]?[^"'`\s,}\]]{4,}/iu;
const ENV_SECRET_PATTERN =
  /\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CLIENT_SECRET|SESSION|COOKIE)[A-Z0-9_]*=\S+/u;
const AUTH_HEADER_PATTERN =
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu;
const BEARER_TOKEN_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/u;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;
const SIGNED_URL_PARAM_NAMES = new Set([
  "access_token",
  "api_key",
  "client_secret",
  "id_token",
  "signature",
  "sig",
  "token",
  "x-amz-signature",
  "x-goog-signature",
]);

function normalizeTlpClassification(tlpClassification) {
  return String(tlpClassification || "")
    .trim()
    .toUpperCase();
}

function hasSensitivePropertyName(propertyName) {
  if (SENSITIVE_PROPERTY_NAMES.has(propertyName)) {
    return true;
  }
  return SENSITIVE_PROPERTY_PREFIXES.some((prefix) =>
    propertyName.startsWith(prefix),
  );
}

function extractUrlCandidates(value) {
  return Array.from(value.matchAll(/https?:\/\/[^\s]+/gu), (match) =>
    match[0].replace(/[),.;]+$/u, ""),
  );
}

function hasSensitiveUrlValue(value) {
  for (const candidate of extractUrlCandidates(value)) {
    if (!URL.canParse(candidate)) {
      continue;
    }
    const parsedUrl = new URL(candidate);
    if (parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
      return true;
    }
    for (const [paramName] of parsedUrl.searchParams) {
      if (SIGNED_URL_PARAM_NAMES.has(paramName.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function hasKnownSensitiveText(value) {
  return (
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    ENV_SECRET_PATTERN.test(value) ||
    AUTH_HEADER_PATTERN.test(value) ||
    BEARER_TOKEN_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value)
  );
}

function propertyContainsSensitiveValue(propertyName, propertyValue) {
  if (!hasSensitivePropertyName(propertyName) || !propertyValue?.trim()) {
    return false;
  }
  return (
    hasSensitiveUrlValue(propertyValue) || hasKnownSensitiveText(propertyValue)
  );
}

function collectSensitivePropertyViolations(
  subject,
  violations = [],
  location = "bom",
  seen = new Set(),
) {
  if (!subject || typeof subject !== "object" || seen.has(subject)) {
    return violations;
  }
  seen.add(subject);
  if (Array.isArray(subject.properties)) {
    const subjectLabel = subject["bom-ref"] || subject.name || location;
    for (const property of subject.properties) {
      if (
        typeof property?.name === "string" &&
        typeof property?.value === "string" &&
        propertyContainsSensitiveValue(property.name, property.value)
      ) {
        violations.push({
          propertyName: property.name,
          subjectLabel,
        });
      }
    }
  }
  if (Array.isArray(subject)) {
    subject.forEach((entry, index) => {
      collectSensitivePropertyViolations(
        entry,
        violations,
        `${location}[${index}]`,
        seen,
      );
    });
    return violations;
  }
  for (const [key, value] of Object.entries(subject)) {
    if (key === "properties") {
      continue;
    }
    collectSensitivePropertyViolations(
      value,
      violations,
      `${location}.${key}`,
      seen,
    );
  }
  return violations;
}

function validateTlpClassification(bomJson, options) {
  const specVersion =
    normalizeCycloneDxSpecVersion(
      bomJson?.specVersion || options?.specVersion,
    ) || 0;
  if (specVersion < 1.7) {
    return bomJson;
  }
  const tlpClassification = normalizeTlpClassification(
    bomJson?.metadata?.distributionConstraints?.tlp ||
      bomJson?.metadata?.distribution ||
      options?.tlpClassification,
  );
  if (!WEAK_TLP_CLASSIFICATIONS.has(tlpClassification)) {
    return bomJson;
  }
  const violations = collectSensitivePropertyViolations(bomJson);
  if (!violations.length) {
    return bomJson;
  }
  const uniqueViolations = [
    ...new Set(
      violations.map(
        ({ propertyName, subjectLabel }) =>
          `${propertyName} on ${subjectLabel}`,
      ),
    ),
  ];
  const errorMessage =
    `CycloneDX 1.7+ BOMs with TLP classification '${tlpClassification}' must not include known sensitive property values. ` +
    "Redact the values or raise the TLP classification to AMBER_AND_STRICT or RED. " +
    `Found: ${uniqueViolations.slice(0, 5).join("; ")}${uniqueViolations.length > 5 ? `; and ${uniqueViolations.length - 5} more` : ""}`;
  if (options?.failOnError) {
    throw new Error(errorMessage);
  }
  console.warn(errorMessage);
  return bomJson;
}

function applyContainerInventoryMetadata(bomJson) {
  if (!bomJson?.metadata) {
    return bomJson;
  }
  const { unpackagedExecutableCount, unpackagedSharedLibraryCount } =
    getContainerFileInventoryStats(bomJson.components);
  const metadataProperties = Array.isArray(bomJson.metadata.properties)
    ? [...bomJson.metadata.properties]
    : [];
  const propertyNamesToReplace = new Set([
    "cdx:container:unpackagedExecutableCount",
    "cdx:container:unpackagedSharedLibraryCount",
  ]);
  const retainedProperties = metadataProperties.filter(
    (property) => !propertyNamesToReplace.has(property?.name),
  );
  if (
    unpackagedExecutableCount ||
    metadataProperties.some(
      (property) =>
        property?.name === "cdx:container:unpackagedExecutableCount",
    )
  ) {
    retainedProperties.push({
      name: "cdx:container:unpackagedExecutableCount",
      value: String(unpackagedExecutableCount),
    });
  }
  if (
    unpackagedSharedLibraryCount ||
    metadataProperties.some(
      (property) =>
        property?.name === "cdx:container:unpackagedSharedLibraryCount",
    )
  ) {
    retainedProperties.push({
      name: "cdx:container:unpackagedSharedLibraryCount",
      value: String(unpackagedSharedLibraryCount),
    });
  }
  if (retainedProperties.length) {
    bomJson.metadata.properties = retainedProperties;
  }
  return bomJson;
}

/**
 * Assemble CycloneDX 1.7 citations from the provenance that cdxgen already
 * holds. Citations are emitted only at spec version 1.7 and above; the
 * downgrade path strips them for older documents.
 *
 * Two honest attribution sources are wired here:
 *   - the component inventory is attributed to the cdxgen tool component, and
 *   - when `--bom-audit` produced findings, the audit properties are attributed
 *     to the cdxgen tool with a note naming the rule engine.
 *
 * Additional provenance (embedded SBOMs, TEA collections, MCP server artefacts)
 * is appended via the per-stage `bomNSData.citations` channel by collectors.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @param {Object} options CLI options
 * @param {Object[]} [extraCitations] Citations produced by per-stage collectors
 * @returns {Object} The mutated BOM
 */
function applyCitations(bomJson, options = {}, extraCitations = []) {
  if (!bomJson) {
    return bomJson;
  }
  const specVersion = options.specVersion || bomJson.specVersion;
  if (!specVersion || Number(specVersion) < 1.7) {
    return bomJson;
  }
  const citations = [];
  const inventoryCitation = buildInventoryCitation(bomJson);
  if (inventoryCitation) {
    citations.push(inventoryCitation);
  }
  const auditCitation = buildAuditFindingsCitation(bomJson);
  if (auditCitation) {
    citations.push(auditCitation);
  }
  for (const citation of Array.isArray(extraCitations) ? extraCitations : []) {
    if (citation) {
      citations.push(citation);
    }
  }
  return attachCitations(bomJson, citations, options);
}

/**
 * Build a citation for the `cdx:audit:*` properties emitted by the BOM audit
 * rule engine. The data source is cdxgen's own rule packs under data/rules.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {Object|null} A citation, or null when no audit properties are present
 */
function buildAuditFindingsCitation(bomJson) {
  const hasAuditProperties =
    Array.isArray(bomJson.components) &&
    bomJson.components.some(
      (component) =>
        Array.isArray(component?.properties) &&
        component.properties.some((property) =>
          property?.name?.startsWith("cdx:audit:"),
        ),
    );
  if (!hasAuditProperties) {
    return null;
  }
  const attributedTo = findCdxgenToolBomRef(bomJson);
  if (!attributedTo) {
    return null;
  }
  return createCitation({
    expressions: ["$.components[*].properties[?(@.name =~ /^cdx:audit:/)]"],
    attributedTo,
    note: "Audit findings attributed to the cdxgen BOM audit rule engine.",
  });
}

/**
 * Run the build-introspection reflection over the final BOM, score it, write
 * the reports, and carry the verdict inside the BOM as metadata properties and
 * annotations. Introspection is opt-in; when disabled this is a no-op, and
 * when enabled a reflection failure warns instead of failing the completed
 * BOM.
 *
 * The CI gate is decided here but enforced by the CLI after the BOM is
 * written, so a below-threshold score never costs the user their output.
 *
 * @param {Object} bomNSData BOM with namespaces object
 * @param {Object} options CLI options
 * @param {string} [filePath] Source path that was scanned
 *
 * @returns {Promise<Object>} The same bomNSData, with `reflection` (carrying its `scoring`) attached when introspection ran
 */
async function applyIntrospection(bomNSData, options, filePath) {
  if (!isIntrospectionEnabled(options) || !bomNSData?.bomJson) {
    return bomNSData;
  }
  // Evidence collection re-processes a finished BOM through a fresh wrapper,
  // but that pass carries neither the scanned path nor the generation's
  // ecosystem context: its ledger events belong to the evinse probes and its
  // marker scan finds nothing, so it would grade a project it never saw. The
  // verdict describes how the BOM was generated, so it stays with the pass
  // that generated it — the document itself is what carries that across.
  if (bomNSData.reflection || hasIntrospectionVerdict(bomNSData.bomJson)) {
    return bomNSData;
  }
  try {
    const reflection = await reflectOnRun(bomNSData.bomJson, options, {
      projectPath: filePath || options.filePath || "",
    });
    reflection.scoring = scoreReflection(reflection, getRemediationCatalog(), {
      secureMode: isSecureMode,
      inContainer: readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true",
      commandFacts: collectCommandFacts(filePath || options.filePath || ""),
    });
    // Report consumers correlate a report with the BOM it describes through
    // these two facts, so they travel on the reflection document itself.
    reflection.bom = {
      serialNumber: bomNSData.bomJson?.serialNumber,
      componentCount: Array.isArray(bomNSData.bomJson?.components)
        ? bomNSData.bomJson.components.length
        : 0,
    };
    bomNSData.reflection = reflection;
    if (isDryRun) {
      blockRemediationsForDryRun(reflection.scoring);
    }
    // A document at a spec version that predates annotations still carries
    // the metadata properties; only the annotations are version-gated.
    const annotationsSupported =
      normalizeCycloneDxSpecVersion(
        options?.specVersion || bomNSData.bomJson?.specVersion,
      ) >= 1.5;
    applyFormulationRunIdMarker(bomNSData.bomJson, reflection.runId);
    applyIntrospectionToBom(bomNSData.bomJson, reflection, reflection.scoring, {
      annotations: annotationsSupported,
    });
    const delivery = emitIntrospectionReports(
      reflection,
      reflection.scoring,
      options,
    );
    printIntrospectionSummary(reflection.scoring, delivery);
    const threshold = options?.introspectFailBelow;
    if (typeof threshold === "number" && Number.isFinite(threshold)) {
      const score = reflection.scoring.overallScore;
      bomNSData.introspectionGate = {
        threshold,
        score,
        passed: score >= threshold,
      };
    }
    if (!reflection.ledgerComplete) {
      console.warn(
        "Build introspection: the ledger is incomplete (buffer truncated or recorder event); treat the verdict with care and re-run with CDXGEN_INTROSPECT_LEDGER set.",
      );
    }
  } catch (err) {
    console.warn(
      `Build introspection failed to complete and was skipped: ${err?.message}`,
    );
  }
  return bomNSData;
}

/**
 * Filter and enhance BOM post generation.
 *
 * @param {Object} bomNSData BOM with namespaces object
 * @param {Object} options CLI options
 * @param {string} [filePath] Source path used for formulation and metadata context
 *
 * @returns {Promise<Object>} Modified bomNSData
 */
export async function postProcess(bomNSData, options, filePath) {
  let jsonPayload = bomNSData.bomJson;
  if (
    typeof bomNSData.bomJson === "string" ||
    bomNSData.bomJson instanceof String
  ) {
    jsonPayload = JSON.parse(bomNSData.bomJson);
  }

  bomNSData.bomJson = filterBom(jsonPayload, options);
  bomNSData.bomJson = applyStandards(bomNSData.bomJson, options);
  bomNSData.bomJson = applyMetadata(bomNSData.bomJson, options);
  bomNSData.bomJson = applyLicenseEnhancement(bomNSData.bomJson, options);
  bomNSData.bomJson = applyContainerInventoryMetadata(bomNSData.bomJson);
  const buildOnlyComponents = extractBuildOnlyComponents(
    bomNSData.bomJson,
    options,
  );
  bomNSData.bomJson = applyFormulation(
    bomNSData.bomJson,
    options,
    filePath,
    buildOnlyComponents.length
      ? [...(bomNSData.formulationList || []), ...buildOnlyComponents]
      : bomNSData.formulationList,
  );
  bomNSData.bomJson = applyBuildOnlyFormulation(
    bomNSData.bomJson,
    buildOnlyComponents,
  );
  bomNSData.bomJson = applyReleaseNotes(bomNSData.bomJson, options, filePath);
  bomNSData.bomJson = applyComponentTypeFilter(bomNSData.bomJson, options);
  // Filtering can leave the tree without a way in, so this runs on the final
  // component set and before annotations, which report on reachability.
  bomNSData.bomJson = repairParentDependencyEdge(bomNSData.bomJson);
  bomNSData.bomJson = applySpecVersionCompatibility(bomNSData.bomJson, options);
  bomNSData.bomJson = validateTlpClassification(bomNSData.bomJson, options);
  // Support for automatic annotations
  if (options.specVersion >= 1.6) {
    setActivityContext({
      bomMutation: "annotations",
      capability: "bom-mutation",
      projectType: "Annotations",
      sourcePath: filePath || options.filePath || process.cwd(),
    });
    try {
      bomNSData.bomJson = annotate(bomNSData.bomJson, options);
    } finally {
      resetActivityContext();
    }
  }
  // Experimental MCP server pinning/composition enrichment. Gated by an
  // off-by-default flag; returns citation hints that applyCitations merges in.
  const mcpPinningCitations = applyMcpPinningState(bomNSData.bomJson, options);
  // CycloneDX 1.7 citations record where each attributed assertion came from.
  // Attached after spec-version compatibility so a 1.6 downgrade never carries
  // a 1.7-only root element, and after annotations so audit findings can be cited.
  bomNSData.bomJson = applyCitations(bomNSData.bomJson, options, [
    ...(mcpPinningCitations || []),
    ...(bomNSData.citations || []),
  ]);
  cleanupEnv(options);
  cleanupTmpDir();
  sortBomCollections(bomNSData.bomJson);
  // Reflection reads the finished BOM, so it runs after sorting; it returns
  // its verdict alongside the BOM instead of mutating it.
  await applyIntrospection(bomNSData, options, filePath);
  return bomNSData;
}

function applyLicenseEnhancement(bomJson, options) {
  const licenseEnhance =
    options?.licenseEnhance !== false &&
    readEnvironmentVariable("CDXGEN_LICENSE_ENHANCE") !== "false";
  if (!licenseEnhance || !bomJson) {
    return bomJson;
  }
  const licensePolicy =
    options?.licensePolicy || readEnvironmentVariable("CDXGEN_LICENSE_POLICY");
  enhanceBom(bomJson, {
    licenseEnrich:
      options?.licenseEnrich !== false &&
      readEnvironmentVariable("CDXGEN_LICENSE_ENRICH") !== "false",
    licensePolicy,
    licenseRef:
      options?.licenseRef ||
      readEnvironmentVariable("CDXGEN_LICENSE_REF") === "true",
    specVersion: options?.specVersion || bomJson.specVersion,
  });
  // When a policy is supplied, surface any prohibited (error-level) licenses.
  // With --fail-on-error this aborts BOM generation; otherwise it warns.
  if (licensePolicy) {
    const violations = collectLicensePolicyViolations(bomJson);
    if (violations.length) {
      const shown = violations.slice(0, 5).join("; ");
      const errorMessage =
        `License policy violation: ${violations.length} component(s) use a prohibited license. ` +
        `Found: ${shown}${violations.length > 5 ? `; and ${violations.length - 5} more` : ""}`;
      if (options?.failOnError) {
        throw new Error(errorMessage);
      }
      console.warn(errorMessage);
    }
  }
  return bomJson;
}

/**
 * Collects the identifiers of components whose licenses violate the configured
 * policy, i.e. carry a `cdx:license:complianceAlert` property set to `error`.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string[]} Sorted, de-duplicated component identifiers
 */
function collectLicensePolicyViolations(bomJson) {
  const violations = new Set();
  const hasErrorAlert = (properties) =>
    Array.isArray(properties) &&
    properties.some(
      (p) => p.name === "cdx:license:complianceAlert" && p.value === "error",
    );
  const visit = (component) => {
    if (!component) {
      return;
    }
    if (hasErrorAlert(component.properties)) {
      violations.add(
        component.purl || component["bom-ref"] || component.name || "unknown",
      );
    }
    for (const sub of component.components || []) {
      visit(sub);
    }
  };
  visit(bomJson?.metadata?.component);
  for (const component of bomJson?.components || []) {
    visit(component);
  }
  return [...violations].sort();
}

function applyReleaseNotes(bomJson, options, filePath) {
  if (!options?.includeReleaseNotes) {
    return bomJson;
  }
  const specVersion = Number(options.specVersion || DEFAULT_CDX_SPEC_VERSION);
  if (specVersion < 1.6) {
    const errorMessage =
      "releaseNotes in metadata.tools.components requires CycloneDX spec version 1.6 or above.";
    if (options.failOnError) {
      throw new Error(errorMessage);
    }
    console.warn(errorMessage);
    return bomJson;
  }
  const toolComponents = bomJson?.metadata?.tools?.components;
  if (!Array.isArray(toolComponents) || !toolComponents.length) {
    return bomJson;
  }
  const cdxgenToolComponent = toolComponents.find(
    (comp) =>
      comp?.group === CDXGEN_TOOL_GROUP && comp?.name === CDXGEN_TOOL_NAME,
  );
  if (!cdxgenToolComponent) {
    return bomJson;
  }
  const releaseNotes = buildReleaseNotesFromGit(filePath, options);
  if (!releaseNotes) {
    const errorMessage =
      "Unable to compute release notes. Provide --release-notes-current-tag and optionally --release-notes-previous-tag.";
    if (options.failOnError) {
      throw new Error(errorMessage);
    }
    console.warn(errorMessage);
    return bomJson;
  }
  cdxgenToolComponent.releaseNotes = releaseNotes;
  return bomJson;
}

/**
 * Apply additional metadata based on components
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyMetadata(bomJson, options) {
  if (!bomJson?.components) {
    return applyCustomMetadataProperties(bomJson, options);
  }
  const bomPkgTypes = new Set();
  const bomPkgNamespaces = new Set();
  const bomSrcFiles = new Set();
  // Collect the manifests a component was identified from, rewriting any
  // absolute path to a relative one as a side effect. Shared by the components
  // and by metadata.component, which a collector such as the ruby one describes
  // from the project's own gemspec (discussion 4410).
  const collectSrcFiles = (comp) => {
    if (!comp) {
      return;
    }
    if (comp.properties) {
      for (const aprop of comp.properties) {
        if (aprop.name === "internal:SrcFile" && aprop.value) {
          const rdir = relativeDir(aprop.value, options);
          if (comp.type !== "file") {
            bomSrcFiles.add(rdir);
          }
          // Fix the filename to use relative directory
          if (rdir !== aprop.value) {
            aprop.value = rdir;
          }
        }
      }
    }
    if (comp?.evidence?.identity && Array.isArray(comp.evidence.identity)) {
      for (const aidentityEvidence of comp.evidence.identity) {
        if (aidentityEvidence.concludedValue) {
          const rdir = relativeDir(aidentityEvidence.concludedValue, options);
          if (comp.type !== "file") {
            bomSrcFiles.add(rdir);
          }
          if (rdir !== aidentityEvidence.concludedValue) {
            aidentityEvidence.concludedValue = rdir;
          }
        }
        if (
          aidentityEvidence.methods &&
          Array.isArray(aidentityEvidence.methods)
        ) {
          for (const amethod of aidentityEvidence.methods) {
            // `value` is optional: an attestation, for one, names no file.
            if (typeof amethod?.value !== "string") {
              continue;
            }
            const rdir = relativeDir(amethod.value, options);
            if (
              comp.type !== "file" &&
              ["manifest-analysis"].includes(amethod.technique) &&
              amethod.value
            ) {
              bomSrcFiles.add(rdir);
            }
            // Fix the filename to use relative directory
            if (rdir !== amethod.value) {
              amethod.value = rdir;
            }
          }
        }
      }
    }
  };
  for (const comp of bomJson.components) {
    if (comp.purl) {
      try {
        const purlObj = Purl.parse(comp.purl);
        if (purlObj?.type) {
          bomPkgTypes.add(purlObj.type);
        }
        if (purlObj?.namespace) {
          bomPkgNamespaces.add(purlObj.namespace);
        }
      } catch (_e) {
        // ignore
      }
    }
    collectSrcFiles(comp);
  }
  // The project's sub-components, the modules of a multi-module build, name
  // their manifests the same way, at any depth.
  const collectSrcFilesTree = (comp) => {
    collectSrcFiles(comp);
    for (const subComponent of comp?.components || []) {
      collectSrcFilesTree(subComponent);
    }
  };
  collectSrcFilesTree(bomJson.metadata?.component);
  if (!bomJson.metadata.properties) {
    bomJson.metadata.properties = [];
  }
  if (bomPkgTypes.size) {
    const componentTypesArray = Array.from(bomPkgTypes).sort();
    // Check if cdx:bom:componentTypes property already exists
    const existingTypesProperty = bomJson.metadata.properties.find(
      (p) => p.name === "cdx:bom:componentTypes",
    );
    if (!existingTypesProperty) {
      bomJson.metadata.properties.push({
        name: "cdx:bom:componentTypes",
        value: componentTypesArray.join("\\n"),
      });
    }
    if (componentTypesArray.length > 1) {
      thoughtLog(
        `BOM includes the ${componentTypesArray.length} component types: ${componentTypesArray.join(", ")}`,
      );
    }
  }
  if (bomPkgNamespaces.size) {
    // Check if cdx:bom:componentNamespaces property already exists
    const existingNamespacesProperty = bomJson.metadata.properties.find(
      (p) => p.name === "cdx:bom:componentNamespaces",
    );
    if (!existingNamespacesProperty) {
      bomJson.metadata.properties.push({
        name: "cdx:bom:componentNamespaces",
        value: Array.from(bomPkgNamespaces).sort().join("\\n"),
      });
    }
  }
  if (bomSrcFiles.size) {
    const bomSrcFilesArray = Array.from(bomSrcFiles).sort();
    // Check if cdx:bom:componentSrcFiles property already exists
    const existingSrcFilesProperty = bomJson.metadata.properties.find(
      (p) => p.name === "cdx:bom:componentSrcFiles",
    );
    if (!existingSrcFilesProperty) {
      bomJson.metadata.properties.push({
        name: "cdx:bom:componentSrcFiles",
        value: bomSrcFilesArray.join("\\n"),
      });
    }
    if (bomSrcFilesArray.length > 1 && bomSrcFilesArray.length < 5) {
      thoughtLog(
        `BOM includes information from ${bomSrcFilesArray.length} manifest files: ${bomSrcFilesArray.join(", ")}`,
      );
    }
  } else {
    if (!bomPkgTypes.has("oci")) {
      thoughtLog("BOM lacks package manifest details. Please help us improve!");
    }
  }
  return applyCustomMetadataProperties(bomJson, options);
}

/**
 * Add the metadata properties the user asked for on the command line, in the
 * environment, or in a config file (discussion 4391), after whatever the scan
 * itself discovered. They never replace a discovered property: the scan's own
 * names, such as `cdx:bom:componentSrcFiles`, keep their values. A BOM without
 * components still gets them.
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options, with `metadataProperties` as
 *   `[{name, value}]`
 *
 * @returns {Object} BOM JSON Object
 */
function applyCustomMetadataProperties(bomJson, options) {
  if (!bomJson?.metadata || !options?.metadataProperties?.length) {
    return bomJson;
  }
  bomJson.metadata.properties = bomJson.metadata.properties || [];
  for (const aprop of options.metadataProperties) {
    if (!aprop?.name?.length || aprop.value === undefined) {
      continue;
    }
    const value = sanitizeBomPropertyValue(aprop.name, `${aprop.value}`);
    if (!value?.length) {
      continue;
    }
    if (
      !bomJson.metadata.properties.some(
        (p) => p.name === aprop.name && p.value === value,
      )
    ) {
      bomJson.metadata.properties.push({ name: aprop.name, value });
    }
  }
  return bomJson;
}

/**
 * Apply definitions.standards based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyStandards(bomJson, options) {
  if (options.standard && Array.isArray(options.standard)) {
    for (let astandard of options.standard) {
      // See issue: #1953
      if (astandard.includes(sep)) {
        astandard = basename(astandard);
      }
      const templateFile = join(
        dirNameStr,
        "data",
        "templates",
        `${astandard}.cdx.json`,
      );
      if (safeExistsSync(templateFile)) {
        const templateData = JSON.parse(readFileSync(templateFile, "utf-8"));
        if (templateData?.metadata?.licenses) {
          if (!bomJson.metadata.licenses) {
            bomJson.metadata.licenses = [];
          }
          bomJson.metadata.licenses = bomJson.metadata.licenses.concat(
            templateData.metadata.licenses,
          );
        }
        if (templateData?.definitions?.standards) {
          if (!bomJson.definitions) {
            bomJson.definitions = { standards: [] };
          }
          bomJson.definitions.standards = bomJson.definitions.standards.concat(
            templateData.definitions.standards,
          );
        }
      }
    }
  }
  return bomJson;
}

/**
 * Method to normalize the identity field from a component's evidence block.
 *
 * In different versions of CycloneDX, the `identity` field can be either a single object or an array of objects.
 * This function ensures that the result is always an array for consistent processing.
 *
 * @param {Object} comp - The component object potentially containing evidence.identity.
 * @returns {Array} An array of identity objects (empty if none are present).
 */
function normalizeIdentities(comp) {
  const identity = comp?.evidence?.identity;
  if (Array.isArray(identity)) {
    return identity;
  }
  if (identity) {
    return [identity];
  }
  return [];
}

/**
 * Method to get the purl identity confidence.
 *
 * @param comp Component
 * @returns {undefined|number} Max of all the available purl identity confidence or undefined
 */
function getIdentityConfidence(comp) {
  if (!comp.evidence) {
    return undefined;
  }
  let confidence;
  for (const aidentity of normalizeIdentities(comp)) {
    if (aidentity?.field === "purl") {
      if (confidence === undefined) {
        confidence = aidentity.confidence || 0;
      } else {
        confidence = Math.max(aidentity.confidence, confidence);
      }
    }
  }
  return confidence;
}

/**
 * Method to get the list of techniques used for identity.
 *
 * @param comp Component
 * @returns {Set|undefined} Set of technique. evidence.identity.methods.technique
 */
function getIdentityTechniques(comp) {
  if (!comp.evidence) {
    return undefined;
  }
  const techniques = new Set();
  for (const aidentity of normalizeIdentities(comp)) {
    if (aidentity?.field === "purl") {
      for (const amethod of aidentity.methods || []) {
        techniques.add(amethod?.technique);
      }
    }
  }
  return techniques;
}

/**
 * Ensure the components moved out of the assembly have landed in the
 * formulation section.
 *
 * With `--include-formulation` they were handed to the full formulation pass.
 * Without it there is no formulation section, so a minimal one is created for
 * them alone: moving a component out of `components[]` and then dropping it
 * would lose it from the document.
 *
 * @param {Object} bomJson BOM JSON object
 * @param {Object[]} buildOnlyComponents Components removed from `components[]`
 *
 * @returns {Object} The same `bomJson`
 */
function applyBuildOnlyFormulation(bomJson, buildOnlyComponents) {
  if (!buildOnlyComponents?.length || !bomJson) {
    return bomJson;
  }
  const alreadyPlaced = (bomJson.formulation || []).some((formula) =>
    formula?.components?.some((comp) =>
      buildOnlyComponents.some((moved) => moved["bom-ref"] === comp["bom-ref"]),
    ),
  );
  if (alreadyPlaced) {
    return bomJson;
  }
  if (!bomJson.formulation) {
    bomJson.formulation = [];
  }
  bomJson.formulation.push({
    "bom-ref": `${bomJson.metadata?.component?.["bom-ref"] || "cdxgen"}#build-dependencies`,
    components: buildOnlyComponents,
  });
  return bomJson;
}

/**
 * Report whether a component exists only to produce the build, rather than
 * being part of the delivered assembly. A cargo build dependency and a
 * proc-macro crate are both marked with `cdx:cargo:hostOnly`.
 *
 * @param {Object} comp Component
 * @returns {boolean} True for a build-time-only component
 */
function isBuildOnlyComponent(comp) {
  return !!comp?.properties?.some(
    (property) =>
      property.name === "cdx:cargo:hostOnly" && property.value === "true",
  );
}

/**
 * Move the build-time-only components out of `components[]`, which describes
 * the delivered assembly, and hand them to the formulation section, which is
 * where CycloneDX describes how the assembly was produced.
 *
 * Their bom-refs stay valid because the formulation components live in the same
 * document, so the dependency graph is left intact. `formulation` exists from
 * CycloneDX 1.5, so an older document keeps them in `components[]` with their
 * `cdx:cargo:hostOnly` marker rather than losing them.
 *
 * @param {Object} bomJson BOM JSON object
 * @param {Object} options CLI options
 *
 * @returns {Object[]} The components removed from `components[]`
 */
export function extractBuildOnlyComponents(bomJson, options) {
  if (options?.specVersion < 1.5 || !bomJson?.components?.length) {
    return [];
  }
  const buildOnlyComponents = [];
  const retainedComponents = [];
  for (const comp of bomJson.components) {
    if (isBuildOnlyComponent(comp)) {
      buildOnlyComponents.push(comp);
    } else {
      retainedComponents.push(comp);
    }
  }
  if (buildOnlyComponents.length) {
    bomJson.components = retainedComponents;
  }
  return buildOnlyComponents;
}

/**
 * Report whether a component carries evidence that it is actually used: an
 * occurrence in the analyzed sources, or a frame in a callstack.
 *
 * @param {Object} comp Component
 * @returns {boolean} True when usage evidence is attached
 */
function hasUsageEvidence(comp) {
  if (comp?.evidence?.occurrences?.length) {
    return true;
  }
  return !!comp?.evidence?.callstack?.frames?.length;
}

/**
 * Re-apply the `--required-only` filter once the evidence stage has attached
 * occurrence and callstack data.
 *
 * A manifest can only say that a dependency is optional; the evidence says
 * whether it is reached. A component the analyzers observed in the sources is
 * promoted to `required` so it survives the filter, while an optional component
 * with no observed usage is dropped as before. A component scoped `excluded` -
 * a dev or test dependency - keeps that scope: an occurrence inside the test
 * sources is not evidence that it ships.
 *
 * @param {Object} bomJson BOM JSON object carrying evidence
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyEvidenceBasedFilter(bomJson, options) {
  if (!options?.requiredOnly || !bomJson?.components?.length) {
    return bomJson;
  }
  if (!(options.evidence || options.includeCrypto)) {
    return bomJson;
  }
  for (const comp of bomJson.components) {
    if (!hasUsageEvidence(comp)) {
      continue;
    }
    if (!comp.properties) {
      comp.properties = [];
    }
    const observed = comp.evidence?.occurrences?.length
      ? "occurrence"
      : "callstack";
    if (
      !comp.properties.some(
        (property) => property.name === "cdx:evidence:usage",
      )
    ) {
      comp.properties.push({ name: "cdx:evidence:usage", value: observed });
    }
    if (comp.scope === "optional") {
      comp.scope = "required";
    }
  }
  // `evidenceFilterStage` tells filterBom that the evidence is in hand, so the
  // scope filter it deferred earlier must run now.
  return filterBom(bomJson, { ...options, evidenceFilterStage: true });
}

/**
 * Filter BOM based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function filterBom(bomJson, options) {
  const newPkgMap = {};
  const newServices = [];
  let filtered = false;
  let anyFiltered = false;
  if (!bomJson?.components) {
    return bomJson;
  }
  const allowedComponentTypes = new Set(
    normalizeCycloneDxComponentTypeFilter(options?.componentType),
  );
  // Evidence generation runs after this stage, so dropping the optional
  // components here would deny the analyzers the chance to prove that one is
  // used. The scope filter is re-applied by applyEvidenceBasedFilter once the
  // occurrence and callstack evidence is attached.
  const deferRequiredOnly = !!(
    options.requiredOnly &&
    !options.evidenceFilterStage &&
    (options.evidence || options.includeCrypto)
  );
  for (const comp of bomJson.components) {
    if (shouldExcludeInventoryType(comp, options)) {
      filtered = true;
      continue;
    }
    if (
      allowedComponentTypes.size &&
      (!comp.type || !allowedComponentTypes.has(comp.type))
    ) {
      filtered = true;
      continue;
    }
    // minimum confidence filter
    if (options?.minConfidence > 0) {
      const confidence = Math.min(options.minConfidence, 1);
      const identityConfidence = getIdentityConfidence(comp);
      if (identityConfidence !== undefined && identityConfidence < confidence) {
        filtered = true;
        continue;
      }
    }
    // identity technique filter
    if (options?.technique?.length && !options.technique.includes("auto")) {
      const allowedTechniques = new Set(
        Array.isArray(options.technique)
          ? options.technique
          : [options.technique],
      );
      const usedTechniques = getIdentityTechniques(comp);
      if (
        usedTechniques &&
        // `intersection` is a Set prototype method; there is no static
        // `Set.intersection`, so the old form threw whenever `--technique` was
        // passed with anything other than `auto`.
        usedTechniques.intersection(allowedTechniques).size === 0
      ) {
        filtered = true;
        continue;
      }
    }
    if (
      options.requiredOnly &&
      !deferRequiredOnly &&
      comp.scope &&
      ["optional", "excluded"].includes(comp.scope)
    ) {
      filtered = true;
    } else if (options.only?.length) {
      const componentPurl = comp.purl?.toLowerCase?.() || "";
      if (!Array.isArray(options.only)) {
        options.only = [options.only];
      }
      // See issue: #1962
      let purlfiltered = true;
      for (const filterstr of options.only) {
        if (
          filterstr.length &&
          componentPurl.includes(filterstr.toLowerCase())
        ) {
          filtered = true;
          purlfiltered = false;
          break;
        }
      }
      if (!purlfiltered) {
        newPkgMap[comp["bom-ref"]] = comp;
      }
    } else if (options.filter?.length) {
      if (!Array.isArray(options.filter)) {
        options.filter = [options.filter];
      }
      let purlfiltered = false;
      const componentPurl = comp.purl?.toLowerCase?.() || "";
      for (const filterstr of options.filter) {
        // Check the purl
        if (
          filterstr.length &&
          componentPurl.includes(filterstr.toLowerCase())
        ) {
          filtered = true;
          purlfiltered = true;
          continue;
        }
        // Look for any properties value matching the string
        const properties = comp.properties || [];
        for (const aprop of properties) {
          if (
            filterstr.length &&
            aprop?.value?.toLowerCase().includes(filterstr.toLowerCase())
          ) {
            filtered = true;
            purlfiltered = true;
          }
        }
      }
      if (!purlfiltered) {
        newPkgMap[comp["bom-ref"]] = comp;
      }
    } else {
      newPkgMap[comp["bom-ref"]] = comp;
    }
  }
  for (const service of bomJson.services || []) {
    if (shouldExcludeInventoryType(service, options)) {
      filtered = true;
      continue;
    }
    newServices.push(service);
  }
  if (filtered) {
    if (!anyFiltered) {
      anyFiltered = true;
    }
    const newcomponents = [];
    const newdependencies = [];
    const retainedRefs = new Set();
    for (const aref of Object.keys(newPkgMap).sort()) {
      newcomponents.push(newPkgMap[aref]);
      retainedRefs.add(aref);
    }
    for (const service of newServices) {
      if (service?.["bom-ref"]) {
        retainedRefs.add(service["bom-ref"]);
      }
    }
    if (bomJson.metadata?.component?.["bom-ref"]) {
      newPkgMap[bomJson.metadata.component["bom-ref"]] =
        bomJson.metadata.component;
      retainedRefs.add(bomJson.metadata.component["bom-ref"]);
    }
    if (bomJson.metadata?.component?.components) {
      for (const comp of bomJson.metadata.component.components) {
        newPkgMap[comp["bom-ref"]] = comp;
        retainedRefs.add(comp["bom-ref"]);
      }
    }
    for (const adep of bomJson.dependencies || []) {
      if (retainedRefs.has(adep.ref)) {
        const newdepson = (adep.dependsOn || []).filter((d) =>
          retainedRefs.has(d),
        );
        const obj = {
          ref: adep.ref,
          dependsOn: newdepson,
        };
        // Filter provides array if needed
        if (adep.provides?.length) {
          obj.provides = adep.provides.filter((d) => retainedRefs.has(d));
        }
        newdependencies.push(obj);
      }
    }
    bomJson.components = newcomponents;
    bomJson.dependencies = newdependencies;
    bomJson.services = newServices;
    // We set the compositions.aggregate to incomplete by default
    if (
      options.specVersion >= 1.5 &&
      options.autoCompositions &&
      bomJson.metadata?.component
    ) {
      if (!bomJson.compositions) {
        bomJson.compositions = [];
      }
      bomJson.compositions.push({
        "bom-ref": bomJson.metadata.component["bom-ref"],
        aggregate: options.only ? "incomplete_first_party_only" : "incomplete",
      });
    }
  }
  if (!anyFiltered && DEBUG_MODE) {
    if (
      options.requiredOnly &&
      !options.deep &&
      hasAnyProjectType(["python"], options, false)
    ) {
      console.log(
        "TIP: Try running cdxgen with --deep argument to identify component usages with atom.",
      );
    } else if (
      options.requiredOnly &&
      options.noBabel &&
      hasAnyProjectType(["js"], options, false)
    ) {
      console.log(
        "Enable babel by removing the --no-babel argument to improve usage detection.",
      );
    }
  }
  return bomJson;
}

function shouldExcludeInventoryType(subject, options) {
  return AI_INVENTORY_PROJECT_TYPES.some(
    (type) =>
      optionIncludesAiInventoryProjectType(options?.excludeType, type) &&
      matchesAiInventoryExcludeType(subject, type),
  );
}

/**
 * Clean up
 */
export function cleanupEnv(_options) {
  if (isDryRun) {
    return;
  }
  if (readEnvironmentVariable("PIP_TARGET")?.startsWith(getTmpDir())) {
    safeRmSync(readEnvironmentVariable("PIP_TARGET"), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Removes the cdxgen temporary directory if it was created inside the system
 * temp directory (as indicated by `CDXGEN_TMP_DIR`). No-ops when the variable
 * is unset or points outside the system temp directory.
 *
 * @returns {void}
 */
export function cleanupTmpDir() {
  if (isDryRun) {
    return;
  }
  if (readEnvironmentVariable("CDXGEN_TMP_DIR")?.startsWith(getTmpDir())) {
    safeRmSync(readEnvironmentVariable("CDXGEN_TMP_DIR"), {
      recursive: true,
      force: true,
    });
  }
}

function stripBomLink(serialNumber, version, ref) {
  return ref.replace(`${serialNumber}/${version - 1}/`, "");
}

/**
 * Annotate the document with annotator
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Annotated BOM JSON
 */
export function annotate(bomJson, options) {
  if (!bomJson?.components) {
    return bomJson;
  }
  const bomAnnotations = bomJson?.annotations || [];
  const cdxgenAnnotator = (bomJson.metadata?.tools?.components || []).filter(
    (c) => c.name === "cdxgen",
  );
  if (!cdxgenAnnotator.length) {
    return bomJson;
  }
  const { bomType } = findBomType(bomJson);
  const requiresContextTuning = [
    "deep-learning",
    "machine-learning",
    "ml",
    "ml-deep",
    "ml-tiny",
  ].includes(options?.profile);
  const requiresContextTrimming =
    (requiresContextTuning && ["saasbom"].includes(bomType.toLowerCase())) ||
    ["ml-tiny"].includes(options?.profile);
  // Construct the bom-link prefix to use for context tuning
  const bomLinkPrefix = `${bomJson.serialNumber}/${bomJson.version}/`;
  const metadataAnnotations = textualMetadata(bomJson);
  let parentBomRef;
  if (bomJson.metadata?.component?.["bom-ref"]) {
    if (requiresContextTuning) {
      bomJson.metadata.component["bom-ref"] =
        `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, bomJson.metadata.component["bom-ref"])}`;
    }
    parentBomRef = bomJson.metadata.component["bom-ref"];
  }
  if (metadataAnnotations) {
    bomAnnotations.push({
      "bom-ref": "metadata-annotations",
      subjects: parentBomRef ? [parentBomRef] : [bomJson.serialNumber],
      annotator: {
        component: cdxgenAnnotator[0],
      },
      // An annotation describes the document it is attached to, so it carries
      // that document's timestamp rather than the moment postgen ran.
      timestamp: bomJson.metadata?.timestamp || getTimestamp(),
      text: metadataAnnotations,
    });
  }
  bomJson.annotations = bomAnnotations;
  // Shall we trim the metadata section
  if (requiresContextTrimming) {
    if (bomJson?.metadata?.component?.components) {
      bomJson.metadata.component.components = undefined;
    }
    if (bomJson?.metadata?.component?.["bom-ref"]) {
      bomJson.metadata.component["bom-ref"] = undefined;
    }
    if (bomJson?.metadata?.component?.properties) {
      bomJson.metadata.component.properties = undefined;
    }
    if (bomJson?.metadata?.properties) {
      bomJson.metadata.properties = undefined;
    }
  }
  // Tag the components
  for (const comp of bomJson.components) {
    const tags = extractTags(comp, bomType, bomJson.metadata?.component?.type);
    if (tags?.length) {
      comp.tags = tags;
    }
    if (requiresContextTuning) {
      comp["bom-ref"] =
        `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, comp["bom-ref"])}`;
      comp.description = undefined;
      comp.properties = undefined;
      comp.evidence = undefined;
    }
    if (requiresContextTrimming) {
      comp.authors = undefined;
      comp.supplier = undefined;
      comp.publisher = undefined;
      comp["bom-ref"] = undefined;
      comp.externalReferences = undefined;
      comp.description = undefined;
      comp.properties = undefined;
      comp.evidence = undefined;
      // We will lose information about nested components, such as the files in case of poetry.lock
      comp.components = undefined;
    }
  }
  // For tiny models, we can remove the dependencies section
  if (requiresContextTrimming) {
    bomJson.dependencies = undefined;
    if (bomType.toLowerCase() === "saasbom") {
      bomJson.components = undefined;
      let i = 0;
      for (const aserv of bomJson.services) {
        aserv.name = `service-${i++}`;
      }
    }
  }
  // Problem: information such as the dependency tree are specific to an sbom
  // To prevent the models from incorrectly learning about the trees, we automatically convert all bom-ref
  // references to [bom-link](https://cyclonedx.org/capabilities/bomlink/) format
  if (requiresContextTuning && bomJson?.dependencies?.length) {
    const newDeps = [];
    for (const dep of bomJson.dependencies) {
      const newRef = `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, dep.ref)}`;
      const newDependsOn = [];
      for (const adon of dep.dependsOn || []) {
        newDependsOn.push(
          `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, adon)}`,
        );
      }
      newDeps.push({
        ref: newRef,
        dependsOn: newDependsOn.sort(),
      });
    }
    // Overwrite the dependencies
    bomJson.dependencies = newDeps;
  }
  return bomJson;
}
