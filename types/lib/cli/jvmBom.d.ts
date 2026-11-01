/**
 * Resolved path to the Gradle modules cache directory, derived from
 * `GRADLE_CACHE_DIR`, `GRADLE_USER_HOME`, or `~/.gradle/caches/modules-2/files-2.1`.
 *
 * @type {string}
 */
export declare let GRADLE_CACHE_DIR: string;
/**
 * Absolute path to the bundled `init.gradle` helper script under `data/helpers`.
 *
 * @type {string}
 */
export declare const GRADLE_INIT_SCRIPT: string;
/**
 * Resolved path to the sbt/Ivy2 cache directory, derived from `SBT_CACHE_DIR`
 * or `~/.ivy2/cache`.
 *
 * @type {string}
 */
export declare const SBT_CACHE_DIR: string;
/**
 * Collect the namespaces of the jars of resolved sbt dependencies. sbt has
 * just downloaded them into the user's caches, so each is read from there;
 * the rest of the cache is never walked.
 *
 * @param {Object[]} pkgList Packages from the sbt dependency trees.
 * @param {Object} [known] Jar namespace mapping already collected. Packages
 *   it covers are skipped.
 * @returns {Promise<Object>} Jar namespace mapping keyed by package purl.
 */
export declare function collectSbtDependencyJars(pkgList: Object[], known?: Object): Promise<Object>;
/**
 * Keep apart two independent Maven projects that declare the same
 * coordinates, such as sample projects in `one/` and `two/` that both call
 * themselves `com.example:demo:0.0.1-SNAPSHOT`. When `component` has the
 * bom-ref of the parent or of a module already collected but comes from a
 * different pom.xml, it gets the directory of its pom, relative to the scan
 * root, as the purl subpath, and the dependency entries that name it follow.
 *
 * @param {Object} component Root component of a Maven tree, updated in place
 * @param {Object} parentComponent Parent component and the modules under it
 * @param {string} rootPath Directory being scanned
 * @param {Object[]} dependenciesList Dependency entries of the tree, updated in place
 * @returns {boolean} True when the component got a distinct identity
 */
export declare function separateDuplicateMavenProject(component: Object, parentComponent: Object, rootPath: string, dependenciesList?: Object[]): boolean;
/**
 * The purls and bom-refs of a parent component and the module components
 * nested under it.
 *
 * @param {Object} parentComponent Parent component.
 * @returns {Set<string>} Purls and bom-refs.
 */
export declare function ownComponentRefs(parentComponent: Object): Set<string>;
/**
 * Function to create bom string for Java jars
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 *
 * @returns {Object} BOM with namespace mapping
 */
export declare function createJarBom(path: string, options: Object): Object;
/**
 * Discover the real sbt project ids for a build by invoking sbt's own
 * `projects` command. This is more reliable than scraping the build files with
 * a regex, since it uses sbt's project resolution and avoids false positives
 * (commented-out code, examples, values that merely resemble project defs) that
 * can lead to hangs when those bogus scopes are later passed to `dependencyTree`.
 *
 * The root project is kept when it has sources of its own, since it is then
 * the application rather than a pure aggregator.
 *
 * Falls back to the regex-based {@link discoverSbtProjects} heuristic when the
 * sbt invocation fails or yields nothing useful.
 *
 * @param {string} basePath Directory of the sbt build
 * @param {string} sbtCmd sbt executable
 * @param {Object} env Environment for the spawned process
 * @param {string[]} [launcherArgs] Launcher options placed before the sbt arguments
 * @returns {string[]} List of sbt project ids
 */
export declare function discoverSbtProjectsFromCmd(basePath: string, sbtCmd: string, env: Object, launcherArgs?: string[]): string[];
/**
 * Read one pom.xml without running Maven: the module it declares and its
 * direct dependencies. Versions resolve from the pom's properties and
 * dependencyManagement and from parent poms inside the scanned directory.
 * Versions that an imported BOM or a parent outside the directory manages
 * stay empty, and transitive dependencies are unknown.
 *
 * No dependency edges are produced. The build-fidelity rules (BF-JVM-001,
 * BF-GEN-001) recognise a pom read without Maven by its missing graph, and a
 * graph of direct edges alone would pass for a resolved one.
 *
 * @param {string} pomFile pom.xml to read
 * @param {string} rootPath Scanned directory
 * @param {Map} [cache] Parent pom results shared by the poms of one scan
 * @returns {{moduleComponent: Object|undefined, pkgList: Object[]}}
 */
export declare function readMavenModuleStatically(pomFile: string, rootPath: string, cache?: Map<any, any>): {
    moduleComponent: Object | undefined;
    pkgList: Object[];
};
/**
 * Function to create bom string for Java projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createJavaBom(path: string, options: Object): Promise<Object>;
//# sourceMappingURL=jvmBom.d.ts.map