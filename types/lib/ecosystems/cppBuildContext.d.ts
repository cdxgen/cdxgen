/**
 * How a C/C++ project is built: its CMake configure presets, the compilers
 * its compilation database or configured build tree names, the
 * security-hardening options it is compiled and linked with, and which of the
 * headers it includes are its own.
 *
 * The presets and compilers become formulation components, the hardening
 * options properties of the project component, and the project's own include
 * directories let the include analysis tell first-party headers from
 * dependencies.
 *
 * Layer 3: this module reads the build tree and may run a compiler (only
 * `--version`, only outside secure mode, only a GCC, Clang, MSVC, Intel,
 * NVIDIA or EDG driver found on the PATH or named by an absolute path outside
 * the project).
 */
/**
 * The empty build context, for scans that are not of a source tree.
 *
 * @returns {Object}
 */
export declare function emptyCppBuildContext(): Object;
/**
 * The executable a driver names, when it may be run: an absolute path, or a
 * command found on the PATH, that is a file outside the project. A relative
 * path, or anything inside the project tree, is never run, since a
 * compilation database can come with the code it describes.
 */
export declare function trustedCompilerPath(driver: any, root: any): any;
/**
 * Resolve the build context of a C/C++ project.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @param {Object} [cmakeContext] The CMake context (`boundaries` lists the
 *   source directories of fetched and submodule dependencies)
 * @param {string[]} [vendoredDirs] Directories of code the project carries
 *   under another license; their headers are not the project's own
 * @returns {{
 *   formulationComponents: Object[],
 *   parentProperties: Object[],
 *   firstPartyIncludeDirs: string[],
 *   compileDatabase: string|undefined,
 *   isFirstPartyHeader: function(string): boolean,
 * }}
 */
export declare function resolveCppBuildContext(path: string, options?: Object, cmakeContext?: Object, vendoredDirs?: string[]): {
    formulationComponents: Object[];
    parentProperties: Object[];
    firstPartyIncludeDirs: string[];
    compileDatabase: string | undefined;
    isFirstPartyHeader: Function;
    (string: any): boolean;
};
//# sourceMappingURL=cppBuildContext.d.ts.map