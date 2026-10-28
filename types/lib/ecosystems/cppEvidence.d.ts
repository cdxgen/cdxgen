/**
 * Whether a directory holds C or C++ sources for atom to parse.
 *
 * The search skips the directories the manifest searches skip, such as
 * node_modules and dot directories, and honours the exclude patterns, so the
 * sources of a native npm addon do not count.
 *
 * @param {string} src directory
 * @param {Object} options CLI options
 * @returns {boolean} true when the directory holds at least one C or C++ file
 */
export declare function hasCppSources(src: string, options?: Object): boolean;
/**
 * The ports vcpkg installed into the `vcpkg_installed` directories of a
 * project and its build trees, by lower-case port name.
 *
 * @param {string} src project directory
 * @param {Object} options CLI options, for the build-directory candidates
 * @returns {Map<string, {version: string, triplet: string}>}
 */
export declare function installedVcpkgPorts(src: string, options?: Object): Map<string, {
    version: string;
    triplet: string;
}>;
/**
 * Read a vcpkg manifest (vcpkg.json) in a directory: the project it describes
 * and the ports it declares. A port's version comes from what vcpkg installed
 * in the build tree when that is known, otherwise from the manifest's
 * `overrides`, which pin it exactly. A `version>=` constraint is only a
 * minimum, so it is kept as a property, never as the version.
 * https://learn.microsoft.com/vcpkg/reference/vcpkg-json
 *
 * The read is cheap and runs no tool, so it does not wait for the atom-based
 * analysis that getCppModules adds.
 *
 * @param {string} src directory that may hold vcpkg.json
 * @param {Object} [options] options
 * @param {Map<string, {version: string, triplet: string}>} [options.installedPorts]
 *   ports vcpkg installed, by lower-case name
 * @param {function(string): boolean} [options.isListed] whether another source
 *   already lists a port by that name
 * @returns {{parentComponent: Object|undefined, pkgList: Object[]}}
 */
export declare function parseVcpkgManifest(src: string, options?: {
    installedPorts?: Map<string, {
        version: string;
        triplet: string;
    }>;
}): {
    parentComponent: Object | undefined;
    pkgList: Object[];
};
/**
 * Method to find c/c++ modules by collecting usages with atom
 *
 * @param {string} src directory
 * @param {object} options Command line options
 * @param {array} osPkgsList Array of OS pacakges represented as components
 * @param {array} epkgList Existing packages list
 * @param {function(string): boolean} [isFirstPartyHeader] Whether an
 *   included header is the project's own (found under the project root or
 *   one of its own include directories, outside any dependency's sources);
 *   such a header is not a component
 */
export declare function getCppModules(src: string, options: object, osPkgsList: array, epkgList: array, isFirstPartyHeader?: Function): {
    parentComponent: Object | {
        group: any;
        name: any;
        version: string;
        type: string;
    } | undefined;
    pkgList: any[];
    dependenciesList: {
        ref: any;
        dependsOn: any[];
    }[];
};
//# sourceMappingURL=cppEvidence.d.ts.map