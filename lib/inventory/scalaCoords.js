import { Purl } from "@cdxgen/cdx-purl";

// Scala libraries publish their Maven artifacts with a trailing Scala binary
// version suffix (`jwt-core_3`, `coursier_2.13`), optionally preceded by a
// platform suffix for Scala.js and Scala Native builds (`upickle_sjs1_3`,
// `upickle_native0.5_3`). sbt components strip the binary suffix and keep the
// platform suffix (`jwt-core`, `upickle_sjs1`), so the same library is named
// differently depending on the build tool that reported it.
const SCALA_BINARY_SUFFIX_REGEX = /_(2\.\d+|3)$/;
const SCALA_PLATFORM_SUFFIX_REGEX = /_(sjs1|sjs0\.6|native0\.\d+)$/;

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
export function parseScalaArtifact(name) {
  const result = {
    originalName: name,
    artifactBase: name,
    binaryVersion: null,
    platformSuffix: "",
    purlName: name,
  };
  if (!name) {
    return result;
  }
  let rest = name;
  const binaryMatch = rest.match(SCALA_BINARY_SUFFIX_REGEX);
  if (binaryMatch) {
    result.binaryVersion = binaryMatch[1];
    rest = rest.slice(0, rest.length - binaryMatch[0].length);
  }
  const platformMatch = rest.match(SCALA_PLATFORM_SUFFIX_REGEX);
  if (platformMatch) {
    result.platformSuffix = platformMatch[0];
    rest = rest.slice(0, rest.length - platformMatch[0].length);
  }
  result.artifactBase = rest;
  result.purlName = binaryMatch ? `${rest}${result.platformSuffix}` : name;
  return result;
}

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
export function scalaCoordinateKey({
  type = "maven",
  group = "",
  artifactBase = "",
  platformSuffix = "",
  version = "",
} = {}) {
  return [type, group, artifactBase, platformSuffix, version].join(":");
}

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
export function coordinateKeyFromPurl(purlString) {
  return scalaCoordinateOfPurl(purlString)?.key;
}

/**
 * The coordinate key of a purl together with the Scala binary version its
 * artifact name carries, if any.
 *
 * @param {string} purlString Package URL to normalize
 * @returns {{ key: string, binaryVersion: string|null }|undefined} The key
 *   and binary version, or undefined when the string is not a parseable purl
 */
export function scalaCoordinateOfPurl(purlString) {
  if (!purlString?.startsWith("pkg:")) {
    return undefined;
  }
  let purlObj;
  try {
    purlObj = Purl.parse(purlString);
  } catch (_err) {
    return undefined;
  }
  if (!purlObj?.name) {
    return undefined;
  }
  const scalaInfo = parseScalaArtifact(purlObj.name);
  return {
    key: scalaCoordinateKey({
      type: purlObj.type,
      group: purlObj.namespace || "",
      artifactBase: scalaInfo.artifactBase,
      platformSuffix: scalaInfo.platformSuffix,
      version: purlObj.version || "",
    }),
    binaryVersion: scalaInfo.binaryVersion,
  };
}

// An artifact name that already ends in a full Scala version, as scala-cli
// `:::` and sbt `CrossVersion.full` artifacts do (`_3.3.7`, `_2.13.16`). A
// binary suffix such as `_3` left on a name is part of the name: the
// component producers strip exactly one, into the compiler version.
const SCALA_FULL_VERSION_SUFFIX_REGEX = /_\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;

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
export function publishedArtifactId(pkg) {
  const name = pkg?.name;
  if (!name || SCALA_FULL_VERSION_SUFFIX_REGEX.test(name)) {
    return name;
  }
  const binaryVersion = (pkg.properties || []).find(
    (property) => property.name === "cdx:scala:compilerVersion",
  )?.value;
  return binaryVersion ? `${name}_${binaryVersion}` : name;
}
