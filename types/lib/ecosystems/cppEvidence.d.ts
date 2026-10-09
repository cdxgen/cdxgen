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
        name: any;
        version: any;
        description: any;
        license: any;
        purl: any;
        type: string;
        "bom-ref": string;
        group?: undefined;
    } | {
        description?: undefined;
        license?: undefined;
        purl?: undefined;
        "bom-ref"?: undefined;
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