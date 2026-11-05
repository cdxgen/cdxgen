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
 * The CPE NVD uses for a shared framework version, with the version and update
 * fields spelled the way the NVD CPE dictionary spells them.
 *
 * The product is `.net` from 5.0 on, `.net_core` before it, and `asp.net_core`
 * for ASP.NET Core. NVD names a .NET Core x.y.0 release and its pre-releases
 * with two version parts (`.net_core:3.1`, `.net_core:3.0:preview9`), and the
 * .NET 5.0 pre-releases the same way (`.net:5.0:rc1`); every other version
 * keeps three. A release candidate is `rc<N>`, and a preview is
 * `preview.<N>` for .NET 7, 8 and 10 and `preview<N>` otherwise. A release
 * keeps the `*` update, which is the only one NVD lists for some releases. A
 * pre-release of any other kind names no version NVD has, so it gets no CPE.
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
 * @param {string} [location] root-relative path of the deps.json. A runtime
 *   found on the scanning host gets none, since host paths can name the user's
 *   home directory.
 * @returns {Object|undefined} component, or undefined when no purl can be built
 */
export declare function createDotnetRuntimeComponent(framework: string, runtime: {
    pack: string;
    version: string;
    rid: string;
}, location?: string): Object | undefined;
/**
 * Parse the output of `dotnet --list-runtimes`, one `<framework> <version>
 * [<directory>]` line per installed runtime. Warnings, update notices, blank
 * lines, unknown frameworks and versions of a shape no runtime pack names are
 * left out, and no more than MAX_FRAMEWORKS runtimes are kept.
 *
 * https://learn.microsoft.com/dotnet/core/install/how-to-detect-installed-versions
 *
 * @param {string} output output of `dotnet --list-runtimes`
 * @returns {{framework: string, version: string, frameworkDir: string}[]} one
 *   entry per installed runtime
 */
export declare function parseDotnetListRuntimes(output: string): {
    framework: string;
    version: string;
    frameworkDir: string;
}[];
/**
 * Create the platform component for one runtime the host install reports.
 *
 * The identity comes from the deps.json in the runtime's own directory, read
 * with the directory as the root so the read cannot leave it and a symlink is
 * not followed. Only an absolute directory is read, which is what the dotnet
 * host prints. A runtime whose deps.json is missing, unreadable or names
 * another version keeps its name, its version and its CPE, without a purl:
 * without the runtime identifier of the pack there is no correct nuget purl.
 *
 * @param {{framework: string, version: string, frameworkDir: string}} entry
 *   one entry of parseDotnetListRuntimes
 * @returns {Object} platform component
 */
export declare function createHostDotnetRuntimeComponent(entry: {
    framework: string;
    version: string;
    frameworkDir: string;
}): Object;
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