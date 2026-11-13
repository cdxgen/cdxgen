export declare function listDirectory(directory: any): any;
export declare function isDirectory(path: any): any;
/**
 * Whether a path is a directory itself, not a symbolic link to one.
 *
 * @param {string} path path
 * @returns {boolean}
 */
export declare function isPlainDirectory(path: string): boolean;
/**
 * The directory a root-relative pattern's symbolic links must stay inside.
 * /opt and /usr/local hold directories that accounts other than root may own,
 * so a link below them is followed only while its target stays inside them.
 *
 * @param {string} rootPath root directory
 * @param {string} pattern `/`-separated pattern relative to the root
 * @returns {string|undefined} the directory, or undefined for other patterns
 */
export declare function rootPatternConfine(rootPath: string, pattern: string): string | undefined;
/**
 * Whether a probe may read a path of a candidate directory. A directory found
 * `within` a home is read through no symbolic link below that home, whoever
 * runs the scan: a link a user left there would resolve with the scan's
 * rights, and whether it resolves at all tells whether a directory exists. A
 * directory with a `confine` is read through links only while each stays
 * inside it.
 *
 * @param {{within?: string, confine?: string}} entry candidate directory
 * @param {string} path path below the directory
 * @returns {boolean}
 */
export declare function isReachedSafely(entry: {
    within?: string;
    confine?: string;
}, path: string): boolean;
/**
 * Look for a runtime no package manager owns, in the directories a spec names.
 * Components come back only for the files nothing owns: a `file` component for
 * each runtime binary or library the spec could read a build from, the
 * components the spec's inventory builds from them, and the edges between them.
 *
 * @param {Object} options probe options, as probeHostPhp documents them
 * @param {Object} spec the runtime: `label`, `ecosystem`, `capability`,
 *   `remediationId` (a remediation catalog id, spelled out by the caller),
 *   `budget.remediationId` (the catalog id recorded when the name budget runs
 *   out), `maxProbes`, `directories(context)`, `classify(name, platform)`,
 *   `readBuild(context, candidate)`, `createInventory()`,
 *   `attach(inventory, component, build, candidate)`, `finish(inventory)`,
 *   optional `chocolateyPackages` and `chocolateyDirectories(context)` (where
 *   those packages unpack outside Chocolatey's folder), and `hooks` carrying
 *   the caller's
 *   `isDryRun`, `readEnvironmentVariable`, `recordActivity` and
 *   `recordDegradation`
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export declare function probeHostRuntime(options: Object, spec: Object): {
    components: Object[];
    dependencies: Object[];
};
/**
 * Ask the package databases of a POSIX host which package owns each path.
 * The paths are named as the host names them (`/usr/lib/ruby/...`). A
 * database that exists but cannot be read is reported, so the caller can tell
 * "no owner" from "unknown".
 *
 * @param {Object} options probe options, as probeHostRuntime takes them
 * @param {string[]} paths logical paths to look up
 * @returns {{owners: Map<string, {database: string, packageName: string}>,
 *   unreadable: string[]}}
 */
export declare function findHostPathOwners(options: Object, paths: string[]): {
    owners: Map<string, {
        database: string;
        packageName: string;
    }>;
    unreadable: string[];
};
//# sourceMappingURL=hostRuntimeProbe.d.ts.map