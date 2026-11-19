/**
 * Words that make a name ending in `key` or `keys` a credential, as in
 * `api_key`, `signingKey` or `AWS_SECRET_ACCESS_KEY`. A name such as
 * `sort_key`, `primary_key` or `projectKey` names no secret, so `key` alone
 * does not qualify a name.
 *
 * @type {ReadonlyArray<string>}
 */
export declare const CREDENTIAL_KEY_QUALIFIERS: ReadonlyArray<string>;
/**
 * Source of a regular expression for a credential name that ends in `key` or
 * `keys`: a qualifier from CREDENTIAL_KEY_QUALIFIERS with an optional `-`,
 * `_` or `.` before `key`, or `key` standing alone. A `key` that follows
 * another word (`sort_key`, `cache.key`) is not matched, and neither is one
 * inside a word (`monkey`). Use it with the `i` flag.
 *
 * @type {string}
 */
export declare const CREDENTIAL_KEY_NAME_SOURCE: string;
/**
 * Whether a name ending in `key` or `keys` names a credential: the name is
 * `key` or `keys` itself, or the part before it is one of
 * CREDENTIAL_KEY_QUALIFIERS. Words are split at punctuation and camelCase, and
 * a qualifier written together with `key` (`apikey`) counts too.
 *
 * @param {unknown} name Property or field name
 * @returns {boolean} true for `key`, `api_key`, `signing.key` and the like
 */
export declare function isCredentialKeyName(name: unknown): boolean;
//# sourceMappingURL=credentialNames.d.ts.map