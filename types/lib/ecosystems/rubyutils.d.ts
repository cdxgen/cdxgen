/**
 * Is the given string a `Gem::Platform` such as `x86_64-linux` or `java`?
 * The cpu component is an open token in RubyGems, so we validate by looking
 * for a known os name in any position.
 *
 * Note that `truffleruby` is deliberately absent from the os table.
 * `Gem::Platform.new("truffleruby").to_s` is `"unknown"`: TruffleRuby reports a
 * conventional local platform such as `x86_64-linux`, and reuses plain ruby
 * gems via an allowlist rather than through a platform of its own. So
 * `truffleruby` never appears as a platform suffix.
 *
 * @param {string} value Candidate platform string
 * @returns {boolean} true if the value looks like a gem platform
 */
export declare function isRubyPlatform(value: string): boolean;
/**
 * Normalize a gem platform the way `Gem::Platform` does.
 *
 * The only alias that matters for a lockfile or a gemspec is `jruby`, which
 * `Gem::Platform` maps to the os `java`, so `Gem::Platform.new("jruby").to_s`
 * is `"java"`. Normalizing keeps a JRuby gem from being reported under two
 * different purls depending on which spelling the source used.
 *
 * @param {string | undefined} platform Platform to normalize
 * @returns {string | undefined} Normalized platform
 */
export declare function normalizeGemPlatform(platform: string | undefined): string | undefined;
/**
 * Split a gem version string into its version and optional native platform.
 *
 * Bundler writes native gems as `name (version-platform)`, for example
 * `google-protobuf (3.25.1-x86_64-linux)`. This mirrors how Bundler itself
 * parses the lockfile: its `NAME_VERSION` regex captures the version as
 * `([^-]*)` followed by an optional `-(.*)` platform, i.e. it splits at the
 * *first* hyphen. That is unambiguous because `Gem::Version` rewrites any `-`
 * to `.pre.` on construction, so a canonical version string, which is what
 * Bundler writes to the lockfile, never contains a hyphen.
 *
 * @param {string | undefined} version Version that may include a platform suffix
 * @returns {{version: (string | undefined), platform: (string | undefined)}} Version and platform
 */
export declare function splitRubyVersionPlatform(version: string | undefined): {
    version: (string | undefined);
    platform: (string | undefined);
};
/**
 * Simplify the ruby version by removing platform suffixes
 *
 * @param {string} version Version to simplify
 * @returns {string} Simplified version
 */
export declare function simplifyRubyVersion(version: string): string;
/**
 * Construct a gem purl. Per the purl specification, the native platform is
 * represented with the `platform` qualifier and not as part of the version.
 * `ruby` is the implied default platform, so it is left out.
 *
 * @param {string} name Gem name
 * @param {string | undefined} version Gem version without any platform suffix
 * @param {string | undefined} platform Gem platform such as `x86_64-linux`
 * @returns {string} purl string
 */
export declare function toGemPurl(name: string, version: string | undefined, platform: string | undefined): string;
/**
 * Read the Ruby string literal at the start of `text`: a double or single
 * quoted string, or a `%q`/`%Q`/`%` percent literal. Escaped delimiters and
 * backslashes are unescaped; every other escape sequence is kept as written.
 * An interpolation such as `#{spec.name}` is kept verbatim, including any
 * quotes inside it.
 *
 * @param {string} text Source starting with the literal
 * @returns {{value: string, interpolated: boolean, complete: boolean, rest: string} | undefined}
 *   The literal's value, whether it holds an interpolation, whether it was
 *   closed within `text`, and the source after it. Undefined when `text` does
 *   not start with a string literal.
 */
export declare function readRubyStringLiteral(text: string): {
    value: string;
    interpolated: boolean;
    complete: boolean;
    rest: string;
} | undefined;
/**
 * Read a Ruby list of strings as written for `authors`, `email`, or `licenses`:
 * an array of string literals, a `%w[]` word array, or a single string. Array
 * elements that are not string literals, such as constants, are skipped.
 *
 * @param {string} text Source of the value
 * @returns {{values: string[], complete: boolean} | undefined} The strings,
 *   and whether the array was closed within `text`. Undefined when the value
 *   is an expression that cannot be read statically.
 */
export declare function readRubyStringList(text: string): {
    values: string[];
    complete: boolean;
} | undefined;
/**
 * Parse a single line from the `CHECKSUMS` section of a Gemfile.lock. Bundler
 * 2.5 onwards writes `name (version[-platform]) algo=digest[,algo=digest]`,
 * where the `name (version[-platform])` token is identical to the one used in
 * the `specs:` section. The digest is lowercase hex. An entry may carry no
 * checksum at all when Bundler could not obtain one.
 *
 * @param {string} line Trimmed line from the CHECKSUMS section
 * @returns {{lockName: string, hashes: Array<object>} | undefined} Lock name and CycloneDX hashes
 */
export declare function parseGemChecksumLine(line: string): {
    lockName: string;
    hashes: Array<object>;
} | undefined;
/**
 * Default location of Bundler's compact index cache. This is the protocol
 * Bundler itself uses to resolve, so any gem the developer has ever installed
 * has a cached `info/<gem>` file here.
 *
 * @returns {string} Path to the compact index cache directory
 */
export declare function getCompactIndexCacheDir(): string;
/**
 * Parse the contents of a Bundler compact index `info/<gem>` file. Each line
 * describes one release:
 *
 *   `VERSION[-PLATFORM] <deps>|checksum:<sha256>,ruby:<req>,rubygems:<req>,...`
 *
 * This is the cheapest source of gem metadata available: a single local file
 * carries the sha256, the runtime dependencies and the required ruby and
 * rubygems versions for every release of a gem.
 *
 * @param {string} infoData Contents of an info file
 * @returns {object} Map of `version[-platform]` to release metadata
 */
export declare function parseCompactIndexInfo(infoData: string): object;
/**
 * Parse a `.bundle/config` file. Bundler writes a small YAML document of
 * `BUNDLE_<SETTING>: "value"` pairs. Two settings matter for an SBOM:
 * `BUNDLE_PATH`, which tells us where the gems actually live, and
 * `BUNDLE_WITHOUT`, which tells us that some groups were never installed and
 * that the SBOM is therefore incomplete by construction.
 *
 * @param {string} configFile Path to a .bundle/config file
 * @returns {object} Map of setting name to value
 */
export declare function parseBundleConfig(configFile: string): object;
/**
 * Enrich gem components from the caches present on the machine, without making
 * any network calls. Two sources are consulted:
 *
 * 1. Bundler's compact index cache, for the sha256 and the required ruby and
 *    rubygems versions of the exact release, including native variants.
 * 2. The installed gemspecs under `GEM_HOME/specifications`, for licenses,
 *    description, project URIs and the native extension list.
 *
 * Because this only reads files it also works in dry-run mode, where the
 * registry lookups performed by `getRubyGemsMetadata` are blocked.
 *
 * @param {Array} pkgList List of gem components to enrich in place
 * @param {object} options Options
 * @param {string} options.gemHome GEM_HOME to read installed gemspecs from
 * @param {string} options.compactIndexCacheDir Bundler compact index cache directory
 * @returns {Promise<Array>} The enriched package list
 */
export declare function enrichGemsFromLocalCache(pkgList: any[], options?: {
    gemHome: string;
    compactIndexCacheDir: string;
}): Promise<any[]>;
/**
 * Method to query rubygems api for gems details
 *
 * A gem that ships several native builds appears in the BOM once per platform.
 * Rather than making one request per variant, the versions listing endpoint is
 * used to fetch every version and platform of such a gem in a single request.
 *
 * @param {Array} pkgList List of packages with metadata
 */
export declare function getRubyGemsMetadata(pkgList: any[]): Promise<any[]>;
/**
 * Utility method to convert a gem package name to a CamelCased module name. Low accuracy.
 *
 * @param name Package name
 */
export declare function toGemModuleNames(name: any): string[];
/**
 * Collect all namespaces for a given gem present at the given gemHome
 *
 * @param {String} rubyCommand Ruby command to use if bundle is not available
 * @param {String} bundleCommand Bundle command to use
 * @param {String} gemHome Value to use as GEM_HOME env variable
 * @param {String} gemName Name of the gem
 * @param {String} filePath File path to the directory containing the Gemfile or .bundle directory
 *
 * @returns {Array<string>} List of module names
 */
export declare function collectGemModuleNames(rubyCommand: string, bundleCommand: string, gemHome: string, gemName: string, filePath: string): Array<string>;
/**
 * Method to parse Gemspec file contents.
 *
 * A source gemspec is Ruby code. The values that can be read without running
 * it are string literals, lists of them, heredocs, and a version constant
 * defined in the version file the gemspec requires. Anything else is left
 * unresolved instead of being guessed.
 *
 * Bundler evaluates the gemspec of a project that uses the Gemfile `gemspec`
 * directive, and locks the gem under `PATH remote: .`. Such a locked version
 * can be supplied through `options.lockedVersions` and is used when the
 * gemspec computes its version in a way that cannot be read statically.
 *
 * @param {string} gemspecData Gemspec data
 * @param {string} gemspecFile File name for evidence.
 * @param {Object} [options] Parse options
 * @param {Object<string, string>} [options.lockedVersions] Locked versions of
 *   the gems the project directory serves, by gem name
 * @param {boolean} [options.projectGemspec] The gemspec describes the project
 *   being scanned. No registry holds the project, so its gem is never looked
 *   up and keeps what the gemspec says.
 * @param {boolean} [options.noFetch] Read the gemspec for the fields it holds
 *   without asking the registry about the gem. The local cache enricher uses
 *   this, since the caller is responsible for the registry round.
 */
export declare function parseGemspecData(gemspecData: string, gemspecFile: string, options?: {
    lockedVersions?: Record<string, string>;
    projectGemspec?: boolean;
    noFetch?: boolean;
}): Promise<any[]>;
/**
 * Method to parse Gemfile.lock
 *
 * Besides the components and the dependency tree, the result lists as
 * `projectGemRefs` the bom-refs of the gems served from the lockfile's own
 * directory (`PATH` with `remote: .`), which is how Bundler records the gem a
 * project builds when its Gemfile uses the `gemspec` directive.
 *
 * Gems the lockfile serves from a git remote or from a path outside the
 * project are never sent to rubygems.org: no public registry holds the release
 * they pinned. Before the registry round, the caches on this machine are read
 * first, so a gem whose installed gemspec or compact index entry is present
 * keeps those answers.
 *
 * @param {object} gemLockData Gemfile.lock data
 * @param {string} lockFile Lock file
 * @param {object} [options] Options
 * @param {string} [options.gemHome] GEM_HOME to read installed gemspecs from
 * @param {string} [options.compactIndexCacheDir] Bundler compact index cache
 */
export declare function parseGemfileLockData(gemLockData: object, lockFile: string, options?: {
    gemHome?: string;
    compactIndexCacheDir?: string;
}): Promise<any[] | {
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    rootList: any[];
    projectGemRefs: any[];
}>;
/**
 * Describe the gem a project builds in its parent component.
 *
 * A gem project sees its own gem more than once: in its gemspec, in the `PATH`
 * entry the Gemfile `gemspec` directive adds to its lockfile, and possibly as
 * an installed copy. Each of them describes the project itself, so all are
 * folded into the parent (discussion 4388). The parent takes the gem's
 * identity, its descriptive metadata, and its `cdx:gem:*` properties; the
 * dependency edges of the sightings move to the parent; and the sightings
 * leave the component list, so the gem is never a dependency of itself.
 *
 * An explicit `--project-version` names the version of the parent. Otherwise
 * the version of the gemspec, which may have come from the lockfile, is used.
 *
 * @param {object} parentComponent Parent component, updated in place
 * @param {object} projectGem Component parsed from the root gemspec
 * @param {object[]} pkgList Components
 * @param {object[]} dependencies Dependency edges
 * @param {string[]} rootList bom-refs of the direct dependencies
 * @param {string[]} projectGemRefs bom-refs of the gems the lockfiles serve from the project directory
 * @param {object} options CLI options
 * @returns {{pkgList: object[], dependencies: object[], rootList: string[]}}
 *   The components, edges, and direct dependencies with the gem folded in
 */
export declare function describeProjectGem(parentComponent: object, projectGem: object, pkgList: object[], dependencies: object[], rootList: string[], projectGemRefs: string[], options?: object): {
    pkgList: object[];
    dependencies: object[];
    rootList: string[];
};
/**
 * Point each gem resolved from the public RubyGems registry at its `.gem`
 * tarball with a `distribution` external reference (discussion 4406).
 *
 * The registry API supplies `gem_uri` when it is reachable, but an offline
 * scan — a dry run, an air-gapped host, or one that only consulted Bundler's
 * local caches — has no way to learn it. For the public registry the URL is
 * deterministic, so it is derived from the recorded `cdx:gem:remote` and the
 * release identity instead. Gems from any other remote are left alone: a
 * private mirror's layout is its own business.
 *
 * @param {Array} pkgList Gem components, enriched in place
 * @returns {Array} The package list
 */
export declare function addRubyGemsDistributionUrls(pkgList: any[]): any[];
/**
 * Intersect Gem::Requirement strings into one `vers` range with the RubyGems
 * versioning scheme, as the CycloneDX `versionRange` requires. `>= 2.3` and
 * `>= 3.3` intersect to `vers:gem/>=3.3`, and `~> 3.1` becomes
 * `vers:gem/>=3.1|<4`, since vers has no pessimistic operator.
 *
 * @param {string[]} requirements Requirement strings, each possibly holding
 *   several comma separated constraints
 * @returns {string|null|undefined} The range, `null` when the requirements
 *   exclude each other, or undefined when none of them could be read
 */
export declare function rubyRequirementToVers(requirements: string[]): string | null | undefined;
/**
 * Describe the Ruby runtime the gems require as one external `platform`
 * component, and make the components that declare a `required_ruby_version`
 * depend on it (discussion 4409).
 *
 * The component stands for the Ruby the bundle as a whole runs on, so its
 * `versionRange` is the intersection of every requirement that could be read,
 * in the `vers` syntax CycloneDX mandates for the field. Each component's own
 * requirement stays in its `cdx:gem:rubyVersionSpecifiers` property. One
 * runtime component per distinct requirement would describe the same
 * interpreter many times over: a modest bundle spells `>= 2.x` a dozen ways.
 *
 * The type is `platform`, the CycloneDX type for a runtime environment that
 * interprets software, and the one cdxgen gives the Ruby it finds in the
 * build environment. The purl names no version, since a range is not one.
 *
 * `isExternal` and `versionRange` are CycloneDX 1.7 fields, and without them
 * the component would claim the product bundles its interpreter, so the caller
 * decides whether the BOM should carry it at all.
 *
 * @param {Array} pkgList Components
 * @param {object} parentComponent The metadata.component, when the project is
 *   itself a gem
 * @param {Array} dependencies Dependency edges
 * @returns {{pkgList: Array, dependencies: Array}} Components and edges with
 *   the runtime component added
 */
export declare function addRubyRuntimeComponent(pkgList: any[], parentComponent: object, dependencies: any[]): {
    pkgList: any[];
    dependencies: any[];
};
//# sourceMappingURL=rubyutils.d.ts.map