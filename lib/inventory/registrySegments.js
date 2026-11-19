/**
 * Checks for the names and versions that are appended to the URL of a package
 * registry.
 *
 * Layer 2. The names come from lockfiles, manifests and purls of the scanned
 * project, and the registry URL may carry the operator's credential. A value
 * that is not exactly one path segment (a `.` or `..` segment, a further `/`,
 * a `\`, a `?`, a `#` or a `%`) would let the project choose another path on
 * the registry host, so callers make no request for it. Encoding a value is
 * not enough: `encodeURIComponent` leaves `..` as it is.
 */

// Characters npm allows in a package name, which URL encoding leaves alone.
const NPM_NAME_PART = "[\\w.~!*'()-]+";
const NPM_REGISTRY_KEY = new RegExp(
  `^(?:@${NPM_NAME_PART}/)?(?!\\.\\.?$)${NPM_NAME_PART}$`,
);
const PYPI_NAME = /^[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?$/;
const PYPI_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!+_-]*$/;
const CRATE_NAME = /^[0-9A-Za-z_-]+$/;
const GEM_SEGMENT = /^(?!\.\.?$)[\w.+-]+$/;
const PUB_NAME = /^[0-9A-Za-z_]+$/;
const COMPOSER_PART = /^(?!\.\.?$)[\w.-]+$/;
const JSR_SEGMENT = /^(?!\.\.?$)[\w.~+-]+$/;

/**
 * Whether a value is a single URL path segment: not empty, not `.` or `..`,
 * and without a separator, `?`, `#`, `%`, whitespace or control character.
 *
 * @param {string} value Name or version
 * @returns {boolean} `true` when the value can be appended to a URL path
 */
export function isPlainPathSegment(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !/[/\\?#%\s\p{Cc}]/u.test(value)
  );
}

/**
 * Whether Maven coordinates are plain path segments once the group is split
 * at its dots.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId
 * @param {string} version Version
 * @returns {boolean} `true` when the coordinates stay inside a repository path
 */
export function isMavenRegistryCoordinate(group, name, version) {
  return (
    typeof group === "string" &&
    group.split(".").every(isPlainPathSegment) &&
    isPlainPathSegment(name) &&
    isPlainPathSegment(version)
  );
}

/**
 * Whether a string has the shape of the name an npm registry serves a package
 * under: `name` or `@scope/name`.
 *
 * @param {string} key Package name, with its scope when it has one
 * @returns {boolean} `true` when the key can be appended to a registry URL
 */
export function isNpmRegistryKey(key) {
  return typeof key === "string" && NPM_REGISTRY_KEY.test(key);
}

/**
 * Whether a string can be the name of a PyPI project.
 *
 * @param {string} name Project name
 * @returns {boolean}
 */
export function isPypiProjectName(name) {
  return typeof name === "string" && PYPI_NAME.test(name);
}

/**
 * Whether a string can be a PyPI release version (PEP 440 characters).
 *
 * @param {string} version Release version
 * @returns {boolean}
 */
export function isPypiReleaseVersion(version) {
  return typeof version === "string" && PYPI_VERSION.test(version);
}

/**
 * Whether a string can be the name of a crate on crates.io.
 *
 * @param {string} name Crate name
 * @returns {boolean}
 */
export function isCrateName(name) {
  return typeof name === "string" && CRATE_NAME.test(name);
}

/**
 * Whether a string can be the name or version of a gem.
 *
 * @param {string} value Gem name or version
 * @returns {boolean}
 */
export function isGemSegment(value) {
  return typeof value === "string" && GEM_SEGMENT.test(value);
}

/**
 * Whether a string can be the name of a pub.dev package.
 *
 * @param {string} name Package name
 * @returns {boolean}
 */
export function isPubPackageName(name) {
  return typeof name === "string" && PUB_NAME.test(name);
}

/**
 * Whether a string is a Packagist name, `vendor/package`.
 *
 * @param {string} name Package name with its vendor
 * @returns {boolean}
 */
export function isComposerPackageName(name) {
  if (typeof name !== "string") {
    return false;
  }
  const parts = name.split("/");
  return parts.length === 2 && parts.every((part) => COMPOSER_PART.test(part));
}

/**
 * Whether a string can be a jsr scope, package name or version.
 *
 * @param {string} value jsr scope, name or version
 * @returns {boolean}
 */
export function isJsrSegment(value) {
  return typeof value === "string" && JSR_SEGMENT.test(value);
}
