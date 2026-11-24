import { createHash } from "node:crypto";

/**
 * Subresource Integrity strings (`sha512-<base64>`), the form npm records in
 * lockfiles and `package.json` metadata as `integrity`. Several hashes may sit
 * in one string, separated by whitespace, and each may carry `?options`.
 */

const KNOWN_ALGORITHMS = new Set(["sha1", "sha256", "sha384", "sha512"]);

/**
 * Whether the text is a non-empty base64 digest: the standard alphabet and at
 * most two trailing padding characters.
 *
 * @param {string} digest Text to check
 * @returns {boolean} True for a base64 digest
 */
function isBase64Digest(digest) {
  let end = digest.length;
  while (end > 0 && digest[end - 1] === "=" && digest.length - end < 2) {
    end--;
  }
  if (end === 0) {
    return false;
  }
  for (let i = 0; i < end; i++) {
    const ch = digest[i];
    const isAlnum =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9");
    if (!isAlnum && ch !== "+" && ch !== "/") {
      return false;
    }
  }
  return true;
}

/**
 * Parse an integrity string into its hashes. A token that is not
 * `<algorithm>-<base64>`, names an algorithm other than sha1, sha256, sha384
 * or sha512, or has a malformed digest is skipped, and `?options` after the
 * digest are ignored.
 *
 * @param {string} str Integrity string, possibly holding several hashes
 * @returns {{algorithm: string, digest: string}[]} The valid hashes, in order
 */
export function parseIntegrity(str) {
  const hashes = [];
  if (typeof str !== "string") {
    return hashes;
  }
  for (const token of str.split(/\s+/)) {
    const dash = token.indexOf("-");
    if (dash < 1) {
      continue;
    }
    const algorithm = token.slice(0, dash).toLowerCase();
    if (!KNOWN_ALGORITHMS.has(algorithm)) {
      continue;
    }
    let digest = token.slice(dash + 1);
    const question = digest.indexOf("?");
    if (question !== -1) {
      digest = digest.slice(0, question);
    }
    if (isBase64Digest(digest)) {
      hashes.push({ algorithm, digest });
    }
  }
  return hashes;
}

/**
 * Compute the integrity string of some data.
 *
 * @param {string|Buffer|Uint8Array} data Content to hash (strings as UTF-8)
 * @param {string} [algorithm] Hash algorithm, sha512 by default
 * @returns {string} `<algorithm>-<base64 digest>`
 */
export function integrityOf(data, algorithm = "sha512") {
  return `${algorithm}-${createHash(algorithm).update(data).digest("base64")}`;
}
