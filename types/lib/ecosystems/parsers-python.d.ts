/**
 * Method to parse python requires_dist attribute found in pypi setup.py
 *
 * @param {String} dist_string string
 */
export declare function parsePyRequiresDist(dist_string: string): {
    name: string;
    version: string;
} | undefined;
/**
 * Method to parse pipfile.lock data
 *
 * @param {Object} lockData JSON data from Pipfile.lock
 * @param {Object[]} [installedMetadata] Components parsed from the installed
 *   `*.dist-info/METADATA` files of this machine, which answer before PyPI
 *   is asked
 */
export declare function parsePiplockData(lockData: Object, installedMetadata?: Object[]): Promise<any[]>;
/**
 * Append a deduplicated name/value property to a component's properties array.
 *
 * @param {object} component Component to mutate.
 * @param {string} name Property name.
 * @param {string} value Property value.
 * @returns {void}
 */
export declare function addComponentProperty(component: object, name: string, value: string): void;
/**
 * Method to parse python pyproject.toml file
 *
 * @param {string} tomlFile pyproject.toml file
 * @returns {Object} Object with parent component, root dependencies, and metadata.
 */
export declare function parsePyProjectTomlFile(tomlFile: string): Object;
/**
 * Derive a file name for a file entry of a python lock file.
 *
 *  - poetry.lock `[metadata.files]` entries carry a `file` key.
 *  - pdm.lock `[metadata.files]` entries carry a `url` key (no `file`).
 *  - pylock.toml / uv.lock artifacts can carry an explicit `name`, a local
 *    `path`, and/or a `url`.
 *
 * @param {object} fileEntry A single lock-file file entry.
 * @returns {string | undefined} The derived file name, or undefined when none can be derived.
 */
export declare function derivePythonLockMetadataFileName(fileEntry: object): string | undefined;
/**
 * Normalise a Python distribution name the way PEP 503 does, so an installed
 * distribution and the lockfile entry it belongs to compare equal whatever
 * separator and case each of them used.
 *
 * @param {string} value Distribution name
 * @returns {string|undefined} The normalised name, or undefined for no name
 */
export declare function normalizePep503Name(value: string): string | undefined;
/**
 * The key an installed distribution and a lockfile entry are matched by: the
 * PEP 503 normalised name and the version.
 *
 * @param {Object} p Component with `name` and `version`
 * @returns {string|undefined} The key, or undefined without a name or version
 */
export declare function installedMetadataKey(p: Object): string | undefined;
/**
 * Enrich lockfile entries from the installed distributions on this machine,
 * before PyPI is asked.
 *
 * Each entry of `installedMetadata` is a component as
 * {@link parseBdistMetadata} builds it from an installed `*.dist-info/METADATA`
 * file. An entry is matched to the lockfile component with the same PEP 503
 * normalised name and the same version, and fills the fields it lacks, so the
 * registry is left only what the installed distributions do not answer. An
 * installed release of another version describes a different release, so it
 * enriches nothing. The distributions enrich the entries in place; no new
 * components are created.
 *
 * @param {Object[]} pkgList Lockfile components, enriched in place
 * @param {Object[]} installedMetadata Components parsed from installed
 *   `*.dist-info/METADATA` files
 * @returns {Set<string>} The keys of the installations that enriched an entry,
 *   as {@link installedMetadataKey} builds them, so a caller that also walks
 *   the METADATA files can skip those as components
 */
export declare function enrichFromInstalledMetadata(pkgList: Object[], installedMetadata: Object[]): Set<string>;
/**
 * Whether an environment marker is false for every CPython interpreter. Only
 * `platform_python_implementation` and `implementation_name` clauses are
 * decided; anything else, or a marker with parentheses, is treated as possibly
 * true, so the answer errs towards keeping a package.
 *
 * @param {string} marker PEP 508 environment marker
 * @returns {boolean} true when no CPython environment satisfies the marker
 */
export declare function markerExcludesCPython(marker: string): boolean;
/**
 * Method to parse python lock files such as poetry.lock, pdm.lock, uv.lock, and pylock.toml.
 *
 * @param {string} lockData Raw TOML text from poetry.lock, pdm.lock, uv.lock, or pylock.toml
 * @param {string} lockFile Lock file name for evidence
 * @param {string} pyProjectFile pyproject.toml file
 * @param {Object} [options] Options
 * @param {Object[]} [options.installedMetadata] Components parsed from the
 *   installed `*.dist-info/METADATA` files of this machine, which answer
 *   before PyPI is asked
 * @param {Map<string, Object>} [options.pyProjectCache] pyproject.toml files
 *   already parsed, shared by the lock files of one scan so that each
 *   manifest is parsed once
 * @param {Map<string, string[]>} [options.workspaceFilesCache] Workspace
 *   member pyproject.toml files already found, keyed by the member pattern
 *   joined to the lock file directory, shared the same way
 */
export declare function parsePyLockData(lockData: string, lockFile: string, pyProjectFile: string, options?: {
    installedMetadata?: Object[];
    pyProjectCache?: Map<string, Object>;
    workspaceFilesCache?: Map<string, string[]>;
}): Promise<{
    pkgList: any[];
    dependenciesList: any[];
    parentComponent?: undefined;
    rootList?: undefined;
    pyLockProperties?: undefined;
    workspaceWarningShown?: undefined;
} | {
    parentComponent: any;
    pkgList: any[];
    rootList: {
        name: any;
        version: any;
        description: any;
        properties: never[];
    }[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    pyLockProperties: any[];
    workspaceWarningShown: boolean;
}>;
/**
 * Method to parse requirements.txt file. This must be replaced with atom parsedeps.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 * @param {Object[]} [installedMetadata] Components parsed from the installed
 *   `*.dist-info/METADATA` files of this machine, which answer before PyPI
 *   is asked
 *
 * @returns {Promise[Array<Object>]} List of direct dependencies from the requirements file
 */
export declare function parseReqFile(reqFile: string, fetchDepsInfo?: boolean, installedMetadata?: Object[]): any;
/**
 * Parse environment markers into structured format
 *
 * @param {String} markersStr Raw markers string
 * @returns {Array<Object>} Structured markers array
 */
export declare function parseReqEnvMarkers(markersStr: string): Array<Object>;
/**
 * Method to parse setup.py data
 *
 * @param {Object} setupPyData Contents of setup.py
 */
export declare function parseSetupPyFile(setupPyData: Object): Promise<Object[]>;
/**
 * Split a conda artifact filename into the name, version, build string and
 * package type it encodes.
 *
 * A conda filename is `<name>-<version>-<build>.<conda|tar.bz2>`, and both the
 * name and the build string can contain hyphens
 * (`python-flatbuffers-1.0-py312_0.conda`,
 * `python-3.12.7-h9e4cc4f_0_cpython.conda`). The version is the only part
 * that always starts with a digit, so the name ends at the first hyphen
 * followed by a digit, the version at the next hyphen, and whatever follows
 * is the build. rattler derives the same three fields this way when a pixi.lock
 * location has to stand in for the name, version and build fields a v6 or v7
 * lock no longer writes.
 *
 * @param {string} filename Artifact filename, e.g. `numpy-2.5.4-py315h39cfc7d_0.conda`
 * @returns {{name: string, version: string, build: string|undefined, type: string|undefined}|undefined}
 *   The parsed fields, or undefined when the filename is not a conda artifact
 */
export declare function parseCondaArtifactFilename(filename: string): {
    name: string;
    version: string;
    build: string | undefined;
    type: string | undefined;
} | undefined;
/**
 * Derive the conda channel name and platform subdir a package location
 * carries. The location is a repository url in every lock and conda-meta
 * record cdxgen reads; pixi.lock v7 also allows file paths, which encode
 * neither field.
 *
 * The channel qualifier holds the canonical channel name (conda-forge, main),
 * never the host: `conda.anaconda.org/<channel>/...` keeps the channel in its
 * path, and `repo.anaconda.com/pkgs/<channel>/...` after the `pkgs` prefix.
 * The subdir is the path segment before the filename, `noarch` included.
 *
 * @param {string} location Package url from a lock file or conda-meta record
 * @returns {{channel: string|undefined, subdir: string|undefined}} The derived
 *   fields; both undefined when the location carries neither
 */
export declare function condaChannelAndSubdir(location: string): {
    channel: string | undefined;
    subdir: string | undefined;
};
/**
 * Build a canonical conda purl from the fields the purl-spec conda type
 * defines: a required name, an optional version, and the optional `build`,
 * `channel`, `subdir` and `type` qualifiers. The build string stays a
 * qualifier and out of the version, matching the canonical purl-spec example
 * (`pkg:conda/absl-py@0.4.1?build=py36h06a4308_0&channel=main&subdir=linux-64&type=tar.bz2`)
 * and ecosystem practice (conda's conda-sboms plugin, pixi-sbom). The conda
 * type defines no name normalisation of its own, so names are kept as written.
 *
 * @param {{name: string, version?: string, build?: string, channel?: string, subdir?: string, type?: string}} fields
 * @returns {string|null} Canonical purl, or null when the parts are invalid
 */
export declare function condaPurl(fields?: {
    name: string;
    version?: string;
    build?: string;
    channel?: string;
    subdir?: string;
    type?: string;
}): string | null;
/**
 * Method to parse pixi.lock data.
 *
 * Lock format versions 5, 6 and 7 are accepted, and the flat package records
 * of versions up to 5 keep working. The packages of every environment in the
 * `environments` section are selected (any environment, any platform,
 * deduplicated by location); without that section the flat package list is
 * used. Conda entries become `pkg:conda` components and pypi entries
 * `pkg:pypi` components, with the conda dependency graph following each
 * entry's `depends` resolved by name.
 *
 * @param {String} pixiLockFileName  pixi.lock file name
 * @param {String} path File path
 */
export declare function parsePixiLockFile(pixiLockFileName: string, path: string): {
    pkgList: Object[];
    formulationList: any[];
    rootList: any[];
    dependenciesList: {
        ref: any;
        dependsOn: any[];
    }[];
    frozen: boolean;
};
/**
 * Read the `.dist-info/INSTALLER` file of an installed distribution.
 *
 * The file names the tool that installed the distribution (packaging
 * specification "Recording installed projects"): conda-build and
 * rattler-build write `conda` into it at package build time, pip writes
 * `pip`, pixi writes `uv-pixi`. conda itself never writes it at install time,
 * so an absent file says nothing.
 *
 * @param {string} distInfoDir The `*.dist-info` directory
 * @returns {string|undefined} The installer name, or undefined without the file
 */
export declare function readDistInfoInstaller(distInfoDir: string): string | undefined;
/**
 * The installed distributions their environment's conda-meta records already
 * describe, so they must not also be emitted as PyPI components.
 *
 * A distribution is attributed to a conda record when both live in the same
 * conda environment (the conda-meta directory's parent) and carry the same
 * PEP 503 normalised name and version, and its INSTALLER file either names
 * `conda` or is absent. Any other installer value (`pip`, `uv`, `uv-pixi`)
 * means a different tool installed or reinstalled the distribution, so it
 * stays a PyPI component even when a conda package of the same name exists.
 *
 * @param {string[]} metadataFiles The installed dist-info METADATA files,
 *   in the order their parse results are passed in `installedLists`
 * @param {Array<Object[]>} installedLists The parse results of `metadataFiles`
 *   as parseBdistMetadata returns them
 * @param {Map<string, Set<string>>} condaEnvKeys Environment prefix to the
 *   {@link installedMetadataKey} keys of its conda-meta records
 * @returns {Set<string>} The keys of the distributions attributed to a conda
 *   record
 */
export declare function condaAttributedKeys(metadataFiles: string[], installedLists: Array<Object[]>, condaEnvKeys: Map<string, Set<string>>): Set<string>;
/**
 * Parse the conda-meta records of installed conda environments.
 *
 * Every record becomes a `pkg:conda` component with its sha256 hash and
 * license, and its `depends` list feeds the dependency graph (virtual
 * packages excluded). The keys of each environment's records are also
 * returned, keyed by the environment prefix, so a caller that also collects
 * the site-packages distributions of the same tree can attribute the ones
 * conda installed (see {@link condaAttributedKeys}).
 *
 * @param {string[]} condaMetaFiles conda-meta record files
 * @returns {{pkgList: Object[], dependenciesList: Object[], envKeys: Map<string, Set<string>>}}
 */
export declare function parseCondaMetaRecords(condaMetaFiles: string[]): {
    pkgList: Object[];
    dependenciesList: Object[];
    envKeys: Map<string, Set<string>>;
};
/**
 * Drop the conda components an environment file declared when the installed
 * environment also records them.
 *
 * A scan root can hold both: the environment.yml the project declares and a
 * conda-meta record of the same package the environment installed. They are
 * one artifact seen twice, and the record is the better half of the pair,
 * because it carries the build, the hashes and the license, so the declared
 * component goes, pinned or not.
 *
 * @param {Object[]} pkgList Components collected so far
 * @param {Object[]} condaMetaPkgList Components built from conda-meta records
 * @param {string[]} envYmlFiles The environment files the scan read
 * @returns {Object[]} The component list without the shadowed declarations
 */
export declare function dropEnvYmlCondaDuplicates(pkgList: Object[], condaMetaPkgList: Object[], envYmlFiles: string[]): Object[];
/**
 * Method to parse conda environment files (`environment.yml`).
 *
 * Every `dependencies` entry that is not the nested pip mapping is a conda
 * dependency: a `channel::` prefix becomes the channel qualifier, and the
 * `channels` list feeds it for entries without their own when it holds
 * exactly one channel. A pinned version becomes the purl version; anything
 * else (a range, a wildcard, a bare name) omits the version, which the conda
 * purl type allows, and records the full spec in a `cdx:conda:spec` property.
 * The nested `pip:` list becomes `pkg:pypi` components through the
 * requirements parser, minus the entries that are urls, paths or editable
 * installs.
 *
 * @param {String} environmentYmlFile environment.yml file name
 * @returns {Promise<{pkgList: Object[]}>} The parsed components
 */
export declare function parseEnvironmentYmlFile(environmentYmlFile: string): Promise<{
    pkgList: Object[];
}>;
/**
 * Method to parse pixi.toml file
 *
 * @param {String} pixiToml
 */
export declare function parsePixiTomlFile(pixiToml: string): {};
/**
 * Method to run cli command `pixi install` in the project directory.
 *
 * @param {string} projectPath Directory containing pixi.toml
 * @returns {boolean} true when pixi install succeeded
 */
export declare function generatePixiLockFile(projectPath: string): boolean;
/**
 * Parse a Mojo `mojoproject.toml` manifest.
 *
 * Mojo projects are pixi-managed, so conda and PyPI dependencies pulled through
 * pixi.lock already keep their correct registered types via the pixi path.
 * Only Mojo's *own* packages — declared in `mojoproject.toml` — need special
 * handling: `mojo` is not a registered purl type, so each is emitted as
 * `pkg:generic/...` with a `cdx:purl:proposedType=mojo` property.
 *
 * The manifest is TOML. The `[project]` table carries the project's name and
 * version; `[dependencies]` maps dependency names to version specifiers. A
 * declared version range (e.g. `==0.1.0`, `>=0.2`) is normalised to its
 * concrete version when one is present, otherwise the version is omitted.
 *
 * @param {string} mojoProjectFile Path to `mojoproject.toml`
 * @returns {{ pkgList: object[], parentComponent: object }}
 */
export declare function parseMojoProject(mojoProjectFile: string): {
    pkgList: object[];
    parentComponent: object;
};
//# sourceMappingURL=parsers-python.d.ts.map