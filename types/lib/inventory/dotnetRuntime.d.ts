/**
 * Read the runtime pack a shared framework's deps.json was built from.
 *
 * @param {Object} depsJson parsed <framework>.deps.json
 * @param {string} framework framework directory name
 * @returns {{pack: string, version: string, rid: string}|undefined}
 */
export declare function runtimePackFromDepsJson(depsJson: Object, framework: string): {
    pack: string;
    version: string;
    rid: string;
} | undefined;
/**
 * The CPE NVD uses for a shared framework version: `.net` from 5.0 on,
 * `.net_core` before it, and `asp.net_core` for ASP.NET Core.
 *
 * @param {string} framework framework directory name
 * @param {string} version runtime version
 * @returns {string|undefined} CPE 2.3 string
 */
export declare function dotnetCpe(framework: string, version: string): string | undefined;
/**
 * Create the platform component for one installed shared framework.
 *
 * @param {string} framework framework directory name
 * @param {{pack: string, version: string, rid: string}} runtime runtime pack
 * @param {string} location root-relative path of the deps.json
 * @returns {Object|undefined} component, or undefined when no purl can be built
 */
export declare function createDotnetRuntimeComponent(framework: string, runtime: {
    pack: string;
    version: string;
    rid: string;
}, location: string): Object | undefined;
/**
 * Find the .NET shared frameworks installed under a root that no package
 * manager owns, and return one platform component per runtime pack.
 *
 * @param {string} rootDir extracted root file system
 * @param {string[]} [ownedPaths] root-relative paths a package database owns
 * @returns {Object[]} platform components
 */
export declare function collectDotnetRuntimes(rootDir: string, ownedPaths?: string[]): Object[];
//# sourceMappingURL=dotnetRuntime.d.ts.map