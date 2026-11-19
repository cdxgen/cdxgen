/**
 * Longest HintPath read for a package name and version. Windows paths stop at
 * 32767 characters and real ones are far shorter. The patterns below retry from
 * every separator and dot, so the length is capped to keep the retries small.
 */
const MAX_HINT_PATH_LENGTH = 4096;

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

  const normalizedPath = hintPath.replace(/\\/g, "/");

  const directPackagePattern =
    /(?:packages|nuget|\.nuget\/packages|paquets)\/([^\/]+?)\.(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)(?:\/|$)/i;
  const directMatch = normalizedPath.match(directPackagePattern);
  if (directMatch) {
    return directMatch[2];
  }

  const structuredPattern =
    /(?:^|\/)(?:packages|nuget|\.nuget\/packages|paquets)\/.+?\/(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)(?:\/|$)/i;
  const structuredMatch = normalizedPath.match(structuredPattern);
  if (structuredMatch) {
    return structuredMatch[1];
  }

  const fallbackPatterns = [
    /lib\/(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)\/[^\/]+\.dll$/,
    /(?:^|\/)(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)(?:\/[^\/]*\.dll$)/,
  ];

  for (const pattern of fallbackPatterns) {
    const fallbackMatch = normalizedPath.match(pattern);
    if (fallbackMatch?.[1]) {
      const version = fallbackMatch[1];
      if (isValidVersion(version)) {
        return version;
      }
    }
  }

  return null;
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
 * @returns {{name: string|null, version: string|null}} Object containing package name and version
 * @example
 * extractPackageInfoFromHintPath('..\\packages\\BouncyCastle.Cryptography.2.6.2\\lib\\net461\\BouncyCastle.Cryptography.dll')
 * // returns { name: 'BouncyCastle.Cryptography', version: '2.6.2' }
 *
 * extractPackageInfoFromHintPath('C:\\Users\\user\\.nuget\\packages\\microsoft.entityframeworkcore\\7.0.10\\lib\\net6.0\\Microsoft.EntityFrameworkCore.dll')
 * // returns { name: 'microsoft.entityframeworkcore', version: '7.0.10' }
 */
export function extractPackageInfoFromHintPath(hintPath) {
  if (
    !hintPath ||
    typeof hintPath !== "string" ||
    hintPath.length > MAX_HINT_PATH_LENGTH
  ) {
    return { name: null, version: null };
  }

  const normalizedPath = hintPath.replace(/\\/g, "/");

  const directPattern =
    /(?:packages|nuget|\.nuget\/packages|paquets)\/([^\/]+?)\.(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)(?:\/|$)/i;
  const directMatch = normalizedPath.match(directPattern);
  if (directMatch) {
    return {
      name: directMatch[1],
      version: directMatch[2],
    };
  }

  const structuredPattern =
    /(?:^|\/)(?:packages|nuget|\.nuget\/packages|paquets)\/(.+?)\/(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)(?:\/|$)/i;
  const structuredMatch = normalizedPath.match(structuredPattern);
  if (structuredMatch) {
    const fullPath = structuredMatch[1];
    const pathParts = fullPath.split("/").filter((part) => part);
    const name = pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
    return {
      name: name,
      version: structuredMatch[2],
    };
  }

  const libPattern =
    /lib\/(\d+(?:\.\d+){1,3}(?:-[a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9.-]+)?)\/[^\/]+\.dll$/;
  const libMatch = normalizedPath.match(libPattern);
  if (libMatch?.[1]) {
    const dllMatch = normalizedPath.match(/\/([^\/]+)\.dll$/);
    return {
      name: dllMatch ? dllMatch[1] : null,
      version: libMatch[1],
    };
  }

  const version = extractVersionFromHintPath(hintPath);
  return {
    name: null,
    version: version,
  };
}
