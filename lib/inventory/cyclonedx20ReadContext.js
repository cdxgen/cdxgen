/**
 * Shared state and the field-mapping engine of the CycloneDX 2.0 reader.
 *
 * Every 2.0 object kind the reader converts has a frozen field spec: the
 * allowlist of the members the 1.x model carries, with the 1.x name or the
 * converter for each. `reverseFields` walks the object's own members in
 * document order and reports every member the spec does not list as a loss,
 * so a field the reader has no mapping for can never vanish silently.
 *
 * Loss pointers are RFC 6901 JSON pointers into the 2.0 input, with array
 * indexes and `~`/`/` escaped.
 */

import { clone, isObjectRecord, shadowKey } from "./cyclonedx20Common.js";

/**
 * A fresh reader context for one 2.0 document.
 *
 * @param {object} doc The (private, cloned) 2.0 document
 * @returns {object} Reader context
 */
export function createReadContext(doc) {
  return {
    doc,
    losses: [],
    shadows: {},
    keptComponents: [],
    keptIdentities: [],
    // What renderCycloneDx20 attributes cdxgen's identity claims with; set
    // from the read metadata (identityClaimContext).
    claims: {},
    shadowSuspended: false,
    partyIndex: indexParties(doc),
    licenseIndex: indexLicenses(doc),
  };
}

/**
 * Map refId → {entry, pointer} for every party declared anywhere in the
 * document (definitions.parties first, then inline `parties` lists), so a
 * partyReference resolves wherever its party is declared.
 */
function indexParties(doc) {
  const index = new Map();
  const add = (entry, pointer) => {
    if (
      isObjectRecord(entry) &&
      typeof entry.refId === "string" &&
      entry.ref === undefined &&
      !index.has(entry.refId)
    ) {
      index.set(entry.refId, { entry, pointer });
    }
  };
  (Array.isArray(doc.definitions?.parties)
    ? doc.definitions.parties
    : []
  ).forEach((entry, i) => {
    add(entry, jsonPointer("/definitions/parties", i));
  });
  const visit = (node, pointer) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        visit(child, jsonPointer(pointer, i));
      });
      return;
    }
    if (!isObjectRecord(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const childPointer = jsonPointer(pointer, key);
      if (key === "parties" && Array.isArray(value)) {
        value.forEach((entry, i) => {
          add(entry, jsonPointer(childPointer, i));
        });
      }
      visit(value, childPointer);
    }
  };
  visit(doc, "");
  return index;
}

/**
 * Map refId → {entry, pointer} for definitions.licenses; a license
 * declaration's refId sits on the expression or on the license object.
 */
function indexLicenses(doc) {
  const index = new Map();
  const licenses = Array.isArray(doc.definitions?.licenses)
    ? doc.definitions.licenses
    : [];
  licenses.forEach((entry, i) => {
    const refId = entry?.refId ?? entry?.license?.refId;
    if (typeof refId === "string" && !index.has(refId)) {
      index.set(refId, {
        entry,
        pointer: jsonPointer("/definitions/licenses", i),
      });
    }
  });
  return index;
}

/**
 * Append reference tokens to a JSON pointer (RFC 6901): `~` becomes `~0` and
 * `/` becomes `~1`; array indexes are plain numbers.
 *
 * @param {string} base Pointer so far ("" is the whole document)
 * @param {...(string|number)} tokens Member names or array indexes
 * @returns {string} The extended pointer
 */
export function jsonPointer(base, ...tokens) {
  let pointer = base;
  for (const token of tokens) {
    pointer += `/${String(token).replaceAll("~", "~0").replaceAll("/", "~1")}`;
  }
  return pointer;
}

/** Record one loss. */
export function addLoss(ctx, pointer, reason) {
  ctx.losses.push({ pointer, reason });
}

/**
 * Report every defined member of `source` that `carried` does not list.
 *
 * @param {object} ctx Reader context
 * @param {string} kind 2.0 object kind, used in the reason
 * @param {object} source 2.0 object
 * @param {string} pointer JSON pointer of `source`
 * @param {Set<string>|object} carried Member names (a Set or spec keys)
 */
export function reportUnmapped(ctx, kind, source, pointer, carried) {
  const has = (key) =>
    carried instanceof Set ? carried.has(key) : Object.hasOwn(carried, key);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !has(key)) {
      addLoss(
        ctx,
        jsonPointer(pointer, key),
        `${kind}.${key} has no 1.x field`,
      );
    }
  }
}

/**
 * Convert one 2.0 object with a field spec. A spec maps each carried 2.0
 * member to `true` (copied under the same name), a string (copied under that
 * 1.x name) or `{to?, spread?, convert}` where
 * `convert(ctx, value, pointer, source)` returns the 1.x value or undefined
 * (and reports its own losses); a `spread` rule returns an object of 1.x
 * members to merge (one 2.0 member feeding several 1.x fields). Members
 * the spec does not list are reported through reportUnmapped.
 *
 * @param {object} ctx Reader context
 * @param {string} kind 2.0 object kind
 * @param {object} source 2.0 object
 * @param {string} pointer JSON pointer of `source`
 * @param {object} spec Frozen field spec
 * @returns {object} The 1.x object
 */
export function reverseFields(ctx, kind, source, pointer, spec) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !Object.hasOwn(spec, key)) {
      continue;
    }
    const rule = spec[key];
    if (rule === true) {
      out[key] = clone(value);
    } else if (typeof rule === "string") {
      out[rule] = clone(value);
    } else {
      const converted = rule.convert(
        ctx,
        value,
        jsonPointer(pointer, key),
        source,
      );
      if (converted !== undefined && rule.spread) {
        Object.assign(out, converted);
      } else if (converted !== undefined) {
        out[rule.to ?? key] = converted;
      }
    }
  }
  reportUnmapped(ctx, kind, source, pointer, spec);
  return out;
}

/**
 * Convert each entry of a 2.0 array with `convertEntry(ctx, entry, pointer)`,
 * dropping entries that convert to undefined. A non-array is a loss.
 */
export function reverseList(ctx, value, pointer, convertEntry) {
  if (!Array.isArray(value)) {
    addLoss(ctx, pointer, "expected an array");
    return undefined;
  }
  const out = [];
  value.forEach((entry, index) => {
    const converted = convertEntry(ctx, entry, jsonPointer(pointer, index));
    if (converted !== undefined) {
      out.push(converted);
    }
  });
  return out.length ? out : undefined;
}

/** A spec rule converting an array entry by entry. */
export function listOf(convertEntry, to) {
  return Object.freeze({
    to,
    convert: (ctx, value, pointer) =>
      reverseList(ctx, value, pointer, convertEntry),
  });
}

/** A spec rule converting a nested object with its own spec. */
export function objectOf(kind, spec, to) {
  return Object.freeze({
    to,
    convert: (ctx, value, pointer) =>
      reverseObject(ctx, kind, value, pointer, spec),
  });
}

/** reverseFields for a value that must be an object; a loss otherwise. */
export function reverseObject(ctx, kind, value, pointer, spec) {
  if (!isObjectRecord(value)) {
    addLoss(ctx, pointer, `${kind} is not an object`);
    return undefined;
  }
  const out = reverseFields(ctx, kind, value, pointer, spec);
  return Object.keys(out).length ? out : undefined;
}

/** Keep `original` for the 1.x value `internal` in namespace `kind`. */
export function registerShadow(ctx, kind, internal, original) {
  registerShadowKey(ctx, kind, shadowKey(internal), original);
}

/** Keep `original` under a precomputed shadow key. */
export function registerShadowKey(ctx, kind, key, original) {
  const byKind = (ctx.shadows[kind] ||= {});
  (byKind[key] ||= []).push(original);
}

/**
 * Run `read()` with component shadows suspended: for section entries that
 * are restored whole, whose nested components the renderer never converts.
 */
export function withoutComponentShadows(ctx, read) {
  const previous = ctx.shadowSuspended;
  ctx.shadowSuspended = true;
  try {
    return read();
  } finally {
    ctx.shadowSuspended = previous;
  }
}
