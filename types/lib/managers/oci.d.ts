/**
 * Check whether a token realm URL belongs to the registry itself.
 *
 * A registry's 401 response names the realm, so a hostile registry picks the
 * URL cdxgen will call. Credentials picked up for the registry must therefore
 * only be attached when the realm has the same origin (scheme, host and
 * port); an http:// realm on the registry's host would otherwise receive them
 * without TLS. Public delegating realms (docker.io to auth.docker.io) are
 * still usable, just anonymously.
 *
 * @param {string} registry Registry host, optionally with a port
 * @param {URL} realmUrl Parsed realm URL from the WWW-Authenticate header
 * @returns {boolean} true when scheme, host and port match the registry
 */
export declare function isSameRegistryHost(registry: string, realmUrl: URL): boolean;
/**
 * Retrieves a CycloneDX BOM attached to an OCI image purely in JavaScript
 * without relying on the `oras` CLI tool.
 *
 * @param {string} image OCI image reference (e.g. `"registry.example.com/org/app:tag"`)
 * @param {string} [platform] OCI platform string (e.g. `"linux/amd64"`); no-op for JS implementation
 * @param {Object} [options]
 * @param {function(Buffer): void} [options.checkBytes] Called with the raw bytes of the BOM layer that is about to be returned. An error it throws is rethrown, and no other referrer is tried.
 * @returns {Promise<Object|undefined>} Parsed CycloneDX BOM JSON object, or `undefined` if not found
 */
export declare function getBomWithOras(image: string, _platform?: undefined, options?: Object): Promise<Object | undefined>;
/**
 * Attach a CycloneDX BOM to an OCI image using the OCI 1.1 artifact manifest
 * API, pushing the BOM as a blob and linking it via the referrers API (with a
 * fallback tag when the registry does not support referrers).
 *
 * @param {string} image The target OCI image reference to attach the BOM to.
 * @param {Object} bomJson The CycloneDX BOM document to attach.
 * @returns {Promise<string|undefined>} The digest of the pushed manifest, or
 *   undefined when the manifest could not be pushed.
 */
export declare function attachBomNative(image: string, bomJson: Object): Promise<string | undefined>;
//# sourceMappingURL=oci.d.ts.map