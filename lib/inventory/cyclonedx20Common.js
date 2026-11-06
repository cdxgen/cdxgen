/**
 * Small shared helpers for the CycloneDX 2.0 renderer and reader: type
 * guards, cloning, render counters and the environment-variable shape change.
 */

import { createHash } from "node:crypto";

/** True for a plain object (not null, not an array). */
export const isObjectRecord = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** True for a string with at least one character. */
export const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

/** structuredClone that passes `undefined` through. */
export const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);

// bomLinkElementType / bomLinkDocumentType values point into another document
// (#/$defs/cyclonedx-common-2.0/$defs/bomLink), so they never resolve here.
export const isBomLink = (value) =>
  typeof value === "string" && value.startsWith("urn:cdx:");

/**
 * A fresh, empty set of render counters.
 *
 * @param {object} [shadows] 2.0 originals kept by readCycloneDx20 (see
 *   takeShadow)
 * @param {{toolRefId?: string, timestamp?: string}} [claims] What identity
 *   claims are attributed with (see identityClaimContext)
 * @returns {object} Render counters
 */
export function createRenderStats(shadows, claims) {
  return {
    claims: isObjectRecord(claims) ? claims : {},
    customSchemes: new Set(),
    droppedMethods: [],
    drops: {},
    rewrites: {},
    formulaComponents: [],
    formulaMembership: [],
    shadows: isObjectRecord(shadows) ? shadows : {},
    shadowUse: new Map(),
  };
}

/**
 * The key a 1.x value is shadowed under: the SHA-256 of its JSON. The
 * reader and the renderer serialize the same object the same way, so an
 * unchanged value finds its 2.0 original again.
 *
 * @param {*} value 1.x value
 * @returns {string} Hex digest
 */
export function shadowKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The 2.0 original readCycloneDx20 kept for this unchanged 1.x value, as a
 * fresh clone, or undefined. Identical 1.x values kept for several originals
 * get them back in document order. Never mutates the stored shadows.
 *
 * @param {object} stats Render counters from createRenderStats
 * @param {string} kind Shadow namespace (component, metadata, …)
 * @param {*} value 1.x value about to be rendered
 * @returns {*} The 2.0 original or undefined
 */
export function takeShadow(stats, kind, value) {
  const byKind = stats.shadows[kind];
  if (!isObjectRecord(byKind) || value === undefined) {
    return undefined;
  }
  const key = shadowKey(value);
  const originals = byKind[key];
  if (!Array.isArray(originals)) {
    return undefined;
  }
  const useKey = `${kind}:${key}`;
  const used = stats.shadowUse.get(useKey) || 0;
  if (used >= originals.length) {
    return undefined;
  }
  stats.shadowUse.set(useKey, used + 1);
  return clone(originals[used]);
}

/**
 * The single 2.0 original readCycloneDx20 kept for this unchanged 1.x value,
 * as a fresh clone, or undefined. Unlike takeShadow nothing is consumed: the
 * reader registers a key here only when every entry it read under that key
 * had the same original, so the lookup does not depend on render order.
 *
 * @param {object} stats Render counters from createRenderStats
 * @param {string} kind Shadow namespace (identity)
 * @param {*} value 1.x value about to be rendered
 * @returns {*} The 2.0 original or undefined
 */
export function peekShadow(stats, kind, value) {
  const byKind = stats.shadows[kind];
  if (!isObjectRecord(byKind) || value === undefined) {
    return undefined;
  }
  const originals = byKind[shadowKey(value)];
  return Array.isArray(originals) && originals.length === 1
    ? clone(originals[0])
    : undefined;
}

/** Count one dropped or rewritten value under a stable label. */
export function countDrop(stats, label, count = 1) {
  stats.drops[label] = (stats.drops[label] || 0) + count;
}

/**
 * Count one value the render rewrote without losing data (a duplicate refId
 * turned into a reference, a retargeted annotation subject).
 */
export function countRewrite(stats, label, count = 1) {
  stats.rewrites[label] = (stats.rewrites[label] || 0) + count;
}

/**
 * Count a 1.x JSF `signature` the render leaves out: it signs the 1.x
 * serialization, so it cannot verify over the re-rendered 2.0 document, and
 * 2.0 `signatures` hold JSS signatures
 * (#/$defs/cyclonedx-common-2.0/$defs/signatures).
 */
export function countSignatureDrop(stats, path) {
  countDrop(
    stats,
    `${path} (1.x JSF signature: does not verify after re-rendering)`,
  );
}

/** Count every defined key of `source` that `handled` does not list. */
export function countUnmapped(stats, prefix, source, handled) {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !handled.has(key)) {
      countDrop(stats, `${prefix}.${key}`);
    }
  }
}

/** Clone the listed fields of `source` that are defined onto `target`. */
export function copyDefined(target, source, fields) {
  for (const field of fields) {
    if (source[field] !== undefined) {
      target[field] = clone(source[field]);
    }
  }
}

/** Remove duplicate entries (by JSON value) for `uniqueItems` arrays. */
export function uniqueByValue(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  }
  return unique;
}

/** Split a 1.x `author` string the way specVersionCompat does. */
export function authorStringToNames(authorValue) {
  if (typeof authorValue !== "string") {
    return [];
  }
  return authorValue
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** A 1.x scalar-or-array identifier field as a list of strings. */
export function identifierValues(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

/** Assign `value` to `out[key]` unless it is undefined. */
export function setDefined(out, key, value) {
  if (value !== undefined) {
    out[key] = value;
  }
}

/**
 * Convert a 1.x `environmentVars` array of {name, value} entries into the 2.0
 * map of names to values
 * (#/$defs/cyclonedx-formulation-2.0/$defs/environmentVars). Reverse for read.
 * Entries the map cannot hold are counted when `stats` is given.
 */
export function convertEnvironmentVars(value, stats) {
  if (Array.isArray(value)) {
    const mapped = {};
    for (const entry of value) {
      // A 1.x string entry becomes a name with a null value, which the 2.0
      // map allows.
      const name = typeof entry === "string" ? entry : entry?.name;
      if (!isObjectRecord(entry) && typeof entry !== "string") {
        countDropIf(stats, "environmentVars (not a name or {name, value})");
      } else if (typeof name !== "string") {
        countDropIf(stats, "environmentVars (no name)");
      } else if (Object.hasOwn(mapped, name)) {
        countDropIf(stats, "environmentVars (repeated name)");
      } else {
        mapped[name] = typeof entry?.value === "string" ? entry.value : null;
      }
    }
    return mapped;
  }
  return clone(value);
}

function countDropIf(stats, label) {
  if (stats) {
    countDrop(stats, label);
  }
}

/** Turn a 2.0 environmentVars map back into the 1.x {name, value} array. */
export function reverseEnvironmentVars(value) {
  if (!Array.isArray(value) && isObjectRecord(value)) {
    return Object.entries(value).map(([name, val]) => ({
      name,
      value: val === null ? undefined : val,
    }));
  }
  return value;
}

/** Every refId string declared anywhere under the given roots. */
export function collectDeclaredRefIds(roots) {
  const declared = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObjectRecord(node)) {
      return;
    }
    if (typeof node.refId === "string") {
      declared.add(node.refId);
    }
    for (const value of Object.values(node)) {
      visit(value);
    }
  };
  roots.forEach(visit);
  return declared;
}

/**
 * True when any `party` member (a refId string or a partyReference) or any
 * `ref` member below `node` names `refId`. Restored 2.0 originals reference
 * a derived party (see derivedPartyDeclarations) without passing through the
 * converters, so its declaration follows the rendered document rather than a
 * render flag.
 */
export function referencesParty(node, refId) {
  if (Array.isArray(node)) {
    return node.some((child) => referencesParty(child, refId));
  }
  if (!isObjectRecord(node)) {
    return false;
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      (key === "party" && (value === refId || value?.ref === refId)) ||
      (key === "ref" && value === refId) ||
      referencesParty(value, refId)
    ) {
      return true;
    }
  }
  return false;
}
