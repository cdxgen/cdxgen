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
/**
 * Whether a value is a single URL path segment: not empty, not `.` or `..`,
 * and without a separator, `?`, `#`, `%`, whitespace or control character.
 *
 * @param {string} value Name or version
 * @returns {boolean} `true` when the value can be appended to a URL path
 */
export declare function isPlainPathSegment(value: string): boolean;
/**
 * Whether Maven coordinates are plain path segments once the group is split
 * at its dots.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId
 * @param {string} version Version
 * @returns {boolean} `true` when the coordinates stay inside a repository path
 */
export declare function isMavenRegistryCoordinate(group: string, name: string, version: string): boolean;
/**
 * Whether a string has the shape of the name an npm registry serves a package
 * under: `name` or `@scope/name`.
 *
 * @param {string} key Package name, with its scope when it has one
 * @returns {boolean} `true` when the key can be appended to a registry URL
 */
export declare function isNpmRegistryKey(key: string): boolean;
/**
 * Whether a string can be the name of a PyPI project.
 *
 * @param {string} name Project name
 * @returns {boolean}
 */
export declare function isPypiProjectName(name: string): boolean;
/**
 * Whether a string can be a PyPI release version (PEP 440 characters).
 *
 * @param {string} version Release version
 * @returns {boolean}
 */
export declare function isPypiReleaseVersion(version: string): boolean;
/**
 * Whether a string can be the name of a crate on crates.io.
 *
 * @param {string} name Crate name
 * @returns {boolean}
 */
export declare function isCrateName(name: string): boolean;
/**
 * Whether a string can be the name or version of a gem.
 *
 * @param {string} value Gem name or version
 * @returns {boolean}
 */
export declare function isGemSegment(value: string): boolean;
/**
 * Whether a string can be the name of a pub.dev package.
 *
 * @param {string} name Package name
 * @returns {boolean}
 */
export declare function isPubPackageName(name: string): boolean;
/**
 * Whether a string is a Packagist name, `vendor/package`.
 *
 * @param {string} name Package name with its vendor
 * @returns {boolean}
 */
export declare function isComposerPackageName(name: string): boolean;
/**
 * Whether a string can be a jsr scope, package name or version.
 *
 * @param {string} value jsr scope, name or version
 * @returns {boolean}
 */
export declare function isJsrSegment(value: string): boolean;
//# sourceMappingURL=registrySegments.d.ts.map