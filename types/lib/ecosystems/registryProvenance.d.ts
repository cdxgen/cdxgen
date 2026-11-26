/**
 * Extract advanced npm provenance and publishing properties from registry metadata.
 *
 * @param {object} packument npm packument body
 * @param {string | undefined} version package version
 * @param {Object} [options] Options
 * @param {boolean} [options.versionPresenceEvidence=true] Whether the
 *   component came from the registry, so that a version the packument does
 *   not hold is recorded as missing. False for a project's own manifest.
 * @returns {object[]} custom properties
 */
export declare function collectNpmRegistryProvenanceProperties(packument: object, version: string | undefined, options?: {
    versionPresenceEvidence?: boolean;
}): object[];
/**
 * The canonical form of a PEP 440 version, for comparing two spellings of
 * the same release: `1.0` and `1.0.0`, `1.0RC1` and `1.0rc1`, `1.0-post1`
 * and `1.0.post1`. Trailing zero release segments are dropped, as packaging's
 * `canonicalize_version` drops them. A string that is not a PEP 440 version
 * is only lowercased.
 *
 * @param {string | undefined} value version
 * @returns {string | undefined} canonical version
 */
export declare function canonicalPypiVersion(value: string | undefined): string | undefined;
/**
 * The key a PyPI project document's `releases` map holds a version under,
 * comparing canonical PEP 440 forms when the exact key is absent.
 *
 * @param {object} releases the project document's `releases` map
 * @param {string | undefined} version requested version
 * @returns {string | undefined} the matching key, if any
 */
export declare function pypiReleaseKey(releases: object, version: string | undefined): string | undefined;
/**
 * Extract advanced PyPI provenance and publishing properties from registry metadata.
 *
 * PyPI answers at two endpoints. The version document
 * (`/pypi/<name>/<version>/json`) describes one release: `info` and `urls`
 * are that release's, and `info.yanked` says whether it was withdrawn. The
 * project document (`/pypi/<name>/json`) adds the `releases` map, the only
 * place the package's age, its newest release and its release cadence can be
 * read from. `body` may be either; a caller that fetched the version document
 * and also wants the history passes the project document as
 * `options.projectBody`.
 *
 * A version is recorded as missing only on a real signal: the caller saw the
 * version document answer 404 (`options.versionNotFound`), or the release
 * history is in hand and holds no release whose canonical PEP 440 form is
 * the requested one.
 *
 * @param {object} body PyPI JSON body, version or project document
 * @param {string | undefined} version package version
 * @param {Object} [options] Options
 * @param {object} [options.projectBody] Project document for the history
 * @param {boolean} [options.versionNotFound] The version document was not found
 * @returns {object[]} custom properties
 */
export declare function collectPypiRegistryProvenanceProperties(body: object, version: string | undefined, options?: {
    projectBody?: object;
    versionNotFound?: boolean;
}): object[];
/**
 * Extract Cargo/crates.io release, publisher, and provenance-adjacent properties.
 *
 * @param {object} crateBody crates.io `/api/v1/crates/{name}` response body
 * @param {string | undefined} version crate version
 * @param {object} [ownersBody] crates.io `/api/v1/crates/{name}/owners` response body
 * @returns {object[]} custom properties
 */
export declare function collectCargoRegistryProvenanceProperties(crateBody: object, version: string | undefined, ownersBody?: object): object[];
//# sourceMappingURL=registryProvenance.d.ts.map