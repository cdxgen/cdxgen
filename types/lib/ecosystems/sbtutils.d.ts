/**
 * Returns a default location of the plugins file.
 *
 * @param {string} projectPath Path to the SBT project
 */
export declare function sbtPluginsPath(projectPath: string): any;
/**
 * Determine the version of SBT used in compilation of this project.
 * By default it looks into a standard SBT location i.e.
 * <path-project>/project/build.properties
 * Returns `null` if the version cannot be determined.
 *
 * @param {string} projectPath Path to the SBT project
 */
export declare function determineSbtVersion(projectPath: string): string | null;
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
export declare function addPlugin(projectPath: string, plugin: string): string | null;
/**
 * Cleans up modifications to the project's plugins' file made by the
 * `addPlugin` function.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} originalPluginsFile Location of the original plugins file, if any
 */
export declare function cleanupPlugin(projectPath: string, originalPluginsFile: string): boolean;
/**
 * Find the repository URL from the local Coursier cache for a given Maven package.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix if applicable)
 * @param {string} version Package version
 * @returns {string|null} The repository URL or null if not found
 */
export declare function findCoursierRegistryUrl(group: string, name: string, version: string): string | null;
/**
 * Test if a given URL exists (returns 2xx/3xx for http/https, or exists on disk for file)
 *
 * @param {string} url URL to test
 * @returns {Promise<boolean>} true if URL exists
 */
export declare function testUrlExists(url: string): Promise<boolean>;
/**
 * Find the local jar path in Coursier cache if it exists.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId (original name with suffix)
 * @param {string} version Package version
 * @returns {string|null} local jar path or null
 */
export declare function findLocalJarPath(group: string, name: string, version: string): string | null;
/**
 * Forget every memoised Coursier lookup, including misses. A long-lived
 * process calls this per scan so that artifacts downloaded since the previous
 * scan are found.
 *
 * @returns {void}
 */
export declare function resetSbtResolutionCaches(): void;
/**
 * Resolve the repo/jar download URLs and optional hashes for a Maven coordinate.
 *
 * Looks up the Coursier registry URL for the coordinate and, when the jar is
 * present in the local Coursier cache, computes MD5/SHA-1/SHA-256/SHA-512
 * digests. Results are memoized per coordinate.
 *
 * @param {string} group Maven groupId.
 * @param {string} name Maven artifactId.
 * @param {string} version Package version.
 * @returns {Promise<{repoUrl: string, jarUrl: string, hashes?: Array<{alg: string, content: string}>}|null>}
 *   Resolved URLs with optional hashes, or null when no registry URL is found.
 */
export declare function resolveJarDistribution(group: string, name: string, version: string): Promise<{
    repoUrl: string;
    jarUrl: string;
    hashes?: Array<{
        alg: string;
        content: string;
    }>;
} | null>;
/**
 * Parse an sbt dependency tree output file and return the package list and dependency tree.
 *
 * Reads a file produced by the sbt `dependencyTree` command and extracts Maven artifact
 * coordinates, building a hierarchical dependency graph. Evicted packages and ranges are ignored.
 *
 * @param {string} sbtTreeFile Path to the sbt dependency tree output file
 * @param {string} [srcFile] Build definition the tree was resolved from, named as the
 *   identity source of every component. The tree file itself is a temporary file cdxgen
 *   deletes after the scan, and naming it would make the BOM differ between two runs.
 * @returns {{ pkgList: Object[], dependenciesList: Object[] }}
 */
export declare function parseSbtTree(sbtTreeFile: string, srcFile?: string): {
    pkgList: Object[];
    dependenciesList: Object[];
};
/**
 * Parse sbt lock file
 *
 * @param {string} pkgLockFile build.sbt.lock file
 */
export declare function parseSbtLock(pkgLockFile: string): Promise<{
    group: any;
    name: string;
    version: any;
    _integrity: string;
    scope: string | undefined;
    properties: {
        name: string;
        value: string;
    }[];
    purl: any;
    "bom-ref": string;
    evidence: {
        identity: {
            field: string;
            confidence: number;
            concludedValue: any;
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
export declare function parseSbtRootProject(projectPath: string): {
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
export declare function discoverSbtProjects(projectPath: string): string[];
/**
 * Parse the output of the sbt `projects` command to extract the real project
 * identifiers as understood by sbt. This is more accurate than scraping the
 * build files with a regex (see {@link discoverSbtProjects}), since it relies
 * on sbt's own project resolution and therefore avoids false positives from
 * commented-out code, examples or values that merely look like project
 * definitions.
 *
 * A typical `sbt projects` output looks like:
 *
 * ```
 * [info] In file:/path/to/build/
 * [info] 	   * chen
 * [info] 	     platform
 * [info] 	     dataflowengineoss
 * ```
 *
 * The project marked with `*` is the currently selected (usually the
 * aggregating root) project.
 *
 * @param {string} stdout Raw stdout captured from `sbt projects`
 * @returns {{projects: string[], root: string | undefined}} The discovered
 *  project ids and the currently selected (root) project id, if any.
 */
export declare function parseSbtProjects(stdout: string): {
    projects: string[];
    root: string | undefined;
};
/**
 * Build the single command line an sbt 2 dependency tree session runs.
 *
 * sbt 2 joins separate command-line arguments into one command line, so the
 * commands are joined with `;` and passed as one argument. Each tree is
 * printed to stdout because `dependencyTree / toFile` no longer exists.
 * Each tree is scoped to its project, so one unresolvable subproject cannot
 * fail the others.
 *
 * @param {string[]} subprojects Project ids, or an empty list for the root
 * @returns {string} The `;`-joined command line
 */
export declare function sbt2DependencyTreeCommand(subprojects: string[]): string;
/**
 * Split the captured stdout of an sbt dependency tree session into one chunk
 * per project tree.
 *
 * sbt 2 joins separate command-line arguments into a single command line and
 * no longer offers `dependencyTree / toFile`, so the trees of all subprojects
 * are captured from stdout in one session. Every tree starts with the root
 * coordinate at the start of a line; log lines carry an `[info]`-style prefix
 * or a shell prompt marker and never look like a root coordinate.
 *
 * @param {string} stdout Raw stdout of the sbt session
 * @returns {string[]} One chunk of output per dependency tree, empty when
 *   nothing parsed as a tree
 */
export declare function splitSbtDependencyTrees(stdout: string): string[];
/**
 * Parse plugins.sbt files to extract sbt plugins as development dependencies.
 *
 * @param {string} projectPath Directory path of the project
 * @returns {Object[]} List of parsed dependency components
 */
export declare function parseSbtPlugins(projectPath: string): Object[];
/**
 * The sbt launcher jar beside the `sbt.bat` on PATH, or under `SBT_HOME`.
 * `SBT_LAUNCH_JAR` names one directly.
 *
 * @returns {string|undefined} Path of `sbt-launch.jar`
 */
export declare function sbtLaunchJar(): string | undefined;
/**
 * Split sbt arguments written for a POSIX shell into the arguments the shell
 * would pass: whitespace separates them outside quotes, and single or double
 * quotes group words without escapes, so a Windows path keeps its
 * backslashes.
 *
 * @param {string[]} args Shell-quoted argument fragments
 * @returns {string[]} The arguments
 */
export declare function splitSbtShellArgs(args: string[]): string[];
/**
 * The command line that starts sbt from its launcher jar. The options
 * `sbt.bat` handles itself become what it makes of them: `-no-colors` and
 * `-D` properties are JVM options, `-addPluginSbtFile` is sbt's own
 * `--addPluginSbtFile`, and `-batch` and the thin client switches have no
 * meaning there. The JVM options of `SBT_OPTS`, `JAVA_OPTS` and the build's
 * `.jvmopts` are kept.
 *
 * @param {string[]} args Arguments as given to `sbt`
 * @param {string} jar The sbt launcher jar
 * @param {string} [dir] Build directory
 * @returns {{ command: string, args: string[] }}
 */
export declare function sbtLauncherCommand(args: string[], jar: string, dir?: string): {
    command: string;
    args: string[];
};
/**
 * Run sbt. On Windows, `sbt.bat` parses its arguments as batch syntax, which
 * keeps the POSIX quoting of the commands and mangles quotes inside them, so
 * sbt starts there from its launcher jar with each command one argument.
 * Elsewhere, or without a launcher jar, sbt runs as given.
 *
 * @param {string} sbtCmd sbt executable
 * @param {string[]} args sbt arguments
 * @param {Object} options Spawn options, as for safeSpawnSync
 * @param {boolean} [shellQuoted] Whether the arguments carry POSIX shell quoting
 * @returns {Object} The spawn result
 */
export declare function sbtSpawnSync(sbtCmd: string, args: string[], options: Object, shellQuoted?: boolean): Object;
//# sourceMappingURL=sbtutils.d.ts.map