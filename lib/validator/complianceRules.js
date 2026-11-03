/**
 * Internal compliance rule catalog for cdx-validate.
 *
 * Implements OWASP SCVS (Software Component Verification Standard) controls
 * and selected EU Cyber Resilience Act (CRA) SBOM expectations as plain
 * JavaScript evaluators. Controls that are not automatable from a static
 * CycloneDX BOM (for example, process or organizational controls) are still
 * modelled so that benchmark reports can surface them as "manual review
 * required" items with a stable identifier.
 *
 * Each rule exports:
 *   id            - Stable short identifier (e.g. "SCVS-1.1").
 *   name          - Human readable short name.
 *   description   - Long description (wording taken from the source standard).
 *   standard      - Source standard key: "SCVS", "CRA" or "CISA".
 *   standardRefs  - Array of canonical control identifiers.
 *   category      - Grouping used by --categories.
 *   severity      - Severity emitted for a failing automatable rule.
 *   scvsLevels    - For SCVS rules, the levels (L1/L2/L3) that require the
 *                   control. Non-SCVS rules use an empty array.
 *   automatable   - True when evaluate() returns a deterministic pass/fail
 *                   from the BOM alone. False means the rule is emitted as
 *                   severity "info" / status "manual" so downstream tooling
 *                   can track coverage.
 *   evaluate      - Function(bomJson) => RuleResult.
 *
 * RuleResult shape:
 *   {
 *     status: "pass" | "fail" | "manual",
 *     message: string,              // human readable summary
 *     mitigation?: string,
 *     locations?: Array<{ bomRef?, purl?, file? }>,
 *     evidence?: Record<string, any>
 *   }
 */

import { Purl } from "@cdxgen/cdx-purl";

import { isCycloneDxBom } from "../inventory/bomUtils.js";

/**
 * Extract the first SPDX-ish license id from a CycloneDX component's licenses
 * block. Returns null when no license is declared.
 *
 * @param {object} comp CycloneDX component
 * @returns {string | null}
 */
function componentLicenseId(comp) {
  if (!comp?.licenses?.length) {
    return null;
  }
  for (const entry of comp.licenses) {
    if (entry?.license?.id) {
      return entry.license.id;
    }
    if (entry?.expression) {
      return entry.expression;
    }
  }
  for (const entry of comp.licenses) {
    if (entry?.license?.name) {
      return entry.license.name;
    }
  }
  return null;
}

function getAllComponents(bomJson) {
  const results = [];
  function traverse(comps) {
    if (!Array.isArray(comps)) {
      return;
    }
    for (const c of comps) {
      if (c?.scope === "excluded") {
        continue;
      }
      results.push(c);
      if (c.components) {
        traverse(c.components);
      }
    }
  }
  traverse(bomJson?.components);
  return results;
}

/**
 * Collect libraries/frameworks/applications worth evaluating for inventory
 * checks. Crypto-assets and data types are excluded because they are tracked
 * with different schemas in CycloneDX.
 *
 * @param {object} bomJson
 * @returns {Array<object>}
 */
function inventoryComponents(bomJson) {
  if (!Array.isArray(bomJson?.components)) {
    return [];
  }
  return getAllComponents(bomJson).filter((c) =>
    [
      "application",
      "framework",
      "library",
      "container",
      "operating-system",
    ].includes(c?.type),
  );
}

/**
 * Format a component identifier for console messages.
 *
 * @param {object} comp
 * @returns {string}
 */
function compLabel(comp) {
  return comp?.purl || comp?.["bom-ref"] || comp?.name || "<unknown>";
}

/**
 * Build a Set of all bom-refs declared anywhere in the BOM so that we can
 * detect orphan components that are not reachable from the dependency tree.
 *
 * @param {object} bomJson
 * @returns {Set<string>}
 */
function collectReferencedRefs(bomJson) {
  const refs = new Set();
  const rootRef = bomJson?.metadata?.component?.["bom-ref"];
  if (rootRef) {
    refs.add(rootRef);
  }
  for (const dep of bomJson?.dependencies || []) {
    if (dep?.ref) {
      refs.add(dep.ref);
    }
    for (const child of dep?.dependsOn || []) {
      refs.add(child);
    }
    for (const prov of dep?.provides || []) {
      refs.add(prov);
    }
  }
  return refs;
}

/**
 * Validate that a license expression is syntactically a known SPDX identifier
 * or an expression built from SPDX operators. This is a best-effort check
 * that tokenises the expression first — avoiding backtracking-heavy regex
 * alternations — and then validates each token with a simple character-class
 * pattern.
 *
 * @param {string} expr
 * @returns {boolean}
 */
function looksLikeSpdx(expr) {
  if (!expr || typeof expr !== "string") {
    return false;
  }
  const trimmed = expr.trim();
  // Reject obvious "unknown" placeholders emitted by several tools.
  const lower = trimmed.toLowerCase();
  if (["noassertion", "unknown", "unlicensed", ""].includes(lower)) {
    return false;
  }
  // Strip balanced parentheses so we can focus on the identifier+operator
  // shape. Parentheses are structural only in SPDX expressions.
  const withoutParens = trimmed.replace(/[()]/g, " ");
  // Identifiers: alphanumeric, dots, dashes, pluses, slashes, colons.
  const tokenPattern = /^[A-Za-z0-9.+\-/:]+$/;
  const operators = new Set(["AND", "OR", "WITH"]);
  // Split on whitespace once; linear scan below validates every token. Two
  // consecutive operators or two consecutive identifiers both fail.
  const tokens = withoutParens.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  let expectIdentifier = true;
  for (const tok of tokens) {
    if (operators.has(tok)) {
      if (expectIdentifier) return false; // operator cannot come first
      expectIdentifier = true;
    } else {
      if (!expectIdentifier) return false; // two identifiers in a row
      if (!tokenPattern.test(tok)) return false;
      expectIdentifier = false;
    }
  }
  // Must end on an identifier, not an operator.
  return !expectIdentifier;
}

/**
 * Helper to build a standard "pass" rule result.
 */
function pass(message, extras = {}) {
  return { status: "pass", message, ...extras };
}

/**
 * Helper to build a standard "fail" rule result.
 */
function fail(message, extras = {}) {
  return { status: "fail", message, ...extras };
}

/**
 * Helper to build a standard "manual" rule result (non-automatable control).
 */
function manual(message, extras = {}) {
  return { status: "manual", message, ...extras };
}

const CDX_AUDIT_MANUAL_COMMAND = "cdx-audit --bom bom.json --scope required";

function buildCdxAuditAssistMitigation(reviewFocus) {
  return `${reviewFocus} To support manual verification, run \`${CDX_AUDIT_MANUAL_COMMAND}\` against the same SBOM and review the resulting repository, workflow, provenance, and publishing findings.`;
}

function buildCdxAuditAssistEvidence(controlId) {
  return {
    reviewMode: "manual-with-cdx-audit",
    standardRef: `SCVS-${controlId}`,
    suggestedCommand: CDX_AUDIT_MANUAL_COMMAND,
  };
}

/**
 * Factory for SCVS manual-review rules. These are emitted so that benchmark
 * reports can accurately reflect per-level coverage even when the rule cannot
 * be evaluated automatically.
 *
 * @param {string} id
 * @param {string} name
 * @param {string} description
 * @param {{ l1: boolean, l2: boolean, l3: boolean }} levels
 * @param {{ mitigation?: string, evidence?: object }} [options]
 * @returns {object}
 */
function scvsManual(id, name, description, levels, options = {}) {
  const required = [];
  if (levels.l1) required.push("L1");
  if (levels.l2) required.push("L2");
  if (levels.l3) required.push("L3");
  return {
    id: `SCVS-${id}`,
    name,
    description,
    standard: "SCVS",
    standardRefs: [`SCVS-${id}`],
    category: "compliance-scvs",
    severity: "info",
    scvsLevels: required,
    automatable: false,
    evaluate: () =>
      manual(
        `${name} is not automatable from the BOM and requires manual review.`,
        {
          evidence: options.evidence,
          mitigation: options.mitigation || description,
        },
      ),
  };
}

// ---------------------------------------------------------------------------
// OWASP SCVS automatable rules
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
const SCVS_RULES = [
  {
    id: "SCVS-1.1",
    name: "Components and versions known",
    description:
      "All direct and transitive components and their versions are known at completion of a build.",
    standard: "SCVS",
    standardRefs: ["SCVS-1.1"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (comps.length === 0) {
        return fail(
          "BOM has no application, framework, or library components.",
          {
            mitigation:
              "Regenerate the BOM with cdxgen so that all direct and transitive components are captured.",
          },
        );
      }
      const missing = comps.filter((c) => !c.version);
      if (missing.length) {
        return fail(`${missing.length} component(s) are missing a version.`, {
          mitigation:
            "Ensure lockfiles are committed and cdxgen has access to them; set --project-version for the root component.",
          locations: missing.slice(0, 25).map((c) => ({
            bomRef: c["bom-ref"],
            purl: c.purl,
            name: c.name,
          })),
          evidence: { missingVersionCount: missing.length },
        });
      }
      return pass(`All ${comps.length} components have a version.`);
    },
  },
  scvsManual(
    "1.2",
    "Package managers used for third-party binaries",
    "Package managers are used to manage all third-party binary components.",
    { l1: true, l2: true, l3: true },
  ),
  {
    id: "SCVS-1.3",
    name: "Machine-readable third-party inventory",
    description:
      "An accurate inventory of all third-party components is available in a machine-readable format.",
    standard: "SCVS",
    standardRefs: ["SCVS-1.3"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      if (!isCycloneDxBom(bomJson)) {
        return fail(
          "BOM is not a valid CycloneDX document (bomFormat/specVersion missing).",
          {
            mitigation:
              "Produce the SBOM with cdxgen or another CycloneDX-compliant tool.",
          },
        );
      }
      const comps = inventoryComponents(bomJson);
      return pass(
        `Machine-readable CycloneDX ${bomJson.specVersion} inventory with ${comps.length} component(s).`,
      );
    },
  },
  scvsManual(
    "1.4",
    "SBOMs generated for published applications",
    "Software bill of materials are generated for publicly or commercially available applications.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "1.5",
    "SBOMs required for new procurements",
    "Software bill of materials are required for new procurements.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "1.6",
    "SBOMs continuously maintained",
    "Software bill of materials continuously maintained and current for all systems.",
    { l1: false, l2: false, l3: true },
  ),
  {
    id: "SCVS-1.7",
    name: "Consistent machine-readable identifiers",
    description:
      "Components are uniquely identified in a consistent, machine-readable format.",
    standard: "SCVS",
    standardRefs: ["SCVS-1.7"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.purl && !(c.cpe || c.swid?.tagId));
      if (missing.length) {
        return fail(
          `${missing.length} component(s) lack a purl, cpe, or swid identifier.`,
          {
            mitigation:
              "Ensure component identifiers are added during generation (cdxgen emits purls automatically).",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              name: c.name,
            })),
            evidence: { missingIdentifierCount: missing.length },
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) have a machine-readable identifier.`,
      );
    },
  },
  {
    id: "SCVS-1.8",
    name: "Component type is known",
    description: "The component type is known throughout inventory.",
    standard: "SCVS",
    standardRefs: ["SCVS-1.8"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = getAllComponents(bomJson);
      const missing = comps.filter((c) => !c?.type);
      if (missing.length) {
        return fail(`${missing.length} component(s) are missing type.`, {
          mitigation: "Set 'type' on each component (library, framework, …).",
          locations: missing.slice(0, 25).map((c) => ({
            bomRef: c["bom-ref"],
            name: c?.name,
          })),
        });
      }
      return pass(`All ${comps.length} component(s) have a type.`);
    },
  },
  scvsManual(
    "1.9",
    "Component function is known",
    "The component function is known throughout inventory.",
    { l1: false, l2: false, l3: true },
  ),
  {
    id: "SCVS-1.10",
    name: "Point of origin is known",
    description: "Point of origin is known for all components.",
    standard: "SCVS",
    standardRefs: ["SCVS-1.10"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter(
        (c) => !c.purl && !c.supplier?.name && !c.publisher,
      );
      if (missing.length) {
        return fail(
          `${missing.length} component(s) lack a point of origin (purl, supplier, or publisher).`,
          {
            mitigation:
              "Populate purl, supplier, or publisher for every component.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              name: c?.name,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) have a point of origin reference.`,
      );
    },
  },
  {
    id: "SCVS-2.1",
    name: "Structured machine-readable SBOM",
    description:
      "A structured, machine readable software bill of materials (SBOM) format is present.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.1"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      if (isCycloneDxBom(bomJson)) {
        return pass(`SBOM format is CycloneDX ${bomJson.specVersion}.`);
      }
      return fail("bomFormat or specVersion missing from the SBOM root.", {
        mitigation: "Use cdxgen or another CycloneDX-compliant generator.",
      });
    },
  },
  scvsManual(
    "2.2",
    "SBOM creation is automated and reproducible",
    "SBOM creation is automated and reproducible.",
    { l1: false, l2: true, l3: true },
  ),
  {
    id: "SCVS-2.3",
    name: "SBOM has unique identifier",
    description: "Each SBOM has a unique identifier.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.3"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      if (
        bomJson?.serialNumber &&
        /^urn:uuid:[0-9a-f-]{36}$/i.test(bomJson.serialNumber)
      ) {
        return pass(`Unique serialNumber present (${bomJson.serialNumber}).`);
      }
      return fail("BOM serialNumber is missing or not a urn:uuid value.", {
        mitigation:
          "Ensure the SBOM includes a serialNumber of the form urn:uuid:<uuid>.",
      });
    },
  },
  {
    id: "SCVS-2.4",
    name: "SBOM is signed",
    description:
      "SBOM has been signed by publisher, supplier, or certifying authority.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.4"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      if (bomJson?.signature) {
        const algo =
          bomJson.signature.algorithm ||
          bomJson.signature.signers?.[0]?.algorithm ||
          bomJson.signature.chain?.[0]?.algorithm;
        return pass(`BOM is signed${algo ? ` (${algo})` : ""}.`);
      }
      return fail("BOM is not signed.", {
        mitigation:
          "Sign the SBOM with `cdx-sign -i bom.json -k private.pem` before distribution.",
      });
    },
  },
  scvsManual(
    "2.5",
    "SBOM signature verification exists",
    "SBOM signature verification exists.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "2.6",
    "SBOM signature verification is performed",
    "SBOM signature verification is performed.",
    { l1: false, l2: false, l3: true },
  ),
  {
    id: "SCVS-2.7",
    name: "SBOM is timestamped",
    description: "SBOM is timestamped.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.7"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const ts = bomJson?.metadata?.timestamp;
      if (typeof ts !== "string" || ts.length === 0) {
        return fail("metadata.timestamp is missing.");
      }
      if (Number.isNaN(Date.parse(ts))) {
        return fail(`metadata.timestamp is not a valid ISO-8601 date: ${ts}`);
      }
      return pass(`metadata.timestamp present (${ts}).`);
    },
  },
  scvsManual(
    "2.8",
    "SBOM is analyzed for risk",
    "SBOM is analyzed for risk.",
    {
      l1: true,
      l2: true,
      l3: true,
    },
    {
      evidence: buildCdxAuditAssistEvidence("2.8"),
      mitigation: buildCdxAuditAssistMitigation(
        "Use predictive audit evidence to show how the SBOM is being reviewed for workflow, provenance, and publishing risk.",
      ),
    },
  ),
  {
    id: "SCVS-2.9",
    name: "Complete and accurate inventory",
    description:
      "SBOM contains a complete and accurate inventory of all components the SBOM describes.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.9"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (comps.length === 0) {
        return fail("BOM has no inventory components.");
      }
      if (
        !Array.isArray(bomJson?.dependencies) ||
        bomJson.dependencies.length === 0
      ) {
        return fail(
          "BOM has components but no dependency graph — inventory is not demonstrably complete.",
          {
            mitigation:
              "Ensure cdxgen is run with access to the full dependency tree so that the 'dependencies' section is populated.",
          },
        );
      }
      return pass(
        `${comps.length} component(s) with a ${bomJson.dependencies.length}-node dependency graph.`,
      );
    },
  },
  scvsManual(
    "2.10",
    "SBOM contains accurate test inventory",
    "SBOM contains an accurate inventory of all test components for the asset or application it describes.",
    { l1: false, l2: true, l3: true },
  ),
  {
    id: "SCVS-2.11",
    name: "SBOM contains asset metadata",
    description:
      "SBOM contains metadata about the asset or software the SBOM describes.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.11"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const meta = bomJson?.metadata?.component;
      if (!meta?.name) {
        return fail("metadata.component is missing or has no name.", {
          mitigation:
            "Pass --project-name (and --project-version) when running cdxgen.",
        });
      }
      if (!meta.version) {
        return fail("metadata.component.version is missing.", {
          mitigation: "Pass --project-version when running cdxgen.",
        });
      }
      return pass(
        `Root asset metadata present (${meta.name}@${meta.version}).`,
      );
    },
  },
  {
    id: "SCVS-2.12",
    name: "Identifiers derived from native ecosystems",
    description:
      "Component identifiers are derived from their native ecosystems (if applicable).",
    standard: "SCVS",
    standardRefs: ["SCVS-2.12"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const invalid = [];
      for (const c of comps) {
        if (!c.purl) continue;
        try {
          Purl.parse(c.purl);
        } catch (_err) {
          invalid.push(c);
        }
      }
      if (invalid.length) {
        return fail(`${invalid.length} component(s) have an invalid purl.`, {
          mitigation:
            "Use PackageURL.fromString to validate purls; regenerate with the latest cdxgen.",
          locations: invalid.slice(0, 25).map((c) => ({
            bomRef: c["bom-ref"],
            purl: c.purl,
          })),
        });
      }
      return pass(
        `All ${comps.filter((c) => c.purl).length} component purls are parseable.`,
      );
    },
  },
  {
    id: "SCVS-2.13",
    name: "Point of origin identified with PURL",
    description:
      "Component point of origin is identified in a consistent, machine readable format (e.g. PURL).",
    standard: "SCVS",
    standardRefs: ["SCVS-2.13"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.purl);
      if (missing.length) {
        return fail(`${missing.length} component(s) are missing a purl.`, {
          mitigation:
            "Purls are the preferred SBOM identifier — regenerate with cdxgen.",
          locations: missing.slice(0, 25).map((c) => ({
            bomRef: c["bom-ref"],
            name: c?.name,
          })),
        });
      }
      return pass(`All ${comps.length} inventory component(s) have a purl.`);
    },
  },
  {
    id: "SCVS-2.14",
    name: "Components have license information",
    description:
      "Components defined in SBOM have accurate license information.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.14"],
    category: "compliance-scvs",
    severity: "high",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.licenses?.length);
      if (missing.length) {
        return fail(
          `${missing.length} component(s) are missing license information.`,
          {
            mitigation:
              "Run cdxgen with FETCH_LICENSE=true, or provide a license policy.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
              name: c?.name,
            })),
            evidence: { missingLicenseCount: missing.length },
          },
        );
      }
      return pass(
        `All ${comps.length} inventory component(s) declare license information.`,
      );
    },
  },
  {
    id: "SCVS-2.15",
    name: "Valid SPDX identifiers or expressions",
    description:
      "Components defined in SBOM have valid SPDX license IDs or expressions (if applicable).",
    standard: "SCVS",
    standardRefs: ["SCVS-2.15"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const invalid = [];
      const evidence = new Set();
      for (const c of comps) {
        const lic = componentLicenseId(c);
        if (lic && !looksLikeSpdx(lic)) {
          invalid.push({ comp: c, lic });
          evidence.add(lic);
        }
      }
      if (invalid.length) {
        return fail(
          `${invalid.length} component(s) use a non-SPDX license expression.`,
          {
            mitigation:
              "Normalize license identifiers to SPDX license IDs or expressions.",
            locations: invalid.slice(0, 25).map(({ comp, _ }) => ({
              bomRef: comp["bom-ref"],
              purl: comp.purl,
            })),
            evidence: Array.from(evidence),
          },
        );
      }
      return pass(
        "SPDX license identifiers are valid for all components with license data.",
      );
    },
  },
  {
    id: "SCVS-2.16",
    name: "Components have copyright statements",
    description: "Components defined in SBOM have valid copyright statements.",
    standard: "SCVS",
    standardRefs: ["SCVS-2.16"],
    category: "compliance-scvs",
    severity: "low",
    scvsLevels: ["L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.copyright);
      if (missing.length) {
        return fail(
          `${missing.length} component(s) are missing copyright statements.`,
          {
            mitigation:
              "Populate copyright metadata for each component (cdxgen does this when license data is available).",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(`All ${comps.length} component(s) declare a copyright.`);
    },
  },
  scvsManual(
    "2.17",
    "Modified components have pedigree information",
    "Components defined in SBOM which have been modified from the original have detailed provenance and pedigree information.",
    { l1: false, l2: false, l3: true },
  ),
  {
    id: "SCVS-2.18",
    name: "Components have file hashes",
    description:
      "Components defined in SBOM have one or more file hashes (SHA-256, SHA-512, etc).",
    standard: "SCVS",
    standardRefs: ["SCVS-2.18"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.hashes?.length);
      if (missing.length) {
        return fail(`${missing.length} component(s) are missing file hashes.`, {
          mitigation:
            "Run cdxgen with FETCH_LICENSE/lockfile context so tarball hashes are captured.",
          locations: missing.slice(0, 25).map((c) => ({
            bomRef: c["bom-ref"],
            purl: c.purl,
          })),
          evidence: { missingHashesCount: missing.length },
        });
      }
      return pass(`All ${comps.length} component(s) have one or more hashes.`);
    },
  },
  scvsManual(
    "3.1",
    "Application uses a repeatable build",
    "Application uses a repeatable build.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "3.2",
    "Build documentation exists",
    "Documentation exists on how the application is built and instructions for repeating the build.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "3.3",
    "Application uses CI build pipeline",
    "Application uses a continuous integration build pipeline.",
    { l1: true, l2: true, l3: true },
    {
      evidence: buildCdxAuditAssistEvidence("3.3"),
      mitigation: buildCdxAuditAssistMitigation(
        "Review the resolved repository workflows to confirm a CI build pipeline is present and corresponds to the released package.",
      ),
    },
  ),
  scvsManual(
    "3.4",
    "Build outputs immutable",
    "Application build pipeline prohibits alteration of build outside of the job performing the build.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "3.5",
    "Package-manager settings immutable",
    "Application build pipeline prohibits alteration of package management settings.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "3.6",
    "No arbitrary code execution",
    "Application build pipeline prohibits the execution of arbitrary code outside of the context of a jobs build script.",
    { l1: false, l2: true, l3: true },
    {
      evidence: buildCdxAuditAssistEvidence("3.6"),
      mitigation: buildCdxAuditAssistMitigation(
        "Review workflow and publishing findings for risky scripts, hidden Unicode, and legacy token-based release steps that may indicate unsafe build execution paths.",
      ),
    },
  ),
  scvsManual(
    "3.7",
    "Builds only from version control",
    "Application build pipeline may only perform builds of source code maintained in version control systems.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "3.8",
    "DNS/network settings immutable",
    "Application build pipeline prohibits alteration of DNS and network settings during build.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "3.9",
    "Certificate trust stores immutable",
    "Application build pipeline prohibits alteration of certificate trust stores.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "3.10",
    "Pipeline authentication enforced",
    "Application build pipeline enforces authentication and defaults to deny.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "3.11",
    "Pipeline authorization enforced",
    "Application build pipeline enforces authorization and defaults to deny.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "3.12",
    "Separation of concerns for system settings",
    "Application build pipeline requires separation of concerns for the modification of system settings.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "3.13",
    "Verifiable audit log of system changes",
    "Application build pipeline maintains a verifiable audit log of all system changes.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "3.14",
    "Verifiable audit log of build changes",
    "Application build pipeline maintains a verifiable audit log of all build job changes.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "3.15",
    "Build pipeline maintenance cadence",
    "Application build pipeline has required maintenance cadence where the entire stack is updated, patched, and re-certified for use.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "3.16",
    "Compiler/tooling tamper monitoring",
    "Compilers, version control clients, development utilities, and software development kits are analyzed and monitored for tampering, trojans, or malicious code.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "3.17",
    "Build-time manipulations known",
    "All build-time manipulations to source or binaries are known and well defined.",
    { l1: true, l2: true, l3: true },
  ),
  {
    id: "SCVS-3.18",
    name: "Checksums of components documented",
    description:
      "Checksums of all first-party and third-party components are documented for every build.",
    standard: "SCVS",
    standardRefs: ["SCVS-3.18"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.hashes?.length);
      if (missing.length) {
        return fail(
          `${missing.length} component(s) have no checksum recorded.`,
          {
            mitigation:
              "Populate component 'hashes' during generation (cdxgen captures these when lockfile or tarball data is available).",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(`All ${comps.length} component(s) have recorded checksums.`);
    },
  },
  scvsManual(
    "3.19",
    "Checksums delivered out-of-band",
    "Checksums of all components are accessible and delivered out-of-band whenever those components are packaged or distributed.",
    { l1: false, l2: true, l3: true },
  ),
  {
    id: "SCVS-3.20",
    name: "Unused components identified",
    description:
      "Unused direct and transitive components have been identified.",
    standard: "SCVS",
    standardRefs: ["SCVS-3.20"],
    category: "compliance-scvs",
    severity: "low",
    scvsLevels: ["L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (!comps.length) {
        return fail("No components to analyse.");
      }
      const refs = collectReferencedRefs(bomJson);
      const orphans = comps.filter(
        (c) => c["bom-ref"] && !refs.has(c["bom-ref"]),
      );
      if (orphans.length) {
        return fail(
          `${orphans.length} component(s) are not referenced by the dependency graph.`,
          {
            mitigation:
              "Remove unused components or ensure the dependency graph is complete.",
            locations: orphans.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} inventory component(s) are reachable from the dependency graph.`,
      );
    },
  },
  scvsManual(
    "3.21",
    "Unused components removed",
    "Unused direct and transitive components have been removed from the application.",
    { l1: false, l2: false, l3: true },
  ),
  // V4 - Package Management (mostly process controls)
  scvsManual(
    "4.1",
    "Binary components from a package repository",
    "Binary components are retrieved from a package repository.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.2",
    "Package repository congruent with origin",
    "Package repository contents are congruent to an authoritative point of origin for open source components.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.3",
    "Package repository strong authentication",
    "Package repository requires strong authentication.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "4.4",
    "Package repository MFA for publishing",
    "Package repository supports multi-factor authentication component publishing.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "4.5",
    "Packages published with MFA",
    "Package repository components have been published with multi-factor authentication.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "4.6",
    "Security incident reporting supported",
    "Package repository supports security incident reporting.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "4.7",
    "Security incident reporting automated",
    "Package repository automates security incident reporting.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "4.8",
    "Publisher security notifications",
    "Package repository notifies publishers of security issues.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "4.9",
    "User security notifications",
    "Package repository notifies users of security issues.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "4.10",
    "Version-to-source correlation",
    "Package repository provides a verifiable way of correlating component versions to specific source codes in version control.",
    { l1: false, l2: true, l3: true },
    {
      evidence: buildCdxAuditAssistEvidence("4.10"),
      mitigation: buildCdxAuditAssistMitigation(
        "Review the resolved repository URL, version mapping, and source correlation details for the component version under review.",
      ),
    },
  ),
  scvsManual(
    "4.11",
    "Package repository auditability",
    "Package repository provides auditability when components are updated.",
    { l1: true, l2: true, l3: true },
    {
      evidence: buildCdxAuditAssistEvidence("4.11"),
      mitigation: buildCdxAuditAssistMitigation(
        "Review provenance, publisher drift, publish timing, and trusted-publishing signals to assess whether package updates are auditable.",
      ),
    },
  ),
  scvsManual(
    "4.12",
    "Code signing for production publishing",
    "Package repository requires code signing to publish packages to production repositories.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "4.13",
    "Package manager verifies remote integrity",
    "Package manager verifies the integrity of packages when they are retrieved from remote repository.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.14",
    "Package manager verifies local integrity",
    "Package manager verifies the integrity of packages when they are retrieved from file system.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.15",
    "TLS required for package repository",
    "Package repository enforces use of TLS for all interactions.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.16",
    "Package manager validates TLS chain",
    "Package manager validates TLS certificate chain to repository and fails securely when validation fails.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.17",
    "Static analysis prior to publishing",
    "Package repository requires and/or performs static code analysis prior to publishing a component and makes results available for others to consume.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "4.18",
    "Package manager does not execute code",
    "Package manager does not execute component code.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "4.19",
    "Install documented in machine-readable form",
    "Package manager documents package installation in machine-readable form.",
    { l1: true, l2: true, l3: true },
  ),
  // V5 - Component Analysis
  scvsManual(
    "5.1",
    "Component analyzable by linters/SAST",
    "Component can be analyzed with linters and/or static analysis tools.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "5.2",
    "Components analyzed prior to use",
    "Component is analyzed using linters and/or static analysis tools prior to use.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "5.3",
    "Analysis repeated on upgrade",
    "Linting and/or static analysis is performed with every upgrade of a component.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "5.4",
    "Automated vulnerability identification",
    "An automated process of identifying all publicly disclosed vulnerabilities in third-party and open source components is used.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "5.5",
    "Automated dataflow exploitability",
    "An automated process of identifying confirmed dataflow exploitability is used.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "5.6",
    "Non-specified component versions identified",
    "An automated process of identifying non-specified component versions is used.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "5.7",
    "Out-of-date components identified",
    "An automated process of identifying out-of-date components is used.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "5.8",
    "End-of-life components identified",
    "An automated process of identifying end-of-life / end-of-support components is used.",
    { l1: false, l2: false, l3: true },
  ),
  scvsManual(
    "5.9",
    "Automated component type identification",
    "An automated process of identifying component type is used.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "5.10",
    "Automated component function identification",
    "An automated process of identifying component function is used.",
    { l1: false, l2: false, l3: true },
  ),
  {
    id: "SCVS-5.11",
    name: "Automated component quantity identification",
    description:
      "An automated process of identifying component quantity is used.",
    standard: "SCVS",
    standardRefs: ["SCVS-5.11"],
    category: "compliance-scvs",
    severity: "low",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (comps.length === 0) {
        return fail("BOM has no inventory components to quantify.");
      }
      return pass(`BOM declares ${comps.length} inventory component(s).`);
    },
  },
  {
    id: "SCVS-5.12",
    name: "Automated component license identification",
    description:
      "An automated process of identifying component license is used.",
    standard: "SCVS",
    standardRefs: ["SCVS-5.12"],
    category: "compliance-scvs",
    severity: "medium",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (comps.length === 0) {
        return fail("BOM has no components to analyse for licenses.");
      }
      const withLic = comps.filter((c) => c.licenses?.length);
      const ratio = withLic.length / comps.length;
      if (ratio < 0.5) {
        return fail(
          `Only ${withLic.length}/${comps.length} (${Math.round(ratio * 100)}%) components have license data.`,
          {
            mitigation: "Run cdxgen with FETCH_LICENSE=true.",
          },
        );
      }
      return pass(
        `${withLic.length}/${comps.length} (${Math.round(ratio * 100)}%) components have license data.`,
      );
    },
  },
  // V6 - Pedigree and Provenance
  scvsManual(
    "6.1",
    "Point of origin verifiable",
    "Point of origin is verifiable for source code and binary components.",
    { l1: false, l2: true, l3: true },
    {
      evidence: buildCdxAuditAssistEvidence("6.1"),
      mitigation: buildCdxAuditAssistMitigation(
        "Review the resolved repository and registry provenance signals to confirm the package point of origin is verifiable.",
      ),
    },
  ),
  scvsManual(
    "6.2",
    "Chain of custody auditable",
    "Chain of custody if auditable for source code and binary components.",
    { l1: false, l2: false, l3: true },
    {
      evidence: buildCdxAuditAssistEvidence("6.2"),
      mitigation: buildCdxAuditAssistMitigation(
        "Review provenance, publisher identity changes, trusted-publishing status, and source-repository correlation to assess auditable chain-of-custody evidence.",
      ),
    },
  ),
  {
    id: "SCVS-6.3",
    name: "Provenance of modified components",
    description: "Provenance of modified components is known and documented.",
    standard: "SCVS",
    standardRefs: ["SCVS-6.3"],
    category: "compliance-scvs",
    severity: "low",
    scvsLevels: ["L1", "L2", "L3"],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const modified = comps.filter((c) => c.pedigree);
      if (modified.length === 0) {
        // No modified components is a pass — nothing to document.
        return pass("No modified components declared — nothing to document.");
      }
      const missing = modified.filter(
        (c) =>
          !c.pedigree?.ancestors?.length &&
          !c.pedigree?.descendants?.length &&
          !c.pedigree?.commits?.length &&
          !c.pedigree?.patches?.length,
      );
      if (missing.length) {
        return fail(
          `${missing.length} component(s) have an empty pedigree object.`,
          {
            mitigation:
              "Populate pedigree.ancestors / commits / patches for modified components.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `${modified.length} modified component(s) have pedigree information.`,
      );
    },
  },
  scvsManual(
    "6.4",
    "Pedigree of modifications documented",
    "Pedigree of component modification is documented and verifiable.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "6.5",
    "Modified components uniquely identified",
    "Modified components are uniquely identified and distinct from origin component.",
    { l1: false, l2: true, l3: true },
  ),
  scvsManual(
    "6.6",
    "Modified components analyzed equally",
    "Modified components are analyzed with the same level of precision as unmodified components.",
    { l1: true, l2: true, l3: true },
  ),
  scvsManual(
    "6.7",
    "Risk of modified variants analyzed",
    "Risk unique to modified components can be analyzed and associated specifically to modified variant.",
    { l1: true, l2: true, l3: true },
  ),
];

// ---------------------------------------------------------------------------
// EU Cyber Resilience Act (CRA) — SBOM expectations
// Based on Annex I section 2 "vulnerability handling requirements" and the
// ENISA SBOM guidance for CRA compliance.
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
const CRA_RULES = [
  {
    id: "CRA-MIN-001",
    name: "SBOM supplier identified",
    description:
      "CRA Article 13(24): The manufacturer must be identifiable from the SBOM so users can reach them for vulnerability reports.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-1"],
    category: "compliance-cra",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const supplier =
        bomJson?.metadata?.supplier?.name ||
        bomJson?.metadata?.manufacture?.name ||
        bomJson?.metadata?.manufacturer?.name;
      if (!supplier) {
        return fail(
          "metadata.supplier / metadata.manufacturer is missing the manufacturer name.",
          {
            mitigation:
              "Populate metadata.supplier.name so downstream users know who to contact.",
          },
        );
      }
      return pass(`Manufacturer declared: ${supplier}.`);
    },
  },
  {
    id: "CRA-MIN-002",
    name: "Manufacturer vulnerability contact",
    description:
      "CRA Annex I(2)(2): Manufacturers must provide a contact address for vulnerability reports.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-2"],
    category: "compliance-cra",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const supplier =
        bomJson?.metadata?.supplier ||
        bomJson?.metadata?.manufacture ||
        bomJson?.metadata?.manufacturer;
      const contacts = supplier?.contact || [];
      const hasContact = Array.isArray(contacts)
        ? contacts.some((c) => c?.email || c?.phone)
        : Boolean(contacts?.email || contacts?.phone);
      const hasUrl = Array.isArray(supplier?.url)
        ? supplier.url.some((u) => u)
        : typeof supplier?.url === "string" && supplier.url.length > 0;
      if (!hasContact && !hasUrl) {
        return fail(
          "No vulnerability contact (email / phone / URL) recorded on the manufacturer.",
          {
            mitigation:
              "Populate metadata.supplier.contact[].email (or .url) with your PSIRT address.",
          },
        );
      }
      return pass("Manufacturer contact information present.");
    },
  },
  {
    id: "CRA-MIN-003",
    name: "Unique SBOM identifier",
    description:
      "CRA requires that each SBOM is uniquely addressable for vulnerability correlation.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-3"],
    category: "compliance-cra",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      if (
        bomJson?.serialNumber &&
        /^urn:uuid:[0-9a-f-]{36}$/i.test(bomJson.serialNumber)
      ) {
        return pass(`serialNumber present (${bomJson.serialNumber}).`);
      }
      return fail("serialNumber missing or not a urn:uuid.");
    },
  },
  {
    id: "CRA-MIN-004",
    name: "Inventory has dependency relationships",
    description:
      "CRA requires a complete inventory including dependency relationships so vulnerabilities can be traced.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-4"],
    category: "compliance-cra",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (comps.length === 0) {
        return fail("BOM has no inventory components.");
      }
      const deps = Array.isArray(bomJson?.dependencies)
        ? bomJson.dependencies
        : [];
      if (deps.length === 0) {
        return fail(
          "BOM has components but no dependency relationships — root-cause analysis is not possible.",
          {
            mitigation:
              "Ensure cdxgen runs with access to lockfiles so the dependency graph is captured.",
          },
        );
      }
      const covered = new Set();
      for (const dep of deps) {
        if (dep?.ref) covered.add(dep.ref);
        for (const child of dep?.dependsOn || []) covered.add(child);
      }
      const uncovered = comps.filter(
        (c) => !c["bom-ref"] || !covered.has(c["bom-ref"]),
      );
      if (uncovered.length > comps.length * 0.25) {
        return fail(
          `${uncovered.length}/${comps.length} component(s) are not represented in the dependency graph.`,
          {
            mitigation:
              "Regenerate with deeper analysis so all components appear in the dependency graph.",
            locations: uncovered.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `${deps.length} dependency node(s) covering ${comps.length - uncovered.length}/${comps.length} component(s).`,
      );
    },
  },
  {
    id: "CRA-MIN-005",
    name: "Timestamp",
    description:
      "CRA requires each SBOM to be timestamped so vulnerability freshness can be evaluated.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-5"],
    category: "compliance-cra",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const ts = bomJson?.metadata?.timestamp;
      if (!ts) return fail("metadata.timestamp is missing.");
      if (Number.isNaN(Date.parse(ts))) {
        return fail(`metadata.timestamp is not valid ISO-8601: ${ts}`);
      }
      return pass(`metadata.timestamp present (${ts}).`);
    },
  },
  {
    id: "CRA-MIN-006",
    name: "Component identifiers resolvable",
    description:
      "CRA requires machine-readable identifiers for every component so users can cross-reference vulnerability databases.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-6"],
    category: "compliance-cra",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      const missing = comps.filter((c) => !c.purl && !c.cpe && !c.swid?.tagId);
      if (missing.length) {
        return fail(
          `${missing.length} component(s) lack purl/cpe/swid identifiers.`,
          {
            mitigation: "Regenerate with cdxgen so purls are emitted.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              name: c.name,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) have a resolvable identifier.`,
      );
    },
  },
  {
    id: "CRA-MIN-007",
    name: "License information",
    description:
      "CRA and downstream guidance (ENISA) recommend recording license data so downstream users can satisfy copyright obligations.",
    standard: "CRA",
    standardRefs: ["CRA-ENISA-LICENSE"],
    category: "compliance-cra",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = inventoryComponents(bomJson);
      if (comps.length === 0) {
        return fail("BOM has no inventory components.");
      }
      const missing = comps.filter((c) => !c.licenses?.length);
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) lack license information.`,
          {
            mitigation:
              "Run cdxgen with FETCH_LICENSE=true or provide a license allow-list.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} inventory component(s) declare license information.`,
      );
    },
  },
  {
    id: "CRA-MIN-008",
    name: "Tool provenance recorded",
    description:
      "CRA Annex I(2)(3): SBOM must record the tool(s) that produced it so its provenance can be audited.",
    standard: "CRA",
    standardRefs: ["CRA-ANNEX-I-2-3-TOOLS"],
    category: "compliance-cra",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const tools = bomJson?.metadata?.tools;
      // CycloneDX 1.4 uses array, 1.5+ uses object with components.
      if (Array.isArray(tools) && tools.length > 0) {
        return pass(`${tools.length} tool(s) recorded.`);
      }
      if (tools?.components?.length || tools?.services?.length) {
        return pass(
          `${tools.components?.length || 0} tool component(s), ${tools.services?.length || 0} tool service(s) recorded.`,
        );
      }
      return fail("metadata.tools is empty or missing.");
    },
  },
];

// ---------------------------------------------------------------------------
// CISA 2026 Minimum Elements for a Software Bill of Materials (SBOM)
// Joint guidance of CISA, NSA, FBI and international partners published on
// 29 July 2026. It replaces the NTIA 2021 minimum elements and adds the
// author signature, data format name and version, generation context, tool
// name and version, SBOM version, component hashes with their algorithm, and
// component licenses. Rule ids cite the element they implement through the
// standardRefs array so users can judge each mapping against the source.
// ---------------------------------------------------------------------------

/**
 * RFC 9557 (IXDTF) date-time shape. RFC 3339 timestamps such as
 * "2026-01-02T03:04:05Z" are valid RFC 9557 as well; the pattern also accepts
 * the bracketed suffix annotations and numeric-offset forms IXDTF adds.
 */
const RFC9557_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})(\[[^\]]+\])*$/;

/**
 * Check the field ranges of an RFC 3339 date-time whose shape
 * RFC9557_TIMESTAMP_RE already accepted: a real calendar day (leap years
 * included), hour 0-23, minute 0-59, second 0-60 (RFC 3339 allows a leap
 * second) and an offset of at most 23:59. Date.parse is not used because it
 * rolls 2026-02-30 over to 2 March and rejects a leap second.
 *
 * @param {string} ts timestamp matching RFC9557_TIMESTAMP_RE
 * @returns {boolean}
 */
function isValidRfc3339DateTime(ts) {
  const num = (start, end) => Number.parseInt(ts.slice(start, end), 10);
  const year = num(0, 4);
  const month = num(5, 7);
  const day = num(8, 10);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > daysInMonth[month - 1]) {
    return false;
  }
  if (num(11, 13) > 23 || num(14, 16) > 59 || num(17, 19) > 60) {
    return false;
  }
  const bracket = ts.indexOf("[");
  const base = bracket === -1 ? ts : ts.slice(0, bracket);
  const last = base[base.length - 1];
  if (last === "Z" || last === "z") {
    return true;
  }
  const offset = base.slice(-5);
  return (
    Number.parseInt(offset.slice(0, 2), 10) <= 23 &&
    Number.parseInt(offset.slice(3, 5), 10) <= 59
  );
}

/** CycloneDX spec versions the maintaining organisations declare deprecated. */
const DEPRECATED_SPEC_VERSIONS = new Set(["1.0", "1.1", "1.2", "1.3"]);

/** Lifecycle phases CycloneDX defines for metadata.lifecycles. */
const LIFECYCLE_PHASES = new Set([
  "design",
  "pre-build",
  "build",
  "post-build",
  "operations",
  "discovery",
  "decommission",
]);

/** Hash algorithms CISA would not accept as the sole hash (not NIST approved). */
const WEAK_HASH_ALGS = new Set(["MD5", "SHA-1"]);

/**
 * A field the 2026 minimum elements allow to carry an explicit "unknown"
 * marker satisfies the element, so only a genuinely absent value fails.
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isExplicitUnknown(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "unknown";
}

/**
 * Collect the tool entries of metadata.tools across both shapes CycloneDX
 * allows: the 1.4 array and the 1.5+ object with components and services.
 *
 * @param {object} bomJson
 * @returns {Array<object>}
 */
function toolEntries(bomJson) {
  const tools = bomJson?.metadata?.tools;
  if (Array.isArray(tools)) {
    return tools;
  }
  return [...(tools?.components || []), ...(tools?.services || [])];
}

/** The --author default of bin/cdxgen.js: the tool's maintainer. */
const CDXGEN_DEFAULT_AUTHOR = "OWASP Foundation";

const AUTHOR_MITIGATION =
  "cdxgen records the SBOM author only from the --author option; pass the person or organisation generating the SBOM (repeat --author for several).";

/** @type {Array<object>} */
const CISA_RULES = [
  {
    id: "CISA-MIN-001",
    name: "SBOM author identified",
    description:
      "CISA 2026 SBOM Author: the name of the entity that creates the SBOM data for the target component. The element captures the entity operating the tool, not the tool itself.",
    standard: "CISA",
    standardRefs: ["CISA-2026-SBOM-AUTHOR"],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const names = [];
      if (Array.isArray(bomJson?.metadata?.authors)) {
        for (const a of bomJson.metadata.authors) {
          if (a?.name) {
            names.push(a.name);
          }
        }
      }
      // CycloneDX 1.4 keeps a single metadata.author contact.
      if (!names.length && bomJson?.metadata?.author?.name) {
        names.push(bomJson.metadata.author.name);
      }
      if (!names.length) {
        return fail("metadata.authors is missing a named SBOM author.", {
          mitigation: AUTHOR_MITIGATION,
        });
      }
      // cdxgen writes its maintainer as the author when --author is not
      // given. That names the tool, which the element excludes, so a list
      // holding only the default does not satisfy it.
      if (names.every((n) => n.trim() === CDXGEN_DEFAULT_AUTHOR)) {
        return fail(
          `metadata.authors names only "${CDXGEN_DEFAULT_AUTHOR}", the default cdxgen writes when --author is not given; it identifies the tool's maintainer, not the entity that created the SBOM.`,
          { mitigation: AUTHOR_MITIGATION },
        );
      }
      return pass(`SBOM author(s) recorded: ${names.join(", ")}.`);
    },
  },
  {
    id: "CISA-MIN-002",
    name: "SBOM author signature present",
    description:
      "CISA 2026 SBOM Author Signature: a digital signature attributable to the SBOM author, giving assurance the claimed signatory signed the data and it was not modified afterwards.",
    standard: "CISA",
    standardRefs: ["CISA-2026-SBOM-AUTHOR-SIGNATURE"],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const sig = bomJson?.signature;
      const signed =
        sig && (typeof sig.signature === "string" || sig.signers?.length > 0);
      if (!signed) {
        return fail("The BOM carries no JSF signature block.", {
          mitigation:
            "Sign the generated BOM with cdx-sign (or another JSON Signature Format signer) before distributing it.",
        });
      }
      return pass("A JSF signature block is present on the BOM.");
    },
  },
  {
    id: "CISA-MIN-003",
    name: "Data format named with a current version",
    description:
      "CISA 2026 SBOM Data Format Name and SBOM Data Format Version: the machine-processable format holding the SBOM and the version of that format. Versions declared deprecated by the format maintainers should not be used.",
    standard: "CISA",
    standardRefs: [
      "CISA-2026-SBOM-DATA-FORMAT-NAME",
      "CISA-2026-SBOM-DATA-FORMAT-VERSION",
    ],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      if (bomJson?.bomFormat !== "CycloneDX") {
        return fail(
          `bomFormat is ${JSON.stringify(bomJson?.bomFormat)}, expected "CycloneDX".`,
        );
      }
      const spec = bomJson?.specVersion;
      if (!spec) {
        return fail("specVersion is missing.", {
          mitigation:
            "Regenerate with a specVersion; cdxgen defaults to 1.6 and --spec-version overrides it.",
        });
      }
      if (DEPRECATED_SPEC_VERSIONS.has(spec)) {
        return fail(
          `specVersion ${spec} is deprecated by the CycloneDX maintainers.`,
          {
            mitigation:
              "Regenerate with --spec-version 1.6 (or newer) so consumers do not reject the document.",
          },
        );
      }
      return pass(`bomFormat CycloneDX at specVersion ${spec}.`);
    },
  },
  {
    id: "CISA-MIN-004",
    name: "Generation context recorded",
    description:
      "CISA 2026 SBOM Generation Context: the relative software lifecycle phase and data available when the SBOM author generated the SBOM, such as before build, build or after build.",
    standard: "CISA",
    standardRefs: ["CISA-2026-SBOM-GENERATION-CONTEXT"],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const lifecycles = Array.isArray(bomJson?.metadata?.lifecycles)
        ? bomJson.metadata.lifecycles
        : [];
      const phases = lifecycles.map((l) => l?.phase).filter(Boolean);
      if (!phases.some((p) => LIFECYCLE_PHASES.has(p))) {
        return fail(
          "metadata.lifecycles records no recognized lifecycle phase.",
          {
            mitigation:
              'cdxgen writes the phase itself ("pre-build", "build" or "post-build") from spec version 1.5; --lifecycle overrides it.',
          },
        );
      }
      return pass(`Generation context phase(s): ${phases.join(", ")}.`);
    },
  },
  {
    id: "CISA-MIN-005",
    name: "Tool name and version recorded",
    description:
      "CISA 2026 SBOM Tool Name and SBOM Tool Version: the software tool the SBOM author used to generate or amend the SBOM, and its version. When no version is available the author should indicate the information is unknown.",
    standard: "CISA",
    standardRefs: ["CISA-2026-SBOM-TOOL-NAME", "CISA-2026-SBOM-TOOL-VERSION"],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const entries = toolEntries(bomJson);
      if (!entries.length) {
        return fail("metadata.tools records no tool.", {
          mitigation:
            "cdxgen records itself in metadata.tools.components on every BOM it generates.",
        });
      }
      const unnamed = entries.filter((t) => !t?.name);
      // "unknown" is an explicit statement the version is not known, so only
      // a genuinely absent version is flagged.
      const unversioned = entries.filter(
        (t) => !t?.version && !isExplicitUnknown(t?.version),
      );
      if (unnamed.length || unversioned.length) {
        const detail = unnamed.length
          ? `${unnamed.length} tool entry/entries without a name`
          : `${unversioned.length} tool entry/entries without a version or an explicit "unknown"`;
        return fail(`metadata.tools is incomplete: ${detail}.`, {
          locations: [...unnamed, ...unversioned]
            .slice(0, 25)
            .map((t) => ({ name: t?.name })),
        });
      }
      return pass(
        `${entries.length} tool(s) recorded with name and version: ${entries.map((t) => `${t.name}@${t.version}`).join(", ")}.`,
      );
    },
  },
  {
    id: "CISA-MIN-006",
    name: "SBOM version recorded",
    description:
      "CISA 2026 SBOM Version: an identifier the SBOM author uses to specify a change from a previously identified version or to mark the first version.",
    standard: "CISA",
    standardRefs: ["CISA-2026-SBOM-VERSION"],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const v = bomJson?.version;
      if (!Number.isInteger(v) || v < 1) {
        return fail(
          `version is ${JSON.stringify(v)}, expected an integer of 1 or more.`,
          {
            mitigation:
              "cdxgen writes version 1 for a first BOM; tools that amend the document should increment it.",
          },
        );
      }
      return pass(`SBOM version ${v}.`);
    },
  },
  {
    id: "CISA-MIN-007",
    name: "Timestamp in RFC 9557 form",
    description:
      "CISA 2026 SBOM Timestamp: the date and time of the most recent update to the SBOM data. The field content should adhere to RFC 9557.",
    standard: "CISA",
    standardRefs: ["CISA-2026-SBOM-TIMESTAMP"],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const ts = bomJson?.metadata?.timestamp;
      if (!ts) {
        return fail("metadata.timestamp is missing.");
      }
      // The pattern checks the RFC 9557 shape, IXDTF suffix annotations
      // included; the field ranges are then checked on the RFC 3339 part.
      if (
        typeof ts !== "string" ||
        !RFC9557_TIMESTAMP_RE.test(ts) ||
        !isValidRfc3339DateTime(ts)
      ) {
        return fail(
          `metadata.timestamp is not RFC 9557 (IXDTF) shaped: ${ts}`,
          {
            mitigation:
              'Write an RFC 3339/9557 date-time with its offset, for example "2026-07-29T12:00:00Z". A date-only value does not satisfy the element.',
          },
        );
      }
      return pass(`metadata.timestamp present (${ts}).`);
    },
  },
  {
    id: "CISA-MIN-008",
    name: "Component names recorded",
    description:
      "CISA 2026 Component Name: the name assigned by the component producer to a software component, in human-readable form.",
    standard: "CISA",
    standardRefs: ["CISA-2026-COMPONENT-NAME"],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const missing = comps.filter((c) => !c.name);
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) have no name.`,
          {
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(`All ${comps.length} component(s) carry a name.`);
    },
  },
  {
    id: "CISA-MIN-009",
    name: "Component versions recorded",
    description:
      "CISA 2026 Component Version: the identifier the component producer uses to specify a change in a component. When the producer supplies no version the SBOM author should mark the information unknown.",
    standard: "CISA",
    standardRefs: ["CISA-2026-COMPONENT-VERSION"],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const missing = comps.filter(
        (c) => !c.version && !isExplicitUnknown(c.version),
      );
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) have neither a version nor an explicit "unknown".`,
          {
            mitigation:
              'Regenerate so every component resolves a version, or set version to the string "unknown" where the producer publishes none.',
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              name: c.name,
            })),
          },
        );
      }
      return pass(`All ${comps.length} component(s) carry a version.`);
    },
  },
  {
    id: "CISA-MIN-010",
    name: "Component producer identified",
    description:
      "CISA 2026 Component Producer: the entity that creates, defines and identifies a component. Where there is no clear producer, the SBOM author should explicitly indicate the component is of unknown provenance.",
    standard: "CISA",
    standardRefs: ["CISA-2026-COMPONENT-PRODUCER"],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const producerOf = (c) => c?.supplier?.name || c?.manufacturer?.name;
      // A producer name of "unknown" counts: it is the explicit
      // unknown-provenance marking the element asks for.
      const missing = comps.filter((c) => !producerOf(c));
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) declare no producer (supplier or manufacturer).`,
          {
            mitigation:
              'Record the maintaining organisation in supplier.name, or set supplier.name to "unknown" to mark the component of unknown provenance.',
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) name a producer or mark it unknown.`,
      );
    },
  },
  {
    id: "CISA-MIN-011",
    name: "Machine-processable component identifiers",
    description:
      "CISA 2026 Component Identifiers: at least one software identifier per component, using common identifiers such as CPE and Package-URL so tools can correlate the component with vulnerability and license databases.",
    standard: "CISA",
    standardRefs: ["CISA-2026-COMPONENT-IDENTIFIERS"],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const missing = comps.filter((c) => !c.purl && !c.cpe && !c.swid?.tagId);
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) have no purl, cpe or swid identifier.`,
          {
            mitigation: "Regenerate with cdxgen so purls are emitted.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              name: c.name,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) carry a machine-processable identifier.`,
      );
    },
  },
  {
    id: "CISA-MIN-012",
    name: "Component hashes with a named algorithm",
    description:
      "CISA 2026 Component Hash Value and Component Hash Algorithm: a hexadecimal hash of the executable component artifact and the cryptographic algorithm that produced it, identified by its IANA hash function textual name.",
    standard: "CISA",
    standardRefs: [
      "CISA-2026-COMPONENT-HASH-VALUE",
      "CISA-2026-COMPONENT-HASH-ALGORITHM",
    ],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const acceptable = (h) =>
        h?.alg &&
        !WEAK_HASH_ALGS.has(h.alg) &&
        typeof h.content === "string" &&
        /^[0-9a-fA-F]+$/.test(h.content);
      const missing = comps.filter(
        (c) => !Array.isArray(c.hashes) || !c.hashes.some(acceptable),
      );
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) lack a hexadecimal hash from an approved algorithm (MD5 and SHA-1 do not satisfy the element alone).`,
          {
            mitigation:
              "Regenerate where the package artifacts or a SHA-256-or-stronger integrity value is reachable; some ecosystems publish only SHA-1, which leaves the element partially satisfied.",
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) carry a hash with a named algorithm.`,
      );
    },
  },
  {
    id: "CISA-MIN-013",
    name: "Component licenses identified",
    description:
      "CISA 2026 Component License: the identifiers for the licenses under which the component is available, machine-processable where possible such as SPDX identifiers, or a pointer to the full license details when no identifier exists.",
    standard: "CISA",
    standardRefs: ["CISA-2026-COMPONENT-LICENSE"],
    category: "compliance-cisa",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const missing = comps.filter((c) => !componentLicenseId(c));
      if (missing.length) {
        return fail(
          `${missing.length}/${comps.length} component(s) declare no license identifier or reference.`,
          {
            mitigation:
              'Run cdxgen with FETCH_LICENSE=true or a license allow-list, or record license.name "unknown" where the license is genuinely not known.',
            locations: missing.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `All ${comps.length} component(s) declare license information.`,
      );
    },
  },
  {
    id: "CISA-MIN-014",
    name: "Dependency relationships cover the inventory",
    description:
      "CISA 2026 Component Dependency Relationship and the Coverage practice: the BOM should include all components that make up the target software, including transitive dependencies, with no minimum depth.",
    standard: "CISA",
    standardRefs: ["CISA-2026-COMPONENT-DEPENDENCY-RELATIONSHIP"],
    category: "compliance-cisa",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      const comps = cisaInventoryComponents(bomJson);
      if (!comps.length) {
        return fail("BOM has no inventory components.");
      }
      const deps = Array.isArray(bomJson?.dependencies)
        ? bomJson.dependencies
        : [];
      if (!deps.length) {
        return fail("BOM has components but no dependency relationships.", {
          mitigation:
            "Run cdxgen with access to the lockfiles so the dependency graph is captured.",
        });
      }
      const covered = collectReferencedRefs(bomJson);
      const uncovered = comps.filter(
        (c) => !c["bom-ref"] || !covered.has(c["bom-ref"]),
      );
      if (uncovered.length) {
        return fail(
          `${uncovered.length}/${comps.length} component(s) are absent from the dependency graph, so coverage of transitive dependencies cannot be judged.`,
          {
            mitigation:
              "Regenerate with deeper analysis so every component appears in the dependency graph.",
            locations: uncovered.slice(0, 25).map((c) => ({
              bomRef: c["bom-ref"],
              purl: c.purl,
            })),
          },
        );
      }
      return pass(
        `${deps.length} dependency node(s) cover all ${comps.length} component(s).`,
      );
    },
  },
  {
    id: "CISA-MIN-015",
    name: "Unknown versus withheld information",
    description:
      "CISA 2026 practice Explicitly Identifying Unknown Information: when data required for an element is not provided, the SBOM author should state whether the information is unknown or withheld, and keep a process for recipients to ask about redacted data.",
    standard: "CISA",
    standardRefs: ["CISA-2026-PRACTICE-UNKNOWN-INFORMATION"],
    category: "compliance-cisa",
    severity: "info",
    scvsLevels: [],
    automatable: false,
    evaluate: () =>
      manual(
        "Whether omitted values are unknown or withheld, and the process for recipients to ask about redacted data, cannot be judged from the BOM alone.",
        {
          mitigation:
            'Keep a published process for recipients to ask about withheld data, and mark genuinely absent values with "unknown" as the other CISA rules check.',
        },
      ),
  },
];

// ---------------------------------------------------------------------------
// CISA and G7 minimum elements for an SBOM for AI
// Joint guidance of CISA and the G7 cybersecurity partners published on
// 12 May 2026. It supplements the general SBOM minimum elements, which are
// to be considered in addition to it, so the CISA_RULES above cover those and
// this catalog only adds the AI-specific clusters: System Level Properties,
// Models, and Datasets. Rules pass with a note when the BOM holds no AI
// components, because the elements apply to AI systems alone. The full
// element mapping, including the elements cdxgen does not emit, lives in
// docs/AI_BOM.md.
// ---------------------------------------------------------------------------

/**
 * Collect the machine-learning-model components of the BOM.
 *
 * @param {object} bomJson
 * @returns {Array<object>}
 */
function aiModelComponents(bomJson) {
  return getAllComponents(bomJson).filter(
    (c) => c?.type === "machine-learning-model",
  );
}

/**
 * Collect the dataset components: type "data" carrying a dataset entry or
 * dataset tag, as the Hugging Face parsers emit them.
 *
 * @param {object} bomJson
 * @returns {Array<object>}
 */
function aiDatasetComponents(bomJson) {
  return getAllComponents(bomJson).filter(
    (c) =>
      c?.type === "data" &&
      ((Array.isArray(c.data) && c.data.some((d) => d?.type === "dataset")) ||
        (Array.isArray(c.tags) && c.tags.includes("dataset"))),
  );
}

/**
 * A rule body for AI elements that only apply when the BOM describes AI
 * components; a BOM without them passes with a note instead of failing.
 *
 * @param {Array<object>} comps the AI components the element applies to
 * @param {string} kind human word such as "model" or "dataset"
 * @param {(comps: Array<object>) => object} body the real evaluation
 * @returns {object}
 */
function aiElement(comps, kind, body) {
  if (!comps.length) {
    return pass(
      `The BOM holds no ${kind} components; the AI ${kind} elements do not apply.`,
    );
  }
  return body(comps);
}

/**
 * A rule body for the System Level Properties elements. They describe the AI
 * system, so they apply only when the BOM holds model or dataset components;
 * any other BOM passes with a note.
 *
 * @param {object} bomJson
 * @param {() => object} body the real evaluation
 * @returns {object}
 */
function aiSystemElement(bomJson, body) {
  if (
    !aiModelComponents(bomJson).length &&
    !aiDatasetComponents(bomJson).length
  ) {
    return pass(
      "The BOM holds no model or dataset components; the AI system elements do not apply.",
    );
  }
  return body();
}

/**
 * The producer of the AI system the BOM describes. CycloneDX defines
 * metadata.supplier and the deprecated metadata.manufacture as the
 * organisation that supplied or manufactured the described component, and
 * metadata.component.supplier/manufacturer hold the same facts on the root
 * component, so each of them names the system producer. metadata.manufacturer
 * is left out: from 1.6 it names the organisation that created the BOM, which
 * is the SBOM author, not the system producer.
 *
 * @param {object} bomJson
 * @returns {string | undefined}
 */
function systemProducerName(bomJson) {
  const metadata = bomJson?.metadata;
  return (
    metadata?.supplier?.name ||
    metadata?.manufacture?.name ||
    metadata?.component?.supplier?.name ||
    metadata?.component?.manufacturer?.name
  );
}

/**
 * The component set the CISA 2026 element rules judge: the regular inventory
 * plus the AI models, which the AI SBOM guidance makes subject to the same
 * minimum elements. Dataset components stay out; their elements are checked
 * by the AI rule set instead.
 *
 * @param {object} bomJson
 * @returns {Array<object>}
 */
function cisaInventoryComponents(bomJson) {
  return [...inventoryComponents(bomJson), ...aiModelComponents(bomJson)];
}

/** @type {Array<object>} */
const CISA_AI_RULES = [
  {
    id: "CISA-AI-001",
    name: "System name and version",
    description:
      "CISA/G7 System Level Properties: the name the system producer assigns to the AI system, and the version that identifies a change from a previously identified version.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-SYSTEM-NAME", "CISA-2026-AI-SYSTEM-VERSION"],
    category: "compliance-cisa-ai",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiSystemElement(bomJson, () => {
        const system = bomJson?.metadata?.component;
        if (!system?.name) {
          return fail("metadata.component is missing the AI system name.", {
            mitigation:
              "cdxgen records the project as metadata.component; --project-name and --project-version override it.",
          });
        }
        if (!system.version && !isExplicitUnknown(system.version)) {
          return fail(
            `metadata.component (${system.name}) carries no version or "unknown" marker.`,
            {
              mitigation:
                'Pass --project-version, or set version to "unknown" when the system has none.',
            },
          );
        }
        return pass(`System ${system.name}@${system.version} recorded.`);
      });
    },
  },
  {
    id: "CISA-AI-002",
    name: "System producer",
    description:
      "CISA/G7 System Level Properties: the entity that creates, defines and identifies the AI system.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-SYSTEM-PRODUCER"],
    category: "compliance-cisa-ai",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiSystemElement(bomJson, () => {
        const producer = systemProducerName(bomJson);
        if (!producer) {
          return fail("No system producer is declared for the AI system.", {
            mitigation:
              "cdxgen does not populate the system producer. Add the producing organisation to metadata.supplier.name (or metadata.component.supplier.name) after generation, for example by post-processing the BOM before signing it.",
          });
        }
        return pass(`System producer declared: ${producer}.`);
      });
    },
  },
  {
    id: "CISA-AI-003",
    name: "Model name and version",
    description:
      "CISA/G7 Models cluster: the name the model producer assigns to the model, and the version identifying a change from a previously identified version.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-MODEL-NAME", "CISA-2026-AI-MODEL-VERSION"],
    category: "compliance-cisa-ai",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiModelComponents(bomJson), "model", (comps) => {
        const bad = comps.filter(
          (c) => !c.name || (!c.version && !isExplicitUnknown(c.version)),
        );
        if (bad.length) {
          return fail(
            `${bad.length}/${comps.length} model component(s) lack a name or a version with an "unknown" marker.`,
            {
              mitigation:
                "Hugging Face revisions fill the version from the repository sha; local artifacts need the version recorded next to them.",
              locations: bad.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                purl: c.purl,
              })),
            },
          );
        }
        return pass(`All ${comps.length} model(s) carry a name and version.`);
      });
    },
  },
  {
    id: "CISA-AI-004",
    name: "Model producer",
    description:
      "CISA/G7 Models cluster: the entity that creates, defines and identifies the AI model, such as the organisations behind its pre-training or fine-tuning.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-MODEL-PRODUCER"],
    category: "compliance-cisa-ai",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiModelComponents(bomJson), "model", (comps) => {
        const missing = comps.filter(
          (c) => !c.supplier?.name && !c.manufacturer?.name,
        );
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} model component(s) declare no producer.`,
            {
              mitigation:
                'cdxgen fills supplier.name from the Hugging Face namespace or from a provider that creates its own models, such as openai or anthropic; hosting and local providers leave it unset. Record the producer manually, or "unknown" where it is not known.',
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                purl: c.purl,
              })),
            },
          );
        }
        return pass(
          `All ${comps.length} model(s) name a producer or mark it unknown.`,
        );
      });
    },
  },
  {
    id: "CISA-AI-005",
    name: "Model identifiers",
    description:
      "CISA/G7 Models cluster: at least one machine-processable identifier per model, such as a purl or cpe, so tools can correlate the model with databases.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-MODEL-IDENTIFIER"],
    category: "compliance-cisa-ai",
    severity: "high",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiModelComponents(bomJson), "model", (comps) => {
        const missing = comps.filter(
          (c) => !c.purl && !c.cpe && !c.swid?.tagId,
        );
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} model component(s) carry no purl, cpe or swid identifier.`,
            {
              mitigation:
                "cdxgen emits pkg:huggingface purls for Hub repositories and keeps dosai's purls; models seen only in source need one recorded.",
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                name: c.name,
              })),
            },
          );
        }
        return pass(
          `All ${comps.length} model(s) carry a machine-processable identifier.`,
        );
      });
    },
  },
  {
    id: "CISA-AI-006",
    name: "Model hashes with a named algorithm",
    description:
      "CISA/G7 Models cluster: a cryptographic hash of the weights or model file with the algorithm that produced it, so the artifact can be verified.",
    standard: "CISA",
    standardRefs: [
      "CISA-2026-AI-MODEL-HASH-VALUE",
      "CISA-2026-AI-MODEL-HASH-ALGORITHM",
    ],
    category: "compliance-cisa-ai",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiModelComponents(bomJson), "model", (comps) => {
        const acceptable = (h) =>
          h?.alg &&
          !WEAK_HASH_ALGS.has(h.alg) &&
          typeof h.content === "string" &&
          /^[0-9a-fA-F]+$/.test(h.content);
        const missing = comps.filter(
          (c) => !Array.isArray(c.hashes) || !c.hashes.some(acceptable),
        );
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} model component(s) lack a hexadecimal hash from an approved algorithm.`,
            {
              mitigation:
                "Local artifacts carry the SHA-256 dosai computes; remote repository references hold the revision instead, and a downloaded artifact needs its hash recorded.",
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                purl: c.purl,
              })),
            },
          );
        }
        return pass(
          `All ${comps.length} model(s) carry a hash with a named algorithm.`,
        );
      });
    },
  },
  {
    id: "CISA-AI-007",
    name: "Model licenses",
    description:
      "CISA/G7 Models cluster: the license type of the AI model, machine-processable where possible, or a link to the licensing document.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-MODEL-LICENSE"],
    category: "compliance-cisa-ai",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiModelComponents(bomJson), "model", (comps) => {
        const missing = comps.filter((c) => !componentLicenseId(c));
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} model component(s) declare no license.`,
            {
              mitigation:
                "Hugging Face model cards fill the license from the card tags; models without a card need the license or its URL recorded.",
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                purl: c.purl,
              })),
            },
          );
        }
        return pass(`All ${comps.length} model(s) declare a license.`);
      });
    },
  },
  {
    id: "CISA-AI-008",
    name: "Model description or model card",
    description:
      "CISA/G7 Models cluster: the model's capabilities, known limitations and lineage, which cdxgen records as a description and a CycloneDX modelCard.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-MODEL-DESCRIPTION"],
    category: "compliance-cisa-ai",
    severity: "low",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiModelComponents(bomJson), "model", (comps) => {
        const missing = comps.filter((c) => !c.description && !c.modelCard);
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} model component(s) carry neither a description nor a modelCard.`,
            {
              mitigation:
                "Model cards from Hugging Face and GGUF metadata populate modelCard automatically; models seen only in source need a description.",
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                name: c.name,
              })),
            },
          );
        }
        return pass(
          `All ${comps.length} model(s) carry a description or model card.`,
        );
      });
    },
  },
  {
    id: "CISA-AI-009",
    name: "Dataset name and identifier",
    description:
      "CISA/G7 Datasets cluster: the dataset's name and the information that identifies it univocally, such as a URL or repository identifier.",
    standard: "CISA",
    standardRefs: [
      "CISA-2026-AI-DATASET-NAME",
      "CISA-2026-AI-DATASET-IDENTIFIER",
    ],
    category: "compliance-cisa-ai",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiDatasetComponents(bomJson), "dataset", (comps) => {
        const hasIdentifier = (c) =>
          c.purl ||
          c.cpe ||
          (Array.isArray(c.data) && c.data.some((d) => d?.contents?.url)) ||
          (Array.isArray(c.externalReferences) &&
            c.externalReferences.some((ref) => ref?.url));
        const missing = comps.filter((c) => !c.name || !hasIdentifier(c));
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} dataset component(s) lack a name or an identifying URL or purl.`,
            {
              mitigation:
                "Hugging Face datasets carry pkg:huggingface purls with the datasets repository URL; private datasets need their URL recorded.",
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                name: c.name,
              })),
            },
          );
        }
        return pass(
          `All ${comps.length} dataset(s) carry a name and identifier.`,
        );
      });
    },
  },
  {
    id: "CISA-AI-010",
    name: "Dataset licenses",
    description:
      "CISA/G7 Datasets cluster: the license type of the dataset, or a link to the licensing document.",
    standard: "CISA",
    standardRefs: ["CISA-2026-AI-DATASET-LICENSE"],
    category: "compliance-cisa-ai",
    severity: "medium",
    scvsLevels: [],
    automatable: true,
    evaluate(bomJson) {
      return aiElement(aiDatasetComponents(bomJson), "dataset", (comps) => {
        const missing = comps.filter((c) => !componentLicenseId(c));
        if (missing.length) {
          return fail(
            `${missing.length}/${comps.length} dataset component(s) declare no license.`,
            {
              mitigation:
                "Hugging Face dataset cards fill the license from the card tags; datasets without a card need the license or its URL recorded.",
              locations: missing.slice(0, 25).map((c) => ({
                bomRef: c["bom-ref"],
                purl: c.purl,
              })),
            },
          );
        }
        return pass(`All ${comps.length} dataset(s) declare a license.`);
      });
    },
  },
  {
    id: "CISA-AI-011",
    name: "Descriptive AI elements",
    description:
      "CISA/G7 elements that describe the AI system beyond identity: system data flow and data usage, system and model input/output properties, model training properties, dataset content, provenance and sensitivity, infrastructure hardware, the security properties cluster, and the KPI cluster.",
    standard: "CISA",
    standardRefs: [
      "CISA-2026-AI-SYSTEM-DATA-FLOW",
      "CISA-2026-AI-MODEL-TRAINING-PROPERTIES",
      "CISA-2026-AI-SECURITY-PROPERTIES",
      "CISA-2026-AI-KPI",
    ],
    category: "compliance-cisa-ai",
    severity: "info",
    scvsLevels: [],
    automatable: false,
    evaluate: (bomJson) =>
      aiSystemElement(bomJson, () =>
        manual(
          "The data-flow, usage, training, infrastructure, security and KPI elements need producer documentation; a BOM can carry parts of them (modelCard inputs and outputs, service endpoints, pedigree) but completeness cannot be judged from the BOM alone.",
          {
            mitigation:
              "Attach the producer's system and model cards, point at the HBOM for hardware, and keep security controls and metrics documentation with the release.",
          },
        ),
      ),
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the full catalog of compliance rules (SCVS + CRA + CISA).
 *
 * @returns {Array<object>}
 */
export function getAllComplianceRules() {
  return [...SCVS_RULES, ...CRA_RULES, ...CISA_RULES, ...CISA_AI_RULES];
}

/**
 * Returns only SCVS rules.
 *
 * @returns {Array<object>}
 */
export function getScvsRules() {
  return [...SCVS_RULES];
}

/**
 * Returns only CRA rules.
 *
 * @returns {Array<object>}
 */
export function getCraRules() {
  return [...CRA_RULES];
}

/**
 * Returns only CISA 2026 minimum elements rules.
 *
 * @returns {Array<object>}
 */
export function getCisaRules() {
  return [...CISA_RULES];
}

/**
 * Returns only the CISA and G7 AI SBOM element rules.
 *
 * @returns {Array<object>}
 */
export function getCisaAiRules() {
  return [...CISA_AI_RULES];
}

/**
 * Test-only export exposing internal helper functions for unit tests.
 * Double-underscore prefixed to discourage external use.
 *
 * @type {Object}
 */
export const __test = {
  componentLicenseId,
  inventoryComponents,
  looksLikeSpdx,
  collectReferencedRefs,
  compLabel,
};
