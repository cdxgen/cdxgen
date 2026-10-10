/**
 * Parse pom file
 *
 * @param {string} pomFile pom file to parse
 * @returns {Object} Object containing pom properties, modules, and array of dependencies
 */
export declare function parsePom(pomFile: string): Object;
/**
 * Every pom file of the reactor an aggregator pom builds: its own modules,
 * recursively through nested aggregators. A recursive dependency:tree run
 * from the aggregator resolves all of them, so their own runs repeat it.
 *
 * A module entry names a directory relative to its pom, sometimes a direct
 * path to a pom file. Entries that are absolute, or that climb out of the
 * aggregator's directory, are ignored: the scan never listed them, and the
 * walk must not follow a pom's pointers outside its own tree.
 *
 * @param {string} rootPom Path of the aggregator pom.
 * @returns {Set<string>} Pom files of the reactor, excluding the aggregator.
 */
export declare function resolveReactorPomFiles(rootPom: string): Set<string>;
/**
 * File name stem for the trees of one recursive dependency:tree run. Maven
 * expands the project expressions for each reactor module, so every module
 * writes its own file; a fixed name would hold only the last module's tree.
 */
export declare const MAVEN_MODULE_TREE_STEM = "${project.groupId}-${project.artifactId}";
/**
 * Read the trees one dependency:tree run wrote, one file per reactor module
 * (see MAVEN_MODULE_TREE_STEM), and tell which of the reactor's pom files
 * they cover. The pom the run started from comes first, then its modules in
 * reactor order. A module pom counts as covered only when its own tree is
 * among the files, so a module the run left out still runs on its own.
 *
 * @param {string} treeDir Directory the run wrote its trees into.
 * @param {string} rootPom The pom file the run started from.
 * @returns {{trees: Array<{pomFile: string, text: string}>, covered: Set<string>}}
 */
export declare function readMavenModuleTrees(treeDir: string, rootPom: string): {
    trees: Array<{
        pomFile: string;
        text: string;
    }>;
    covered: Set<string>;
};
/**
 * Parse maven dependency:tree json output
 *
 * @param rawOutput
 * @param pomFile
 * @returns {{parentComponent: {}, pkgList: *[], dependenciesList: *[]}|{}|{}|*|{parentComponent: {[p: string]: *}|{}, pkgList: [], dependenciesList: []}}
 */
export declare function parseMavenTreeJson(rawOutput: any, pomFile: any): {
    parentComponent: {};
    pkgList: any[];
    dependenciesList: any[];
} | {} | {} | any | {
    parentComponent: {
        [p: string]: any;
    } | {};
    pkgList: [];
    dependenciesList: [];
};
/**
 * Parse maven tree output
 * @param {string} rawOutput Raw string output
 * @param {string} pomFile .pom file for evidence
 *
 * @returns {Object} Object containing packages and dependencies
 */
export declare function parseMavenTree(rawOutput: string, pomFile: string): Object;
/**
 * Parse mill dependencies from file
 *
 * Scala artifacts are emitted in the sbt purl form: the Scala binary suffix
 * is stripped from the artifact name and the version it carried is recorded
 * in the cdx:scala:compilerVersion property, so one library keeps a single
 * purl whichever build tool reported it.
 *
 * @param {string} module name of the module
 * @param {map} dependencies the parsed dependencies
 * @param {map} relations a map containing all relations
 * @param {string} millRootPath root of the project
 * @param {string} logFileName name of the tree log the module wrote
 *
 * @returns the bom-ref of the module
 */
export declare function parseMillDependency(module: string, dependencies: map, relations: map, millRootPath: string, logFileName?: string): any;
export declare function completeComponent(component: any): any;
/**
 * Parse clojure cli dependencies output
 * @param {string} rawOutput Raw string output
 */
export declare function parseCljDep(rawOutput: string): any[];
/**
 * Parse lein dependency tree output
 * @param {string} rawOutput Raw string output
 */
export declare function parseLeinDep(rawOutput: string): Object[];
/**
 * Recursively walks a parsed EDN map node produced by the Leiningen dependency
 * tree and collects unique dependency entries into the deps array.
 *
 * @param {Object} node Parsed EDN node (expected to have a "map" property)
 * @param {Object} keys_cache Cache object used to deduplicate entries by group-name-version key
 * @param {Object[]} deps Accumulator array of dependency objects with group, name, and version fields
 * @returns {Object[]} The populated deps array
 */
export declare function parseLeinMap(node: Object, keys_cache: Object, deps: Object[]): Object[];
/**
 * Parse bazel action graph output
 * @param {string} rawOutput Raw string output
 */
export declare function parseBazelActionGraph(rawOutput: string): any[];
/**
 * Parse bazel skyframe state output
 * @param {string} rawOutput Raw string output
 */
export declare function parseBazelSkyframe(rawOutput: string): any[];
/**
 * Parse bazel BUILD file
 * @param {string} rawOutput Raw string output
 */
export declare function parseBazelBuild(rawOutput: string): any[];
/**
 * Parse dependencies in Key:Value format
 */
export declare function parseKVDep(rawOutput: any): any[];
/**
 * Parse Leiningen project.clj data and extract dependency packages.
 *
 * @param {string} leinData Raw text contents of a Leiningen project.clj file
 * @returns {Object[]} Array of package objects with group, name, and version
 */
export declare function parseLeiningenData(leinData: string): Object[];
/**
 * Parse EDN (Extensible Data Notation) deps.edn data and extract dependency packages.
 *
 * Handles Clojure deps.edn files, extracting packages listed under the `:deps` key.
 *
 * @param {string} rawEdnData Raw EDN text contents of a deps.edn file
 * @returns {Object[]} Array of package objects with group, name, and version
 */
export declare function parseEdnData(rawEdnData: string): Object[];
//# sourceMappingURL=parsers-jvm.d.ts.map