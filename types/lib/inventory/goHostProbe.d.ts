/**
 * Look for Go toolchains no package manager owns on the host. Components come
 * back only for the files nothing owns: a `file` component for each `go`
 * launcher with the cdx:go properties, and one `platform` component per
 * toolchain version with its CPE.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export declare function probeHostGo(options?: Object): {
    components: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=goHostProbe.d.ts.map