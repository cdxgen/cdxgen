export type CargoCacheMetadata = {
    /**
     * Crate description.
     */
    description?: string;
    /**
     * SPDX license expression.
     */
    license?: string;
    /**
     * Source repository URL.
     */
    repository?: string;
    /**
     * Homepage URL.
     */
    homepage?: string;
    /**
     * Minimum supported Rust version.
     */
    rustVersion?: string;
    /**
     * SHA-256 of the published `.crate` archive.
     */
    checksum?: string;
    /**
     * Feature table.
     */
    features?: Object;
    /**
     * Whether this version was yanked.
     */
    yanked?: boolean;
    /**
     * RFC 3339 publish timestamp.
     */
    publishTime?: string;
    /**
     * Newest non-yanked version in the index.
     */
    latestVersion?: string;
    /**
     * Which local files answered, for provenance.
     */
    sources: string[];
};
/**
 * Reset memoized state. Tests that point `CARGO_HOME` at a fixture need the
 * next call to look again rather than reuse the previous run's answer.
 *
 * @returns {void}
 */
export declare function resetCargoCacheState(): void;
/**
 * Whether the local registry should be consulted before crates.io.
 *
 * @returns {boolean} false when `CARGO_METADATA_SOURCE=registry` opts out.
 */
export declare function localCargoMetadataEnabled(): boolean;
/**
 * Resolve the Cargo registry root.
 *
 * @returns {string} Absolute path to `$CARGO_HOME/registry`.
 */
export declare function getCargoRegistryDir(): string;
/**
 * Read everything the local registry knows about one crate version.
 *
 * @param {string} name Crate name.
 * @param {string} version Exact version.
 * @returns {CargoCacheMetadata|undefined} Metadata, or undefined when neither
 *   local source has this crate.
 */
export declare function readCargoCacheMetadata(name: string, version: string): CargoCacheMetadata | undefined;
/**
 * The manifest values of a `.crate` archive, read without extracting it.
 *
 * @param {string} crateFile Path to the `.crate` archive
 * @param {string} name Crate name, for the archive's inner directory
 * @param {string} version Crate version
 * @returns {Promise<{values: Object, source: string}|undefined>}
 */
export declare function readCrateArchiveValues(crateFile: string, name: string, version: string): Promise<{
    values: Object;
    source: string;
} | undefined>;
//# sourceMappingURL=cargoCache.d.ts.map