/**
 * Parse a Scala-published Maven artifact name into its coordinate parts.
 *
 * @param {string} name Maven artifactId, for example `upickle_sjs1_3`
 * @returns {{ originalName: string, artifactBase: string, binaryVersion: string|null,
 *   platformSuffix: string, purlName: string }} The artifact name without any
 *   Scala suffix (`upickle`), the Scala binary version from the suffix (`3`),
 *   the platform suffix including the underscore (`_sjs1`) or an empty string,
 *   and the artifact name sbt-style purls emit (binary suffix dropped, platform
 *   suffix kept).
 */
export declare function parseScalaArtifact(name: string): {
    originalName: string;
    artifactBase: string;
    binaryVersion: string | null;
    platformSuffix: string;
    purlName: string;
};
/**
 * Build a qualifier-free coordinate key for a Scala-published artifact.
 *
 * The key ignores purl qualifiers such as `repository_url` and `type`, so the
 * POM-coordinate keys of the jar namespace mapping and the sbt-style purls of
 * the components resolve to the same entry.
 *
 * @param {Object} parts Coordinate parts
 * @param {string} [parts.type] Purl type, defaults to `maven`
 * @param {string} [parts.group] Maven groupId
 * @param {string} parts.artifactBase Artifact name without any Scala suffix
 * @param {string} [parts.platformSuffix] `_sjs1`, `_native0.5` or empty
 * @param {string} [parts.version] Package version
 * @returns {string} The coordinate key
 */
export declare function scalaCoordinateKey({ type, group, artifactBase, platformSuffix, version, }?: {
    type?: string;
    group?: string;
    artifactBase: string;
    platformSuffix?: string;
    version?: string;
}): string;
/**
 * Build the qualifier-free coordinate key of a purl string.
 *
 * The artifact name is normalized with {@link parseScalaArtifact}, so
 * `pkg:maven/g/foo_3@1.0` and the sbt-style `pkg:maven/g/foo@1.0` share a key,
 * while the Scala.js build `foo_sjs1_3` keeps its own key (`foo` plus the
 * `_sjs1` platform suffix) and never joins the plain `foo` component.
 *
 * @param {string} purlString Package URL to normalize
 * @returns {string|undefined} The coordinate key, or undefined when the string
 *   is not a parseable purl
 */
export declare function coordinateKeyFromPurl(purlString: string): string | undefined;
/**
 * The coordinate key of a purl together with the Scala binary version its
 * artifact name carries, if any.
 *
 * @param {string} purlString Package URL to normalize
 * @returns {{ key: string, binaryVersion: string|null }|undefined} The key
 *   and binary version, or undefined when the string is not a parseable purl
 */
export declare function scalaCoordinateOfPurl(purlString: string): {
    key: string;
    binaryVersion: string | null;
} | undefined;
/**
 * The artifactId the library is published under, for cache and repository
 * lookups only. Components a Scala build tool reports carry the name with the
 * Scala binary suffix stripped (the platform suffix kept) together with
 * `cdx:scala:compilerVersion`; on disk and in the repository the artifact is
 * `cats-core_2.13` or `upickle_sjs1_3`. Names that end in a full Scala version
 * are used as they are.
 *
 * The component's own `name`, `purl` and `bom-ref` never change.
 *
 * @param {Object} pkg Package with `name` and `properties`.
 * @returns {string} The artifactId to look up.
 */
export declare function publishedArtifactId(pkg: Object): string;
//# sourceMappingURL=scalaCoords.d.ts.map