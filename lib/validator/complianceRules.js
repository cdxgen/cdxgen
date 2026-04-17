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
 *   standard      - Source standard key: "SCVS" or "CRA".
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

import { PackageURL } from "packageurl-js";

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

/**
 * Factory for SCVS manual-review rules. These are emitted so that benchmark
 * reports can accurately reflect per-level coverage even when the rule cannot
 * be evaluated automatically.
 *
 * @param {string} id
 * @param {string} name
 * @param {string} description
 * @param {{ l1: boolean, l2: boolean, l3: boolean }} levels
 * @returns {object}
 */
function scvsManual(id, name, description, levels) {
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
          mitigation: description,
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
      if (bomJson?.bomFormat !== "CycloneDX" || !bomJson?.specVersion) {
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
      if (bomJson?.bomFormat === "CycloneDX" && bomJson?.specVersion) {
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
  scvsManual("2.8", "SBOM is analyzed for risk", "SBOM is analyzed for risk.", {
    l1: true,
    l2: true,
    l3: true,
  }),
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
          PackageURL.fromString(c.purl);
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
  ),
  scvsManual(
    "4.11",
    "Package repository auditability",
    "Package repository provides auditability when components are updated.",
    { l1: true, l2: true, l3: true },
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
  ),
  scvsManual(
    "6.2",
    "Chain of custody auditable",
    "Chain of custody if auditable for source code and binary components.",
    { l1: false, l2: false, l3: true },
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the full catalog of compliance rules (SCVS + CRA).
 *
 * @returns {Array<object>}
 */
export function getAllComplianceRules() {
  return [...SCVS_RULES, ...CRA_RULES];
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

// Expose internal helpers for unit tests only.
export const __test = {
  componentLicenseId,
  inventoryComponents,
  looksLikeSpdx,
  collectReferencedRefs,
  compLabel,
};
