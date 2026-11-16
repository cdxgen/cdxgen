/**
 * Determine whether a project language is a Go variant that should trigger golem analysis.
 *
 * @param {string} language Project language identifier.
 * @returns {boolean} True when the language maps to a Go variant.
 */
export declare function isGolemGoLanguage(language: string): boolean;
/**
 * Read and parse a golem analysis JSON report file.
 *
 * @param {string} jsonFile Path to the golem JSON report.
 * @returns {object|undefined} Parsed report object, or undefined when the file
 *   is missing, cannot be parsed, or holds something other than a JSON object
 *   such as `null`.
 */
export declare function readGolemJsonFile(jsonFile: string): object | undefined;
/**
 * The environment the golem child runs in.
 *
 * By default the analysis must not let the analysed repository drive the host
 * C compiler: a package's `#cgo` directives, `.syso` files and pkg-config
 * lines choose the compiler's flags, and on a Go toolchain older than
 * go1.26.11 / go1.27.4 that is command execution on the scanning host. The
 * environment pins CGO_ENABLED=0, which every golem release honours, and
 * drops the CGO_*_ALLOW variables because each of them re-opens what the
 * patched toolchain refuses for every package in the build. With
 * `options.golemCgo` the analyst asked for the compiled view, so the
 * environment states CGO_ENABLED=1 instead and the rest is inherited.
 *
 * @param {object} [options={}] Evinse options.
 * @returns {object} The child process environment for the golem invocation.
 */
export declare function golemSpawnEnv(options?: object): object;
/**
 * Invoke the golem analyzer binary over a source directory to produce a JSON report.
 *
 * Assembles the analyze invocation (callgraph mode, data-flow mode, patterns,
 * tags, tests, stdlib flags) from the options and writes the result to
 * `outputFile`.
 *
 * @param {string} src Source directory to analyze.
 * @param {string} outputFile Destination path for the JSON report.
 * @param {object} [options={}] Options controlling golem behavior.
 * @returns {boolean} True when the analysis succeeded and the report was written.
 */
export declare function runGolemAnalysis(src: string, outputFile: string, options?: object): boolean;
/**
 * Orchestrate a full golem run: execute the analyzer, read the report, and clean up.
 *
 * When `options.semanticsSlicesFile` is set the report is persisted there;
 * otherwise it is written to a temporary directory that is removed after parsing.
 *
 * @param {string} src Source directory to analyze.
 * @param {object} [options={}] Options forwarded to {@link runGolemAnalysis}.
 * @returns {object|undefined} Parsed golem report, or undefined on failure.
 */
export declare function analyzeGolemProject(src: string, options?: object): object | undefined;
/**
 * Project a golem report into CycloneDX component evidence, properties, and crypto assets.
 *
 * Aggregates import/usage/call-graph/data-flow evidence and crypto signals from
 * the report, attaching per-component properties and occurrence evidence while
 * collecting any derived cryptographic-asset components.
 *
 * @param {object} [golemReport={}] Parsed golem analysis report.
 * @param {Array<object>} [components=[]] Existing BOM components to match against.
 * @returns {{componentPropertiesMap: Object<string, Array<object>>, cryptoComponents: Array<object>, cryptoGeneratePurls: Object<string, boolean>, dataFlowFrames: Object<string, Array>, metadataProperties: Array<object>, purlLocationMap: Object<string, Array>}}
 *   Projected evidence maps and crypto components.
 */
export declare function collectGolemEvidence(golemReport?: object, components?: Array<object>): {
    componentPropertiesMap: Record<string, object[]>;
    cryptoComponents: Array<object>;
    cryptoGeneratePurls: Record<string, boolean>;
    dataFlowFrames: Record<string, any[]>;
    metadataProperties: Array<object>;
    purlLocationMap: Record<string, any[]>;
};
/**
 * Normalise a Go route path to the placeholder spelling OpenAPI — and
 * therefore the rest of the services a BOM carries — uses. gin, echo and
 * fiber write `:id`, gin writes `*filepath`, chi and gorilla/mux write `{id}`
 * or `{id:[0-9]+}`, and Go 1.22's net/http patterns write `{id...}`; all
 * become `{id}`. Braces are matched by depth, so a regular expression with
 * its own braces or slashes (`{code:[0-9]{3}}`, `{rest:[a-z/]+}`) stays one
 * variable. A fiber constraint or optional marker (`:id<int>`, `:name?`) is
 * dropped, and net/http's `{$}` is removed. A `:` or `*` placeholder is only
 * recognised at the start of a segment — or, for fiber, after a `-` or `.` —
 * so a literal colon such as `/time/09:30` is left alone. Values that do not
 * start with `/` are returned as they are, and so is echo's catch-all, whose
 * bare `*` names no placeholder.
 *
 * @param {string} routePath Path a golem endpoint reports
 * @param {string} [framework] Framework the route was registered with
 * @returns {string} The normalised path
 */
export declare function normalizeGolemRoutePath(routePath: string, framework?: string): string;
/**
 * Split a route golem reports into the `[METHOD ][HOST]/PATH` parts of a Go
 * 1.22 net/http ServeMux pattern. golem puts a `/` in front of the pattern it
 * read, so `GET /items/{id}` arrives as `/GET /items/{id}` and
 * `GET example.com/items` as `/GET example.com/items`. A method followed by a
 * space or tab is split off, and so is a host between the method and the
 * path. Without a method, only a value that starts with `/` is a route: the
 * `:8080` a listener reports and the `GET` that a gorilla/mux
 * `.Methods("GET")` call leaves behind are not, and give undefined. A host
 * pattern without a method reaches golem's report as a plain path
 * (`/example.com/items`) and stays one.
 *
 * @param {string} routePath Path a golem endpoint reports
 * @returns {{method: (string|undefined), host: (string|undefined), path: string}|undefined}
 *   The parts, or undefined when the value is not a route
 */
export declare function parseGolemRoutePattern(routePath: string): {
    method: (string | undefined);
    host: (string | undefined);
    path: string;
} | undefined;
/**
 * Reduce an outbound URL golem reports to what is safe to keep in a BOM:
 * scheme, host and path, without userinfo, query, fragment or `;name=value`
 * path parameters such as `;jsessionid=` and `;token=`. Webhook and bot URLs
 * that authenticate by their path — Slack, Discord, Teams, Zapier, IFTTT,
 * Telegram — keep only their route (`https://hooks.slack.com/services`), and a
 * path segment holding a token shape the BOM sanitizer recognises ends the
 * path there. Undefined when the value is not a URL with a host.
 *
 * @param {string} value URL golem reports
 * @returns {string|undefined} The sanitised URL
 */
export declare function sanitizeGolemEndpointUrl(value: string): string | undefined;
/**
 * Project the services and API endpoints of a golem report into evinse's
 * service map, so a Go `evinse`/`saasbom` run lists its services the way the
 * kosi (Kotlin) and dosai (.NET) collectors already do (#4498).
 *
 * golem rolls one service up per server it saw — a `gin` engine, a net/http
 * listener on `:8080` — and lists the routes registered on it, each with its
 * HTTP method and framework. Route paths are normalised to OpenAPI
 * placeholders and Go 1.22 ServeMux patterns are split into method, host and
 * path; entries that are not routes are skipped. It also rolls the outbound
 * hosts the source calls into services of `kind: "external"`; those carry
 * `x-trust-boundary: true`, since a host the application calls sits outside
 * its own trust boundary, and their URLs are sanitised before they become
 * endpoints. Every endpoint is percent-encoded to an RFC 3986 reference. The
 * map is keyed by the golem service id, which is unique per server, while
 * `name` carries the display name.
 *
 * HTTP methods are lower-cased to match the property values the OpenAPI flow
 * emits, so a consumer grouping by `cdx:service:httpMethod` sees one value
 * per method.
 *
 * @param {object|null} [golemReport={}] Parsed golem analysis report.
 * @param {Object} [servicesMap={}] Service map to populate.
 * @returns {Object} The service map
 */
export declare function collectGolemServices(golemReport?: object | null, servicesMap?: Object): Object;
//# sourceMappingURL=golem.d.ts.map