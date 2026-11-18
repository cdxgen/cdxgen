/**
 * Derive a version value from an osquery result row.
 *
 * Falls back through alternate row fields (e.g. `hotfix_id`, `port`, `pid`)
 * that carry version-like values for the given query category.
 *
 * @param {Object} res osquery result row
 * @returns {string|undefined} First present version-like field value
 */
export declare function deriveOsQueryVersion(res: Object): string | undefined;
/**
 * Derive a name value from an osquery result row.
 *
 * @param {Object} res osquery result row
 * @param {boolean} singleResult Whether the query returned exactly one row
 * @param {string} queryName Query name used as a fallback name for single-result queries
 * @returns {string|undefined} First present name-like field value
 */
export declare function deriveOsQueryName(res: Object, singleResult: boolean, queryName: string): string | undefined;
/**
 * Derive a publisher value from an osquery result row.
 *
 * @param {Object} res osquery result row
 * @returns {string} Publisher-like value, or an empty string when absent or literal `"null"`
 */
export declare function deriveOsQueryPublisher(res: Object): string;
/**
 * Derive a description value from an osquery result row.
 *
 * @param {Object} res osquery result row
 * @returns {string} First present description-like field value, or an empty string
 */
export declare function deriveOsQueryDescription(res: Object): string;
/**
 * Sanitize an identity string for use in component names and references.
 *
 * @param {string} value Raw identity value
 * @param {Object} [options]
 * @param {boolean} [options.keepSpaces=false] Keep spaces, as a component name
 *   does: the real name of `7-Zip 26.02 (x64)` is not `7-Zip+26.02+(x64)`, and
 *   a purl encodes its own spaces
 * @returns {string} Value with spaces mapped to `+` (unless kept), `:`/`%` mapped to `-`, and `@`/brace delimiters trimmed
 */
export declare function sanitizeOsQueryIdentity(value: string, { keepSpaces }?: {
    keepSpaces?: boolean;
}): string;
/**
 * Sanitize a value for safe use inside a `bom-ref`.
 *
 * @param {string} value Raw value
 * @param {string} [fallback="unknown"] Value returned when the input is empty or `"null"`
 * @returns {string} Whitespace-collapsed value with bom-ref delimiters replaced by `-`
 */
export declare function sanitizeOsQueryBomRefValue(value: string, fallback?: string): string;
/**
 * Build a deterministic fallback `bom-ref` for an osquery-derived component.
 *
 * @param {string} queryCategory Osquery category (e.g. `deb_packages`)
 * @param {string} componentType CycloneDX component type
 * @param {string|undefined} name Component name
 * @param {string|undefined} version Component version
 * @param {string|undefined} identityField Row field used to distinguish the component's identity
 * @param {string|undefined} identityValue Value of the identity field
 * @returns {string} BOM ref of the form `osquery:<category>:<type>:<name>@<version>[<field>=<value>]`
 */
export declare function createOsQueryFallbackBomRef(queryCategory: string, componentType: string, name: string | undefined, version: string | undefined, identityField: string | undefined, identityValue: string | undefined): string;
/**
 * Determine whether an osquery-derived component type may carry a purl.
 *
 * @param {string} componentType CycloneDX component type
 * @returns {boolean} `false` for `cryptographic-asset`, `data`, `device`, and `information`
 */
export declare function shouldCreateOsQueryPurl(componentType: string): boolean;
/**
 * Construct a purl string for an osquery-derived component.
 *
 * Builds through `tryBuildPurl`, so an invalid combination yields `null`
 * instead of throwing. Derives a swid `tag_id` qualifier when missing and a
 * distro namespace from `/etc/os-release` for OS package types that require one.
 *
 * @param {string} purlType Purl type (e.g. `deb`, `rpm`, `generic`)
 * @param {string|null} group Purl namespace or group
 * @param {string} name Component name
 * @param {string} version Component version
 * @param {Object|null} qualifiers Purl qualifiers
 * @param {string|null} subpath Purl subpath (leading slashes are stripped)
 * @returns {string|null} Canonical purl string, or `null` when the parts do not form a valid purl
 */
export declare function createOsQueryPurl(purlType: string, group: string | null, name: string, version: string, qualifiers: Object | null, subpath: string | null): string | null;
/**
 * The version and purl of a row from an OS package table: `deb_packages`,
 * `rpm_packages`, `pacman_packages`, `homebrew_packages`, `macports_packages`,
 * `snap_packages`, `flatpak_packages` or the rows of the apk database.
 *
 * Such a row is named the way the package manager's own scan names it: deb,
 * rpm and apk with the vendor and the `arch`, `distro`, `distro_name` and
 * `epoch` qualifiers of the container scan, an rpm version joined to its
 * release, a MacPorts version joined to its revision, a flatpak by its
 * application ID with the `arch` and `branch` of its ref. A row's `path`,
 * `admindir` or source file is not a path inside the package, so none of them
 * becomes a subpath.
 *
 * @param {string} purlType One of OS_PACKAGE_PURL_TYPES
 * @param {Object} res osquery row
 * @param {string} name Component name derived from the row
 * @param {Object} [distro] What getDistroInfo() reports; the host's by default
 * @returns {{version: string, purl: string|null}} The component version and the purl, which is null when the row cannot be expressed as one
 */
export declare function createOsQueryPackageIdentity(purlType: string, res: Object, name: string, distro?: Object): {
    version: string;
    purl: string | null;
};
/**
 * The columns of an OS package row that give its licence and its home page.
 * They become the component's `licenses` and a `website` reference rather than
 * properties. `separator` splits a licence column that lists several: pacman
 * keeps one licence per entry, which osquery joins with commas.
 */
export declare const OS_PACKAGE_LICENSE_COLUMNS: {
    alpm: {
        license: string;
        separator: string;
        website: string;
    };
    snap: {
        license: string;
    };
    flatpak: {
        license: string;
        website: string;
    };
};
/**
 * The property name an OS package table column is emitted under.
 *
 * @param {string|undefined} purlType Purl type of the table
 * @param {string} column Column name
 * @returns {string|undefined} The property name, or undefined when the column is not emitted
 */
export declare function osPackagePropertyName(purlType: string | undefined, column: string): string | undefined;
//# sourceMappingURL=osqueryTransform.d.ts.map