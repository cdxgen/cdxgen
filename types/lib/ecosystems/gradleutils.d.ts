import { isProjectToolingAllowed } from "../core/projectTooling.js";
export { isProjectToolingAllowed };
/**
 * Method to return the gradle command to use.
 *
 * Project-local wrapper scripts (`gradlew`) are attacker-controlled files in
 * the scanned project, so they are only used when the project's own tooling
 * may run (see isProjectToolingAllowed); otherwise the system Gradle is used.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export declare function getGradleCommand(srcPath: string, rootPath: string | null, options?: Object): string;
/**
 * Read a whitespace-separated list of Gradle arguments from an environment
 * variable such as `GRADLE_ARGS`. Repeated, leading or trailing whitespace
 * adds no empty argument, which Gradle would read as a task path.
 *
 * @param {string} name Name of the environment variable
 * @returns {string[]} The arguments, empty when the variable is unset
 */
export declare function gradleArgsFromEnv(name: string): string[];
/**
 * Method to combine the general gradle arguments, the sub-commands and the sub-commands' arguments in the correct way
 *
 * @param {string[]} gradleArguments The general gradle arguments, which must only be added once
 * @param {string[]} gradleSubCommands The sub-commands that are to be executed by gradle
 * @param {string[]} gradleSubCommandArguments The arguments specific to the sub-command(s), which much be added PER sub-command
 * @param {int} gradleCommandLength The length of the full gradle-command
 *
 * @returns {string[]} Array of arrays of arguments to be added to the gradle command
 */
export declare function buildGradleCommandArguments(gradleArguments: string[], gradleSubCommands: string[], gradleSubCommandArguments: string[], gradleCommandLength: int): string[];
/**
 * List the dependency tasks to run for the root project and every module read
 * from `gradle properties`.
 *
 * The root project is recognised by identity, never by purl. A module named
 * after the root project that inherits its group and version has the root's
 * purl (issue 4695), and it still needs its own `:module:dependencies` task.
 * `root` in `modulesToSkip` drops the root task; any other entry is a module
 * path.
 *
 * @param {Map<string, Object>} gradleModules Modules keyed by project path, and the root project by its name
 * @param {Object} rootComponent The component built for the root project
 * @param {string} gradleDepTask Name of the dependency task, usually `dependencies`
 * @param {string[]} modulesToSkip Module paths, or `root`, to leave out
 * @returns {string[]} Task paths in the order Gradle should run them
 */
export declare function gradleDependencyTasks(gradleModules: Map<string, Object>, rootComponent: Object, gradleDepTask: string, modulesToSkip?: string[]): string[];
/**
 * Method to split the output produced by Gradle using parallel processing by project
 *
 * Gradle groups console output by task and prints a `> Task :path` header
 * before each group, repeating it whenever a task's output resumes after
 * another task's. Each group is therefore keyed by the project in its own
 * header (`> Task :app:dependencies` belongs to `:app`), never by whatever
 * report header happened to precede it, and the groups of one project are
 * concatenated in order, so reordering or interrupting the task reports cannot
 * move a report to another project or overwrite one (issue 4465). The groups
 * of a root task (`:dependencies`) all take the root project's name from the
 * `Root project '…'` header that only a root task prints, so a continuation
 * group, which carries no report header, stays with the rest of the root
 * report. The groups of other tasks are dropped along with their headers.
 *
 * @param {string} rawOutput Full output produced by Gradle using parallel processing
 * @param {string[]} relevantTasks The list of gradle tasks whose output need to be considered.
 * @returns {map} Map with subProject names as keys and corresponding dependency task outputs as values.
 */
export declare function splitOutputByGradleProjects(rawOutput: string, relevantTasks: string[]): map;
/**
 * Parse gradle projects output
 *
 * @param {string} rawOutput Raw string output
 */
export declare function parseGradleProjects(rawOutput: string): {
    rootProject: string;
    projects: any[];
};
/**
 * Parse gradle properties output
 *
 * `gradlePlugin` is true when the project has the `gradlePlugin` extension,
 * which `java-gradle-plugin`, `kotlin-dsl` and `groovy-gradle-plugin` add: the
 * project builds Gradle plugins, as a `build-logic` build does.
 *
 * @param {string} rawOutput Raw string output
 * @param {string} gradleModuleName The name (or 'path') of the module as seen from the root of the project
 * @returns {{rootProject: string, projects: string[], metadata: Object, gradlePlugin: boolean}} The parsed properties
 */
export declare function parseGradleProperties(rawOutput: string, gradleModuleName?: string): {
    rootProject: string;
    projects: string[];
    metadata: Object;
    gradlePlugin: boolean;
};
/**
 * Execute gradle properties command using multi-threading and return parsed output
 *
 * @param {string} dir Directory to execute the command
 * @param {array} allProjectsStr List of all sub-projects (including the preceding `:`)
 * @param {array} extraArgs List of extra arguments to use when calling gradle
 *
 * @returns {string} The combined output for all subprojects of the Gradle properties task
 */
export declare function executeParallelGradleProperties(dir: string, allProjectsStr: array, extraArgs?: array, options?: {}): string;
/**
 * Forget the causes diagnosed so far, so a process that generates more than
 * one BOM diagnoses each run on its own.
 *
 * @returns {void}
 */
export declare function resetGradleFailureCauses(): void;
/**
 * Whether a gradle invocation has already failed outright this run, so a
 * caller can skip reporting a consequence of that failure as its own
 * degradation.
 *
 * @returns {boolean} True once an invocation failure has been recorded.
 */
export declare function hasGradleInvocationFailure(): boolean;
/**
 * Record why a gradle invocation failed. Every failure also records the
 * `jvm.gradle.invocation-failed` degradation so the reflection can rank the
 * repair; version-incompatibility causes additionally record a
 * `tool.mismatch` event naming the versions, which is the fact the report
 * cannot derive from an empty BOM alone. Diagnosis events are recorded once
 * per cause per run; the degradation dedupes in the reflection by id.
 *
 * @param {Object} result The spawnSync result of the failed invocation.
 * @param {Object} context Call-site facts.
 * @param {string} [context.command] The redacted command that was attempted.
 * @param {string} [context.gradleVersion] The gradle version in play, when the caller knows it.
 * @returns {void}
 */
export declare function recordGradleInvocationFailure(result: Object, context?: {
    command?: string;
    gradleVersion?: string;
}): void;
/**
 * Read the properties of every project the dependency reports name that
 * `gradleModules` does not have yet, such as a project of an included build,
 * and add a module for each one whose properties task printed a report. One
 * Gradle invocation covers all of them.
 *
 * @param {Iterable<string>} reports Text of the `gradle dependencies` reports
 * @param {Map} gradleModules Modules keyed by project path, updated in place
 * @param {string} gradleRootPath Directory to run Gradle in
 * @param {Object} options CLI options
 * @returns {Promise<string[]>} Paths of the projects added
 */
export declare function loadGradleModulesForReports(reports: Iterable<string>, gradleModules: Map<any, any>, gradleRootPath: string, options?: Object): Promise<string[]>;
/**
 * Give the components of a build-tooling report, such as that of an included
 * build that builds Gradle plugins, the `excluded` scope that build-tool
 * configurations get. `reconcileGradleComponents` later keeps a stronger
 * scope that another project's report gives the same component.
 *
 * @param {Object[]} pkgList Components from one project's report, updated in place
 * @param {Map<string, Object>} gradleModules Modules, which keep their own scope
 * @returns {Object[]} The same list
 */
export declare function excludeGradleBuildTooling(pkgList: Object[], gradleModules: Map<string, Object>): Object[];
/**
 * Reconcile the copies of a component that several Gradle projects report.
 * Every copy gets the strongest scope any project gave it, so a library one
 * module only tests with stays required when another module compiles against
 * it, and a dependency one project failed to resolve loses its failure
 * properties when another project resolved it.
 *
 * @param {Object[]} pkgList Components from all the projects, updated in place
 * @returns {Object[]} The same list
 */
export declare function reconcileGradleComponents(pkgList: Object[]): Object[];
/**
 * Method to resolve dependencies from a gradle output
 *
 * A constraint line (`(c)`) adds neither a component nor an edge. Gradle
 * prints a nested constraint under the platform or module that declares it,
 * and only when the dependency it affects is resolved elsewhere in the tree,
 * where that dependency gets its component and edges. A top-level
 * `{strictly …}` constraint from consistent resolution can name a module the
 * configuration never resolves. A dependency that failed to resolve carries
 * `cdx:gradle:resolutionFailed`, keeps the version it was requested at when
 * that is a concrete version, and otherwise records the request in
 * `cdx:gradle:requestedVersion`. A dependency seen in several configurations
 * keeps the strongest scope among them. Platforms and BOMs get a `pom` type
 * and the `excluded` scope.
 *
 * The parser runs no Gradle task. A project the tree names but `gradleModules`
 * lacks gets a component built from the root project's group and version; use
 * `loadGradleModulesForReports` first to read such projects' properties.
 *
 * The lines Gradle prints under another project, such as `project ':lib'` in
 * the report of `:app`, show that project's dependencies as `:app` resolved
 * them, after conflict resolution. When `reportedProjects` names that project,
 * its own report supplies its edges, so these lines add no edge from it.
 *
 * @param {string} rawOutput Text output from gradle dependencies task
 * @param {string} rootProjectName Key in `gradleModules` of the project the report belongs to
 * @param {map} gradleModules Gradle modules keyed by project path, and the root project by its name
 * @param {string} gradleRootPath Directory Gradle ran in, recorded as `cdx:gradle:GradleRootPath`
 * @param {Set<string>} [reportedProjects] Keys in `gradleModules` of the projects whose own reports are parsed
 * @returns {{pkgList: Object[], dependenciesList: Object[]}|{}} The components and dependency graph
 */
export declare function parseGradleDep(rawOutput: string, rootProjectName?: string, gradleModules?: map, gradleRootPath?: string, reportedProjects?: Set<string>): {
    pkgList: Object[];
    dependenciesList: Object[];
} | {};
/**
 * Method that handles object creation for gradle modules.
 *
 * @param {string} name The simple name of the module
 * @param {object} metadata Object with all other parsed data for the gradle module
 * @returns {object} An object representing the gradle module in SBOM-format
 */
export declare function buildObjectForGradleModule(name: string, metadata: object): object;
/**
 * Extract Gradle repository URLs from the evaluation output properties.
 *
 * @param {string} propertiesOutput Properties command output containing repository lines
 * @returns {Object} Map of repository names to their URLs
 */
export declare function extractGradleRepositoryUrls(propertiesOutput: string): Object;
/**
 * Parse the distribution URLs resolved by the init script when the
 * `resolve-gradle-distribution` feature flag is enabled. The init script emits lines of
 * the form `<CDXGEN:distribution>:group:name:version -> https://.../name-version.jar`.
 *
 * @param {string} stdout Gradle stdout logs containing the distribution markers
 * @returns {Object} Map of `group:name:version` keys to their resolved distribution URLs
 */
export declare function parseGradleResolvedDistributions(stdout: string): Object;
/**
 * Parse Gradle info logs to capture HTTP URLs of resolved dependency artifacts.
 *
 * @param {string} stdout Gradle stdout logs under --info
 * @returns {Object} Map of filenames to their resolved distribution URLs
 */
export declare function parseGradleInfoLogsForUrls(stdout: string): Object;
/**
 * Collect Gradle project dependencies by scanning the Gradle cache directory for JAR files
 * and their associated POM files.
 *
 * Uses the `GRADLE_CACHE_DIR` or `GRADLE_USER_HOME` environment variables to locate the
 * Gradle files-2.1 cache, then delegates to {@link collectJarNS} to extract namespace
 * and purl information from those JARs.
 *
 * @param {string} _gradleCmd Gradle command (unused; reserved for future use)
 * @param {string} _basePath Base project path (unused; reserved for future use)
 * @param {boolean} _cleanup Whether to clean up temporary files (unused; reserved for future use)
 * @param {boolean} _includeCacheDir Whether to include cache directory (unused; reserved for future use)
 * @returns {Promise<Object>} JAR namespace mapping object returned by collectJarNS
 */
export declare function collectGradleDependencies(_gradleCmd: string, _basePath: string, _cleanup?: boolean, // eslint-disable-line no-unused-vars
_includeCacheDir?: boolean): Promise<Object>;
/**
 * Method to return the mill command to use.
 *
 * The project-local `mill` script is an attacker-controlled file in the
 * scanned project, so it is only used when the project's own tooling may run
 * (see isProjectToolingAllowed).
 *
 * @param {string} srcPath Path to look for mill wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export declare function getMillCommand(srcPath: string, options?: Object): string;
/**
 * Determine the Mill version of a build.
 *
 * The version is read from the `.mill-version` file, from the
 * `//| mill-version:` header of the build file, or from the launcher itself.
 *
 * @param {string} millRootPath Root of the Mill build
 * @param {string} millCmd Mill command to use for the fallback probe
 * @returns {string|null} The Mill version, or null when it cannot be determined
 */
export declare function getMillVersion(millRootPath: string, millCmd: string): string | null;
/**
 * Find the Mill daemons running under a tree.
 *
 * Daemons record their process id in `out/mill-daemon*` (Mill 1.x) or
 * `out/mill-server*` directories, directly or one level below (Mill 0.12
 * keeps one subdirectory per server). Only processes that are still alive
 * are returned.
 *
 * @param {string} rootPath Tree to search
 * @returns {Map<string, Set<number>>} Live daemon process ids by the root of
 *   the build they belong to
 */
export declare function findMillDaemons(rootPath: string): Map<string, Set<number>>;
/**
 * Stop the Mill daemons that started under the scanned tree during the scan.
 *
 * cdxgen's own Mill calls run with --no-server, but a project build cdxgen
 * runs can shell out to Mill without it and leave a daemon behind. Daemons
 * that were already running when the scan started belong to the user, for
 * example to an IDE, and are left alone; every other live daemon is shut
 * down through the launcher of the build it belongs to.
 *
 * @param {string} rootPath Scanned tree
 * @param {Map<string, Set<number>>} [runningBefore] Result of
 *   {@link findMillDaemons} taken before the scan
 * @param {Object} [options] CLI options
 */
export declare function stopMillDaemons(rootPath: string, runningBefore?: Map<string, Set<number>>, options?: Object): void;
/**
 * Method to return the maven command to use.
 *
 * Project-local wrapper scripts (`mvnw`) are attacker-controlled files in the
 * scanned project, so they are only used when the project's own tooling may
 * run (see isProjectToolingAllowed); otherwise the installed Maven is used.
 *
 * @param {string} srcPath Path to look for maven wrapper
 * @param {string} rootPath Root directory to look for maven wrapper
 * @param {Object} [options] CLI options (`installDeps` gates wrapper use)
 */
export declare function getMavenCommand(srcPath: string, rootPath: string, options?: Object): string;
/**
 * Parse a Gradle version catalog (`gradle/libs.versions.toml`).
 *
 * A catalog declares coordinates the build scripts then reference by alias.
 * It is a declaration, not a resolution: entries may go unused, and their
 * versions may be references into the `[versions]` table. Because of that,
 * catalog components are emitted only as a fallback when Gradle itself
 * produced no dependency information, and every component carries a
 * `cdx:gradle:catalog=true` property so consumers can tell declared catalog
 * entries from a resolved graph.
 *
 * Only libraries whose version resolves to a literal (inline or via
 * `version.ref`) are emitted; rich or unresolved versions would produce purls
 * that identify no artifact. Plugins are skipped because they are build-time
 * only.
 *
 * @param {string} catalogFile Path to `libs.versions.toml`
 * @returns {Object[]} Package records for resolvable library entries
 */
export declare function parseGradleVersionCatalog(catalogFile: string): Object[];
/**
 * Parse one Gradle dependency lockfile.
 *
 * Both layouts are read. A Gradle 6+ `gradle.lockfile` has one
 * `group:name:version=configuration,configuration` line per module and an
 * `empty=` line naming the configurations that resolved nothing. A legacy
 * `gradle/dependency-locks/<configuration>.lockfile` has one
 * `group:name:version` line per module, and the file name is the
 * configuration.
 *
 * The scope of a module is the strongest that `gradleConfigurationScope`
 * gives any of its configurations, so a module locked for both
 * `testRuntimeClasspath` and `runtimeClasspath` is `required`. Everything in
 * a buildscript or settings lockfile is build tooling and `excluded`.
 *
 * A lockfile records resolved versions, so components carry a purl identity
 * with confidence 1 and the lockfile path as the evidence value. The purl and
 * bom-ref match what `parseGradleDep` builds for the same coordinate, so a
 * component reads the same whether Gradle ran or not. A lockfile is flat: it
 * says nothing about which module depends on which, so no dependency graph is
 * returned.
 *
 * The file is untrusted input. It is read only when it is a regular file no
 * larger than 8 MiB, at most 100000 lines are read, and a malformed line
 * costs only itself. Line content never reaches a property.
 *
 * @param {string} lockFile Path to the lockfile
 * @param {Object} [options] Parse options
 * @param {string} [options.rootDir] Directory the lockfile must resolve inside
 * @returns {Object[]} Components, one per locked module
 */
export declare function parseGradleLockfile(lockFile: string, options?: {
    rootDir?: string;
}): Object[];
/**
 * Parse several Gradle lockfiles of one build and merge the result.
 *
 * Every project of a multi-project build has its own lockfile, so the same
 * module often appears in several of them with different configurations. The
 * copies collapse into one component with the strongest scope any lockfile
 * gave it (see `reconcileGradleComponents`), and its evidence lists every
 * lockfile that locked it. The first lockfile that locked a module stays its
 * `internal:SrcFile`.
 *
 * @param {string[]} lockFiles Paths to the lockfiles
 * @param {Object} [options] Parse options, as for `parseGradleLockfile`
 * @returns {Object[]} Components, one per locked module
 */
export declare function parseGradleLockfiles(lockFiles: string[], options?: Object): Object[];
/**
 * Find the Gradle dependency lockfiles of one build.
 *
 * Both layouts are searched below `rootPath`, recursively even when
 * `options.multiProject` is off: every subproject of a Gradle build locks its
 * own configurations, and the subprojects belong to the same build. The
 * Gradle 6+ names are `gradle.lockfile`, `buildscript-gradle.lockfile` and
 * `settings-gradle.lockfile`; the Gradle 4.8 to 5.x layout is
 * `gradle/dependency-locks/<configuration>.lockfile`.
 *
 * A lockfile is accepted only when the project directory that owns it holds a
 * Gradle build file, and never when it sits under `build/`, `.gradle/`,
 * `node_modules/` or a vendored directory. `getAllFiles` already leaves
 * `.git`, `.hg`, `.chen` and `node_modules` out; `build/` and `.gradle/` are
 * Gradle's own output and cache directories, which a lockfile in them cannot
 * belong to the project's source of truth.
 *
 * Custom `dependencyLocking.lockFile` paths, the Nebula `dependencies.lock`
 * and Palantir `versions.lock` formats are not looked for.
 *
 * @param {string} rootPath Directory to search
 * @param {Object} [options] CLI options
 * @returns {string[]} Lockfile paths, in a stable order
 */
export declare function findGradleLockfiles(rootPath: string, options?: Object): string[];
//# sourceMappingURL=gradleutils.d.ts.map