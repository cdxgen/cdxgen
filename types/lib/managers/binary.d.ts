/**
 * Look up plugin manifest entries for the given tool names and return their
 * CycloneDX tool component objects, de-duplicated by bom-ref.
 *
 * @param {string[]} [toolNames=[]] Plugin tool names to resolve.
 * @returns {Object[]} De-duplicated CycloneDX tool component objects.
 */
export declare function getPluginToolComponents(toolNames?: string[]): Object[];
/**
 * Run the `cargo-auditable` companion binary against the given source path and
 * return its stdout.
 *
 * @param {string} src Path to the Rust binary or source to inspect.
 * @returns {string|undefined} The tool's stdout, or undefined when the binary
 *   is unavailable or produced no output.
 */
export declare function getCargoAuditableInfo(src: string): string | undefined;
/**
 * Check that sourcekitten (bundled plugin or SOURCEKITTEN_CMD) answers a
 * trivial syntax request.
 *
 * @param env {Object} Optional environment overrides merged over process.env
 * @returns {String} `ok`; `unavailable` when there is no bundled plugin and
 *   SOURCEKITTEN_CMD is unset; `not-found` when the configured executable does
 *   not exist; `failed` when it ran but could not answer
 */
export declare function probeSourcekitten(env: Object): string;
/**
 * Execute sourcekitten plugin with the given arguments
 *
 * @param args {Array} Arguments
 * @param env {Object} Optional environment overrides merged over process.env,
 *   used to align sourcekitten with a specific Swift toolchain
 * @returns {undefined|Object} Command output
 */
export declare function executeSourcekitten(args: any[], env: Object): undefined | Object;
/**
 * Canonicalise the distro vendor namespace of an OS package component
 * produced by trivy, regardless of whether trivy expressed the vendor via the
 * purl namespace or the component group (it is inconsistent between
 * packages). e.g. pkg:rpm/alma/... -> pkg:rpm/almalinux/... and
 * pkg:rpm/cbl-mariner/... -> pkg:rpm/azure-linux/... so the purls match the
 * vulnerability feeds. Also aligns the ``distro`` qualifier vendor prefix
 * (alma-9.8 -> almalinux-9.8, mariner-2.0 -> azure-linux-2.0), including
 * spellings that disagree with the namespace, and rebuilds ``group`` and
 * ``bom-ref`` from the rewritten purl.
 *
 * The namespace table is OS_NAMESPACE_ALIAS from lib/inventory/osinfo.js so
 * the trivy path and the os-release path (getDistroInfo) cannot drift apart.
 *
 * A `distro` qualifier that is not purl-safe (trivy emits Amazon Linux as
 * `amazon-2023.12.20260727+(Amazon Linux)`) is replaced with the os-release
 * derived value, or dropped when there is none: an unusable qualifier
 * invalidates the purl and fails validation for the whole BOM.
 *
 * @param {Object} comp trivy OS package component (mutated in place)
 * @param {Object} purlObj parsed PackageURL of comp.purl (mutated in place)
 * @param {string} name component package name (basename form)
 * @param {string} group component group derived from the trivy component name
 * @param {string} [distroId] canonical os-release distro id, e.g. "amazon-2023"
 * @returns {string} the canonicalised group
 */
export declare function canonicaliseOsPackageNamespace(comp: Object, purlObj: Object, name: string, group: string, distroId?: string): string;
/**
 * Repair a `distro` qualifier that cannot survive purl parsing, in place.
 *
 * trivy stamps Amazon Linux with the full pretty version — the qualifier
 * arrives as `distro=amazon-2023.12.20260727+%28Amazon+Linux%29`, whose spaces
 * and parentheses `Purl.parse` rejects outright ("Invalid character in
 * qualifier distro"). The component then bypasses every canonicalisation below
 * (they all need a parsed purl) and reaches the BOM verbatim, where schema
 * validation fails and the *entire* SBOM is discarded — an Amazon Linux scan
 * produces no output at all today.
 *
 * The release is already known from os-release, so the unusable value is
 * swapped for it; with no usable replacement the qualifier is dropped, since a
 * missing qualifier costs one matching hint while an invalid one costs the
 * whole document.
 *
 * @param {Object} comp component whose purl may carry an unusable qualifier
 * @param {string} [distroId] canonical os-release distro id, e.g. "amazon-2023"
 * @returns {Object} the same component
 */
export declare function repairOsComponentPurl(comp: Object, distroId?: string): Object;
/**
 * Drop source-package shadow components that duplicate a real installed
 * package, in place.
 *
 * A shadow is emitted whenever an rpm/deb declares a source name different
 * from its own (bzip2-libs -> bzip2) so that scanners keying on source names
 * still match. When the source package is *itself* installed at the same
 * version, the shadow's purl is identical to the real component's and the two
 * collapse in trimComponents() — which keeps whichever was seen first and
 * never merges `tags`. Seen-first is trivy's listing order, so the outcome is
 * arbitrary: when the shadow wins, a genuinely installed package is reported
 * with `tags: ["source"]` and identity confidence 0, the very marker the
 * shadow carries so consumers can filter shadows out. That turns a real
 * package into a filtered-away one.
 *
 * Dropping the redundant shadow is loss-free: it duplicates the real
 * component's purl (so nothing that matches on purl changes) and its bom-ref
 * is byte-identical, so no dependency reference can dangle.
 *
 * @param {Array} pkgList component list, mutated in place
 * @returns {Array} the same list, for convenience
 */
export declare function dropRedundantSourceComponents(pkgList: any[]): any[];
/**
 * Get the packages installed in the container image filesystem.
 *
 * @param src {String} Source directory containing the extracted filesystem.
 * @param imageConfig {Object} Image configuration containing environment variables, command, entrypoints etc
 * @param options CLI options controlling inventory generation
 *
 * @returns {Object} Metadata containing packages, dependencies, etc
 */
export declare function getOSPackages(src: string, imageConfig: Object, options?: {}): Object;
/**
 * Split a `Name <address>` maintainer string into an `organizationalContact`.
 *
 * @param {string} value Maintainer or supplier string
 * @returns {{name: string, email?: string}|undefined} The contact, if any
 */
export declare function parseOrganizationalContact(value: string): {
    name: string;
    email?: string;
} | undefined;
/**
 * Merge package-owned services that share a bom-ref into one service whose
 * properties are the union of theirs, first occurrence first.
 *
 * @param {Object[]} services Services, possibly sharing bom-refs
 * @returns {Object[]} One service per bom-ref
 */
export declare function dedupeServices(services: Object[]): Object[];
/**
 * Collect the dependency edges trivy recorded for one OS package component.
 *
 * Trivy keys its `dependencies` by its own bom-refs, which may leave the `+` of
 * an rpm or deb version unescaped (`...libstdc%2B%2B6@14.2.0+git10526-...`), so
 * each ref is read structurally and re-rendered in cdxgen's decoded bom-ref
 * form with the component's type, namespace and distro qualifiers.
 *
 * @param {Object<string, string[]>} tmpDependencies Trivy's refs mapped to the refs they depend on
 * @param {string} origBomRef The component's bom-ref as trivy wrote it
 * @param {object} comp The component after cdxgen rewrote its purl and bom-ref
 * @returns {{ref: string, dependsOn: string[]}|undefined} Dependency entry for the component
 */
export declare const retrieveDependencies: (tmpDependencies: Record<string, string[]>, origBomRef: string, comp: object) => {
    ref: string;
    dependsOn: string[];
} | undefined;
/**
 * Batch-enrich operating-system components with host-path trust data using the
 * `trustinspector` helper on darwin and Windows.
 *
 * @param {Object[]} [components=[]] OS components to enrich.
 * @returns {{components: Object[], tools: Object[]}} The enriched components
 *   and any trust-inspector tool components that should be attached to the BOM
 *   metadata.
 */
export declare function enrichOSComponentsWithTrustData(components?: Object[]): {
    components: Object[];
    tools: Object[];
};
/**
 * Execute a SQL query against the bundled osquery binary and return the parsed
 * JSON result.
 *
 * @param {string} query The SQL query string to run.
 * @returns {Object|undefined} The parsed JSON result, or undefined when the
 *   binary is unavailable, dry-run blocks execution, or the output cannot be
 *   parsed.
 */
export declare function executeOsQuery(query: string): Object | undefined;
/**
 * Method to execute dosai to create slices for dotnet
 *
 * @param {string} src Source Path
 * @param {string} slicesFile Slices file name
 * @returns boolean
 */
export declare function getDotnetSlices(src: string, slicesFile: string): boolean;
/**
 * Method to generate binary SBOM using blint
 *
 * @param {string} src Path to binary or its directory
 * @param {string} binaryBomFile Path to binary
 * @param {boolean} deepMode Deep mode flag
 *
 * @return {boolean} Result of the generation
 */
export declare function getBinaryBom(src: string, binaryBomFile: string, deepMode: boolean): boolean;
//# sourceMappingURL=binary.d.ts.map