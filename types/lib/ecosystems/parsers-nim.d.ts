/**
 * Nim parser for `.nimble` manifests and `nimble.lock`.
 *
 * A `.nimble` file is a Nim script whose practical surface is a set of
 * `key = "value"` assignments plus `requires "dep >= 1.0"` lines; it is read
 * with a line scanner over those shapes rather than a Nim interpreter.
 * Nimble persists the resolved dependency set to `nimble.lock` (JSON), which
 * is the source of truth for versions.
 *
 * No `nim` purl type is registered, so packages are identified as generic
 * carrying a `cdx:purl:proposedType=nim` property, following the convention
 * used for nix and zig.
 */
/**
 * Parse a Nim project from a `.nimble` manifest and optional `nimble.lock`.
 *
 * @param {string} nimbleFile Path to the `.nimble` file
 * @param {string} [nimbleLockFile] Path to `nimble.lock`, if present
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object, rootInputs?: string[], lockEntries: number }}
 *   `lockEntries` counts the package records the lock holds
 */
export declare function parseNimProject(nimbleFile: string, nimbleLockFile?: string): {
    pkgList: object[];
    dependencies: object[];
    parentComponent: object;
    rootInputs?: string[];
    lockEntries: number;
};
/**
 * Read the assignments and requirements of a `.nimble` file.
 *
 * @param {string} filePath File to read
 * @returns {{name?: string, version?: string, description?: string, license?: string, requires: Array<{name: string, constraint?: string}>}}
 */
export declare function readNimbleFile(filePath: string): {
    name?: string;
    version?: string;
    description?: string;
    license?: string;
    requires: Array<{
        name: string;
        constraint?: string;
    }>;
};
//# sourceMappingURL=parsers-nim.d.ts.map