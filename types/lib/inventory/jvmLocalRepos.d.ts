/**
 * Forget every memoised lookup. A long-lived process (server mode) calls this
 * per scan so that artifacts a build downloaded in the meantime are found, and
 * tests call it after changing the cache environment variables.
 *
 * @returns {void}
 */
export declare function resetJvmLocalRepoCaches(): void;
/**
 * Read `<localRepository>` from a Maven settings file.
 *
 * @param {string} settingsFile Path to settings.xml.
 * @returns {string|undefined} Absolute local repository path.
 */
export declare function localRepositoryFromSettings(settingsFile: string): string | undefined;
/**
 * Pull the values cdxgen needs out of a Maven argument list: the
 * `maven.repo.local` system property and the user settings file.
 *
 * @param {string[]} args Parsed arguments.
 * @param {string} [baseDir] Directory relative paths resolve against.
 * @returns {{repoLocal?: string, settingsFile?: string}}
 */
export declare function mavenRepoArgs(args: string[], baseDir?: string): {
    repoLocal?: string;
    settingsFile?: string;
};
/**
 * The arguments that hand a scanned project's own `settings.xml` to Maven.
 *
 * The file is passed as global settings (`-gs`), so the user's
 * `~/.m2/settings.xml` still applies and wins on mirrors, servers and proxies.
 * Nothing is added, and `skipped` says why, in secure mode, where a scanned
 * repository must not choose Maven's repositories, proxies or credentials, or
 * when MVN_ARGS or MAVEN_ARGS already names a settings file.
 *
 * @param {string} projectDir Directory holding the project's pom.xml.
 * @param {{secureMode?: boolean}} [opts]
 * @returns {{settingsFile?: string, args: string[], skipped?: "secure-mode"|"user-settings"}}
 */
export declare function projectSettingsArgs(projectDir: string, { secureMode }?: {
    secureMode?: boolean;
}): {
    settingsFile?: string;
    args: string[];
    skipped?: "secure-mode" | "user-settings";
};
/**
 * Every Maven local repository this run may have populated, most specific
 * first: MAVEN_CACHE_DIR, then an explicit `-Dmaven.repo.local` (from
 * MVN_ARGS, MAVEN_ARGS, MAVEN_OPTS or the project's `.mvn/maven.config`), then
 * `<localRepository>` from the settings Maven would read, then
 * `~/.m2/repository`.
 *
 * @param {Object} [opts]
 * @param {string} [opts.projectDir] Project directory, for `.mvn/maven.config`.
 * @returns {string[]} Absolute paths. Not filtered for existence.
 */
export declare function mavenLocalRepositories({ projectDir }?: {
    projectDir?: string;
}): string[];
/**
 * Gradle module cache directories (`.../modules-2/files-2.1`): the one under
 * GRADLE_USER_HOME, the cdxgen-specific GRADLE_CACHE_DIR, the default
 * `~/.gradle` when neither is set, and the read-only shared cache named by
 * GRADLE_RO_DEP_CACHE.
 *
 * @returns {string[]} Absolute paths. Not filtered for existence.
 */
export declare function gradleCacheRoots(): string[];
/**
 * The Coursier cache directory used by sbt, Mill and scala-cli: COURSIER_CACHE
 * when set, otherwise the platform default (XDG_CACHE_HOME is honoured on
 * Linux).
 *
 * @returns {string|undefined} Absolute path. Not checked for existence.
 */
export declare function coursierCacheDir(): string | undefined;
/**
 * Convert a Coursier repository prefix into the repository URL it caches.
 *
 * @param {string[]} parts Prefix segments relative to the cache root.
 * @returns {string|null} Repository URL.
 */
export declare function coursierPrefixToUrl(parts: string[]): string | null;
/**
 * Locate a Maven coordinate's directory in the Coursier cache.
 *
 * @param {string} group Maven groupId.
 * @param {string} name Maven artifactId, including any Scala suffix.
 * @param {string} version Version.
 * @returns {{repoUrl: string, dir: string}|null} Repository URL and directory.
 */
export declare function locateInCoursierCache(group: string, name: string, version: string): {
    repoUrl: string;
    dir: string;
} | null;
/**
 * Locate a Maven artifact and its POM in the local caches.
 *
 * Only the exact file names Maven, Gradle and Coursier use are accepted, so a
 * classifier jar (`-sources`, `-javadoc`, `-linux-x86_64`) is never mistaken
 * for the main artifact. Results, including misses, are memoised until
 * {@link resetJvmLocalRepoCaches}.
 *
 * @param {string} group Maven groupId.
 * @param {string} name Maven artifactId.
 * @param {string} version Version.
 * @param {Object} [opts]
 * @param {string} [opts.classifier] Classifier of the wanted jar.
 * @param {string} [opts.extension] Artifact extension. Defaults to jar.
 * @param {string} [opts.projectDir] Project directory, for `.mvn/maven.config`.
 * @returns {{jarPath?: string, pomPath?: string, sha1?: string, repoUrl?: string}|null}
 */
export declare function findLocalMavenArtifact(group: string, name: string, version: string, opts?: {
    classifier?: string;
    extension?: string;
    projectDir?: string;
}): {
    jarPath?: string;
    pomPath?: string;
    sha1?: string;
    repoUrl?: string;
} | null;
/**
 * Split an artifact file name into its classifier and extension, given the
 * artifactId and version it belongs to.
 *
 * @param {string} fileName File name, for example `netty-4.1.1-linux.jar`.
 * @param {string} name artifactId.
 * @param {string} version Version.
 * @returns {{classifier: string, extension: string}|undefined} Undefined when
 *   the name does not belong to the coordinate.
 */
export declare function splitArtifactFileName(fileName: string, name: string, version: string): {
    classifier: string;
    extension: string;
} | undefined;
/**
 * Infer Maven coordinates from where an artifact sits on disk.
 *
 * Paths inside a configured Maven repository or Gradle cache are read by
 * their layout. Paths elsewhere are recognised by the conventional
 * `.m2/repository` and `files-2.1` segments, so a copied cache still works. A
 * Coursier path is resolved through its sibling POM, because the repository
 * prefix and the group path cannot be told apart from the path alone.
 *
 * @param {string} filePath Absolute path of a jar or other artifact.
 * @returns {{group: string, name: string, version: string, classifier: string, extension: string, sha1?: string}|undefined}
 */
export declare function inferMavenCoordinatesFromPath(filePath: string): {
    group: string;
    name: string;
    version: string;
    classifier: string;
    extension: string;
    sha1?: string;
} | undefined;
/**
 * Look up the Maven coordinates of a jar by its SHA-1 in the local caches.
 *
 * The index is built once, on first use, from the Gradle module cache (whose
 * directory names are SHA-1s) and from the `*.jar.sha1` files Maven writes
 * next to every downloaded jar. It answers the question cdxgen would otherwise
 * send to the Maven Central search API.
 *
 * @param {string} sha1 Hex SHA-1 of the jar.
 * @returns {{group: string, name: string, version: string, classifier: string, extension: string, path: string}|undefined}
 */
export declare function findMavenCoordinatesBySha1(sha1: string): {
    group: string;
    name: string;
    version: string;
    classifier: string;
    extension: string;
    path: string;
} | undefined;
//# sourceMappingURL=jvmLocalRepos.d.ts.map