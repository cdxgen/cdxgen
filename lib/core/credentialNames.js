/**
 * Words that make a name ending in `key` or `keys` a credential, as in
 * `api_key`, `signingKey` or `AWS_SECRET_ACCESS_KEY`. A name such as
 * `sort_key`, `primary_key` or `projectKey` names no secret, so `key` alone
 * does not qualify a name.
 *
 * @type {ReadonlyArray<string>}
 */
export const CREDENTIAL_KEY_QUALIFIERS = Object.freeze([
  "access",
  "account",
  "aes",
  "api",
  "auth",
  "bearer",
  "client",
  "decrypt",
  "decryption",
  "deploy",
  "encrypt",
  "encryption",
  "gpg",
  "hmac",
  "jwt",
  "license",
  "master",
  "pgp",
  "private",
  "root",
  "rsa",
  "secret",
  "service",
  "session",
  "shared",
  "sign",
  "signing",
  "ssh",
  "storage",
  "subscription",
  "webhook",
]);

const QUALIFIER_SET = new Set(CREDENTIAL_KEY_QUALIFIERS);

/**
 * Source of a regular expression for a credential name that ends in `key` or
 * `keys`: a qualifier from CREDENTIAL_KEY_QUALIFIERS with an optional `-`,
 * `_` or `.` before `key`, or `key` standing alone. A `key` that follows
 * another word (`sort_key`, `cache.key`) is not matched, and neither is one
 * inside a word (`monkey`). Use it with the `i` flag.
 *
 * @type {string}
 */
export const CREDENTIAL_KEY_NAME_SOURCE = `(?:(?:${CREDENTIAL_KEY_QUALIFIERS.join("|")})[-_.]?keys?|(?<![a-z0-9_.-])keys?)`;

function splitNameWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Whether a name ending in `key` or `keys` names a credential: the name is
 * `key` or `keys` itself, or the part before it is one of
 * CREDENTIAL_KEY_QUALIFIERS. Words are split at punctuation and camelCase, and
 * a qualifier written together with `key` (`apikey`) counts too.
 *
 * @param {unknown} name Property or field name
 * @returns {boolean} true for `key`, `api_key`, `signing.key` and the like
 */
export function isCredentialKeyName(name) {
  const words = splitNameWords(name);
  const last = words.at(-1);
  if (!last) {
    return false;
  }
  let stem;
  if (last === "key" || last === "keys") {
    stem = "";
  } else if (last.endsWith("keys")) {
    stem = last.slice(0, -4);
  } else if (last.endsWith("key")) {
    stem = last.slice(0, -3);
  } else {
    return false;
  }
  if (stem) {
    return QUALIFIER_SET.has(stem);
  }
  return words.length === 1 || QUALIFIER_SET.has(words.at(-2));
}
