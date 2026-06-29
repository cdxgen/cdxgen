import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { DEFAULT_CDX_SPEC_VERSION } from "./bomUtils.js";
import {
  canonicalizeAST,
  correctLicenseId,
  isLicenseRef,
  parseSpdxExpression,
  renderAST,
  tokenize,
  upgradeDeprecatedAST,
} from "./spdxExpression.js";

let spdxLicenseList = null;
let licenseDb = null;
let licenseAliases = null;
let licenseDeprecations = null;

let url = import.meta?.url;
if (url && !url.startsWith("file://")) {
  url = new URL(`file://${import.meta.url}`).toString();
}
const dirNameStr = url
  ? dirname(dirname(dirname(fileURLToPath(url))))
  : __dirname;

function loadSpdxLicenseList() {
  if (!spdxLicenseList) {
    try {
      spdxLicenseList = JSON.parse(
        readFileSync(
          join(dirNameStr, "data", "spdx-license-list.json"),
          "utf-8",
        ),
      );
    } catch (_e) {
      spdxLicenseList = { licenses: {}, exceptions: {} };
    }
  }
  return spdxLicenseList;
}

function loadLicenseDb() {
  if (!licenseDb) {
    try {
      licenseDb = JSON.parse(
        readFileSync(join(dirNameStr, "data", "license-db.json"), "utf-8"),
      );
    } catch (_e) {
      licenseDb = {};
    }
  }
  return licenseDb;
}

function _loadLicenseAliases() {
  if (!licenseAliases) {
    try {
      licenseAliases = JSON.parse(
        readFileSync(join(dirNameStr, "data", "license-aliases.json"), "utf-8"),
      );
    } catch (_e) {
      licenseAliases = {};
    }
  }
  return licenseAliases;
}

function loadLicenseDeprecations() {
  if (!licenseDeprecations) {
    try {
      licenseDeprecations = JSON.parse(
        readFileSync(
          join(dirNameStr, "data", "license-deprecations.json"),
          "utf-8",
        ),
      );
    } catch (_e) {
      licenseDeprecations = {};
    }
  }
  return licenseDeprecations;
}

const FOSS_CATEGORIES = new Set([
  "Copyleft",
  "Copyleft Limited",
  "Patent License",
  "Permissive",
  "Public Domain",
  "CLA",
]);

/**
 * Parses a compliance policy file.
 *
 * @param {string} policyPath Path to policy file
 * @returns {object|null} Parsed policy object
 */
export function loadPolicy(policyPath) {
  if (!policyPath) return null;
  try {
    const content = readFileSync(policyPath, "utf-8");
    return parseYaml(content);
  } catch (err) {
    console.error(
      `Failed to load license policy from ${policyPath}: ${err.message}`,
    );
    return null;
  }
}

export { parseSpdxExpression };

/**
 * Resolves a raw license ID or expression to a CycloneDX license object shape.
 *
 * @param {string} raw Raw license string
 * @param {object} opts Options
 * @returns {object|null} Resolved license object: { id } or { expression } or { name }
 */
export function resolveLicenseId(raw, opts = {}) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. URL check
  if (trimmed.startsWith("http")) {
    const spdxList = loadSpdxLicenseList();
    const cleanUrl = trimmed.toLowerCase().replace(/\/$/, "");
    for (const [id, meta] of Object.entries(spdxList.licenses)) {
      if (meta.seeAlso) {
        for (const u of meta.seeAlso) {
          if (u.trim().toLowerCase().replace(/\/$/, "") === cleanUrl) {
            return { id, url: trimmed };
          }
        }
      }
    }

    if (opts.getKnownLicense) {
      const known = opts.getKnownLicense(trimmed, opts.pkg || {});
      if (known) {
        const res = {};
        if (known.id) res.id = known.id;
        if (known.name) res.name = known.name;
        res.url = trimmed;
        return res;
      }
    }

    return { name: "CUSTOM", url: trimmed };
  }

  // 2. Parser check for complex expression
  const tokens = tokenize(trimmed);
  const hasOperators = tokens.some((t) => {
    const u = t.toUpperCase();
    return u === "AND" || u === "OR" || u === "WITH";
  });

  if (hasOperators || tokens.includes("(") || tokens.includes(")")) {
    const parsed = parseSpdxExpression(trimmed);
    if (parsed.ast) {
      const upgradedAST = upgradeDeprecatedAST(parsed.ast);
      const canonicalAST = canonicalizeAST(upgradedAST);
      const normalizedExpr = renderAST(canonicalAST);
      return { expression: normalizedExpr };
    }
  }

  // 3. Simple identifier/alias check
  const corrected = correctLicenseId(trimmed);
  if (corrected) {
    const upgraded = upgradeDeprecated(corrected);
    if (
      upgraded.includes(" ") ||
      upgraded.includes("WITH") ||
      upgraded.includes("AND") ||
      upgraded.includes("OR")
    ) {
      return { expression: upgraded };
    }
    // LicenseRef-* identifiers are not valid SPDX ids and must not be placed in
    // the CycloneDX `id` field. Emit them as an `expression` when LicenseRef
    // synthesis is enabled, otherwise fall through so the original name/text is
    // preserved (avoids producing schema-invalid BOMs).
    if (isLicenseRef(upgraded)) {
      if (opts.licenseRef) {
        return { expression: upgraded };
      }
      return null;
    }
    const res = { id: upgraded };
    res.url = `https://opensource.org/licenses/${upgraded}`;
    return res;
  }

  // 4. Fallback: synthesize LicenseRef if enabled
  if (opts.licenseRef) {
    const slug = makeRefSlug(trimmed);
    if (slug) {
      return { expression: `LicenseRef-cdxgen-${slug}` };
    }
  }

  return null;
}

function makeRefSlug(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Upgrades deprecated SPDX license identifiers or expressions.
 *
 * @param {string} idOrExpr License ID or expression
 * @returns {string} Upgraded identifier or expression
 */
export function upgradeDeprecated(idOrExpr) {
  if (!idOrExpr) return idOrExpr;

  const tokens = tokenize(idOrExpr);
  const hasOperators = tokens.some((t) => {
    const u = t.toUpperCase();
    return u === "AND" || u === "OR" || u === "WITH";
  });

  if (hasOperators || tokens.includes("(") || tokens.includes(")")) {
    const parsed = parseSpdxExpression(idOrExpr);
    if (parsed.ast) {
      const upgradedAST = upgradeDeprecatedAST(parsed.ast);
      const canonicalAST = canonicalizeAST(upgradedAST);
      return renderAST(canonicalAST);
    }
  }

  const deprecations = loadLicenseDeprecations();
  const canonical = getCanonicalId(idOrExpr);
  const repl =
    deprecations[idOrExpr] ||
    deprecations[idOrExpr.toLowerCase()] ||
    (canonical && deprecations[canonical]);
  if (repl) {
    return repl;
  }
  return canonical || idOrExpr;
}

// Memoized lowercase lookup maps to avoid O(n) scans on every license.
let spdxLowerMap = null;
let dbKeyLowerMap = null;
let dbBySpdxLowerMap = null;

function getSpdxLowerMap() {
  if (!spdxLowerMap) {
    spdxLowerMap = new Map();
    for (const [id, entry] of Object.entries(loadSpdxLicenseList().licenses)) {
      spdxLowerMap.set(id.toLowerCase(), { id, entry });
    }
  }
  return spdxLowerMap;
}

function getDbKeyLowerMap() {
  if (!dbKeyLowerMap) {
    dbKeyLowerMap = new Map();
    const db = loadLicenseDb();
    for (const key of Object.keys(db)) {
      dbKeyLowerMap.set(key.toLowerCase(), db[key].spdx_license_key);
    }
  }
  return dbKeyLowerMap;
}

function getDbBySpdxLowerMap() {
  if (!dbBySpdxLowerMap) {
    dbBySpdxLowerMap = new Map();
    for (const entry of Object.values(loadLicenseDb())) {
      if (entry.spdx_license_key) {
        const k = entry.spdx_license_key.toLowerCase();
        // First entry wins to keep behavior deterministic.
        if (!dbBySpdxLowerMap.has(k)) {
          dbBySpdxLowerMap.set(k, entry);
        }
      }
    }
  }
  return dbBySpdxLowerMap;
}

function getCanonicalId(id) {
  if (!id) return null;
  const lower = id.toLowerCase();
  const spdxHit = getSpdxLowerMap().get(lower);
  if (spdxHit) {
    return spdxHit.id;
  }
  const dbHit = getDbKeyLowerMap().get(lower);
  if (dbHit) {
    return dbHit;
  }
  return null;
}

/**
 * Normalizes a single CycloneDX license object or string.
 *
 * @param {object|string} license License object or string
 * @param {object} opts Options
 * @returns {object} Normalized license object
 */
export function normalizeLicense(license, opts = {}) {
  if (!license) return license;

  if (typeof license === "string") {
    const resolved = resolveLicenseId(license, opts);
    if (resolved) {
      return resolved;
    }
    return { name: license };
  }

  if (license.license && typeof license.license === "object") {
    const resLic = normalizeLicense(license.license, opts);
    // CycloneDX requires an SPDX expression at the license-choice level
    // ({ expression }), not nested inside `license`. When the inner license
    // resolves to an expression, hoist it and drop the `license` wrapper to
    // keep the BOM schema-valid.
    if (resLic?.expression) {
      const hoisted = { expression: resLic.expression };
      if (license.acknowledgement) {
        hoisted.acknowledgement = license.acknowledgement;
      }
      if (license["bom-ref"]) {
        hoisted["bom-ref"] = license["bom-ref"];
      }
      return hoisted;
    }
    return { ...license, license: resLic };
  }

  const result = { ...license };
  if (result.expression) {
    const resolved = resolveLicenseId(result.expression, opts);
    if (resolved?.expression) {
      result.expression = resolved.expression;
      delete result.id;
      delete result.name;
    }
  } else if (result.id) {
    const resolved = resolveLicenseId(result.id, opts);
    if (resolved) {
      if (resolved.id) {
        if (result.id !== resolved.id) {
          delete result.url;
        }
        result.id = resolved.id;
        delete result.name;
        delete result.expression;
      } else if (resolved.expression) {
        result.expression = resolved.expression;
        delete result.id;
        delete result.name;
      }
    }
  } else if (result.name) {
    const resolved = resolveLicenseId(result.name, opts);
    if (resolved) {
      if (resolved.id) {
        result.id = resolved.id;
        delete result.name;
        delete result.expression;
      } else if (resolved.expression) {
        result.expression = resolved.expression;
        delete result.id;
        delete result.name;
      }
    } else if (opts.licenseRef) {
      const slug = makeRefSlug(result.name);
      if (slug) {
        result.expression = `LicenseRef-cdxgen-${slug}`;
        delete result.id;
        delete result.name;
      }
    }
  }
  if (
    result.id &&
    !result.id.toLowerCase().startsWith("licenseref-") &&
    !result.url
  ) {
    result.url = `https://opensource.org/licenses/${result.id}`;
  }
  return result;
}

/**
 * Normalizes and deduplicates a component's licenses array.
 *
 * @param {object} component CycloneDX Component
 * @param {object} opts Options
 * @returns {object} Modified component
 */
export function enhanceComponentLicenses(component, opts = {}) {
  if (!component?.licenses) return component;

  const compOpts = {
    ...opts,
    pkg: {
      name: component.name,
      group: component.group,
      purl: component.purl,
    },
  };

  const rawLicenses = Array.isArray(component.licenses)
    ? component.licenses
    : [component.licenses];

  const normalized = rawLicenses
    .map((l) => normalizeLicense(l, compOpts))
    .filter(Boolean);

  const seen = new Set();
  const deduped = [];
  for (const l of normalized) {
    const core = l.license || l;
    const key = core.expression
      ? `expr:${core.expression}`
      : core.id
        ? `id:${core.id}`
        : `name:${core.name}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(l);
    }
  }

  // Pre-1.7 schemas require a single SPDX-expression tuple when an expression is
  // present; 1.7 permits a mixed list, so only collapse when asked.
  component.licenses = opts._collapseLicenses
    ? collapseLicenseChoice(deduped)
    : deduped;
  return component;
}

/**
 * Combines license-choice entries into a single SPDX expression operand string,
 * AND-ing the operands (matching the CycloneDX schema example
 * `Apache-2.0 AND (MIT OR GPL-2.0-only)`). Sub-expressions containing AND/OR are
 * parenthesized. Named (non-SPDX) licenses cannot be valid expression operands
 * and are omitted.
 *
 * @param {object[]} entries normalized license-choice entries
 * @returns {string|null} combined expression, or null when no valid operands
 */
function combineLicensesToExpression(entries) {
  const operands = [];
  for (const entry of entries) {
    if (entry.expression) {
      operands.push(
        /\b(AND|OR)\b/i.test(entry.expression)
          ? `(${entry.expression})`
          : entry.expression,
      );
      continue;
    }
    const core = entry.license || entry;
    if (core.id) {
      operands.push(core.id);
    }
  }
  return operands.length ? operands.join(" AND ") : null;
}

/**
 * Enforces the CycloneDX license-choice rule: a `licenses` array is EITHER a
 * list of `{license:{id|name}}` objects OR a single-element tuple holding one
 * `{expression}`. When normalization yields an expression mixed with other
 * entries (or multiple entries with an expression), collapse everything into a
 * single combined expression so the BOM stays schema-valid.
 *
 * @param {object[]} entries normalized license-choice entries
 * @returns {object[]} a schema-valid license-choice array
 */
function collapseLicenseChoice(entries) {
  if (!Array.isArray(entries) || entries.length <= 1) {
    return entries;
  }
  if (!entries.some((entry) => entry.expression)) {
    // Pure list of id/name licenses is already a valid choice.
    return entries;
  }
  const combined = combineLicensesToExpression(entries);
  return combined ? [{ expression: combined }] : entries;
}

function getComplianceAlert(licenseId, category, policy) {
  if (!policy?.license_policies) return null;
  const idLower = licenseId ? licenseId.toLowerCase() : "";
  const catLower = category ? category.toLowerCase() : "";

  for (const entry of policy.license_policies) {
    if (entry.license_key && entry.license_key.toLowerCase() === idLower) {
      return normalizeAlertLabel(entry.label || entry.compliance_alert);
    }
  }

  for (const entry of policy.license_policies) {
    if (entry.category && entry.category.toLowerCase() === catLower) {
      return normalizeAlertLabel(entry.label || entry.compliance_alert);
    }
  }

  return null;
}

function normalizeAlertLabel(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (
    l.includes("approve") ||
    l.includes("pass") ||
    l.includes("allow") ||
    l === "green"
  ) {
    return "pass";
  }
  if (l.includes("restrict") || l.includes("warn") || l === "yellow") {
    return "warning";
  }
  if (
    l.includes("prohibit") ||
    l.includes("error") ||
    l.includes("fail") ||
    l.includes("deny") ||
    l.includes("reject") ||
    l === "red"
  ) {
    return "error";
  }
  return label;
}

/**
 * Opt-in: enriches a license object with metadata properties and compliance policy.
 *
 * @param {object} licenseWrapper License wrapper object
 * @param {object} policy Compliance policy
 * @param {object} opts Options
 * @returns {object} Enriched license wrapper
 */
export function enrichLicenseMetadata(licenseWrapper, policy, _opts = {}) {
  if (!licenseWrapper) return licenseWrapper;

  const core = licenseWrapper.license || licenseWrapper;
  if (!core || core.expression) {
    return licenseWrapper;
  }

  const id = core.id;
  const name = core.name;

  let category = "Unstated License";
  let osiApproved = "false";
  let fsfLibre = "false";
  let deprecated = "false";

  let dbEntry = null;
  if (id) {
    dbEntry = getDbBySpdxLowerMap().get(id.toLowerCase()) || null;
  } else if (name) {
    const alias = correctLicenseId(name);
    if (alias) {
      dbEntry = getDbBySpdxLowerMap().get(alias.toLowerCase()) || null;
    }
  }

  if (dbEntry) {
    category = dbEntry.category || "Unstated License";
    deprecated = dbEntry.is_deprecated ? "true" : "false";
    if (dbEntry.osi_url) {
      osiApproved = "true";
    }
  }

  const spdxHit = id ? getSpdxLowerMap().get(id.toLowerCase()) : null;
  if (spdxHit) {
    const spdxEntry = spdxHit.entry;
    osiApproved = spdxEntry.isOsiApproved ? "true" : "false";
    fsfLibre = spdxEntry.isFsfLibre ? "true" : "false";
    deprecated = spdxEntry.isDeprecated ? "true" : "false";
  }

  const foss = FOSS_CATEGORIES.has(category) ? "true" : "false";
  const alert = getComplianceAlert(id || name, category, policy);

  if (!core.properties) {
    core.properties = [];
  }

  const props = [
    { name: "cdx:license:category", value: category },
    { name: "cdx:license:foss", value: foss },
    { name: "cdx:license:osiApproved", value: osiApproved },
    { name: "cdx:license:fsfLibre", value: fsfLibre },
    { name: "cdx:license:deprecated", value: deprecated },
  ];

  if (alert) {
    props.push({ name: "cdx:license:complianceAlert", value: alert });
  }

  for (const p of props) {
    const idx = core.properties.findIndex((item) => item.name === p.name);
    if (idx >= 0) {
      core.properties[idx].value = p.value;
    } else {
      core.properties.push(p);
    }
  }

  return licenseWrapper;
}

/**
 * Walks a whole BOM and enhances all metadata and component licenses.
 *
 * @param {object} bom CycloneDX BOM JSON Object
 * @param {object} opts Options
 * @returns {object} Enhanced BOM
 */
export function enhanceBom(bom, opts = {}) {
  if (!bom) return bom;

  const policy = opts.licensePolicy ? loadPolicy(opts.licensePolicy) : null;

  // CycloneDX 1.7 allows a mixed list of named licenses and SPDX expressions in
  // the same `licenses` array, so we preserve that granularity. Pre-1.7 schemas
  // require a single SPDX-expression tuple, so collapse mixed entries there.
  const specVersion = Number(
    opts.specVersion ?? bom.specVersion ?? DEFAULT_CDX_SPEC_VERSION,
  );
  const effectiveOpts = {
    ...opts,
    _collapseLicenses: Number.isFinite(specVersion) && specVersion < 1.7,
  };

  if (bom.metadata?.component) {
    enhanceComponent(bom.metadata.component, policy, effectiveOpts);
  }

  if (bom.metadata?.licenses) {
    const rawLicenses = Array.isArray(bom.metadata.licenses)
      ? bom.metadata.licenses
      : [bom.metadata.licenses];

    const normalizedMeta = rawLicenses
      .map((l) => {
        const normalized = normalizeLicense(l, effectiveOpts);
        if (effectiveOpts.licenseEnrich) {
          enrichLicenseMetadata(normalized, policy, effectiveOpts);
        }
        return normalized;
      })
      .filter(Boolean);
    bom.metadata.licenses = effectiveOpts._collapseLicenses
      ? collapseLicenseChoice(normalizedMeta)
      : normalizedMeta;
  }

  if (bom.components && Array.isArray(bom.components)) {
    for (const comp of bom.components) {
      enhanceComponent(comp, policy, effectiveOpts);
    }
  }

  return bom;
}

function enhanceComponent(component, policy, opts) {
  if (!component) return;

  if (opts.licenseEnhance !== false) {
    enhanceComponentLicenses(component, opts);
  }

  if (opts.licenseEnrich && component.licenses) {
    let componentWorstAlert = null;
    const categories = new Set();

    for (const l of component.licenses) {
      enrichLicenseMetadata(l, policy, opts);

      const core = l.license || l;
      if (core.properties) {
        const catProp = core.properties.find(
          (p) => p.name === "cdx:license:category",
        );
        if (catProp) categories.add(catProp.value);

        const alertProp = core.properties.find(
          (p) => p.name === "cdx:license:complianceAlert",
        );
        if (alertProp) {
          componentWorstAlert = getWorstAlert(
            componentWorstAlert,
            alertProp.value,
          );
        }
      }
    }

    if (!componentWorstAlert && policy) {
      for (const l of component.licenses) {
        const core = l.license || l;
        if (core.expression) {
          const parsed = parseSpdxExpression(core.expression);
          if (parsed.ast) {
            const operands = [];
            collectASTOperands(parsed.ast, operands);
            for (const op of operands) {
              const alert = getComplianceAlert(op, null, policy);
              if (alert) {
                componentWorstAlert = getWorstAlert(componentWorstAlert, alert);
              }
            }
          }
        }
      }
    }

    if (categories.size > 0) {
      setComponentProperty(
        component,
        "cdx:license:category",
        Array.from(categories).join(", "),
      );
    }
    if (componentWorstAlert) {
      setComponentProperty(
        component,
        "cdx:license:complianceAlert",
        componentWorstAlert,
      );
    }
  }

  if (component.components && Array.isArray(component.components)) {
    for (const sub of component.components) {
      enhanceComponent(sub, policy, opts);
    }
  }
}

function getWorstAlert(current, next) {
  if (!current) return next;
  if (!next) return current;
  const levels = { error: 3, warning: 2, pass: 1 };
  const currentVal = levels[current] || 0;
  const nextVal = levels[next] || 0;
  return nextVal > currentVal ? next : current;
}

function setComponentProperty(component, name, value) {
  if (!component.properties) {
    component.properties = [];
  }
  const idx = component.properties.findIndex((p) => p.name === name);
  if (idx >= 0) {
    component.properties[idx].value = value;
  } else {
    component.properties.push({ name, value });
  }
}

function collectASTOperands(node, operands) {
  if (node.type === "License") {
    operands.push(node.id);
  } else if (node.type === "With") {
    collectASTOperands(node.license, operands);
  } else if (node.type === "And" || node.type === "Or") {
    collectASTOperands(node.left, operands);
    collectASTOperands(node.right, operands);
  }
}

/**
 * Looks up the ScanCode category for a license identifier from the bundled
 * database.
 *
 * @param {string} id SPDX license identifier
 * @returns {string|null} Category label or null
 */
function getLicenseCategory(id) {
  if (!id) {
    return null;
  }
  const entry = getDbBySpdxLowerMap().get(id.toLowerCase());
  return entry?.category || null;
}

const ALERT_RANK = { error: 3, warning: 2, pass: 1 };

/**
 * Evaluates a single license object (`{id}`, `{name}`, or `{expression}`)
 * against a compliance policy.
 *
 * @param {object} core License object
 * @param {object} policy Parsed policy
 * @returns {object|null} { license, category, alert } or null when no alert
 */
function evaluateLicensePolicy(core, policy) {
  if (!core) {
    return null;
  }
  if (core.expression) {
    const parsed = parseSpdxExpression(core.expression);
    if (!parsed.ast) {
      return null;
    }
    const operands = [];
    collectASTOperands(parsed.ast, operands);
    let worstAlert = null;
    let worstCategory = null;
    for (const op of operands) {
      const category = getLicenseCategory(op);
      const alert = getComplianceAlert(op, category, policy);
      if (
        alert &&
        (!worstAlert || ALERT_RANK[alert] > ALERT_RANK[worstAlert])
      ) {
        worstAlert = alert;
        worstCategory = category;
      }
    }
    return worstAlert
      ? { license: core.expression, category: worstCategory, alert: worstAlert }
      : null;
  }
  const display = core.id || core.name;
  if (!display) {
    return null;
  }
  const id = core.id || correctLicenseId(core.name);
  const category = getLicenseCategory(id);
  const alert = getComplianceAlert(id || core.name, category, policy);
  return alert ? { license: display, category, alert } : null;
}

/**
 * Walks every component license in a BOM and returns the entries that violate
 * the supplied compliance policy (alert `error`, or `warning` when
 * `includeWarnings` is set). Recurses into nested components and the metadata
 * component.
 *
 * @param {object} bom CycloneDX BOM
 * @param {object} policy Parsed policy object (see loadPolicy)
 * @param {object} [opts] { includeWarnings?: boolean }
 * @returns {object[]} Violations: { ref, name, version, license, category, alert }
 */
export function collectPolicyViolations(bom, policy, opts = {}) {
  if (!bom || !policy) {
    return [];
  }
  const minRank = opts.includeWarnings === true ? 2 : 3;
  const violations = [];
  const visit = (component) => {
    if (!component) {
      return;
    }
    const licenses = Array.isArray(component.licenses)
      ? component.licenses
      : component.licenses
        ? [component.licenses]
        : [];
    for (const l of licenses) {
      const core = l.license || l;
      const evaluated = evaluateLicensePolicy(core, policy);
      if (evaluated && (ALERT_RANK[evaluated.alert] || 0) >= minRank) {
        violations.push({
          ref:
            component.purl ||
            component["bom-ref"] ||
            component.name ||
            "unknown",
          name: component.name,
          version: component.version,
          ...evaluated,
        });
      }
    }
    for (const sub of component.components || []) {
      visit(sub);
    }
  };
  visit(bom?.metadata?.component);
  for (const component of bom?.components || []) {
    visit(component);
  }
  return violations;
}
