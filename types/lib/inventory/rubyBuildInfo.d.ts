/**
 * The most Ruby-named files one scan opens in search of a build version.
 *
 * @type {number}
 */
export declare const MAX_RUBY_PROBES: number;
/**
 * Parse an MRI version and normalize a pre-release to the hyphenated form the
 * release tarballs use: `3.4.0preview2` becomes `3.4.0-preview2`.
 *
 * @param {string} text candidate version, without a patchlevel
 * @returns {string|undefined} the version, or undefined
 */
export declare function parseRubyVersion(text: string): string | undefined;
/**
 * Read the first line `ruby -v` prints, or the description compiled into
 * libruby, for MRI, JRuby and TruffleRuby:
 * - `ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [x86_64-linux]`
 * - `ruby 2.7.8p225 (2023-03-30 revision 1f4d455848) [x86_64-linux]`
 * - `ruby 3.4.0preview2 (2024-10-07 master 32c733f57b) +PRISM [x86_64-linux]`
 * - `jruby 9.4.8.0 (3.1.4) 2024-07-02 4d41e55a67 OpenJDK 64-Bit ...`
 * - `truffleruby 24.1.0, like ruby 3.2.4, Oracle GraalVM Native [x86_64-linux]`
 *
 * @param {string} text description line
 * @returns {{engine: string, version: string, patchlevel?: string,
 *   rubyVersion?: string, platform?: string}|undefined} engine is `ruby`,
 *   `jruby` or `truffleruby`; for the last two, rubyVersion is the Ruby
 *   language version the engine implements
 */
export declare function parseRubyDescription(text: string): {
    engine: string;
    version: string;
    patchlevel?: string;
    rubyVersion?: string;
    platform?: string;
} | undefined;
/**
 * Read the entries of an rbconfig.rb that identify a build. Only literal
 * `CONFIG["KEY"] = "value"` lines are read; Ruby is never evaluated.
 *
 * @param {string} text rbconfig.rb contents
 * @returns {{version: string, patchlevel?: string, abi?: string,
 *   arch?: string, baseName?: string}|undefined}
 */
export declare function parseRbConfig(text: string): {
    version: string;
    patchlevel?: string;
    abi?: string;
    arch?: string;
    baseName?: string;
} | undefined;
/**
 * Whether a file name is one a Ruby interpreter is installed under: `ruby`,
 * a versioned `ruby3.3` as distros and `--program-suffix` builds name it,
 * `ruby.exe` and `rubyw.exe`.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {boolean}
 */
export declare function isRubyBinaryName(fileName: string): boolean;
/**
 * Whether a file name is the shared Ruby library: libruby.so.3.3.6, Debian's
 * libruby-3.1.so.3.1.2,
 * libruby.3.3.dylib, or the RubyInstaller's x64-ucrt-ruby340.dll.
 *
 * @param {string} fileName basename or path of the candidate
 * @returns {boolean}
 */
export declare function isLibrubyName(fileName: string): boolean;
/**
 * The version a libruby soname spells, libruby.so.3.3.6 -> 3.3.6.
 *
 * @param {string} fileName basename or path
 * @returns {string|undefined}
 */
export declare function versionFromLibrubyName(fileName: string): string | undefined;
/**
 * The install prefix of a file under bin, sbin or lib: /usr/local/bin/ruby ->
 * /usr/local, C:\Ruby34-x64\bin\ruby.exe -> C:\Ruby34-x64.
 *
 * @param {string} absPath absolute path
 * @returns {string|undefined}
 */
export declare function rubyInstallPrefix(absPath: string): string | undefined;
/**
 * The rbconfig.rb files an install prefix holds, at most a few levels down:
 * <prefix>/lib/ruby/<abi>/<arch>/rbconfig.rb, and the Debian layout
 * <prefix>/lib/<triplet>/ruby/<abi>/rbconfig.rb.
 *
 * @param {string} prefix install prefix
 * @returns {string[]} absolute paths
 */
export declare function findRbConfigFiles(prefix: string): string[];
/**
 * Find the description compiled into a file, `ruby 3.3.6 (2024-11-05 ...`.
 *
 * @param {string} absPath absolute path of a ruby binary or libruby
 * @param {string|undefined} rootDir extracted root
 * @returns {ReturnType<typeof parseRubyDescription>}
 */
export declare function readRubyDescription(absPath: string, rootDir: string | undefined): ReturnType<typeof parseRubyDescription>;
/**
 * Read the Ruby build version of a ruby binary or libruby.
 *
 * @param {string} absPath absolute path of the candidate
 * @param {string|undefined} rootDir extracted root, when the file came from one
 * @returns {{version: string, source: string, patchlevel?: string,
 *   abi?: string, arch?: string}|undefined} source is `rbconfig`, `binary`
 *   or `soname`
 */
export declare function readRubyBuildVersion(absPath: string, rootDir: string | undefined): {
    version: string;
    source: string;
    patchlevel?: string;
    abi?: string;
    arch?: string;
} | undefined;
/**
 * The CPE that lets a downstream scanner match an interpreter version. NVD
 * names MRI ruby-lang:ruby and keeps a pre-release in the update field, as in
 * cpe:2.3:a:ruby-lang:ruby:3.4.0:preview1:*:*:*:*:*:*.
 *
 * @param {string} version interpreter version
 * @param {string} [engine="ruby"] `ruby` or `jruby`
 * @returns {string|undefined} CPE 2.3 string, or undefined for an engine NVD
 *   does not name
 */
export declare function rubyCpe(version: string, engine?: string): string | undefined;
/**
 * A Ruby runtime is one `platform` component per distinct engine and version,
 * like the PHP and Node.js runtime components. Its identity is
 * `pkg:generic/ruby` (or `jruby`, `truffleruby`).
 *
 * @param {string} version interpreter version
 * @param {Object} [options] options
 * @param {boolean} [options.withCpe=true] false for a Ruby a distro packaged,
 *   which backports fixes under its old upstream version
 * @param {string} [options.engine="ruby"] `ruby`, `jruby` or `truffleruby`
 * @returns {Object} component with `purl`, `bom-ref` and, when one applies, `cpe`
 */
export declare function createRubyRuntimeComponent(version: string, { withCpe, engine }?: {
    withCpe?: boolean;
    engine?: string;
}): Object;
/**
 * The bom-ref of the runtime component for a version.
 *
 * @param {string} version interpreter version
 * @param {string} [engine="ruby"] engine
 * @returns {string|undefined} bom-ref, which is the runtime's purl
 */
export declare function rubyRuntimeRef(version: string, engine?: string): string | undefined;
/**
 * The properties a Ruby file component carries once its build is known. They
 * belong on unpackaged `file` components only: a package-owned Ruby is
 * identified by its package.
 *
 * @param {{version: string, source: string, patchlevel?: string, abi?: string, arch?: string}} build
 *   result of readRubyBuildVersion
 * @returns {{name: string, value: string}[]} properties to append
 */
export declare function rubyBuildProperties(build: {
    version: string;
    source: string;
    patchlevel?: string;
    abi?: string;
    arch?: string;
}): {
    name: string;
    value: string;
}[];
/**
 * Start collecting the runtime components and edges of one scan.
 *
 * @returns {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}}
 */
export declare function createRubyRuntimeInventory(): {
    runtimeComponents: Object[];
    dependencies: Object[];
    runtimeRefs: Set<string>;
};
/**
 * Tag a Ruby file component with its build facts and link it to the runtime
 * component of its version, creating that component on first use. Mutates the
 * component in place.
 *
 * @param {{runtimeComponents: Object[], dependencies: Object[], runtimeRefs: Set<string>}} inventory
 *   accumulator from createRubyRuntimeInventory
 * @param {Object} component file component, with a `properties` array
 * @param {{version: string, source: string, patchlevel?: string, abi?: string, arch?: string}} build
 *   result of readRubyBuildVersion
 */
export declare function attachRubyBuild(inventory: {
    runtimeComponents: Object[];
    dependencies: Object[];
    runtimeRefs: Set<string>;
}, component: Object, build: {
    version: string;
    source: string;
    patchlevel?: string;
    abi?: string;
    arch?: string;
}): void;
/**
 * The upstream Ruby version an OS package carries: 1:3.1.2-7+deb12u1 -> 3.1.2,
 * 3.3.10-r0 -> 3.3.10, 3.0.7-168.el9_8 -> 3.0.7, 3.4.8_1 -> 3.4.8, and the
 * Chocolatey 3.4.10.1 -> 3.4.10.
 *
 * @param {string} version package version
 * @param {string} [purlType] purl type of the package
 * @returns {string|undefined}
 */
export declare function upstreamRubyVersion(version: string, purlType?: string): string | undefined;
/**
 * Describe the Ruby an OS package installed with its upstream identity,
 * `pkg:generic/ruby@<upstream>`, so a BOM names the interpreter both ways. The
 * component of a distro package carries no CPE, since distros backport fixes
 * under their old upstream version; Homebrew and Chocolatey ship the upstream
 * release, so theirs does. `cdx:os:installedBy` names the package to judge it
 * by.
 *
 * @param {Object[]} components BOM components, OS packages among them
 * @returns {Object[]} runtime components to add, one per distinct version
 */
export declare function deriveOsPackagedRubyRuntimes(components: Object[]): Object[];
/**
 * Where the default gems of an install live: the gemspec paths
 * <prefix>/lib/ruby/gems/<abi>/specifications/default/*.gemspec.
 *
 * @param {string} gemspecPath path of a gemspec, either separator
 * @returns {{prefix: string, abi: string}|undefined} the install prefix and
 *   ABI, when the gemspec is a default gem of a lib/ruby/gems tree
 */
export declare function defaultGemInstall(gemspecPath: string): {
    prefix: string;
    abi: string;
} | undefined;
/**
 * Whether a path lies inside an installed gem's own directory,
 * <gem home>/gems/<name>-<version>/..., beside the specifications directory of
 * that gem home. The lockfiles, manifests and nested gemspecs there belong to
 * the gem's own development, not to anything installed.
 *
 * Only the part of the path from the scanned directory down counts, so a scan
 * of one installed gem (`cdxgen /usr/local/bundle/gems/rails-7.1.0`) still
 * reads that gem's files. The scanned directory may itself be the `gems`
 * directory, as when an image scan reads each gem home on its own.
 *
 * @param {string} filePath absolute path, either separator
 * @param {function(string): boolean} exists existence check
 * @param {string} [scanRoot] the directory the scan started from
 * @returns {boolean}
 */
export declare function isInsideInstalledGem(filePath: string, exists: Function, scanRoot?: string): boolean;
/**
 * Link the default gems of an unpackaged Ruby to the runtime they ship with.
 * The runtime is known from its `file` components, which carry the build
 * version and the path they were found at; a default gem belongs to the
 * runtime installed under the same prefix. Gems an OS package installed are
 * left to that package, as is any gem whose install has no unpackaged runtime.
 *
 * @param {Object[]} components BOM components
 * @param {string} [rootDir] extracted root the source paths may start with
 * @returns {{ref: string, dependsOn: string[]}[]} edges from each runtime to
 *   its default gems
 */
export declare function linkDefaultGemsToRuntimes(components: Object[], rootDir?: string): {
    ref: string;
    dependsOn: string[];
}[];
//# sourceMappingURL=rubyBuildInfo.d.ts.map