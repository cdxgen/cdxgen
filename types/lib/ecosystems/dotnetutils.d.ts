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
export declare function extractVersionFromHintPath(hintPath: string | null | undefined): string | null;
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
export declare function isValidVersion(version: string | null | undefined): boolean;
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
export declare function extractPackageInfoFromHintPath(hintPath: string | null | undefined, referenceNames?: string[]): {
    name: string | null;
    version: string | null;
};
//# sourceMappingURL=dotnetutils.d.ts.map