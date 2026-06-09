export function _resetOsInfoCache(): void;
/**
 * Resolves a file path to its owning OS package manager package, including a
 * correctly computed purl with distro qualifiers derived from /etc/os-release.
 *
 * @param {string} filePath - Absolute path to the library file
 * @returns {{ name: string, version: string, arch: string, type: string, purl: string } | undefined}
 */
export function resolvePackageForFile(filePath: string): {
    name: string;
    version: string;
    arch: string;
    type: string;
    purl: string;
} | undefined;
//# sourceMappingURL=osPackageResolver.d.ts.map