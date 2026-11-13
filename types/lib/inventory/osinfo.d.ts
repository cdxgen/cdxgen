/**
 * Ubuntu / Debian codename map and RHEL display-name aliases.
 * Keep this list updated every year.
 */
export declare const OS_DISTRO_ALIAS: {
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
    "ubuntu-26.04": string;
    "ubuntu-26.10": string;
    "debian-15": string;
    "debian-14": string;
    "debian-14.5": string;
    "debian-13": string;
    "debian-13.7": string;
    "debian-13.6": string;
    "debian-13.5": string;
    "debian-13.4": string;
    "debian-13.3": string;
    "debian-13.2": string;
    "debian-13.1": string;
    "debian-12": string;
    "debian-12.15": string;
    "debian-12.14": string;
    "debian-12.13": string;
    "debian-12.12": string;
    "debian-12.11": string;
    "debian-12.10": string;
    "debian-12.9": string;
    "debian-12.8": string;
    "debian-12.7": string;
    "debian-12.6": string;
    "debian-12.5": string;
    "debian-12.4": string;
    "debian-12.2": string;
    "debian-12.1": string;
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
/**
 * Canonical purl namespace for distro vendors that are published under more
 * than one spelling. Both the os-release path (`getDistroInfo`) and the trivy
 * passthrough in `lib/managers/binary.js` route through this single map so the
 * two paths cannot drift apart again.
 *
 * Azure Linux 2.0 is CBL-Mariner 2.0 — Microsoft renamed the product — and the
 * OSV feed publishes `pkg:rpm/azure-linux/<name>` for every generation
 * (ecosystems "Azure Linux:2" and "Azure Linux:3"), so the historical
 * spellings azurelinux, cbl-mariner and mariner all canonicalise to
 * "azure-linux". rhel/ol/amzn/opensuse-* are the cases previously inlined in
 * getDistroInfo(); alma/rocky-linux were previously inlined in binary.js.
 *
 * Amazon Linux canonicalises to "amazon", the spelling the vulnerability feeds
 * publish (AppThreat vuln-list `amazon`): the os-release ID is `amzn` and
 * trivy emits `amazon`, and the previous `amazonlinux` mapping here matched
 * neither, so live-host Amazon Linux purls matched nothing at all.
 */
export declare const OS_NAMESPACE_ALIAS: {
    alma: string;
    amazonlinux: string;
    amzn: string;
    azurelinux: string;
    "cbl-mariner": string;
    mariner: string;
    ol: string;
    "opensuse-leap": string;
    "opensuse-tumbleweed": string;
    rhel: string;
    "rocky-linux": string;
};
/**
 * Vendor prefixes that `distro` qualifier values are canonicalised for, so one
 * release has exactly one qualifier value no matter which side produced it.
 *
 * trivy stamps the qualifier from its own distro table while cdxgen stamps it
 * from os-release, and the two disagree: an Oracle Linux 9.8 image came out
 * with `oracle-9.8` on 99 components and `ol-9.8` on 43, and a RHEL 9.8 image
 * with namespace `redhat` but qualifier `rhel-9.8`. Canonicalising both sides
 * through this map collapses each release onto the vendor its purl namespace
 * already uses.
 *
 * SUSE is deliberately absent. `sles-15.6`, `opensuse-leap-15.6` and
 * `opensuse-tumbleweed-<snapshot>` are the values consumers derive the release
 * channel from (vulnerability-db maps them to per-release channels), and both
 * sides already agree on them; folding Leap and Tumbleweed onto a bare
 * `opensuse-` vendor would destroy exactly the distinction that matters.
 *
 * Keys are matched longest-first so `cbl-mariner-2.0` resolves against the
 * full vendor segment rather than a shorter prefix.
 */
export declare const OS_DISTRO_QUALIFIER_ALIAS: {
    alma: string;
    amazonlinux: string;
    amzn: string;
    azurelinux: string;
    "cbl-mariner": string;
    mariner: string;
    ol: string;
    rhel: string;
    "rocky-linux": string;
};
/**
 * Whether a `distro` qualifier value is safe to place in a purl unencoded.
 *
 * @param {string} qualifier - distro qualifier value
 * @returns {boolean} true when the value contains only purl-safe characters
 *   and is at most 128 characters long
 */
export declare function isCleanDistroQualifier(qualifier: string): boolean;
/**
 * Canonicalise the vendor prefix of a `distro` qualifier value
 * (e.g. "cbl-mariner-2.0" or "mariner-2.0" -> "azure-linux-2.0") so a release
 * has exactly one qualifier spelling regardless of which tool emitted it.
 * Values without a known vendor prefix are returned unchanged.
 *
 * @param {string} qualifier - distro qualifier value such as "azurelinux-3.0"
 * @returns {string} canonical qualifier value
 */
export declare function canonicalDistroQualifier(qualifier: string): string;
/**
 * Parse an os-release file from an arbitrary root path and return a plain
 * key→value object.  Results are cached per root path so the file is read
 * at most once per process per distinct root.
 *
 * @param {string} [root="/"] - Root of the filesystem to search (e.g. a
 *   container rootfs extracted to a temp directory, or "/" for the live host).
 * @returns {Object} Raw key/value pairs from the os-release file.
 */
export declare function readOsRelease(root?: string): Object;
/**
 * Reset the per-root os-release cache. Exported for unit tests only.
 */
export declare function _resetOsReleaseCache(): void;
/**
 * Derive structured distro information from an os-release file.
 *
 * Returns an object with:
 *   - purlType    {string}  "deb" | "apk" | "rpm" | "alpm" (Arch and the
 *                           distros built on it)
 *   - namespace   {string}  canonical purl namespace (e.g. "ubuntu", "alpine",
 *                           "azure-linux" for both Azure Linux and CBL-Mariner)
 *   - distroId    {string}  ID + "-" + VERSION_ID with a canonical vendor
 *                           prefix (e.g. "ubuntu-22.04", "azure-linux-3.0",
 *                           "alpine-3.24.3")
 *   - distroName  {string}  release codename, or a token OS_DISTRO_ALIAS knows
 *                           (e.g. "jammy", "rhel", "alpine-3.24"); empty when
 *                           the distro has neither
 *
 * lib/managers/binary.js getOSPackages() reads its distro from here, so a
 * container scan and an OBOM run on the same system give a package the same
 * `distro` and `distro_name` qualifiers.
 *
 * @param {string} [root="/"] - Filesystem root to look for os-release.
 * @returns {{ purlType: string, namespace: string, distroId: string, distroName: string }}
 */
export declare function getDistroInfo(root?: string): {
    purlType: string;
    namespace: string;
    distroId: string;
    distroName: string;
};
//# sourceMappingURL=osinfo.d.ts.map