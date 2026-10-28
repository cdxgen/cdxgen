/**
 * Look for Node.js no package manager owns on the host. Components come back
 * only for the files nothing owns: a `file` component for each `node` binary
 * with the cdx:node and cdx:brotli properties, one `platform` component per
 * Node.js version with its CPE, and the brotli component when a binary embeds
 * a decoder.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export declare function probeHostNode(options?: Object): {
    components: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=nodeHostProbe.d.ts.map