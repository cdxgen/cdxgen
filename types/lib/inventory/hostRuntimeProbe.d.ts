export declare function listDirectory(directory: any): any;
export declare function isDirectory(path: any): any;
/**
 * Look for a runtime no package manager owns, in the directories a spec names.
 * Components come back only for the files nothing owns: a `file` component for
 * each runtime binary or library the spec could read a build from, the
 * components the spec's inventory builds from them, and the edges between them.
 *
 * @param {Object} options probe options, as probeHostPhp documents them
 * @param {Object} spec the runtime: `label`, `ecosystem`, `capability`,
 *   `remediationId` (a remediation catalog id, spelled out by the caller),
 *   `maxProbes`, `directories(context)`, `classify(name, platform)`,
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