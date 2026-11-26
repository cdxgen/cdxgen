/**
 * Longest HintPath read for a package name and version. Windows paths stop at
 * 32767 characters and real ones are far shorter. The segment walk below
 * retries from every separator and dot, so the length is capped to keep the
 * retries small.
 */
const MAX_HINT_PATH_LENGTH = 4096;

/**
 * The folders a NuGet cache or packages directory can be named by, compared
 * case-insensitively. `packages`, `nuget` and `paquets` hold the
 * packages.config layout; the global-packages folder is the `.nuget` +
 * `packages` pair (Windows `%USERPROFILE%` or a POSIX home), or `nuget` +
 * `packages` when a drive root was pointed at it.
 */
const NUGET_PACKAGES_SEGMENTS = new Set(["packages", "nuget", "paquets"]);

/**
 * Index of the first package id segment after a NuGet packages root, or -1
 * when the path names none.
 *
 * @param {string[]} segments Path segments
 * @returns {number} The id segment index, or -1
 */
function nugetPackageIdSegmentIndex(segments) {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i].toLowerCase();
    if (segment === ".nuget") {
      if (
        i + 1 < segments.length &&
        segments[i + 1].toLowerCase() === "packages"
      ) {
        return i + 2;
      }
      continue;
    }
    if (segment === "nuget" && segments[i + 1]?.toLowerCase() === "packages") {
      return i + 2;
    }
    if (NUGET_PACKAGES_SEGMENTS.has(segment)) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Split a packages.config folder segment of the form `<id>.<version>`.
 *
 * The form is ambiguous when the id itself ends in numbers, as
 * `Microsoft.VisualStudio.Shell.15.0.17.11.40262` does. A reference name or
 * the DLL file name marks the split when it is a prefix of the segment
 * followed by a dot, and the longest such prefix wins. Without one, the first
 * split whose remainder is a valid version wins, which is the shortest id.
 *
 * @param {string} idSegment The segment that holds the id and the version
 * @param {string[]} referenceNames Names the caller knows the package by
 * @returns {{name: string, version: string}|undefined} The split result
 */
function splitPackageIdSegment(idSegment, referenceNames) {
  const lowerSegment = idSegment.toLowerCase();
  let splitIndex = -1;
  for (const referenceName of referenceNames) {
    if (typeof referenceName !== "string" || !referenceName) {
      continue;
    }
    let hintName = referenceName;
    if (hintName.toLowerCase().endsWith(".dll")) {
      hintName = hintName.slice(0, -4);
    }
    const prefix = `${hintName.toLowerCase()}.`;
    if (
      prefix.length < lowerSegment.length &&
      lowerSegment.startsWith(prefix) &&
      prefix.length > splitIndex + 1
    ) {
      splitIndex = prefix.length - 1;
    }
  }
  if (splitIndex !== -1) {
    const version = idSegment.slice(splitIndex + 1);
    if (isValidVersion(version)) {
      return { name: idSegment.slice(0, splitIndex), version };
    }
  }
  for (
    let dotIndex = idSegment.indexOf(".");
    dotIndex !== -1;
    dotIndex = idSegment.indexOf(".", dotIndex + 1)
  ) {
    const version = idSegment.slice(dotIndex + 1);
    if (isValidVersion(version)) {
      return { name: idSegment.slice(0, dotIndex), version };
    }
  }
  return undefined;
}

/**
 * Read a package name and version out of a HintPath by walking its segments.
 *
 * The global-packages layout puts the id and the version in a segment of
 * their own each (`<root>/<id>/<version>/lib/...`), so an id with dotted
 * numeric parts such as `microsoft.visualstudio.shell.15.0` stays whole and
 * the version is the next segment. That layout is tried first. The
 * packages.config layout folds both into one segment
 * (`<root>/<id>.<version>/lib/...`), which splits on the reference or DLL
 * name when it has one. Versions further down the tree, and the `lib`
 * folder the assembly was loaded from, answer last.
 *
 * @param {string} hintPath The HintPath string to read
 * @param {string[]} referenceNames Names the caller knows the package by,
 *   such as the `<Reference Include>` name and the DLL file name
 * @returns {{name: string|null, version: string|null}} The package info
 */
function extractPackageInfoFromSegments(hintPath, referenceNames) {
  const normalizedPath = hintPath.replace(/\\/g, "/");
  const segments = normalizedPath.split("/").filter((part) => part);
  const idSegmentIndex = nugetPackageIdSegmentIndex(segments);
  if (idSegmentIndex !== -1 && idSegmentIndex < segments.length) {
    const idSegment = segments[idSegmentIndex];
    const nextSegment = segments[idSegmentIndex + 1];
    if (nextSegment && isValidVersion(nextSegment)) {
      return { name: idSegment, version: nextSegment };
    }
    const splitInfo = splitPackageIdSegment(idSegment, referenceNames);
    if (splitInfo) {
      return splitInfo;
    }
    // Older or nested layouts keep the version deeper in the tree; the
    // first segment that is a version names the folder before it.
    for (let i = idSegmentIndex + 1; i < segments.length; i++) {
      if (isValidVersion(segments[i])) {
        return { name: segments[i - 1] || null, version: segments[i] };
      }
    }
  }
  const libPattern =
    /lib\/(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)\/[^\/]+\.dll$/;
  const libMatch = normalizedPath.match(libPattern);
  if (libMatch?.[1] && isValidVersion(libMatch[1])) {
    const dllMatch = normalizedPath.match(/\/([^\/]+)\.dll$/);
    return {
      name: dllMatch ? dllMatch[1] : null,
      version: libMatch[1],
    };
  }
  const tailPattern =
    /(?:^|\/)(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)\/[^\/]*\.dll$/;
  const tailMatch = normalizedPath.match(tailPattern);
  if (tailMatch?.[1] && isValidVersion(tailMatch[1])) {
    return { name: null, version: tailMatch[1] };
  }
  return { name: null, version: null };
}

/**
 * Extracts version number from a HintPath in .NET project files
 * @param {string|null|undefined} hintPath - The HintPath string to extract version from
 * @returns {string|null} The extracted version number or null if not found
 * @example
 * extractVersionFromHintPath('..\\packages\\BouncyCastle.Cryptography.2.6.2\\lib\\net461\\BouncyCastle.Cryptography.dll')
 * // returns '2.6.2'
 *
 * extractVersionFromHintPath('C:\\Users\\user\\.nuget\\packages\\microsoft.entityframeworkcore\\7.0.10\\lib\\net6.0\\Microsoft.EntityFrameworkCore.dll')
 * // returns '7.0.10'
 *
 * extractVersionFromHintPath('../packages/MyLib.1.0.0+build.123/lib/net48/MyLib.dll')
 * // returns '1.0.0+build.123'
 */
export function extractVersionFromHintPath(hintPath) {
  if (
    !hintPath ||
    typeof hintPath !== "string" ||
    hintPath.length > MAX_HINT_PATH_LENGTH
  ) {
    return null;
  }
  return extractPackageInfoFromSegments(hintPath, []).version;
}

/**
 * Validates if a string is a valid semantic version
 * Supports versions with pre-release identifiers and build metadata
 * @param {string|null|undefined} version - The version string to validate
 * @returns {boolean} True if the version is valid, false otherwise
 * @example
 * isValidVersion('1.0.0') // true
 * isValidVersion('1.0.0-alpha') // true
 * isValidVersion('1.0.0+build.123') // true
 * isValidVersion('1.0.0-alpha+build.123') // true
 * isValidVersion('1.0.0-') // false
 * isValidVersion('invalid') // false
 */
export function isValidVersion(version) {
  if (!version || typeof version !== "string") return false;

  const versionRegex =
    /^\d+(\.\d+){1,3}(-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?(\+[a-zA-Z0-9.-]+)?$/;
  return versionRegex.test(version);
}

/**
 * Extracts both package name and version from a HintPath in .NET project files
 * @param {string|null|undefined} hintPath - The HintPath string to extract package info from
 * @param {string[]} [referenceNames] Names the reference is known by, such as
 *   the `<Reference Include>` name and the DLL file name. They mark where an
 *   ambiguous packages.config segment such as
 *   `Microsoft.VisualStudio.Shell.15.0.17.11.40262` splits into an id and a
 *   version.
 * @returns {{name: string|null, version: string|null}} Object containing package name and version
 * @example
 * extractPackageInfoFromHintPath('..\\packages\\BouncyCastle.Cryptography.2.6.2\\lib\\net461\\BouncyCastle.Cryptography.dll')
 * // returns { name: 'BouncyCastle.Cryptography', version: '2.6.2' }
 *
 * extractPackageInfoFromHintPath('C:\\Users\\user\\.nuget\\packages\\microsoft.entityframeworkcore\\7.0.10\\lib\\net6.0\\Microsoft.EntityFrameworkCore.dll')
 * // returns { name: 'microsoft.entityframeworkcore', version: '7.0.10' }
 */
export function extractPackageInfoFromHintPath(hintPath, referenceNames = []) {
  if (
    !hintPath ||
    typeof hintPath !== "string" ||
    hintPath.length > MAX_HINT_PATH_LENGTH
  ) {
    return { name: null, version: null };
  }
  return extractPackageInfoFromSegments(hintPath, referenceNames || []);
}
