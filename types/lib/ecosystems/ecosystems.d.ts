export declare let metadata_cache: {};
/**
 * Internal helper to reset metadata_cache. Used by parseGoModData (still in
 * utils.js until batch 6) because ESM forbids reassigning an imported binding.
 * NOT re-exported through the utils.js barrel.
 */
export declare function _clearMetadataCache(): void;
/**
 * Fetches license information for a list of Swift packages by querying the
 * GitHub repository license API for packages hosted on github.com.
 *
 * @param {Object[]} pkgList List of Swift package objects with optional repository.url fields
 * @returns {Promise<Object[]>} Resolved list of package objects, each augmented with a license field where available
 */
export declare function getSwiftPackageMetadata(pkgList: Object[]): Promise<Object[]>;
/**
 * Method to retrieve metadata for npm packages by querying npmjs
 *
 * A license the registry declares replaces the one the package arrived with.
 * When the registry declares none, the package keeps its own, and only a
 * package with neither falls back to its repository's license.
 *
 * @param {Array} pkgList Package list
 */
export declare function getNpmMetadata(pkgList: any[], registryUrl: any): Promise<any[]>;
/**
 * Method to locate local Gradle, Maven, or Coursier cache files for a given maven coordinate.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId
 * @param {string} version Package version
 * @returns {Object|null} Object containing jarPath, sha1, and pomPath, or null
 */
export declare function findLocalMvnArtifact(group: string, name: string, version: string): Object | null;
/**
 * Method to retrieve metadata for maven packages, from the local caches first
 * and from Maven Central only for what remains.
 *
 * Every package is first enriched from data on disk. Only when license
 * fetching is enabled (FETCH_LICENSE) or `force` is set are the packages
 * still without a licence looked up remotely, and then only those a public
 * repository can hold.
 *
 * @param {Array} pkgList Package list
 * @param {Object} jarNSMapping Jar Namespace mapping object
 * @param {Boolean} force Force fetching of license
 * @param {{skipPurls?: Set<string>}} [context] Purls or bom-refs of the
 *   project's own modules, which are never looked up remotely.
 *
 * @returns {Array} Updated package list
 */
export declare function getMvnMetadata(pkgList: any[], jarNSMapping?: Object, force?: boolean, context?: {
    skipPurls?: Set<string>;
}): any[];
/**
 * Method to compose URL of pom.xml
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {String} fullUrl
 */
export declare function composePomXmlUrl({ urlPrefix, group, name, version }: string): string;
/**
 * Method to fetch pom.xml data and parse it to JSON, merged with its parents.
 *
 * Each level is read from the local caches first. When a parent cannot be
 * found, the child and any nearer parents are still returned.
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Object|undefined}
 */
export declare function fetchPomXmlAsJson({ urlPrefix, group, name, version }: string): Object | undefined;
/**
 * Method to fetch pom.xml data, from the local caches when present.
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>}
 */
export declare function fetchPomXml({ urlPrefix, group, name, version }: string): Promise<string>;
/**
 * Method extract single or multiple license entries that might appear in pom.xml
 *
 * @param {Object|Array} license
 */
export declare function parseLicenseEntryOrArrayFromPomXml(license: Object | any[]): any[] | undefined;
/**
 * Method to parse pom.xml in search of a comment containing license text
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>} License ID
 */
export declare function extractLicenseCommentFromPomXml({ urlPrefix, group, name, version, }: string): Promise<string>;
/**
 * Method to mimic pip version solver using node-semver
 *
 * @param {Array} versionsList List of version numbers available
 * @param {*} versionSpecifiers pip version specifier
 */
export declare function guessPypiMatchingVersion(versionsList: any[], versionSpecifiers: any): any;
/**
 * Method to retrieve metadata for python packages by querying pypi
 *
 * @param {Array} pkgList Package list
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 */
export declare function getPyMetadata(pkgList: any[], fetchDepsInfo: boolean): Promise<any[]>;
/**
 * Method to parse bdist_wheel metadata (dist-info/METADATA)
 *
 * @param {string} mDataFile bdist_wheel metadata file
 * @param {string} rawMetadata Raw metadata
 *
 */
export declare function parseBdistMetadata(mDataFile: string, rawMetadata?: string): {
    name: string;
    version: string;
    description: string;
    author: string;
    licenses: never[];
    externalReferences: never[];
    properties: never[];
}[];
/**
 * Build a stable dedupe key for an external reference from its type/url/comment.
 *
 * @param {{type: string, url: string, comment?: string}} reference External reference.
 * @returns {string} JSON-stringified dedupe key.
 */
export declare function createExternalReferenceKey(reference: {
    type: string;
    url: string;
    comment?: string;
}): string;
/**
 * Merge external references onto a component, skipping duplicates.
 *
 * @param {object} component Component to enrich with external references.
 * @param {Array<{type: string, url: string, comment?: string}>} references References to merge.
 * @returns {void}
 */
export declare function mergeExternalReferences(component: object, references: Array<{
    type: string;
    url: string;
    comment?: string;
}>): void;
/**
 * Method to construct a GitHub API url for the given repo metadata
 * @param {Object} repoMetadata Repo metadata with group and name
 * @return {String|undefined} github api url (or undefined - if not enough data)
 */
export declare function repoMetadataToGitHubApiUrl(repoMetadata: Object): string | undefined;
/**
 * Method to split GitHub url into its parts
 * @param {String} repoUrl Repository url
 * @return {[String]} parts from url
 */
export declare function getGithubUrlParts(repoUrl: string): [string];
/**
 * Method to construct GitHub api url from repo metadata or one of multiple formats of repo URLs
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {String|undefined} github api url (or undefined - if not a GitHub repo)
 */
export declare function toGitHubApiUrl(repoUrl: string, repoMetadata: Object): string | undefined;
/**
 * Prefetch the GitHub licence endpoint for a list of repository URLs.
 *
 * The single biggest remaining serialisation: `getRepoLicense` is called once
 * per component from npm, Maven, Swift and Go, each call a full round trip to
 * api.github.com. Batching them also makes the authenticated concurrency
 * allowance worth having — with `GITHUB_TOKEN` set, cdxrs runs eight of these at
 * a time instead of one.
 *
 * @param {Array<string|undefined>} repoUrls Repository URLs (duplicates and
 *   empties are fine).
 * @returns {Promise<void>}
 */
export declare function prefetchRepoLicenses(repoUrls: Array<string | undefined>): Promise<void>;
/**
 * Discard prefetched repository licences. Tests only.
 */
export declare function resetRepoLicensePrefetch(): void;
/**
 * Fetch the license for a repository, primarily via the GitHub license API.
 *
 * Resolves the GitHub API license endpoint for the repository URL, deriving an
 * SPDX id from the response (or by scanning the license file content when the
 * API reports `NOASSERTION`). Honours any prefetched response.
 *
 * @param {string} repoUrl Repository URL.
 * @param {object} [repoMetadata] Optional repository metadata.
 * @returns {Promise<{url: string, id?: string, name?: string}|undefined>}
 *   Resolved license object, or undefined when no license can be determined.
 */
export declare function getRepoLicense(repoUrl: string, repoMetadata?: object): Promise<{
    url: string;
    id?: string;
    name?: string;
} | undefined>;
/**
 * Prefetch the pkg.go.dev pages for a list of Go modules.
 *
 * Go was the last ecosystem making one round trip per module with the URL known
 * up front: `getGoPkgLicense` and `getGoPkgVCSUrl` are both called from inside
 * the parsers' loops, so a module list of any size was fetched strictly one at a
 * time. Both pages are HTML, which is why these requests carry
 * `responseType: "text"` and so run on the JS pool rather than through cdxrs.
 *
 * Callers must pass exactly the modules their loop will look up. A superset
 * issues requests the serial path never made; a subset only loses some of the
 * batching.
 *
 * @param {Array<{group?: string, name?: string}>} modules Modules about to be
 *   resolved. Duplicates and entries without a name are fine.
 * @returns {Promise<void>}
 */
export declare function prefetchGoPkgMetadata(modules: Array<{
    group?: string;
    name?: string;
}>): Promise<void>;
/**
 * Discard prefetched pkg.go.dev documents. Tests only.
 */
export declare function resetGoPkgPrefetch(): void;
/**
 * Method to get go pkg license from go.dev site.
 *
 * @param {Object} repoMetadata Repo metadata
 */
export declare function getGoPkgLicense(repoMetadata: Object): Promise<any>;
/**
 * Method to get go pkg vcs url from go.dev site.
 *
 * @param {String} group Package group
 * @param {String} name Package name
 */
export declare function getGoPkgVCSUrl(group: string, name: string): Promise<any>;
/**
 * Method to retrieve metadata for rust packages by querying crates
 *
 * The local Cargo registry is consulted first, because crates.io's crawler
 * policy allows one request per second and a populated `~/.cargo` already
 * holds the license, description, repository, checksum and yanked flag for
 * every crate the build compiled.
 *
 * What it does not hold is publisher identity, so a caller that needs the
 * publisher-drift and release-cadence signals — the predictive audit does —
 * passes `preferLocalCache: false` and takes the slower registry path.
 *
 * @param {Array} pkgList Package list
 * @param {Object} [options] Options
 * @param {boolean} [options.preferLocalCache=true] Answer from the local Cargo
 *   registry where it can, and query crates.io only for the rest.
 */
export declare function getCratesMetadata(pkgList: any[], options?: {
    preferLocalCache?: boolean;
}): Promise<any[]>;
/**
 * Method to retrieve metadata for dart packages by querying pub.dev
 *
 * @param {Array} pkgList Package list
 */
export declare function getDartMetadata(pkgList: any[]): Promise<any[]>;
/**
 * Normalize a Cargo checksum/integrity string into canonical hex-prefixed form.
 *
 * Accepts an existing `sha256-`/`sha384-` prefixed digest (validating the hex
 * length) or a bare hex digest, returning `<algo>-<digest>`. Returns undefined
 * for non-string or unrecognized inputs.
 *
 * @param {string} integrity Raw checksum string from a Cargo.lock or registry.
 * @returns {string|undefined} Canonical `algo-digest` integrity, or undefined.
 */
export declare function normalizeCargoIntegrity(integrity: string): string | undefined;
/**
 * Method to extract a war or ear file
 *
 * @param {string} jarFile Path to jar file
 * @param {string} tempDir Temporary directory to use for extraction
 * @param {object} jarNSMapping Jar class names mapping object
 *
 * @return pkgList Package list
 */
export declare function extractJarArchive(jarFile: string, tempDir: string, jarNSMapping?: object): Promise<any[]>;
/**
 * Method to retrieve metadata for nuget packages
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependencies Dependencies
 */
export declare function getNugetMetadata(pkgList: any[], dependencies?: any[]): Promise<{
    pkgList: any[];
    dependencies: any[];
}>;
//# sourceMappingURL=ecosystems.d.ts.map