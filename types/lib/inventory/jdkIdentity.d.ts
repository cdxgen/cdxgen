/**
 * The longest a `release` file is read. The file holds a dozen lines; the
 * GraalVM ones list their modules and run to a few kilobytes.
 *
 * @type {number}
 */
export declare const JDK_RELEASE_MAX_BYTES: number;
export declare const JDK_RELEASE_FILE_NAME = "release";
/**
 * The most JDK-named files one scan opens in search of a release file.
 *
 * @type {number}
 */
export declare const MAX_JDK_PROBES: number;
/**
 * Parse the text of a JDK `release` file: one `KEY="value"` per line.
 *
 * @param {string|undefined} text content of the file
 * @returns {Object<string, string>} the keys with their unquoted values
 */
export declare function parseJdkRelease(text: string | undefined): Record<string, string>;
/**
 * Choose the vendor entry for the text a JDK reports about its maker.
 *
 * @param {...string} texts IMPLEMENTOR, IMPLEMENTOR_VERSION, runtime line
 * @returns {Object} the vendor entry; OpenJDK when nothing matches
 */
export declare function jdkVendorFor(...texts: string[]): Object;
/**
 * Describe a JDK from the keys of its `release` file.
 *
 * @param {Object<string, string>} release result of parseJdkRelease
 * @returns {Object|undefined} the identity, or undefined when the file names
 *   no Java version
 */
export declare function jdkIdentityFromRelease(release: Record<string, string>): Object | undefined;
/**
 * Describe a JDK from the output of `java -version` (standard error, which
 * is where every Java version prints it) or of `java --version`.
 *
 * ```
 * openjdk version "21.0.7" 2025-04-15 LTS
 * OpenJDK Runtime Environment Temurin-21.0.7+6 (build 21.0.7+6-LTS)
 * ```
 *
 * @param {string|undefined} text output with the option echoes removed
 * @returns {Object|undefined} the identity, or undefined when no line names a
 *   Java version
 */
export declare function parseJavaVersionOutput(text: string | undefined): Object | undefined;
/**
 * Read the identity of the JDK in a home directory from its release file,
 * through the bounded file helpers: only a regular file inside the scan root
 * is opened, the read is capped, and nothing is executed.
 *
 * @param {string} javaHome absolute path of the JDK home
 * @param {string|undefined} rootDir directory the home must live in
 * @param {function(string, number, string): (string|undefined)} [readText]
 *   bounded reader, `readScanFileText` unless a test brings one
 * @returns {Object|undefined} identity with `home`, or undefined
 */
export declare function readJdkIdentity(javaHome: string, rootDir: string | undefined, readText: Function): Object | undefined;
/**
 * The properties a JDK component carries. Values are small facts: the
 * vendor, versions and the place; never the release file's other keys.
 *
 * @param {Object} identity result of readJdkIdentity or parseJavaVersionOutput
 * @param {string} [home] logical path of the JDK home, as the scan names it
 * @returns {{name: string, value: string}[]}
 */
export declare function jdkProperties(identity: Object, home?: string): {
    name: string;
    value: string;
}[];
/**
 * A JDK is one `platform` component named java, with
 * the generic identity described at the top of this file.
 *
 * @param {Object} identity result of readJdkIdentity or parseJavaVersionOutput
 * @param {Object} [options]
 * @param {string} [options.home] logical home path for the properties
 * @returns {Object} component with `purl` and `bom-ref`
 */
export declare function createJdkComponent(identity: Object, options?: {
    home?: string;
}): Object;
/**
 * Whether a file name is a JDK's launcher.
 *
 * @param {string} fileName basename
 * @param {string} [platform] `win32` names `java.exe`
 * @returns {string|undefined} `java` for a launcher, undefined otherwise
 */
export declare function classifyJavaBinary(fileName: string, platform?: string): string | undefined;
/**
 * Start collecting the JDK components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], byRef: Map<string, Object>}}
 */
export declare function createJdkInventory(): {
    runtimeComponents: Object[];
    dependencies: Object[];
    byRef: Map<string, Object>;
};
/**
 * Record a JDK in the inventory: one component per identity, with every
 * home it was found in as an occurrence and a `cdx:java:home` property.
 *
 * @param {Object} inventory accumulator from createJdkInventory
 * @param {Object} identity result of readJdkIdentity
 * @param {string} [home] logical path of the JDK home
 * @returns {Object} the component of the identity
 */
export declare function addJdkToInventory(inventory: Object, identity: Object, home?: string): Object;
/**
 * Tag a java launcher file component with the JDK it belongs to and link it
 * to the JDK's component.
 *
 * @param {Object} inventory accumulator from createJdkInventory
 * @param {Object} component file component with a `properties` array
 * @param {Object} identity result of readJdkIdentity
 * @param {string} [home] logical path of the JDK home
 */
export declare function attachJdk(inventory: Object, component: Object, identity: Object, home?: string): void;
/**
 * Describe a JDK that an OS package manager installed, from the package's
 * name, version and architecture qualifier: the deb `openjdk-21-jre-headless`,
 * the rpm `java-21-openjdk-headless` and Corretto's `java-21-amazon-corretto-*`,
 * the apk `openjdk21-jre-headless`, Homebrew's `openjdk@21`, Chocolatey's
 * `Temurin25` and the Windows program `Eclipse Temurin JDK with Hotspot
 * 25.0.4.1+1 (x64)`. Documentation, demo and source packages are not JDKs.
 *
 * @param {Object} component OS package component
 * @param {Object} [options]
 * @param {string} [options.hostArch] architecture to assume when the package
 *   names none, such as the one of the host an OBOM describes
 * @returns {Object|undefined} identity, or undefined for any other package
 */
export declare function jdkIdentityFromOsPackage(component: Object, options?: {
    hostArch?: string;
}): Object | undefined;
/**
 * Add the JDK facts to the OS packages that are JDKs, in place: vendor,
 * version, VM, architecture, the home a Windows program's install location
 * names, and the Base64 intrinsic exposure the host rules read. The packages
 * stay what they are (purl, version); a JDK an OS package owns is identified
 * by that package, and distros backport fixes under the upstream version.
 *
 * @param {Object[]} components components of a scan, changed in place
 * @param {Object} [options] see jdkIdentityFromOsPackage
 * @returns {number} how many packages gained the facts
 */
export declare function annotateOsPackageJdks(components: Object[], options?: Object): number;
//# sourceMappingURL=jdkIdentity.d.ts.map