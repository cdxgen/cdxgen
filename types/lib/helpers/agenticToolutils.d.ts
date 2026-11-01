import { redactHomePath } from "../core/paths.js";
export { redactHomePath };
/**
 * The purl type used for installed agentic CLI tools. These tools ship as
 * self-contained executables rather than as a resolvable source package, so a
 * `pkg:generic/...` identifier is the honest representation.
 */
export declare const AGENTIC_TOOL_PURL_TYPE = "generic";
/**
 * Describe where each supported agentic CLI tool stores its per-user state.
 *
 * Each entry lists the tool key, a display name, and the candidate home
 * directories per platform (mirroring how `getIdeExtensionDirs` models IDE
 * extension locations). Only the current platform's directories plus
 * always-present dot-directories are included.
 *
 * An entry may also name `mcpConfigs`, the files and keys where the tool
 * lists its MCP servers, and `ide`, the IDE_PRODUCTS id of the editor the tool
 * ships in, whose installed version and extensions folder it then reports.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{tool: string, name: string, dirs: string[], supportDirs?: string[], mcpConfigs?: Array<{file: string, key: string}>, ide?: string}>}
 *   One entry per known agentic CLI tool.
 */
export declare function getAgenticToolDirs(home?: string): Array<{
    tool: string;
    name: string;
    dirs: string[];
    supportDirs?: string[];
    mcpConfigs?: Array<{
        file: string;
        key: string;
    }>;
    ide?: string;
}>;
/**
 * Discover which agentic CLI tools are installed for the current user by
 * checking their known home directories.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{tool: string, name: string, dir: string, supportDir?: string, mcpConfigs?: Object[], ide?: string}>}
 *   One entry per discovered tool, using the first existing directory.
 */
export declare function discoverAgenticTools(home?: string): Array<{
    tool: string;
    name: string;
    dir: string;
    supportDir?: string;
    mcpConfigs?: Object[];
    ide?: string;
}>;
/**
 * Count the MCP servers a tool lists across its configuration files. A server
 * named in two files is counted once.
 *
 * @param {string} dir Tool home directory, which relative files resolve against
 * @param {Array<{file: string, key: string}>} [mcpConfigs] Files and the key
 *   holding the server map. A key is looked up as written first, so a dotted
 *   key such as `amp.mcpServers` matches a literal property.
 * @returns {number|undefined} Number of servers, or undefined when no file
 *   defines any
 */
export declare function countConfiguredMcpServers(dir: string, mcpConfigs?: Array<{
    file: string;
    key: string;
}>): number | undefined;
/**
 * Compute safe, redacted signal counts for a discovered tool. Only structural
 * counts and small enumerated values are returned; no credential, transcript,
 * or telemetry content is read.
 *
 * @param {string} tool Tool key
 * @param {string} dir Discovered tool home directory
 * @param {string} [supportDir] Optional platform support directory
 * @param {Array<{file: string, key: string}>} [mcpConfigs] Files that list
 *   the tool's MCP servers, used when the tool has no reader of its own
 * @param {string} [home] Home directory the tool was found in
 * @returns {Object} Map of signal name to count/boolean/small-string value
 */
export declare function collectToolSignals(tool: string, dir: string, supportDir?: string, mcpConfigs?: Array<{
    file: string;
    key: string;
}>, home?: string): Object;
/**
 * Build a CycloneDX application component for one discovered agentic tool.
 *
 * @param {{tool: string, name: string, dir: string, supportDir?: string, mcpConfigs?: Object[], ide?: string}} entry
 *   Discovered tool entry
 * @param {string} [home] Home directory, used to find the tool's editor
 * @returns {Object} CycloneDX component
 */
export declare function componentForAgenticTool(entry: {
    tool: string;
    name: string;
    dir: string;
    supportDir?: string;
    mcpConfigs?: Object[];
    ide?: string;
}, home?: string): Object;
/**
 * Discover installed agentic CLI tools on the current host and return CycloneDX
 * components describing each one, plus the child agents, plugins, and providers
 * they define and the dependency edges linking children to their tool.
 *
 * This host scan is unconditional: it does not consult scan filters such as
 * `--exclude` or profile/technique options, because it inventories fixed tool
 * home directories rather than a project tree.
 *
 * @param {Object} [options={}] Collection options
 * @param {string} [options.home] Home directory to scan, defaulting to the
 *   current user's
 * @returns {{components: Object[], services: Object[], dependencies: Object[]}} Discovered inventory
 */
export declare function collectAgenticTools(options?: {
    home?: string;
}): {
    components: Object[];
    services: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=agenticToolutils.d.ts.map