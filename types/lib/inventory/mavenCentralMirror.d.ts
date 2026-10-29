/**
 * Opt-in switch that points every Maven Central consumer at Google's public
 * mirror: cdxgen's own POM, licence and metadata lookups, and every JVM build
 * tool cdxgen runs (Maven and its wrapper, Gradle, sbt, Mill, Bazel and the
 * Clojure tools). The value selects the mirror:
 *
 *   `true`/`google`  the global mirror bucket
 *   `eu`             the Europe bucket
 *   `asia`           the Asia bucket
 *   `http(s)://...`  any other mirror or repository manager of Maven Central
 *
 * An explicit `MAVEN_CENTRAL_URL` still wins for cdxgen's own lookups, and a
 * repository the user or the project already configures is never replaced:
 * only the default Maven Central URLs are moved. Nothing is written to the
 * scanned project or the user's home directory; the injection goes through
 * command-line arguments and environment variables, and any settings or init
 * script it needs is written under cdxgen's temp directory and removed again.
 */
export declare const MAVEN_CENTRAL_MIRROR_VAR = "MAVEN_CENTRAL_MIRROR";
/**
 * Google's public Maven Central mirror buckets, named by region.
 *
 * @type {Object<string, string>}
 */
export declare const MAVEN_CENTRAL_MIRROR_URLS: Record<string, string>;
/**
 * The default Maven Central repository URLs that the mirror replaces, for
 * tools that name repositories by URL.
 *
 * @type {string[]}
 */
export declare const MAVEN_CENTRAL_DEFAULT_URLS: string[];
/**
 * Read the mirror switch. Undefined when cdxgen should use Maven Central
 * itself, the mirror URL otherwise.
 *
 * @returns {string|undefined} Mirror base URL with a trailing slash
 */
export declare function mavenCentralMirrorUrl(): string | undefined;
/**
 * Whether the mirror switch is on. Names and URLs that do not resolve to a
 * mirror leave it off, so a typo never silently redirects builds.
 *
 * @returns {boolean}
 */
export declare function isMavenCentralMirrorEnabled(): boolean;
/**
 * The repository cdxgen's own POM, licence and metadata lookups should fetch
 * from. An explicit `MAVEN_CENTRAL_URL` is a deliberate choice, often a
 * repository manager holding private artefacts, so it keeps winning over the
 * mirror.
 *
 * @returns {string|undefined} Mirror URL, or undefined to keep the existing
 *   `MAVEN_CENTRAL_URL` behaviour
 */
export declare function mavenCentralFetchUrl(): string | undefined;
/**
 * Insert the mirror into the content of a settings file that is passed to
 * Maven anyway, keeping every other element as it is. The mirror is appended
 * to the existing ones, so the file's own mirror of Central still wins.
 *
 * @param {string} content Existing settings.xml content
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string|undefined} Merged content, or undefined when the file
 *   holds no recognisable settings element to merge into
 */
export declare function mergeMavenMirrorSettings(content: string, mirrorUrl: string): string | undefined;
/**
 * Extra Maven arguments that send Central to the mirror, written as a global
 * settings file under cdxgen's temp directory. An existing `-gs` settings
 * file named by the caller is merged with the mirror instead, so a project
 * that ships its own settings.xml keeps its repositories and its own mirror.
 * A settings file the user named themselves (in `MVN_ARGS`/`MAVEN_ARGS`) is
 * never touched, and neither is secure mode.
 *
 * @param {string} [existingSettingsFile] Settings file the caller already
 *   passes to Maven
 * @returns {string[]} Arguments to append to the Maven command line
 */
export declare function mavenMirrorSettingsArgs(existingSettingsFile?: string): string[];
/**
 * Environment for a Maven or Maven wrapper invocation that moves the
 * wrapper's own distribution download off Maven Central. Plain `mvn`
 * invocations ignore it.
 *
 * @returns {Object} Environment variables to add to the child process
 */
export declare function mavenWrapperMirrorEnv(): Object;
/**
 * A Gradle init script that rewrites Maven Central repository URLs to the
 * mirror as the settings and every project declare them. Repositories that are
 * not Maven Central keep their URL, so private repositories and declared
 * mirrors are untouched.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
export declare function gradleMirrorInitScript(mirrorUrl: string): string;
/**
 * Extra Gradle arguments that install the mirror init script. Gradle applies
 * every init script it is given, so cdxgen's own helper script keeps working.
 *
 * @returns {string[]} Arguments to append to the Gradle command line
 */
export declare function gradleMirrorInitScriptArgs(): string[];
/**
 * An sbt launcher repositories file that resolves Maven Central from the
 * mirror. The launcher replaces its default list with this file, so the
 * plugin and Typesafe repositories it must still reach are named here, and
 * only the Central entry points at the mirror.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
export declare function sbtRepositoriesFile(mirrorUrl: string): string;
/**
 * Environment for an sbt invocation that resolves Maven Central from the
 * mirror: a repositories file under cdxgen's temp directory, named through
 * `SBT_OPTS`. A user who already configures repositories (`~/.sbt/repositories`
 * or their own `sbt.repository.config`) keeps their configuration, and the
 * mirror stays out of the way.
 *
 * @returns {Object} Environment variables to add to the child process
 */
export declare function sbtMirrorEnv(): Object;
/**
 * Environment for tools that resolve through the Coursier CLI.
 *
 * @returns {Object} Environment variables to add to the child process
 */
export declare function coursierMirrorEnv(): Object;
/**
 * Extra Bazel build arguments that hand the mirror to repository rules, whose
 * environment Bazel otherwise keeps isolated from the client's. Repositories
 * whose URLs the project pins, as rules_jvm_external projects do, are not
 * changed by this; it covers the ones that resolve through Coursier defaults.
 *
 * @returns {string[]} Arguments to append to the Bazel build command line
 */
export declare function bazelMirrorArgs(): string[];
/**
 * The `-Sdeps` data that repoints the default `central` repository of the
 * Clojure CLI at the mirror. Repositories merge by name, so a project's other
 * repositories, including Clojars, keep resolving as declared.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
export declare function clojureMirrorSdeps(mirrorUrl: string): string;
/**
 * Extra arguments for a Clojure CLI invocation. Skipped when the user already
 * passes `-Sdeps`, whose data would otherwise be replaced.
 *
 * @param {string[]} baseArgs Arguments the caller already assembled
 * @returns {string[]} Arguments to append
 */
export declare function clojureMirrorArgs(baseArgs?: string[]): string[];
/**
 * Arguments for a Leiningen invocation that repoint its `central` repository
 * at the mirror, through `lein update-in`, which changes the project map in
 * memory and never the project.clj file. Skipped when the project declares
 * its own `:mirrors`, which must keep winning.
 *
 * @param {string[]} baseArgs Arguments the caller already assembled
 * @param {string} [projectFileContent] The project's project.clj, when the
 *   caller has it at hand
 * @returns {string[]} Full argument list to invoke Leiningen with
 */
export declare function leiningenMirrorArgs(baseArgs: string[], projectFileContent?: string): string[];
//# sourceMappingURL=mavenCentralMirror.d.ts.map