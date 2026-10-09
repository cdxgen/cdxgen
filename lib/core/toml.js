/**
 * TOML parsing with stable, ordinary objects.
 *
 * smol-toml 1.9 began returning tables and inline tables with a `null`
 * prototype so that a hostile `__proto__` key in a manifest cannot pollute
 * `Object.prototype`. The SBOM data itself is unaffected, but cdxgen hands
 * parsed manifests straight to callers (and `assert.deepStrictEqual` in the
 * test suite), which compare by prototype and would see every table as a
 * different kind of value. Re-wrapping the parse result with the standard
 * prototype keeps the pre-1.9 contract: plain objects all the way down,
 * `__proto__` keys included as ordinary own properties.
 */

import { parse as smolParse } from "smol-toml";

/**
 * Recursively rebuild a parsed value with `Object.prototype` roots.
 *
 * Class instances other than plain tables (smol-toml dates, strings, numbers)
 * are passed through untouched, and arrays are copied only when an element
 * actually changes, so unmodified branches keep their original identity.
 *
 * @param {unknown} value value produced by smol-toml's parse
 * @returns {unknown} the same data with plain-prototype objects
 */
function toPlainPrototype(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = toPlainPrototype(value[i]);
      if (out[i] !== value[i]) {
        changed = true;
      }
    }
    return changed ? out : value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__") {
      // Plain assignment would re-point the new object's prototype instead
      // of recording the key, reintroducing the pollution smol-toml guards
      // against.
      Object.defineProperty(out, key, {
        value: toPlainPrototype(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[key] = toPlainPrototype(entry);
    }
  }
  return out;
}

/**
 * Parse a TOML document into plain objects.
 *
 * @param {string} text TOML source
 * @returns {Object} parsed document whose tables use `Object.prototype`
 */
export function parseToml(text) {
  return toPlainPrototype(smolParse(text));
}
