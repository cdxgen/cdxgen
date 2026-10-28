/**
 * The most node-named files one scan opens in search of a build version.
 *
 * @type {number}
 */
export declare const MAX_NODE_PROBES: number;
/**
 * Whether a file name is one the Node.js runtime is installed under.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {boolean} true for `node`, `nodejs` and `node.exe`
 */
export declare function isNodeBinaryName(fileName: string): boolean;
/**
 * Parse a Node.js version in the grammar the release tooling produces:
 * `24.22.1`, `25.0.0-rc.1`, `26.0.0-nightly20260301abcdef`.
 *
 * @param {string} text candidate version, without the leading `v`
 * @returns {string|undefined} the version, or undefined
 */
export declare function parseNodeVersion(text: string): string | undefined;
/**
 * Read the Node.js version a `node` binary was built as.
 *
 * @param {string} absPath absolute path of the binary
 * @param {string|undefined} rootDir extracted root, when the file came from one
 * @returns {{version: string, source: string, channel?: string}|undefined}
 *   source is `release-url` or `binary`
 */
export declare function readNodeBuildVersion(absPath: string, rootDir: string | undefined): {
    version: string;
    source: string;
    channel?: string;
} | undefined;
/**
 * The CPE that lets a downstream scanner match a Node.js version. NVD names the
 * product node.js and keeps a pre-release in the update field.
 *
 * @param {string} version Node.js version
 * @returns {string} CPE 2.3 string
 */
export declare function nodeCpe(version: string): string;
/**
 * A Node.js runtime is one `platform` component per distinct version, like the
 * PHP and Go stdlib components. Its identity is `pkg:generic/node`: it is only
 * used where no package manager owns the runtime.
 *
 * @param {string} version Node.js version
 * @returns {Object} component with `purl`, `bom-ref` and `cpe`
 */
export declare function createNodeRuntimeComponent(version: string): Object;
/**
 * The properties a node file component carries once its build is known.
 *
 * @param {{version: string, source: string, channel?: string}} build result of readNodeBuildVersion
 * @returns {{name: string, value: string}[]} properties to append
 */
export declare function nodeBuildProperties(build: {
    version: string;
    source: string;
    channel?: string;
}): {
    name: string;
    value: string;
}[];
/**
 * Start collecting the runtime components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export declare function createNodeRuntimeInventory(): {
    runtimeComponents: Object[];
    dependencies: Object[];
    runtimeRefs: Set<string>;
};
/**
 * Tag a node file component with its build facts and link it to the runtime
 * component of its version, creating that component on first use. Mutates the
 * component in place.
 *
 * @param {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}} inventory
 *   accumulator from createNodeRuntimeInventory
 * @param {Object} component file component, with a `properties` array
 * @param {{version: string, source: string, channel?: string}} build result of readNodeBuildVersion
 */
export declare function attachNodeBuild(inventory: {
    runtimeComponents: Object[];
    dependencies: Object[];
    runtimeRefs: Set<string>;
}, component: Object, build: {
    version: string;
    source: string;
    channel?: string;
}): void;
//# sourceMappingURL=nodeBuildInfo.d.ts.map