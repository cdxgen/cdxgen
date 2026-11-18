/**
 * The directory of a process's launcher under the probe's root. On the live
 * Windows root the path already names its drive; under another root the drive
 * letter is dropped and the rest joined to it.
 *
 * @param {Object} context probe context with `rootPath`, `logicalRoot`,
 *   `platform` and `pathApi`
 * @param {string} launcherPath path of the launcher as the host names it
 * @returns {string} absolute directory
 */
export declare function processDirectory(context: Object, launcherPath: string): string;
/**
 * Look for JDKs no package manager owns on the host. Components come back
 * only for the files nothing owns: a `file` component for each `java`
 * launcher with the cdx:java properties, and one `platform` component per JDK
 * identity.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export declare function probeHostJdk(options?: Object): {
    components: Object[];
    dependencies: Object[];
};
/**
 * Record, on the process and listening-port rows of java launchers, the two
 * JVM options that switch the Base64 intrinsic path off: `-XX:-UseBASE64Intrinsics`
 * and `-XX:UseAVX=<0-3>`, read from the row's command lines, including the
 * text of a JAVA_TOOL_OPTIONS or JDK_JAVA_OPTIONS assignment in them. They
 * become `cdx:java:jvmOption:UseBASE64Intrinsics` (`true`/`false`) and
 * `cdx:java:jvmOption:UseAVX`. No other option is read: a `-D` value can hold
 * a password.
 *
 * @param {Object[]} components the OS scan's components, changed in place
 * @returns {number} how many rows gained an option
 */
export declare function annotateJavaProcessOptions(components: Object[]): number;
/**
 * Join the listening-port and process rows of java launchers to the JDK
 * whose home holds the row's path: a probed JDK, or an OS package JDK that
 * names its home (a Windows program's install location). Each such row gains
 * `cdx:java:version` and `cdx:java:vendor`. A row osquery reports with the
 * version 0, a placeholder (a listening-port row's version is its port), gets
 * the JDK's version, and its swid purl and bom-ref are rewritten. A JDK is
 * `mitigated` only when every one of its homes has a running process and
 * every such process sets an option that switches the Base64 intrinsic path
 * off (see annotateJavaProcessOptions); a home without a running process
 * keeps the JDK `exposed`. An OBOM has no dependency graph, so no edge is
 * added. A row whose JDK was not found keeps what it had.
 *
 * @param {Object[]} components the OS scan's components, changed in place
 * @param {Object[]} jdkComponents JDK components with `cdx:java:home`
 * @returns {number} how many rows were changed
 */
export declare function linkJdkProcessRows(components: Object[], jdkComponents: Object[]): number;
//# sourceMappingURL=jdkHostProbe.d.ts.map