/**
 * Where a C/C++ project's build trees are: the build directories its CMake
 * presets configure, and the conventional ones (`build`, `build-<name>`,
 * `out`, `builddir`, `cmake-build-<name>`). Shared by the lookups for
 * `CMakeCache.txt` and for the compilation database, so both search the same
 * places in the same order.
 */
/**
 * Whether `child` is `parent` or inside it. Only a whole `..` segment leaves
 * the parent: an entry named `..name` is inside it.
 *
 * @param {string} child Path to test
 * @param {string} parent Directory
 * @returns {boolean}
 */
export declare function isInsideDir(child: string, parent: string): boolean;
/**
 * The key `findEnclosingDir` looks a directory up by: its resolved path,
 * lower-cased on Windows, where paths compare without regard to case.
 *
 * @param {string} dir Directory
 * @returns {string}
 */
export declare function dirKey(dir: string): string;
/**
 * The deepest of the given directories that `child` is or is inside. Walks
 * up from `child`, so a lookup costs the depth of the path rather than the
 * number of directories: the lists come from the scanned project, and so
 * does the number of paths looked up.
 *
 * @param {string} child Path to test
 * @param {Set<string>|Map<string, *>} dirs Directories, keyed by `dirKey`
 * @returns {string|undefined} The key of the directory, if any
 */
export declare function findEnclosingDir(child: string, dirs: Set<string> | Map<string, any>): string | undefined;
/**
 * CMake's `${hostSystemName}` for this host.
 *
 * @returns {string}
 */
export declare function hostSystemName(): string;
/**
 * Read a project's presets documents: `CMakePresets.json` and
 * `CMakeUserPresets.json`, each followed by the files it includes (schema
 * version 4 and later). An include outside the project, or one that a link
 * leads out of it, is not read.
 *
 * @param {string} root Project source directory
 * @returns {Array<{file: string, fileDir: string, document: Object}>}
 */
export declare function readCmakePresetDocuments(root: string): Array<{
    file: string;
    fileDir: string;
    document: Object;
}>;
/**
 * The visible configure presets of a project, resolved and with their macros
 * expanded for this host.
 *
 * @param {string} root Project source directory
 * @returns {Object[]} See `resolveConfigurePresets`
 */
export declare function readCmakeConfigurePresets(root: string): Object[];
/**
 * The directories a project's build trees may be in, most specific first:
 * the directory of an explicit `--cmake-cache`, the build directories of its
 * configure presets, then the `build`, `build-<name>`, `out`, `builddir` and
 * `cmake-build-<name>` directories at the project root, and the directories
 * one level below `build`, `out` and `out/build` (where Visual Studio puts
 * preset builds). Only existing directories are listed; in secure mode, only
 * those inside the project.
 *
 * @param {string} root Project source directory
 * @param {Object} [options] CLI options (`cmakeCache`)
 * @returns {string[]} Absolute directories, without duplicates
 */
export declare function cmakeBuildDirCandidates(root: string, options?: Object): string[];
//# sourceMappingURL=cmakeBuildDirs.d.ts.map