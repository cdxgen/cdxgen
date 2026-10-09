export declare const JDK_OWNER_PREFIXES: string[];
export declare const SCALA_STDLIB_ARTIFACTS: Set<string>;
export declare function appendUniqueProperty(properties: any, name: any, value: any): void;
export declare function addPropertyValue(map: any, key: any, name: any, value: any): void;
export declare function addSetValue(map: any, key: any, value: any): void;
/**
 * True for every project type the Scala path serves, matching the alias list
 * the BOM generators dispatch on.
 *
 * @param {string} language Project language or type.
 * @returns {boolean}
 */
export declare function isScalasemLanguage(language: string): boolean;
/**
 * True when scalasem is turned off, through CDXGEN_SCALASEM_DISABLE or the
 * --no-scalasem flag, which yargs carries as `scalasem: false`. Library code never reads
 * process.argv for this.
 *
 * @param {Object} options CLI options.
 * @returns {boolean}
 */
export declare function scalasemDisabled(options?: Object): boolean;
/**
 * The scalasem entry point: SCALASEM_CMD wins, then the scalasem.js inside
 * the installed atom-parsetools package.
 *
 * @returns {string|undefined}
 */
export declare function resolveScalasemCommand(): string | undefined;
/**
 * Where the scalasem report is persisted. An absolute --semantics-slices-file
 * keeps its directory; anything else lands in the evinse output directory, the
 * same rule the atom slice writer follows.
 *
 * @param {Object} options CLI options carrying `output` and `semanticsSlicesFile`.
 * @returns {string} Absolute report path.
 */
export declare function scalasemOutputFile(options?: Object): string;
/**
 * A version 1 semantics slice (the shape atom's scalasem wrote before schema
 * version 2): keyed by .scala files with `usedTypes`, no `_meta.schemaVersion`.
 *
 * @param {Object} parsed Candidate slice.
 * @returns {boolean}
 */
export declare function isV1SemanticsSlice(parsed: Object): boolean;
/**
 * Run scalasem over a Scala project and return its report, reusing a
 * persisted version 2 report that belongs to this project and is newer than
 * the input BOM.
 *
 * Failures are visible rather than silent: the reason is printed once, the
 * run's diagnostics reach the caller as `cdx:scalasem:diagnostic` properties,
 * and --fail-on-error claims the exit status. A version 1 slice of this
 * project, at the path the user named or at the report path, is returned
 * separately and never overwritten; the fresh report then goes to a
 * temporary file.
 *
 * @param {string} src Project directory.
 * @param {Object} options CLI options.
 * @returns {Object|undefined} `{ report, reportFile, v1Slice, metadataProperties }`,
 *   or undefined when the analyzer is disabled.
 */
export declare function analyzeScalaProject(src: string, options?: Object): Object | undefined;
/**
 * The `cdx:scalasem:*` metadata properties of one run: what produced the
 * report, and what limited it.
 *
 * @param {Object|undefined} report Parsed scalasem report, when one exists.
 * @param {Object[]} diagnostics Run diagnostics, from the report or the spawn.
 * @returns {Object[]} Metadata properties.
 */
export declare function scalasemMetadataProperties(report: Object | undefined, diagnostics?: Object[]): Object[];
export declare function sortedCsv(values: any): string | undefined;
/**
 * The platform a purl's artifact name targets: `_sjs1` is Scala.js,
 * `_native0.x` is Scala Native, and neither is the JVM.
 *
 * @param {string} purl Package URL.
 * @returns {"jvm"|"js"|"native"} Platform key.
 */
export declare function scalaPurlPlatform(purl: string): "jvm" | "js" | "native";
/**
 * The class and package index that joins scalasem symbols to component purls.
 *
 * Symbols are indexed from three sources in priority order: the classpath the
 * report recorded (1), the `internal:Namespaces` properties of the components
 * (2), and the jar namespace map cdxgen writes beside the BOM (3). A symbol an
 * earlier source already attributed is never re-attributed by a later one.
 *
 * A jar answers for the classes it ships and for the packages it ships classes
 * in directly, never for the parents of those packages: a library with one
 * class under `scala.collection.compat` owns neither `scala.collection` nor
 * `scala`. The JDK has no component, and neither do the project's own classes.
 */
export declare class ScalaJoinIndex {
    classPurls: Map<any, any>;
    packagePurls: Map<any, any>;
    sourceBySymbol: Map<any, any>;
    purlsBySource: Map<any, any>;
    namespacesByPurl: Map<any, any>;
    projectClasses: Set<any>;
    projectPackages: Set<any>;
    constructor();
    hasNamespaces(purl: any): boolean;
    /**
     * Index the classes of one library: each class under its dotted name (a
     * nested `Outer$Inner` also as `Outer.Inner`, an object `Foo$` as `Foo`),
     * and the package each one sits in.
     *
     * @param {string} purl The owning component purl.
     * @param {string[]} names Class names from the jar or the namespace property.
     * @param {number} source The source priority, 1 to 3.
     */
    addNamespaces(purl: string, names: string[], source: number): void;
    addSymbol(map: any, symbol: any, purl: any, source: any): void;
    /**
     * Record the classes the project defines, so that references to them, and
     * to packages only the project fills, never join a library.
     *
     * @param {Object} report Parsed scalasem report.
     */
    addProjectDefinitions(report: Object): void;
    /**
     * Whether a symbol belongs to code the BOM has no component for: the JDK,
     * or the project itself.
     */
    isUnowned(symbol: any): boolean;
    /**
     * The libraries that ship the class a symbol names: the longest dotted
     * prefix of the symbol that is a class name, for a member or a nested type.
     */
    classOwners(symbol: any): any;
    /**
     * The libraries that ship classes directly in the package a symbol names or
     * sits in. A package the project also fills is ambiguous and joins nothing,
     * and `javax.` names join only through an exact class, since the JDK ships
     * most of them.
     */
    packageOwners(symbol: any): any;
    /**
     * The purl owning a symbol: the class first, then the package it sits in,
     * each narrowed to the module's own classpath and the file's platform, and
     * kept only when a single owner remains.
     *
     * @param {string} symbol Fully qualified symbol from the report.
     * @param {string|undefined} platform Platform of the referencing file.
     * @param {Set<string>|undefined} allowedPurls Purls on the module's classpath.
     * @returns {string|undefined} Component purl.
     */
    lookup(symbol: string, platform: string | undefined, allowedPurls: Set<string> | undefined): string | undefined;
    /**
     * The owners a stack is evidence for: every jar that ships the class, since
     * which one served the call cannot be told from the source, or the single
     * package owner when no jar lists the class.
     */
    lookupAll(symbol: any, platform: any, allowedPurls: any): any[];
    /**
     * Narrow candidate owners to what the referencing file can use. A module
     * compiles against its own classpath: a library on it wins, and a library
     * only other modules compile against does not qualify. A library on no
     * module's classpath stays a candidate, since the report cannot list every
     * jar (a locally published snapshot, say). The file's platform then picks
     * among the JVM, Scala.js and Scala Native variants of one library.
     */
    narrow(candidates: any, platform: any, allowedPurls: any): any[];
}
/**
 * Whether a report key names a source file entry. The schema keys file
 * entries by their relative path, for Scala sources, scripts and the Java
 * sources of a mixed module alike.
 */
export declare function isReportFileKey(key: any): boolean;
/**
 * Index the BOM components by their normalized Scala coordinates, both with
 * and without the version, so a classpath jar, a namespace property and a map
 * entry of the same library meet on one component. Each entry keeps the Scala
 * binary version the component was built for, so the `_2.13` and `_3`
 * artifacts of one library in a Maven build stay apart.
 */
export declare function componentCoordinateIndex(components?: any[]): {
    byVersion: Map<any, any>;
    withoutVersion: Map<any, any>;
};
/**
 * The component a report classpath entry belongs to. Coordinates are
 * normalized (`upickle_sjs1_3` and the purl name `upickle_sjs1` share a key),
 * the entry's version and Scala binary version win, and a versionless match
 * must have a single owner. A jar the BOM does not hold matches nothing: no
 * component is invented.
 *
 * @returns {{component: Object, exact: boolean}|undefined} The component, and
 *   whether its version is the one on the classpath.
 */
export declare function matchClasspathEntry(entry: any, { byVersion, withoutVersion }: {
    byVersion: any;
    withoutVersion: any;
}, platform: any): {
    component: Object;
    exact: boolean;
} | undefined;
/**
 * Build the symbol index from the three sources, reading each classpath jar
 * once, and only for components that carry no namespaces yet.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object[]} components BOM components.
 * @param {Object} jarNSMapping The jar namespace map cdxgen writes beside the BOM.
 * @returns {Promise<ScalaJoinIndex>}
 */
export declare function buildScalaJoinIndex(report: Object, components: Object[], jarNSMapping: Object): Promise<ScalaJoinIndex>;
export declare const SCALASEM_PROTOCOL_NAMES: Set<string>;
export declare const SCALASEM_KEYSTORE_NAMES: Set<string>;
export declare const SCALASEM_QUALIFIED_ALGORITHMS: Set<string>;
export declare const SCALASEM_NO_OID_ALGORITHMS: Set<string>;
/**
 * The OID registry key for a canonical scalasem algorithm name, with the key
 * size, mode, curve or padding when the name needs one. Names that have no
 * key return undefined.
 *
 * @param {string} name Canonical algorithm name.
 * @param {number} [keySize] Key size in bits, when the report carries one.
 * @param {string} [mode] Block cipher mode, such as `GCM`.
 * @param {string} [curve] Elliptic curve name.
 * @param {string} [padding] JCA padding name.
 * @returns {string|undefined} Registry key such as `aes256-GCM`.
 */
export declare function scalasemCryptoOidKey(name: string, keySize?: number, mode?: string, curve?: string, padding?: string): string | undefined;
/**
 * Project a scalasem report onto CycloneDX evidence: occurrences for the
 * joined components, call stacks for the library sinks, namespaces for the
 * components the classpath join read, and the run's metadata properties.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object[]} components BOM components.
 * @param {Object} options CLI options; `scalaNamespaceMap` carries the jar
 *   namespace map cdxgen wrote beside the BOM.
 * @returns {Promise<Object>} The evidence maps `createEvinseFile` consumes.
 */
export declare function collectScalasemEvidence(report?: Object, components?: Object[], options?: Object): Promise<Object>;
/**
 * The component purl of the library a crypto finding names as its provider.
 * Maven coordinates match on group and base artifact; the short aliases cover
 * the providers the rules emit for libraries without a coordinate.
 */
export declare function scalasemProviderPurl(provider: any, components?: any[]): any;
/**
 * A JDBC address without what may carry credentials: userinfo, the Oracle
 * `user/password@` prefix, URL parameters and the `;key=value` properties
 * some drivers take. The report is sanitized already; this keeps the BOM
 * safe from a report written by anything else.
 *
 * @param {string} value JDBC URL.
 * @returns {string} The address part.
 */
export declare function sanitizeJdbcUrl(value: string): string;
/**
 * The host a service URL names, or the topic and JDBC scheme equivalents, so
 * every outbound service is named after where it talks to rather than the
 * client library it uses.
 */
export declare function scalasemServiceName(service: any): any;
/**
 * The endpoint a service row carries, normalized: a URL as its scheme and
 * host, a host as it is, a topic as `client:topic`, a JDBC URL with its
 * credentials and parameters dropped.
 */
export declare function scalasemServiceEndpoint(service: any): any;
/**
 * Outbound services: HTTP and websocket clients, data stores, messaging
 * topics and cloud clients. Locations ride in
 * `cdx:scalasem:service:location` properties because CycloneDX services
 * carry no evidence field before 2.0; spec compatibility keeps the
 * occurrences below that only at 2.0.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object} servicesMap Map populated with service definitions.
 * @returns {Object} The mutated services map.
 */
export declare function collectScalasemServices(report?: Object, servicesMap?: Object): Object;
/**
 * Inbound endpoints, one service per route, named the way the OpenAPI reader
 * names its own so the two converge on one entry for the same route.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object} servicesMap Map populated with service definitions.
 * @returns {Object} The mutated services map.
 */
export declare function collectScalasemApiEndpoints(report?: Object, servicesMap?: Object): Object;
/**
 * The npm packages a Scala.js build bundles. scalajs-bundler installs them
 * with a lock file under `target`, and a bundler workspace such as a Vite
 * client keeps its own manifest and lock file beside the build. Their npm
 * components join the BOM so the report's JavaScript module imports can be
 * attributed to them. Only lock files name the installed versions, and a
 * workspace counts only when its manifest uses Scala.js, so a documentation
 * site or a tool's own `package.json` adds nothing.
 *
 * @param {string} src Project directory.
 * @param {Object[]} pkgList Components the build tools reported.
 * @param {Object} [options] CLI options; `exclude` is honoured.
 * @returns {Promise<{components: Object[], roots: string[], dependencies: Object[]}>}
 *   Npm components, the bom-refs the workspaces depend on directly, and the
 *   lock files' dependency edges between the npm components.
 */
export declare function collectScalaJsNpmComponents(src: string, pkgList?: Object[], options?: Object): Promise<{
    components: Object[];
    roots: string[];
    dependencies: Object[];
}>;
//# sourceMappingURL=scalasem.d.ts.map