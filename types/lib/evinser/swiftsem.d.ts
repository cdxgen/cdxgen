/**
 * Convert a SwiftPM target or package name into its module name.
 *
 * @param {String} name Target or package name
 * @returns {String} Module name
 */
export declare function toModuleName(name: string): string;
/**
 * Decide whether a module belongs to tests or to an aggregate product and so
 * must not contribute build symbols or semantic context.
 *
 * @param {String} moduleName Module name
 * @returns {boolean} `true` when the module should be skipped
 */
export declare function isTestOrAggregateModule(moduleName: string): boolean;
/**
 * Parse the JSON printed by `swift -print-target-info`.
 *
 * `paths.runtimeResourcePath` is `<toolchain>/usr/lib/swift` for every
 * toolchain layout (Xcode, `.xctoolchain` bundles, swiftly, Linux tarballs),
 * so it names the toolchain that actually compiles the project.
 * `paths.sdkPath` is the SDK the driver selected, on macOS through `SDKROOT`
 * or `xcrun`; it is absent when no SDK applies, as on Linux.
 *
 * @param {Object} targetInfo Parsed `-print-target-info` output
 * @returns {undefined|Object} `{ compilerVersion, triple, runtimeResourcePath, sdkPath, toolchainDir }`
 */
export declare function parseSwiftTargetInfo(targetInfo: Object): undefined | Object;
/**
 * Identify the toolchain that `swift` resolves to inside a project directory.
 *
 * The query runs in the project directory because toolchain managers such as
 * swiftly select the toolchain per directory (`.swift-version`), so the
 * compiler that builds a project can differ from the one on the PATH of the
 * calling process.
 *
 * @param {String} basePath Project directory
 * @returns {undefined|Object} Toolchain details, see parseSwiftTargetInfo
 */
export declare function resolveSwiftToolchain(basePath: string): undefined | Object;
/**
 * Environment overrides that make sourcekitten load the SourceKit of the
 * toolchain that builds the project.
 *
 * Without guidance sourcekitten uses the toolchain of the selected Xcode (or
 * the `swift` found on the PATH on Linux). SourceKit cannot load modules
 * produced by a different compiler version, so every reference to a
 * dependency then goes unresolved. On macOS sourcekitten honours
 * `XCODE_DEFAULT_TOOLCHAIN_OVERRIDE` ahead of `xcrun`; on Linux it honours
 * `LINUX_SOURCEKIT_LIB_PATH`. Explicitly configured values always win.
 *
 * @param {Object} toolchain Toolchain details from resolveSwiftToolchain
 * @param {String} [platform] Platform name, defaults to process.platform
 * @returns {undefined|Object} Environment overrides for sourcekitten
 */
export declare function sourcekittenEnvForToolchain(toolchain: Object, platform?: string): undefined | Object;
/**
 * Retrieve the structure information of a .swift file in json format
 *
 * @param {String} filePath Path to .swift file
 * @param {Object} [env] Environment overrides for sourcekitten
 *
 * @returns {undefined|Object} JSON representation of the swift file or undefined.
 */
export declare function getStructure(filePath: string, env?: Object): undefined | Object;
/**
 * Parse the data from the structure command
 *
 * @param {Object} structureJson Json from the structure command
 * @returns {Object|undefined} Parsed value
 */
export declare function parseStructure(structureJson: Object): Object | undefined;
/**
 * Split a Swift command line, as printed by a verbose build or given in an
 * environment variable, into arguments.
 *
 * Paths on Windows use backslash separators, so a backslash there is literal
 * unless it precedes a double quote (the `CommandLineToArgvW` rules). Single
 * quotes, which SwiftPM uses to quote arguments on every platform, keep their
 * content literal. Elsewhere shell quoting applies.
 *
 * @param {String} commandString Command line
 * @param {String} [platform] Platform name, defaults to process.platform
 * @returns {Array<String>} Arguments
 */
export declare function splitSwiftCommandArgs(commandString: string, platform?: string): Array<string>;
/**
 * Method to perform swift build in verbose mode.
 *
 * `SWIFT_BUILD_ARGS` adds arguments to the build, for example
 * `--build-system native` to use the llbuild engine with Swift 6.4.
 *
 * @param {String} basePath Path
 * @returns {undefined|String} Verbose build output
 */
export declare function verboseBuild(basePath: string): undefined | string;
/**
 * Reduce one module's compiler invocation to the arguments that affect how
 * its sources are type-checked.
 *
 * Only known argument classes are kept, so outputs, incremental build
 * bookkeeping, response files, and flags a SourceKit build may not know are
 * dropped. The order of the kept arguments is preserved, which keeps paired
 * clang arguments such as `-Xcc -I -Xcc <path>` intact. The module cache is
 * dropped as well: the build's cache may hold modules of other toolchains.
 *
 * @param {Array<String>} tokens Tokenized compiler invocation
 * @returns {Array<String>} Sanitized compiler arguments
 */
export declare function sanitizeSwiftModuleArgs(tokens: Array<string>): Array<string>;
/**
 * Remove the arguments that would make SourceKit load code named by the
 * project. A `.build` directory that cdxgen did not create is project content,
 * so the compiler arguments read from it are cleaned this way whenever the
 * project's own tooling may not run. The project's SDK is replaced with the
 * SDK of the host toolchain when one is known, and dropped otherwise.
 *
 * @param {Array<String>} args Sanitized compiler arguments
 * @param {String} [sdkPath] Host SDK that takes the place of the project's
 * @returns {Array<String>} Arguments without plugin and clang pass-through flags
 */
export declare function withoutSwiftPluginArgs(args: Array<string>, sdkPath?: string): Array<string>;
/**
 * Extract the per-module compiler invocations printed by a verbose swift
 * build.
 *
 * Both engines print one driver invocation per module that carries
 * `-module-name`: llbuild prints `swiftc ... -module-name X ... @sources`,
 * while the Swift Build engine prints `builtin-SwiftDriver -- swiftc ...
 * -module-name X ... @<target>.SwiftFileList`. llbuild also prints the
 * frontend jobs of each module, which are only used when no driver line is
 * found. Package manifest and plugin compilations are skipped.
 *
 * @param {String} buildOutput Verbose build output
 * @param {String} [platform] Platform that printed the output, which decides
 *   its quoting rules; defaults to process.platform
 * @returns {Object} Map of module name to `{ args, sources, isDriver }`
 */
export declare function parseSwiftModuleInvocations(buildOutput: string, platform?: string): Object;
/**
 * Parse the llbuild engine's build description
 * (`.build/<triple>/debug/description.json`).
 *
 * Its `swiftCommands` record every Swift module the build compiled, with the
 * exact source list and compiler arguments. Host-tool variants
 * (`...-tool.module`, built for macros and plugins) are used only when a
 * module has no regular variant.
 *
 * @param {Object} descriptionJson Parsed description.json
 * @returns {Object} Map of module name to `{ args, sources, isDriver }`
 */
export declare function parseSwiftBuildDescription(descriptionJson: Object): Object;
/**
 * Merge the sanitized arguments of several modules into one argument list,
 * used when a source file cannot be attributed to a single module. The first
 * module's single-value flags win, include paths accumulate, and `-Xcc`
 * values are merged per clang argument group.
 *
 * @param {Array<Array<String>>} argLists Sanitized argument lists, most relevant first
 * @returns {Array<String>} Merged arguments
 */
export declare function mergeSwiftModuleArgs(argLists: Array<Array<string>>): Array<string>;
/**
 * Method to parse the verbose swift build output to identify key compiler
 * parameters. The arguments of the root package's modules are merged, or of
 * every module when the root modules are unknown.
 *
 * @param {String} buildOutput Verbose build output
 * @param {Array<String>|Set<String>} [rootModules] Module names of the root package
 * @returns {Object} `{ params, compilerArgs }` where params maps module names to their arguments
 */
export declare function extractCompilerParamsFromBuild(buildOutput: string, rootModules?: Array<string> | Set<string>): Object;
/**
 * Method to index a swift file and extract metadata
 *
 * @param {String} filePath Path to .swift file
 * @param {String|Array<string>} compilerArgs Compiler arguments. They should
 *   list every source of the file's module so that references across files
 *   resolve; the file itself is appended when missing.
 * @param {Object} [env] Environment overrides for sourcekitten
 * @returns {undefined|Object} metadata
 */
export declare function index(filePath: string, compilerArgs: string | Array<string>, env?: Object): undefined | Object;
/**
 * Parse the data from the index command
 *
 * Besides the symbol names and lines, the unified symbol resolution (USR) of
 * every indexed entity is recorded with its lines. A USR identifies the
 * declaration the compiler resolved a reference to, including the module
 * that declares it, which is what attributes a usage to a dependency.
 *
 * @param {Object} indexJson Json from the index command
 * @returns {Object|undefined} Parsed value
 */
export declare function parseIndex(indexJson: Object): Object | undefined;
/**
 * Identify the module that declares an entity from its demangled name.
 *
 * Qualified names start with the module (`Yams.dump(object:...)`), and
 * members declared in extensions carry the extending module
 * (`(extension in Yams):Swift.String.yaml`), which is what a usage of the
 * member depends on.
 *
 * @param {String} demangled Output of `swift demangle --compact`
 * @returns {undefined|String} Module name
 */
export declare function moduleFromDemangledName(demangled: string): undefined | string;
/**
 * Identify the module of a mangled Swift name without the demangler. Only the
 * leading module context is decoded, so extension members are attributed to
 * the extended type's module.
 *
 * @param {String} mangled Mangled name starting with `$s`
 * @returns {undefined|String} Module name
 */
export declare function moduleFromMangledPrefix(mangled: string): undefined | string;
/**
 * Identify the declaring module of each USR.
 *
 * Swift USRs are demangled in one batch with `swift demangle`; clang module
 * references (`c:@M@<module>`, emitted for import declarations) carry the
 * module name directly. Other clang USRs name no module and are skipped.
 *
 * @param {Array<String>} usrs USRs to resolve
 * @param {String} basePath Directory to run the demangler in
 * @returns {Map<String, String>} USR to module name
 */
export declare function resolveUsrModules(usrs: Array<string>, basePath: string): Map<string, string>;
/**
 * Method to execute dump-package package command.
 *
 * @param {String} basePath Path
 * @returns {undefined|Object} Output from dump-package command
 */
export declare function dumpPackage(basePath: string): undefined | Object;
/**
 * Parse the data from dump-package command
 *
 * @param {Object} dumpJson Json from dump-package command
 * @returns {Object|undefined} Parsed value
 */
export declare function parseDumpPackage(dumpJson: Object): Object | undefined;
/**
 * Retrieve the module information of the swift project
 *
 * @param {String} moduleName Module name
 * @param {String|Array<string>} compilerArgs Compiler arguments extracted from verbose build log
 * @param {Object} [env] Environment overrides for sourcekitten
 * @returns {undefined|Object} JSON representation of the swift module or undefined.
 */
export declare function moduleInfo(moduleName: string, compilerArgs: string | Array<string>, env?: Object): undefined | Object;
/**
 * Parse the data from module-info command to replicate the swift interface
 *
 * @param {Object} moduleInfoJson Json from module-info command
 * @returns {Object|undefined} Parsed classes, protocols, enums and their functions
 */
export declare function parseModuleInfo(moduleInfoJson: Object): Object | undefined;
/**
 * Method to collect the build symbols from the output file maps generated by
 * swift build.
 *
 * Both build engines are supported: the llbuild engine writes per-module
 * `output-file-map.json` files, while the Swift Build engine (default from
 * Swift 6.4) writes per-target `<target>-OutputFileMap.json` files under
 * `.build/out/Intermediates.noindex`.
 *
 * @param {String} basePath Path
 * @param {Object} options CLI options
 * @param {Array<String>} [fileMaps] Output file maps, found under basePath when omitted
 * @returns {Object} symbols map keyed by module name
 */
export declare function collectBuildSymbols(basePath: string, options: Object, fileMaps?: Array<string>): Object;
/**
 * Method to parse output file map to identify the module, its sources, and
 * their symbols. The symbol list is imprecise; the sources are exact.
 *
 * The module name is derived from the containing directory for llbuild maps
 * (`<Module>.build` and, since Swift 6.4, `<Module>-tool.build`) and from the
 * file name for Swift Build maps (`<target>-OutputFileMap.json`, where the
 * target name still needs to be sanitised into a module name).
 *
 * @param filemap {String} File name
 * @returns {Object} parsed module metadata `{ moduleName, moduleSymbols, sourceFiles }`
 */
export declare function parseOutputFileMap(filemap: string): Object;
/**
 * Parse `.build/workspace-state.json` into the dependency packages of the
 * workspace and the directory each one was materialised in.
 *
 * @param {Object} stateJson Parsed workspace-state.json
 * @param {String} basePath Root package directory
 * @returns {Array<Object>} `{ identity, name, location, kind, dir }` per package
 */
export declare function parseSwiftWorkspaceState(stateJson: Object, basePath: string): Array<Object>;
/**
 * Parse the Swift Build engine's project model (`.build/manifest.pif`) into
 * the module names each package declares.
 *
 * The manifest is a list of workspace, project, and target objects linked
 * through their `signature` hashes. A project's guid is `PACKAGE:<identity>`
 * and each target records its `PRODUCT_MODULE_NAME`. Unlike the verbose
 * build output, the manifest lists modules whose compilation never started,
 * which keeps the module-to-package mapping complete when a build fails.
 *
 * @param {Array} manifestJson Parsed manifest.pif contents
 * @returns {Object} Map of package identity to module names
 */
export declare function parseSwiftBuildManifest(manifestJson: any[]): Object;
/**
 * Collect the modules imported by a Swift source file, with their lines.
 *
 * Declarations such as `@testable import Foo`, `public import Foo`,
 * `@_implementationOnly import cmark_gfm`, and `import struct Foo.Bar` are
 * recognised; comments, string literals, and `canImport` conditions are not
 * imports.
 *
 * @param {String} sourceText Swift source
 * @returns {Array<Object>} `{ module, line }` per import declaration
 */
export declare function parseSwiftImports(sourceText: string): Array<Object>;
/**
 * Collect the clang module names declared at the top level of a module map.
 *
 * @param {String} moduleMapText module.modulemap contents
 * @returns {Object} `{ modules, headerPaths }`
 */
export declare function parseClangModuleMap(moduleMapText: string): Object;
/**
 * Build a description of every module in a completed swift build: its
 * compiler arguments, sources, and owning package.
 *
 * Arguments come from the llbuild build description when present and from
 * the verbose build output otherwise (the only source for the Swift Build
 * engine); sources come from the same places or from the output file maps.
 * Packages come from `workspace-state.json`, and every module is attributed
 * to the package whose directory holds its sources. Clang modules are
 * discovered through their module maps.
 *
 * @param {String} basePath Root package directory
 * @param {String} buildOutput Verbose build output
 * @param {Object} options CLI options
 * @param {Object} [rootMetadata] Parsed dump-package of the root package
 * @returns {Object} `{ modules, packages, root, clangModules, fileMaps }`
 */
export declare function collectSwiftBuildPlan(basePath: string, buildOutput: string, options: Object, rootMetadata?: Object): Object;
/**
 * Check that sourcekitten can load SourceKit, with a trivial syntax request.
 *
 * A missing binary, a binary without its Swift runtime (`error while loading
 * shared libraries: libswiftCore.so`), or one linked against a different
 * Swift runtime than the toolchain provides (Linux has no stable Swift ABI, so
 * such a binary crashes inside libswiftCore) fails every request; the probe
 * turns that into one clear message instead of silent empty results.
 *
 * @param {Object} [env] Environment overrides for sourcekitten
 * @returns {boolean} `true` when sourcekitten answered the probe
 */
export declare function isSourcekittenUsable(env?: Object): boolean;
/**
 * Create a precise semantics slices file for a swift project.
 *
 * The project is built once in verbose mode. Every source file of the root
 * package's (non-test) modules is then indexed with sourcekitten using that
 * module's own compiler arguments and source list, with sourcekitten aligned
 * to the toolchain that compiled the project. The declaring module of every
 * resolved reference is recovered from its USR, which attributes each usage
 * to the package that provides the module (`moduleReferences`).
 *
 * @param basePath basePath Path
 * @param options options CLI options
 */
export declare function createSemanticsSlices(basePath: any, options: any): {
    projectPath: any;
    toolchain: any;
    packageMetadata: Object | undefined;
    packages: any;
    packageModules: {};
    buildSymbols: Object;
    fileIndexes: {};
} | undefined;
//# sourceMappingURL=swiftsem.d.ts.map