/**
 * Parse the `//> using` directives of a scala-cli source file.
 *
 * @param {string} sourceFile Path of the source file
 * @returns {{ scalaVersion: string|null, platform: string|null, nativeVersion: string|null, deps: Object[] }}
 *   The declared scala version and platform, and the declared dependencies as
 *   `{ group, artifact, version, cross, test }` entries, where `cross` is
 *   `::`, `:::` or `none`
 */
export declare function parseScalaCliDirectives(sourceFile: string): {
    scalaVersion: string | null;
    platform: string | null;
    nativeVersion: string | null;
    deps: Object[];
};
/**
 * Build a component for a scala-cli dependency in the sbt purl form: the
 * Scala binary suffix is not part of the name, the platform suffix of the
 * declared platform is, and the Scala binary version is recorded as
 * cdx:scala:compilerVersion.
 *
 * @param {Object} dep Parsed dependency declaration
 * @param {Object} project Directives of the file the dependency was declared in
 * @param {string} sourceFile File the dependency was declared in
 * @returns {Object|null} The component, or null for malformed declarations
 */
export declare function scalaCliComponent(dep: Object, project: Object, sourceFile: string): Object | null;
/**
 * Map a jar path of the Coursier cache to its Maven coordinates.
 *
 * Only the https cache layout with a well-known repository path segment is
 * parsed; anything else returns null rather than guessing a group id.
 *
 * @param {string} jarPath Path of a jar in the Coursier cache
 * @returns {{ group: string, name: string, version: string }|null} The coordinates
 */
export declare function coordinatesFromCoursierPath(jarPath: string): {
    group: string;
    name: string;
    version: string;
} | null;
/**
 * Collect the components a scala-cli project declares through its
 * `//> using` directives.
 *
 * Transitive dependencies are added from the class path of
 * `scala-cli compile --print-class-path` when dependency installation is
 * allowed, by mapping the Coursier cache paths back to coordinates.
 *
 * @param {string} dirPath Directory of the scala-cli project
 * @param {Object} options CLI options
 * @returns {Object[]} Component list, empty when the project declares no
 *   scala-cli directives
 */
export declare function collectScalaCliComponents(dirPath: string, options?: Object): Object[];
//# sourceMappingURL=scalacliutils.d.ts.map