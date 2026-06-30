/**
 * Returns a default location of the plugins file.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function sbtPluginsPath(projectPath: string): any;
/**
 * Determine the version of SBT used in compilation of this project.
 * By default it looks into a standard SBT location i.e.
 * <path-project>/project/build.properties
 * Returns `null` if the version cannot be determined.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function determineSbtVersion(projectPath: string): string | null;
/**
 * Adds a new plugin to the SBT project by amending its plugins list.
 * Only recommended for SBT < 1.2.0 or otherwise use `addPluginSbtFile`
 * parameter.
 * The change manipulates the existing plugins' file by creating a copy of it
 * and returning a path where it is moved to.
 * Once the SBT task is complete one must always call `cleanupPlugin` to remove
 * the modifications made in place.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} plugin Name of the plugin to add
 */
export function addPlugin(projectPath: string, plugin: string): string | null;
/**
 * Cleans up modifications to the project's plugins' file made by the
 * `addPlugin` function.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} originalPluginsFile Location of the original plugins file, if any
 */
export function cleanupPlugin(projectPath: string, originalPluginsFile: string): boolean;
/**
 * Find the repository URL from the local Coursier cache for a given Maven package.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix if applicable)
 * @param {string} version Package version
 * @returns {string|null} The repository URL or null if not found
 */
export function findCoursierRegistryUrl(group: string, name: string, version: string): string | null;
/**
 * Test if a given URL exists (returns 2xx/3xx for http/https, or exists on disk for file)
 *
 * @param {string} url URL to test
 * @returns {Promise<boolean>} true if URL exists
 */
export function testUrlExists(url: string): Promise<boolean>;
/**
 * Find the local jar path in Coursier cache if it exists.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix)
 * @param {string} version Package version
 * @returns {string|null} local jar path or null
 */
export function findLocalJarPath(group: string, name: string, version: string): string | null;
/**
 * Resolves the direct download URL for a Maven jar package if found in the local cache,
 * and validates that the URL exists.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix)
 * @param {string} version Package version
 * @returns {Promise<{ repoUrl: string, jarUrl: string, hashes?: Array }|null>} resolved URLs or null
 */
export function resolveJarDistribution(group: string, name: string, version: string): Promise<{
    repoUrl: string;
    jarUrl: string;
    hashes?: any[];
} | null>;
/**
 * Parse an sbt dependency tree output file and return the package list and dependency tree.
 *
 * Reads a file produced by the sbt `dependencyTree` command and extracts Maven artifact
 * coordinates, building a hierarchical dependency graph. Evicted packages and ranges are ignored.
 *
 * @param {string} sbtTreeFile Path to the sbt dependency tree output file
 * @returns {{ pkgList: Object[], dependenciesList: Object[] }}
 */
export function parseSbtTree(sbtTreeFile: string): {
    pkgList: Object[];
    dependenciesList: Object[];
};
/**
 * Parse sbt lock file
 *
 * @param {string} pkgLockFile build.sbt.lock file
 */
export function parseSbtLock(pkgLockFile: string): Promise<{
    group: any;
    name: any;
    version: any;
    _integrity: string;
    scope: string | undefined;
    properties: {
        name: string;
        value: string;
    }[];
    purl: string;
    "bom-ref": string;
    evidence: {
        identity: {
            field: string;
            confidence: number;
            concludedValue: string;
            methods: {
                technique: string;
                confidence: number;
                value: string;
            }[];
        };
    };
}[]>;
/**
 * Parse the root build.sbt to extract the aggregate project name, organization, and version.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {{ name: string, group: string, version: string }|null}
 */
export function parseSbtRootProject(projectPath: string): {
    name: string;
    group: string;
    version: string;
} | null;
/**
 * Discover SBT subproject names statically by parsing build.sbt and project files.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {string[]} List of discovered subproject names
 */
export function discoverSbtProjects(projectPath: string): string[];
/**
 * Parse plugins.sbt files to extract sbt plugins as development dependencies.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {Object[]} List of parsed dependency components
 */
export function parseSbtPlugins(projectPath: string): Object[];
//# sourceMappingURL=sbtutils.d.ts.map