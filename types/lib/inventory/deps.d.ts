/**
 * Whether a jar holds sources or javadoc rather than classes.
 *
 * @param {string} jarName Jar file name.
 * @returns {boolean}
 */
export declare function isDocumentationJar(jarName: string): boolean;
/**
 * Collect maven dependencies
 *
 * @param {string} mavenCmd Maven command to use
 * @param {string} basePath Path to the maven project
 * @param {boolean} cleanup Remove temporary directories
 * @param {boolean} includeCacheDir Include maven and gradle cache directories
 */
export declare function collectMvnDependencies(mavenCmd: string, basePath: string, cleanup?: boolean, includeCacheDir?: boolean): Promise<{}>;
/**
 * Method to collect class names from all jars in a directory
 *
 * @param {string} jarPath Path containing jars
 * @param {object} pomPathMap Map containing jar to pom names. Required to successfully parse gradle cache.
 *
 * @return object containing jar name and class list
 */
export declare function collectJarNS(jarPath: string, pomPathMap?: object): Promise<{}>;
/**
 * Convert a JAR namespace mapping (produced by {@link collectJarNS}) into an array
 * of CycloneDX package component objects.
 *
 * Each entry in the mapping is resolved to a component with name, group, version,
 * purl, hashes, namespace properties, and source file evidence.
 *
 * @param {Object} jarNSMapping Map of purl string to `{ jarFile, pom, namespaces, hashes }`
 * @returns {Promise<Object[]>} Array of component objects derived from the JAR mapping
 */
export declare function convertJarNSToPackages(jarNSMapping: Object): Promise<Object[]>;
/**
 * Deprecated function to parse pom.xml. Use parsePom instead.
 *
 * @deprecated
 * @param pomXmlData XML contents
 * @returns {Object} Parent component data
 */
export declare function parsePomXml(pomXmlData: any): Object;
/**
 * Parse a JAR MANIFEST.MF file and return its key-value pairs as an object.
 *
 * @param {string} jarMetadata Raw text contents of a MANIFEST.MF file
 * @returns {Object} Key-value pairs extracted from the manifest
 */
export declare function parseJarManifest(jarMetadata: string): Object;
/**
 * Select the most reliable group candidate from JAR manifest metadata.
 *
 * @param {Object} jarMetadata Parsed MANIFEST.MF key-value map
 * @returns {string} Best group candidate, or empty string if none exists
 */
export declare function inferJarGroupFromManifest(jarMetadata?: Object): string;
/**
 * Trim group suffix that duplicates the artifact name for compound artifact names.
 *
 * @param {string} group Group candidate
 * @param {string} name Artifact name candidate
 * @returns {string} Adjusted group
 */
export declare function trimJarGroupSuffix(group: string, name: string): string;
/**
 * Parse a Maven pom.properties file and return its key-value pairs as an object.
 *
 * @param {string} pomProperties Raw text contents of a pom.properties file
 * @returns {Object} Key-value pairs extracted from the properties file
 */
export declare function parsePomProperties(pomProperties: string): Object;
/**
 * Method to get pom properties from maven directory
 *
 * A shaded or fat jar carries a `pom.properties` for every artifact folded
 * into it. When the jar's file name is known, the descriptor whose
 * `artifactId-version` (or `artifactId`) starts the file name is the jar's
 * own; otherwise the first descriptor is used, as before.
 *
 * @param {string} mavenDir Path to maven directory
 * @param {string} [jarName] File name of the jar the directory came from
 *
 * @return array with pom properties
 */
export declare function getPomPropertiesFromMavenDir(mavenDir: string, jarName?: string): Object;
/**
 * The licences a MANIFEST.MF `Bundle-License` value names. The value is a
 * comma-separated list; each item is an SPDX id, a licence name or a URL,
 * optionally followed by `;link=` and `;description=` attributes, and any
 * part may be quoted. Each item is mapped through findLicenseId; an item it
 * cannot map is replaced by its `link` URL when one is given, which the
 * licence URL lookup resolves later. `<<EXTERNAL>>` names no licence.
 *
 * @param {string} value Raw Bundle-License value.
 * @returns {string[]} Licence ids, names or URLs, without duplicates.
 */
export declare function parseManifestLicenseList(value: string): string[];
/**
 * The Maven descriptor a jar carries for itself, read from an extracted
 * `META-INF/maven` directory: the pom.properties that names the jar's own
 * coordinates and the pom.xml stored beside it.
 *
 * @param {string} mavenDir Path to the extracted META-INF/maven directory
 * @param {string} [jarName] File name of the jar the directory came from
 * @returns {{properties: Object, pomXml?: string}|undefined} The chosen
 *   descriptor, with its pom.xml text when one is stored beside it.
 */
export declare function readEmbeddedMavenDescriptor(mavenDir: string, jarName?: string): {
    properties: Object;
    pomXml?: string;
} | undefined;
/**
 * The Maven descriptor and manifest licence a jar carries for itself, read
 * from its zip without extracting it. Entry names are only matched and
 * paired, never used as paths, and each entry is read only under a size
 * bound, because the archive is untrusted input.
 *
 * @param {string} jarFile Path to the jar.
 * @param {{group: string, name: string, version: string}} coordinates The jar's own coordinates, which choose its descriptor.
 * @returns {Promise<{properties?: Object, pomXml?: string, manifestLicenses?: string[]}|undefined>}
 */
export declare function readEmbeddedJarMetadata(jarFile: string, coordinates: {
    group: string;
    name: string;
    version: string;
}): Promise<{
    properties?: Object;
    pomXml?: string;
    manifestLicenses?: string[];
} | undefined>;
/**
 * Method to read a single file entry from a zip file
 *
 * @param {string} zipFile Zip file to read
 * @param {string} filePattern File pattern
 * @param {string} contentEncoding Encoding. Defaults to utf-8
 *
 * @returns {Promise<string|undefined>} File contents
 */
export declare function readZipEntry(zipFile: string, filePattern: string, contentEncoding?: string): Promise<string | undefined>;
/**
 * Read every zip entry whose name contains `pathFragment`. Unlike
 * `readZipEntry`, which returns the first matching entry, this enumerates all
 * matches — needed for PEP 770, where a distribution may carry several SBOM
 * documents under `<dist>.dist-info/sboms/`, in a directory whose name is
 * prefixed by the distribution stem and so is not known in advance.
 *
 * Entries larger than `maxEntryBytes` are skipped without being decompressed,
 * because a wheel is untrusted input and its declared sizes are the only cheap
 * defence against an archive that expands without bound.
 *
 * @param {string} zipFile Path to a zip archive (e.g. a wheel)
 * @param {string} pathFragment Substring an entry name must contain
 * @param {Object} [opts] Options
 * @param {string} [opts.contentEncoding] Text encoding. Defaults to utf-8
 * @param {number} [opts.maxEntryBytes] Per-entry uncompressed size bound
 * @returns {Promise<Array<{name: string, data: string}>>} Matching entries
 */
export declare function readZipEntriesMatching(zipFile: string, pathFragment: string, { contentEncoding, maxEntryBytes }?: {
    contentEncoding?: string;
    maxEntryBytes?: number;
}): Promise<Array<{
    name: string;
    data: string;
}>>;
/**
 * Method to get the classes and relevant sources in a jar file
 *
 * @param {string} jarFile Jar file to read
 *
 * @returns List of classes and sources matching certain known patterns
 */
export declare function getJarClasses(jarFile: string): Promise<any>;
/**
 * Recursively flatten a Python package's transitive dependencies into the
 * dependencies map and flat package list.
 *
 * @param {Object} dependenciesMap Map of bom-ref to the list of dependent bom-refs, mutated in place
 * @param {Object[]} pkgList Flat list of package component objects, mutated in place
 * @param {string} reqOrSetupFile Path to the requirements.txt or setup.py file used as evidence
 * @param {Object} t Root package object with name, version, and nested dependencies
 * @returns {void}
 */
export declare function flattenDeps(dependenciesMap: Object, pkgList: Object[], reqOrSetupFile: string, t: Object): void;
/**
 * Comparator function for sorting CycloneDX component objects.
 *
 * Compares components by `bom-ref`, then `purl`, then `name`, using locale-aware
 * string comparison on the first available key.
 *
 * @param {Object|string} a First component to compare
 * @param {Object|string} b Second component to compare
 * @returns {number} Negative, zero, or positive integer as required by Array.sort
 */
export declare function componentSorter(a: Object | string, b: Object | string): number;
//# sourceMappingURL=deps.d.ts.map