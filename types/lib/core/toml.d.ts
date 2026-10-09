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
/**
 * Parse a TOML document into plain objects.
 *
 * @param {string} text TOML source
 * @returns {Object} parsed document whose tables use `Object.prototype`
 */
export declare function parseToml(text: string): Object;
//# sourceMappingURL=toml.d.ts.map