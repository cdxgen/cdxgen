/**
 * Whether a path holds any Terraform or OpenTofu configuration or lock file
 * the workspace assembly would consider; used by project-type autodetection.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} [options] CLI options
 * @returns {boolean}
 */
export declare function hasTerraformConfiguration(scanPath: string, options?: Object): boolean;
/**
 * Parse a `.terraform.lock.hcl` file.
 *
 * @param {string} lockFile Path to the lock file
 * @returns {{ pkgList: object[] }} Provider components
 */
export declare function parseTerraformLockFile(lockFile: string): {
    pkgList: object[];
};
/**
 * Locate the Terraform roots under `scanPath`: directories that own a
 * configuration — those with a lock file or module manifest, plus config
 * directories no other config directory references through a local module
 * call.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} options CLI options
 * @returns {{ dir: string, lockFile?: string, manifestFile?: string }[]} Roots sorted by relative POSIX path
 */
export declare function findTerraformRoots(scanPath: string, options?: Object): {
    dir: string;
    lockFile?: string;
    manifestFile?: string;
}[];
/**
 * Inventory a Terraform workspace: providers from the lock file and
 * `required_providers`, modules from the manifest or the configuration, the
 * dependency graph between them, and offline licenses from the installed
 * packages.
 *
 * @param {string} scanPath Directory to scan
 * @param {Object} options CLI options
 * @param {string} parentRef `bom-ref` of the parent component the CLI built
 * @returns {{ pkgList: object[], dependencies: object[], parentProperties: object[], srcFiles: string[] }}
 */
export declare function parseTerraformWorkspace(scanPath: string, options: Object, parentRef: string): {
    pkgList: object[];
    dependencies: object[];
    parentProperties: object[];
    srcFiles: string[];
};
//# sourceMappingURL=parsers-terraform.d.ts.map