/**
 * The first affected release of the advisory: OpenJDK 17.0.6. Every later
 * feature release is affected as well, so the bound is open-ended.
 */
export declare const JAVA4SHELL_FIRST_AFFECTED: Readonly<{
    major: 17;
    update: 6;
}>;
/**
 * Builds that fix the defect, one entry per feature release:
 * `{ major: 21, version: "21.0.14" }` makes every 21.x JDK below that version
 * affected and that version and later not. Empty until vendors publish
 * fixed builds; the range above stays open-ended until then.
 *
 * @type {{major: number, version: string}[]}
 */
export declare const JAVA4SHELL_FIXED_VERSIONS: {
    major: number;
    version: string;
}[];
/**
 * Whether a JDK version lies in the range the advisory names: 17.0.6 and
 * later, which includes every later feature release, minus the fixed builds.
 *
 * @param {string|undefined} version JAVA_VERSION such as `21.0.5` or `1.8.0_504`
 * @returns {boolean}
 */
export declare function isJava4ShellAffectedVersion(version: string | undefined): boolean;
/**
 * The exposure of a JDK to the Base64 intrinsic defect, before looking at
 * the JVM options of any process: `not-affected` for a JDK before 17.0.6, a
 * fixed build, a VM other than HotSpot (OpenJ9 and Semeru have no C2 Base64
 * intrinsic), or a CPU architecture other than x86-64, and `exposed`
 * otherwise. An unknown architecture stays `exposed`.
 *
 * @param {{version: string, vm?: string, arch?: string, vendor?: {key: string}}} identity
 *   JDK identity
 * @returns {"exposed"|"not-affected"}
 */
export declare function java4ShellExposure(identity: {
    version: string;
    vm?: string;
    arch?: string;
    vendor?: {
        key: string;
    };
}): "exposed" | "not-affected";
/**
 * Whether the text of /proc/cpuinfo lists every CPU feature the overflow
 * needs on its first `flags` line.
 *
 * @param {string|undefined} cpuinfo text of /proc/cpuinfo
 * @returns {boolean}
 */
export declare function cpuHasAvx512Vbmi(cpuinfo: string | undefined): boolean;
/**
 * The warning for a JDK that Java4Shell can hit on this host, or undefined.
 *
 * @param {Object} identity JDK identity from jdkIdentity.js
 * @param {Object} [host] overrides for tests: `platform`, `arch`, `cpuinfo`
 *   and `options`, the text of the JVM option variables
 * @returns {string|undefined}
 */
export declare function java4ShellWarning(identity: Object, host?: Object): string | undefined;
/**
 * Print the Java4Shell warning once per run.
 *
 * @param {Object} identity JDK identity from jdkIdentity.js
 */
export declare function warnIfJava4ShellExposed(identity: Object): void;
/**
 * Read the two options that change the vulnerable path from the command line
 * of a java process: `-XX:-UseBASE64Intrinsics` and `-XX:UseAVX=<0-3>`. The
 * tokens may come from the command line itself or from the text of a
 * JAVA_TOOL_OPTIONS or JDK_JAVA_OPTIONS assignment in it. The last
 * occurrence of an option wins, as in the JVM.
 *
 * @param {string|undefined} cmdline command line text
 * @returns {{UseBASE64Intrinsics?: string, UseAVX?: string}} the options set,
 *   as `true`/`false` and `0` to `3`
 */
export declare function parseJvmPathOptions(cmdline: string | undefined): {
    UseBASE64Intrinsics?: string;
    UseAVX?: string;
};
/**
 * Whether the options of a process switch the vulnerable path off: the
 * intrinsic is disabled, or AVX is capped below AVX-512 (`UseAVX` 0 to 2).
 *
 * @param {{UseBASE64Intrinsics?: string, UseAVX?: string}} options result of
 *   parseJvmPathOptions
 * @returns {boolean}
 */
export declare function jvmOptionsMitigate(options: {
    UseBASE64Intrinsics?: string;
    UseAVX?: string;
}): boolean;
//# sourceMappingURL=java4shell.d.ts.map