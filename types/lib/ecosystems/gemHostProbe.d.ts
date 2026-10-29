/**
 * The gem homes of a host, each a directory with a `specifications` directory.
 *
 * @param {string} rootPath root directory
 * @param {string} platform `linux`, `darwin` or `win32`
 * @returns {string[]} absolute gem home directories
 */
export declare function findGemHomes(rootPath: string, platform: string): string[];
/**
 * Inventory the gems of a host's gem homes. One component per distinct gem
 * and version, with an occurrence for each gemspec it was read from, so no
 * host path reaches a purl.
 *
 * @param {Object} [options] options
 * @param {string} [options.rootPath="/"] root directory; tests point it at a built tree
 * @param {string} [options.platform] `linux`, `darwin` or `win32`
 * @param {function(string): (Object[]|undefined)} [options.executeOsQuery] runs
 *   an osquery query, for rpm ownership
 * @param {Object[]} [options.packageComponents] the OS packages the scan has
 *   inventoried, which name the owners
 * @param {Object} [options.packageDatabases] where the package databases are
 * @returns {Promise<Object[]>} gem components
 */
export declare function probeHostRubyGems(options?: {
    rootPath?: string;
    platform?: string;
}): Promise<Object[]>;
//# sourceMappingURL=gemHostProbe.d.ts.map