/**
 * Parse an os-release file from an arbitrary root path and return a plain
 * key→value object.  Results are cached per root path so the file is read
 * at most once per process per distinct root.
 *
 * @param {string} [root="/"] - Root of the filesystem to search (e.g. a
 *   container rootfs extracted to a temp directory, or "/" for the live host).
 * @returns {Object} Raw key/value pairs from the os-release file.
 */
export function readOsRelease(root?: string): Object;
export function _resetOsReleaseCache(): void;
/**
 * Derive structured distro information from an os-release file.
 *
 * Returns an object with:
 *   - purlType    {string}  "deb" | "apk" | "rpm"
 *   - namespace   {string}  purl namespace (e.g. "ubuntu", "alpine", "fedora")
 *   - distroId    {string}  ID + "-" + VERSION_ID  (e.g. "ubuntu-22.04")
 *   - distroName  {string}  codename/alias          (e.g. "jammy")
 *
 * Mirrors the logic in lib/managers/binary.js getOSPackages() so that both
 * callers share a single implementation.
 *
 * @param {string} [root="/"] - Filesystem root to look for os-release.
 * @returns {{ purlType: string, namespace: string, distroId: string, distroName: string }}
 */
export function getDistroInfo(root?: string): {
    purlType: string;
    namespace: string;
    distroId: string;
    distroName: string;
};
/**
 * Ubuntu / Debian codename map and RHEL display-name aliases.
 * Keep this list updated every year.
 */
export const OS_DISTRO_ALIAS: {
    "ubuntu-4.10": string;
    "ubuntu-5.04": string;
    "ubuntu-5.10": string;
    "ubuntu-6.06": string;
    "ubuntu-6.10": string;
    "ubuntu-7.04": string;
    "ubuntu-7.10": string;
    "ubuntu-8.04": string;
    "ubuntu-8.10": string;
    "ubuntu-9.04": string;
    "ubuntu-9.10": string;
    "ubuntu-10.04": string;
    "ubuntu-10.10": string;
    "ubuntu-11.04": string;
    "ubuntu-11.10": string;
    "ubuntu-12.04": string;
    "ubuntu-12.10": string;
    "ubuntu-13.04": string;
    "ubuntu-13.10": string;
    "ubuntu-14.04": string;
    "ubuntu-14.10": string;
    "ubuntu-15.04": string;
    "ubuntu-15.10": string;
    "ubuntu-16.04": string;
    "ubuntu-16.10": string;
    "ubuntu-17.04": string;
    "ubuntu-17.10": string;
    "ubuntu-18.04": string;
    "ubuntu-18.10": string;
    "ubuntu-19.04": string;
    "ubuntu-19.10": string;
    "ubuntu-20.04": string;
    "ubuntu-20.10": string;
    "ubuntu-21.04": string;
    "ubuntu-21.10": string;
    "ubuntu-22.04": string;
    "ubuntu-22.10": string;
    "ubuntu-23.04": string;
    "ubuntu-23.10": string;
    "ubuntu-24.04": string;
    "ubuntu-24.10": string;
    "ubuntu-25.04": string;
    "ubuntu-25.10": string;
    "debian-15": string;
    "debian-14": string;
    "debian-14.5": string;
    "debian-13": string;
    "debian-13.5": string;
    "debian-12": string;
    "debian-12.5": string;
    "debian-12.6": string;
    "debian-11": string;
    "debian-11.5": string;
    "debian-10": string;
    "debian-10.5": string;
    "debian-9": string;
    "debian-9.5": string;
    "debian-8": string;
    "debian-8.5": string;
    "debian-7": string;
    "debian-7.5": string;
    "debian-6": string;
    "debian-5": string;
    "debian-4": string;
    "debian-3.1": string;
    "debian-3": string;
    "debian-2.2": string;
    "debian-2.1": string;
    "debian-2": string;
    "debian-1.3": string;
    "debian-1.2": string;
    "debian-1.1": string;
    "red hat enterprise linux": string;
    "red hat enterprise linux 6": string;
    "red hat enterprise linux 7": string;
    "red hat enterprise linux 8": string;
    "red hat enterprise linux 9": string;
    "red hat enterprise linux 10": string;
};
//# sourceMappingURL=osinfo.d.ts.map