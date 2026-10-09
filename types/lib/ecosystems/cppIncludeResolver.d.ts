/**
 * Which package provides a C/C++ header, from the file the include resolved
 * to. atom 4 and later name that file in each include's usages slice
 * (`resolvedPath`); with it, a header is attributed exactly instead of by its
 * name: to the project itself, to a dependency whose sources CMake fetched or
 * a submodule checked out, to code the project vendors, to a port vcpkg
 * installed, to a package in the Conan cache, or to the operating-system
 * package that owns the file.
 *
 * Layer 3: reads the vcpkg installed tree and the Conan cache, and asks the
 * OS package manager about a file (`dpkg-query -S`, `rpm -qf`, `apk info -W`,
 * or the Homebrew Cellar path).
 */
/**
 * The include slices of an atom C/C++ usages report: for each header as
 * written, the files it resolved to, whether it was written as a system
 * include, and the functions the including files call that it declares.
 * Slices from atom releases that do not name the resolved file contribute no
 * paths and no symbols.
 *
 * @param {Object} sliceData Parsed atom usages report
 * @returns {Map<string, {paths: Set<string>, system: boolean, symbols: Set<string>}>}
 */
export declare function parseCIncludeSlices(sliceData: Object): Map<string, {
    paths: Set<string>;
    system: boolean;
    symbols: Set<string>;
}>;
/**
 * Index the ports vcpkg installed into the given `vcpkg_installed`
 * directories: every file a port installed, by absolute path. vcpkg lists a
 * port's files in `vcpkg/info/<port>_<version>_<triplet>.list`, one path per
 * line relative to the installed directory.
 *
 * @param {string[]} installedDirs `vcpkg_installed` directories
 * @returns {Map<string, {port: string, version: string, triplet: string}>}
 */
export declare function readVcpkgInstalledIndex(installedDirs: string[]): Map<string, {
    port: string;
    version: string;
    triplet: string;
}>;
/**
 * The package folders of a Conan 2 cache, from its database
 * (`<home>/p/cache.sqlite3`, table `packages`).
 *
 * @param {string} conanHome Conan 2 home (`CONAN_HOME`, or `~/.conan2`)
 * @returns {Array<{dir: string, name: string, version: string}>}
 */
export declare function conan2Packages(conanHome: string): Array<{
    dir: string;
    name: string;
    version: string;
}>;
/**
 * The Conan package a file belongs to: in a Conan 1 cache
 * (`<home>/.conan/data/<name>/<version>/<user>/<channel>/package/<id>/...`)
 * from its path, in a Conan 2 cache from the cache's database.
 *
 * @param {string} file Absolute path
 * @param {Object[]} conan2 Conan 2 package folders (see `conan2Packages`)
 * @returns {{name: string, version: string}|undefined}
 */
export declare function conanPackageOf(file: string, conan2: Object[]): {
    name: string;
    version: string;
} | undefined;
/**
 * Build the function that attributes a header from the files it resolved
 * to.
 *
 * @param {Object} context
 * @param {string} context.src Project scan root
 * @param {Object[]} [context.components] Components already known: CMake
 *   dependencies (`cdx:cmake:sourceDir`) and vendored code
 *   (`cdx:vendored:path`) claim the headers under their directories
 * @param {string[]} [context.buildDirs] Build directories, searched for
 *   `vcpkg_installed`
 * @param {function(string): boolean} [context.isFirstPartyHeader] Whether a
 *   file is the project's own
 * @returns {function(Iterable<string>): Object|undefined} Given the resolved
 *   files, `{kind: "first-party"}`, `{kind: "component", component}`,
 *   `{kind: "vcpkg", port, version, triplet}`, `{kind: "conan", name,
 *   version}`, `{kind: "os", pkgInfo}`, or `undefined` when no file says.
 *   Its `vcpkgPorts()` lists the ports vcpkg installed.
 */
export declare function createIncludeAttributor(context: {
    src: string;
    components?: Object[];
    buildDirs?: string[];
}): Function;
//# sourceMappingURL=cppIncludeResolver.d.ts.map