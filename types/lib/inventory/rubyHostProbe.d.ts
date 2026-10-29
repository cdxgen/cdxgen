export declare const RUBY_VERSION_MANAGER_DIRECTORIES: string[];
export declare const HOME_PARENTS: {
    linux: string[];
    darwin: string[];
};
/**
 * Expand a relative directory pattern whose `*` segments match one directory
 * name each.
 *
 * @param {string} base absolute directory the pattern hangs off
 * @param {string} pattern `/`-separated relative pattern
 * @returns {string[]} existing directories, at most MAX_EXPANDED_DIRECTORIES
 */
export declare function expandDirectories(base: string, pattern: string): string[];
/**
 * The home directories of a host: /root and /home/* on Linux, /Users/* on
 * macOS.
 *
 * @param {{rootPath: string, platform: string}} context probe context
 * @returns {string[]}
 */
export declare function homeDirectories(context: {
    rootPath: string;
    platform: string;
}): string[];
/**
 * The directories a Windows Ruby lives in: the RubyInstaller's C:\Ruby34-x64,
 * Chocolatey's C:\tools\ruby34, and the hosted toolcache.
 *
 * @param {Object} context probe context
 * @returns {string[]} install roots, each with a `bin` directory
 */
export declare function windowsRubyRoots(context: Object): string[];
/**
 * Look for Ruby no package manager owns on the host. Components come back
 * only for the files nothing owns: a `file` component for each `ruby` binary
 * with the cdx:ruby properties, and one `platform` component per Ruby version
 * with its CPE.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export declare function probeHostRuby(options?: Object): {
    components: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=rubyHostProbe.d.ts.map