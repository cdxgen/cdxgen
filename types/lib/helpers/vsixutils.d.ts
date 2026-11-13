/**
 * The purl type for VS Code extensions as defined by the packageurl spec.
 */
export declare const VSCODE_EXTENSION_PURL_TYPE = "vscode-extension";
/**
 * Namespace of the `pkg:generic` purl given to an installed editor, which has
 * no package type of its own.
 */
export declare const IDE_PURL_NAMESPACE = "cdxgen-ide";
/**
 * VS Code-family editors and remote servers whose installed extensions cdxgen
 * can inventory.
 *
 * Every editor built from VS Code installs extensions into
 * `<home>/<dataFolderName>/extensions` on Windows, macOS and Linux alike, and
 * its remote server installs them into `<home>/<serverDataFolderName>/extensions`
 * on the remote host. Settings and global storage live elsewhere (for example
 * `~/Library/Application Support/Cursor/User`), and that folder never holds
 * extensions.
 *
 * `apps` lists where the editor itself is installed, relative to the
 * platform's application folders, so its version can be read from
 * `resources/app/product.json` and `package.json`.
 */
export declare const IDE_PRODUCTS: ({
    id: string;
    name: string;
    dataFolderName: string;
    serverDataFolderName: string;
    apps: {
        darwin: string[];
        linux: string[];
        win32: string[];
    };
} | {
    serverDataFolderName?: undefined;
    id: string;
    name: string;
    dataFolderName: string;
    apps: {
        darwin?: undefined;
        linux?: undefined;
        win32?: undefined;
    };
})[];
/**
 * Describe where each known editor and remote server installs extensions for
 * the given home directory.
 *
 * Each desktop editor contributes one entry for its own extensions folder and,
 * when it has a remote server, a second entry for the server's folder. For the
 * current user's home, the `VSCODE_EXTENSIONS` environment variable, which VS
 * Code reads in place of the default folder, adds one more entry.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{id: string, name: string, kind: string, dirs: string[]}>}
 *   One entry per editor or server, with `kind` set to `desktop` or `server`
 */
export declare function getIdeExtensionDirs(home?: string): Array<{
    id: string;
    name: string;
    kind: string;
    dirs: string[];
}>;
/**
 * Discover the extension folders that exist for the given home directory.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{id: string, name: string, kind: string, dir: string, home: string}>}
 *   One entry per existing folder
 */
export declare function discoverIdeExtensionDirs(home?: string): Array<{
    id: string;
    name: string;
    kind: string;
    dir: string;
    home: string;
}>;
/**
 * Find the editor or server an extensions folder belongs to from its path,
 * such as `~/.cursor/extensions` or `/home/dev/.cursor-server/extensions`.
 *
 * @param {string} extensionsDir Path to an extensions folder
 * @returns {{id: string, name: string, kind: string, home: string}|undefined}
 *   The match, with the home folder it sits in, or undefined for a folder no
 *   known editor uses
 */
export declare function identifyIdeFromExtensionsDir(extensionsDir: string): {
    id: string;
    name: string;
    kind: string;
    home: string;
} | undefined;
/**
 * Read an editor's identity from the `product.json` and `package.json` in its
 * `resources/app` folder (or the root of a remote server).
 *
 * Forks report their own release in different fields of `product.json`:
 * `version` (Cursor, Kiro), `windsurfVersion` (Windsurf and Devin Desktop),
 * `positronVersion`, `appVersion` (Trae) and `codeServerVersion`. VS Code
 * itself has none of these and keeps its release in `package.json`, as every
 * fork does for the VS Code release it is based on.
 *
 * @param {string} appDir Folder holding `product.json`
 * @param {string} [rootDir] Folder both files must stay under, read without
 *   following symlinks
 * @returns {Object|undefined} `{ version, vscodeVersion, commit, quality,
 *   nameLong, dataFolderName, serverDataFolderName, appDir }`, or undefined
 *   when there is no product.json
 */
export declare function readIdeProductInfo(appDir: string, rootDir?: string): Object | undefined;
/**
 * Find the installed editor (or remote server) for an extensions folder and
 * read its identity.
 *
 * A remote server is looked up in the home the folder is in. A desktop editor
 * and code-server are looked up in the application folders of the machine
 * running cdxgen, so that lookup happens only when `probeApps` is true: for a
 * scan of this host, not for a folder copied from another machine.
 *
 * @param {{id: string, kind: string}} ide Entry from discoverIdeExtensionDirs
 * @param {string} [home] Home directory
 * @param {Object} [options] Lookup options
 * @param {boolean} [options.probeApps] Look in this machine's application
 *   folders; defaults to true only for the current user's home
 * @param {string[]} [options.appDirs] Folders to read in place of the
 *   application folders
 * @returns {Object|undefined} Result of readIdeProductInfo for the newest
 *   installation whose data folder matches, or undefined
 */
export declare function findIdeProductInfo(ide: {
    id: string;
    kind: string;
}, home?: string, options?: {
    probeApps?: boolean;
    appDirs?: string[];
}): Object | undefined;
/**
 * Parse a `.vsixmanifest` XML string and extract extension metadata.
 *
 * @param {string} manifestData Raw XML content of a `.vsixmanifest` file
 * @returns {Object|undefined} Object with { publisher, name, version, displayName, description, platform, tags } or undefined on failure
 */
export declare function parseVsixManifest(manifestData: string): Object | undefined;
/**
 * Parse npm-style dependency maps from a VS Code extension's package.json
 * and create CycloneDX component objects with versionRange attributes.
 *
 * @param {Object} pkg Parsed package.json object
 * @param {string} extensionPurl The purl of the parent extension (for dependency tree)
 * @returns {{ components: Object[], dependencies: Object[] }} CycloneDX components and dependency tree
 */
export declare function parseExtensionDependencies(pkg: Object, extensionPurl: string): {
    components: Object[];
    dependencies: Object[];
};
/**
 * Parse a VS Code extension's `package.json` and extract metadata
 * including deep capability and permission information.
 *
 * @param {string|Object} packageJsonData Either raw JSON string or parsed object
 * @param {string} [srcPath] Optional path to the source directory for evidence
 * @returns {Object|undefined} Object with metadata and capabilities or undefined
 */
export declare function parseVsixPackageJson(packageJsonData: string | Object, srcPath?: string): Object | undefined;
/**
 * Extract deep capability and permission information from a VS Code
 * extension package.json.
 *
 * This captures security-relevant metadata such as:
 * - activationEvents: when the extension activates (e.g., `*` means always)
 * - extensionKind: where the extension runs (ui, workspace, or both)
 * - permissions: workspace trust, virtual workspace support
 * - contributes: commands, debuggers, terminal profiles, task providers, fs providers
 * - extensionDependencies/extensionPack: required extensions
 * - scripts: whether postinstall or other lifecycle scripts exist
 * - main/browser: entry points for analysis
 *
 * @param {Object} pkg Parsed package.json object
 * @returns {Object} Capabilities object with structured metadata
 */
export declare function extractExtensionCapabilities(pkg: Object): Object;
/**
 * Convert parsed extension metadata into a CycloneDX component object.
 *
 * @param {Object} extInfo Object with { publisher, name, version, displayName, description, platform, srcPath, capabilities }
 * @param {string} [ideName] Optional IDE name for properties
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export declare function toComponent(extInfo: Object, ideName?: string): Object | undefined;
/**
 * True when a .vsix path is a regular file. A FIFO or a device named `*.vsix`
 * would block or never end, and a root scan does not follow a symlink.
 *
 * @param {string} vsixFile Path to the .vsix
 * @returns {boolean} true when the archive can be opened
 */
export declare function isReadableVsix(vsixFile: string): boolean;
/**
 * Extract a `.vsix` file (ZIP archive) to a temporary directory for deep
 * analysis. The caller is responsible for cleaning up the temp directory.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<string|undefined>} Path to the extracted temp directory, or undefined on failure
 */
export declare function extractVsixToTempDir(vsixFile: string): Promise<string | undefined>;
/**
 * Clean up a temporary directory created during vsix extraction.
 *
 * @param {string} tempDir Path to the temp directory to remove
 */
export declare function cleanupTempDir(tempDir: string): void;
/**
 * Parse a `.vsix` file (ZIP archive) and extract the extension metadata.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<Object|undefined>} CycloneDX component object or undefined
 */
export declare function parseVsixFile(vsixFile: string): Promise<Object | undefined>;
/**
 * Read the install registry an editor keeps beside its extensions.
 *
 * `extensions.json` lists every installed extension with where it came from
 * and when it was installed. `.obsolete` names the folders of extensions that
 * were uninstalled or replaced by an update but are still on disk until the
 * editor next starts. Folder names from either file are only compared with the
 * names in the folder, never turned into paths.
 *
 * @param {string} extensionsDir Extensions folder
 * @returns {{records: Map<string, Object>, obsolete: Set<string>, hasRegistry: boolean}}
 *   Install records keyed by folder name, the obsolete folder names, and
 *   whether an extensions.json was read
 */
export declare function readInstalledExtensionsRegistry(extensionsDir: string): {
    records: Map<string, Object>;
    obsolete: Set<string>;
    hasRegistry: boolean;
};
/**
 * Hash the `main` and `browser` entry files of an installed extension the way
 * the extension host resolves them: the path as written, with a `.js` suffix,
 * or as a folder holding `index.js`. Only regular files that stay inside the
 * extension folder are read; a symlink, a FIFO or a path that leaves the
 * folder is not.
 *
 * @param {string} extDir Installed extension folder
 * @param {{main?: string, browser?: string}} entries Entry points from
 *   package.json
 * @returns {Array<{role: string, name: string, digest: string, path: string}>}
 *   One entry per hashed file, with its path relative to the folder
 */
export declare function hashExtensionEntryFiles(extDir: string, entries: {
    main?: string;
    browser?: string;
}): Array<{
    role: string;
    name: string;
    digest: string;
    path: string;
}>;
/**
 * Describe the code an installed extension runs as `file` components with
 * their SHA-256, so the extension can be matched against a published hash of
 * a known good or known bad build.
 *
 * @param {string} extDir Installed extension folder
 * @param {Object} capabilities Capabilities from extractExtensionCapabilities
 * @param {string} parentRef bom-ref of the extension component
 * @returns {Object[]} File components, empty when no entry file is found
 */
export declare function describeExtensionEntryFiles(extDir: string, capabilities: Object, parentRef: string): Object[];
/**
 * Parse a single installed extension folder.
 *
 * `package.json` gives the identity and capabilities. The `.vsixmanifest` the
 * editor keeps beside it adds the target platform, links and manifest
 * properties, and the folder name supplies the platform when neither does.
 *
 * @param {string} extDir Absolute path to the extension folder (e.g. `~/.cursor/extensions/anthropic.claude-code-2.1.313-darwin-arm64`)
 * @param {string} [ideName] Name of the editor the folder belongs to
 * @param {Object} [installRecord] Entry for the folder from extensions.json
 * @param {Object} [options] Parse options
 * @param {boolean} [options.nameOnly] Read only the folder name, as a root
 *   scan or a scan of a folder given as a path does for a symlinked folder
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export declare function parseInstalledExtensionDir(extDir: string, ideName?: string, installRecord?: Object, options?: {
    nameOnly?: boolean;
}): Object | undefined;
/**
 * Attempt to extract extension metadata from a directory name following the
 * pattern `publisher.name-version` or `publisher.name-version-platform`.
 *
 * @param {string} extDir Absolute path to extension directory
 * @param {string} [ideName] IDE name
 * @returns {Object|undefined} CycloneDX component or undefined
 */
export declare function parseExtensionDirName(extDir: string, ideName?: string): Object | undefined;
/**
 * Decide whether a folder is an editor's extensions folder: one at a path a
 * known editor uses, or one holding the `extensions.json` or `.obsolete` an
 * editor writes. A source repository whose subfolders happen to include an
 * extension is not one.
 *
 * @param {string} dir Folder to check
 * @returns {boolean} True when the folder is an extensions folder
 */
export declare function isInstalledExtensionsDir(dir: string): boolean;
/**
 * Decide whether a folder is one installed extension: a `.vsixmanifest`, or a
 * package.json with a publisher and a `vscode` engine.
 *
 * @param {string} dir Folder to check
 * @returns {boolean} True for an extension folder
 */
export declare function isInstalledExtensionDir(dir: string): boolean;
/**
 * Build a CycloneDX component for an installed editor or remote server.
 *
 * @param {{id: string, name: string, kind: string, dirs?: string[], dir?: string, home?: string}} ide
 *   Discovered extensions folder, or folders, of one editor
 * @param {Object} [productInfo] Result of findIdeProductInfo
 * @param {number} extensionCount Number of extension builds found
 * @returns {Object} CycloneDX application component
 */
export declare function toIdeComponent(ide: {
    id: string;
    name: string;
    kind: string;
    dirs?: string[];
    dir?: string;
    home?: string;
}, productInfo?: Object, extensionCount: number): Object;
/**
 * Collect the installed extensions of each editor folder, plus a component for
 * each editor and the dependency edges from an editor to its extensions.
 *
 * One extension installed in two editors is one component: the editors are
 * listed in `cdx:vscode-extension:ide`, every folder it was found in is an
 * occurrence, and every copy's entry files are hashed. When two copies of the
 * same build have different entry-file bytes, each digest becomes its own file
 * component and the extension is marked `cdx:vscode-extension:entryHashMismatch`.
 *
 * @param {Array<{id?: string, name?: string, kind?: string, dir: string, home?: string, only?: string, probeApps?: boolean}>} ideDirs
 *   Extensions folders, as returned by discoverIdeExtensionDirs. `only` limits
 *   a folder to one extension; `home` and `probeApps` say where the editor's
 *   own version is looked up (see findIdeProductInfo), and a folder with
 *   `probeApps: false` reads only the names of its symlinked extension folders
 * @param {Object} [options] Collection options
 * @param {boolean} [options.includeIdeComponents=true] Emit a component for
 *   each editor and link it to its extensions
 * @param {string} [options.home] Home directory used when a folder names none
 * @param {boolean} [options.probeApps] Default for folders that do not say
 * @returns {{components: Object[], dependencies: Object[]}} Inventory
 */
export declare function collectIdeInventory(ideDirs: Array<{
    id?: string;
    name?: string;
    kind?: string;
    dir: string;
    home?: string;
    only?: string;
    probeApps?: boolean;
}>, options?: {
    includeIdeComponents?: boolean;
    home?: string;
    probeApps?: boolean;
}): {
    components: Object[];
    dependencies: Object[];
};
/**
 * Collect all installed extensions from a set of IDE extension directories.
 *
 * @param {Array<{name: string, dir: string}>} ideDirs Array of { name, dir } from discoverIdeExtensionDirs
 * @returns {Object[]} Array of CycloneDX component objects
 */
export declare function collectInstalledExtensions(ideDirs: Array<{
    name: string;
    dir: string;
}>): Object[];
/**
 * Merge two descriptions of the same extension build, such as a `.vsix` file
 * and the folder it was installed into, so neither loses its hashes,
 * occurrences, entry files or properties.
 *
 * @param {Object[]} components Components, some of which share a bom-ref
 * @returns {Object[]} Components with one entry per extension bom-ref
 */
export declare function mergeExtensionComponents(components: Object[]): Object[];
/**
 * Add the host's editors and the extensions osquery could not see to an OBOM
 * component list.
 *
 * osquery's `vscode_extensions` table reads `extensions.json` for a fixed set
 * of editors, so extensions of other editors, and folders an editor never
 * registered, are missing from its rows. The editor folders of each home are
 * read here: an extension osquery already reported keeps its row and gains the
 * editor names, the occurrences and the hashed entry files, and the rest are
 * added. Every editor found also becomes a component. No dependency edges are
 * added, because an OBOM has no dependency graph.
 *
 * @param {Object[]} pkgList OBOM components, which are updated in place
 * @param {Object} [options] Collection options
 * @param {string[]} [options.homes] Home directories to read
 * @param {string} [options.home] One home directory to read, used when
 *   `homes` is not given; defaults to the current user's
 * @param {Array<Object>} [options.ideDirs] Extensions folders to read in place
 *   of discovering them
 * @returns {Object[]} Components to append to the OBOM
 */
export declare function collectObomIdeInventory(pkgList: Object[], options?: {
    homes?: string[];
    home?: string;
    ideDirs?: Array<Object>;
}): Object[];
//# sourceMappingURL=vsixutils.d.ts.map