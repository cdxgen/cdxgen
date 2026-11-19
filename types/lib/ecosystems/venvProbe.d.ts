/**
 * Find the virtual environments and pyenv interpreters under the fixed
 * places of a root.
 *
 * An environment below a home directory is reached through no symbolic link
 * below that home, whoever runs the scan: a link a user leaves there would be
 * resolved with the scan's rights. One below /opt or /usr/local is reached
 * through links only while they stay inside that directory. Each environment
 * records the rule as `within` or `confine`.
 *
 * @param {string} rootPath root directory
 * @param {string} platform `linux` or `darwin`
 * @returns {{path: string, kind: string, within?: string, confine?: string}[]} environments, at most MAX_ENVIRONMENTS
 */
export declare function findPythonEnvironments(rootPath: string, platform: string): {
    path: string;
    kind: string;
    within?: string;
    confine?: string;
}[];
/**
 * Inventory the packages installed in the virtual environments and pyenv
 * interpreters of a host. One component per distinct name and version, with
 * an occurrence for each dist-info directory it was found in, so no host path
 * reaches a purl.
 *
 * @param {Object} [options] options
 * @param {string} [options.rootPath="/"] root directory; tests point it at a built tree
 * @param {string} [options.platform] `linux` or `darwin`
 * @returns {Object[]} pypi components
 */
export declare function probeHostPythonEnvironments(options?: {
    rootPath?: string;
    platform?: string;
}): Object[];
/**
 * Add the packages of the host's Python environments to an OBOM's component
 * list. A package osquery already listed from the interpreter's own
 * site-packages keeps its component; the environment's dist-info becomes one
 * more occurrence of it, and its cdx:python:environment property says where
 * else it is installed.
 *
 * @param {Object[]} components OBOM components
 * @param {Object[]} envPackages result of probeHostPythonEnvironments
 * @returns {Object[]} the components, with the environment packages merged in
 */
export declare function mergeHostPythonEnvironmentPackages(components: Object[], envPackages: Object[]): Object[];
//# sourceMappingURL=venvProbe.d.ts.map