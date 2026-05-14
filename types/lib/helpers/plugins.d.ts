/**
 * Determine the normalized plugin target tuple for the current runtime.
 *
 * @returns {{arch: string, extn: string, platform: string, pluginsBinSuffix: string}}
 */
export function getPluginsBinTarget(): {
    arch: string;
    extn: string;
    platform: string;
    pluginsBinSuffix: string;
};
/**
 * Resolve the cdxgen companion plugins directory for the current runtime.
 *
 * @returns {{
 *   arch: string,
 *   extn: string,
 *   extraNMBinPath: string|undefined,
 *   platform: string,
 *   pluginManifestFile: string|undefined,
 *   pluginVersion: string|undefined,
 *   pluginsBinSuffix: string,
 *   pluginsDir: string,
 * }}
 */
export function resolveCdxgenPlugins(): {
    arch: string;
    extn: string;
    extraNMBinPath: string | undefined;
    platform: string;
    pluginManifestFile: string | undefined;
    pluginVersion: string | undefined;
    pluginsBinSuffix: string;
    pluginsDir: string;
};
/**
 * Retrieve the default plugin runtime, recomputing it only when the
 * environment that influences plugin discovery changes.
 *
 * @returns {ReturnType<typeof resolveCdxgenPlugins>} The resolved plugin runtime.
 */
export function getDefaultPluginRuntime(): ReturnType<typeof resolveCdxgenPlugins>;
/**
 * Add the detected node_modules binary directory to PATH when present.
 *
 * @param {ReturnType<typeof resolveCdxgenPlugins>} [pluginRuntime] Detected plugin runtime.
 * @returns {ReturnType<typeof resolveCdxgenPlugins>} The resolved plugin runtime.
 */
export function setPluginsPathEnv(pluginRuntime?: ReturnType<typeof resolveCdxgenPlugins>): ReturnType<typeof resolveCdxgenPlugins>;
/**
 * Resolve a known plugin binary path, honoring explicit environment overrides.
 *
 * @param {string} toolName Tool identifier.
 * @param {ReturnType<typeof resolveCdxgenPlugins>} [pluginRuntime] Detected plugin runtime.
 * @returns {string|undefined} Resolved binary path or configured override.
 */
export function resolvePluginBinary(toolName: string, pluginRuntime?: ReturnType<typeof resolveCdxgenPlugins>): string | undefined;
//# sourceMappingURL=plugins.d.ts.map