/**
 * Retrieves a CycloneDX BOM attached to an OCI image using the `oras` CLI tool.
 * Discovers SBOM attachments via `oras discover`, pulls the first matching
 * artifact, and returns the parsed BOM JSON. Retries automatically with a
 * platform-specific manifest when the initial platform-agnostic discovery fails.
 *
 * @param {string} image OCI image reference (e.g. `"registry.example.com/org/app:tag"`)
 * @param {string} [platform] OCI platform string (e.g. `"linux/amd64"`); detected automatically when omitted
 * @returns {Object|undefined} Parsed CycloneDX BOM JSON object, or `undefined` if not found
 */
export function getBomWithOras(image: string, platform?: string): Object | undefined;
//# sourceMappingURL=oci.d.ts.map