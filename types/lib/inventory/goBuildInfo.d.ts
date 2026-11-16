export declare const PRE_1_18_VERSION = "unknown-pre-1.18";
/**
 * Read the Go toolchain version from an executable's buildinfo header.
 *
 * @param {string} filePath absolute path to a possible Go binary
 * @returns {string|undefined} `go1.x.y`, `unknown-pre-1.18` for old layouts,
 *   or undefined when the file carries no Go buildinfo
 */
export declare function readGoBuildVersion(filePath: string): string | undefined;
/**
 * Read the build settings of a Go executable: the toolchain version plus the
 * settings its module-info `build` lines record. Everything here is provenance
 * about the build; flag values stay in the binary.
 *
 * @param {string} filePath absolute path to a possible Go binary
 * @returns {{buildVersion: string, cgoEnabled: boolean|undefined, cgoEnvFlagNames: string[], trimpath: boolean, buildmode: string|undefined}|undefined}
 *   undefined when the file carries no Go buildinfo; `cgoEnabled` is
 *   undefined when the binary records no CGO_ENABLED line
 */
export declare function readGoBuildSettings(filePath: string): {
    buildVersion: string;
    cgoEnabled: boolean | undefined;
    cgoEnvFlagNames: string[];
    trimpath: boolean;
    buildmode: string | undefined;
} | undefined;
/**
 * Parse the `build` settings out of a module-info string.
 *
 * The module-info text holds one tab-separated record per line: the module
 * path, the main module, each dependency, and then the build settings Go
 * records at link time (`CGO_ENABLED=1`, `-buildmode=exe`, `-trimpath`,
 * `-ldflags=...`, the `CGO_*FLAGS` values, absent when `-trimpath` was used).
 * Only settings a report may carry are returned: the CGO_*FLAGS values are
 * flags for the host C compiler, so their names alone are reported, and
 * `-ldflags` is dropped for the same reason.
 *
 * @param {string|undefined} moduleInfo raw module-info string with the
 *   16-byte sentinels Go wraps it in, or undefined
 * @returns {{cgoEnabled: boolean|undefined, cgoEnvFlagNames: string[], trimpath: boolean, buildmode: string|undefined}}
 */
export declare function parseGoBuildModuleSettings(moduleInfo: string | undefined): {
    cgoEnabled: boolean | undefined;
    cgoEnvFlagNames: string[];
    trimpath: boolean;
    buildmode: string | undefined;
};
//# sourceMappingURL=goBuildInfo.d.ts.map