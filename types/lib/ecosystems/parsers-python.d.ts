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
 * Method to parse python lock files such as poetry.lock, pdm.lock, uv.lock, and pylock.toml.
 *
 * @param {string} lockData Raw TOML text from poetry.lock, pdm.lock, uv.lock, or pylock.toml
 * @param {string} lockFile Lock file name for evidence
 * @param {string} pyProjectFile pyproject.toml file
 * @param {Object} [options] Options
 * @param {Object[]} [options.installedMetadata] Components parsed from the
 *   installed `*.dist-info/METADATA` files of this machine, which answer
 *   before PyPI is asked
 */
export declare function parsePyLockData(lockData: string, lockFile: string, pyProjectFile: string, options?: {
    installedMetadata?: Object[];
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
 * Method to parse pixi.lock data
 *
 * @param {String} pixiLockFileName  pixi.lock file name
 * @param {String} path File path
 */
export declare function parsePixiLockFile(pixiLockFileName: string, path: string): {
    pkgList: any;
    formulationList: any[];
    rootList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    frozen: boolean;
};
/**
 * Method to parse pixi.toml file
 *
 * @param {String} pixiToml
 */
export declare function parsePixiTomlFile(pixiToml: string): {};
/**
 * Method to run cli command `pixi install`
 *
 *
 */
export declare function generatePixiLockFile(_path: any): void;
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