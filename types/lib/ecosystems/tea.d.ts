/**
 * Parse a Transparency Exchange Identifier (TEI) URN.
 *
 * Syntax: `urn:tei:<type>:<domain-name>:<unique-identifier>` where
 * `<domain-name>` is used for `/.well-known/tea` discovery.
 *
 * @param {string} tei TEI URN string
 * @returns {{type: string, domain: string, id: string}|null} Parsed parts
 */
export declare function parseTei(tei: string): {
    type: string;
    domain: string;
    id: string;
} | null;
/**
 * Compare two semver strings (major.minor.patch with optional prerelease).
 * Returns 1 when a > b, -1 when a < b, 0 when equal.
 *
 * @param {string} a Version string
 * @param {string} b Version string
 * @returns {number} Comparison result
 */
export declare function compareTeaVersions(a: string, b: string): number;
/**
 * Pick the endpoint and API version to use, per the discovery spec: the client
 * MUST pick the endpoint with the highest matching version supported by both
 * the client and the endpoint (SemVer comparison), preferring the highest
 * `priority` when several tie. Returns the best-effort selection.
 *
 * @param {Object[]} endpoints Endpoints from the `.well-known/tea` document
 * @param {string[]} [supported] Versions the client supports
 * @returns {{url: string, version: string}|null} Selected endpoint
 */
export declare function selectTeaEndpoint(endpoints: Object[], supported?: string[]): {
    url: string;
    version: string;
} | null;
/**
 * Discover TEA endpoints for a domain via `https://<domain>/.well-known/tea`.
 * The well-known document must conform to the TEA Well-Known schema, and is
 * requested without the TEA token.
 *
 * @param {string} domain Domain name from the TEI
 * @param {Object} [options] CLI options
 * @returns {Promise<Object|null>} Parsed well-known document
 */
export declare function discoverTeaEndpoints(domain: string, options?: Object): Promise<Object | null>;
/**
 * Resolve a TEI to a product release UUID and a selected TEA server.
 *
 * The TEA token goes only to the server the TEI's domain advertises in its
 * well-known document, returned as `tokenServerUrl`. A server that only the
 * discovery response names is used without the token unless it has the same
 * origin.
 *
 * @param {string} tei TEI URN string
 * @param {Object} [options] CLI options
 * @returns {Promise<{productReleaseUuid: string, server: {url: string, version: string}, tokenServerUrl: string}|null>}
 */
export declare function resolveTei(tei: string, options?: Object): Promise<{
    productReleaseUuid: string;
    server: {
        url: string;
        version: string;
    };
    tokenServerUrl: string;
} | null>;
/**
 * Fetch the latest TEA Collection for a product (or component) release.
 *
 * @param {Object} input Fetch inputs
 * @param {string} input.rootUrl TEA server root URL
 * @param {string} input.version TEA API version
 * @param {string} input.releaseUuid Product or component release UUID
 * @param {string} [input.scope] `productRelease` (default) or `componentRelease`
 * @param {Object} [input.options] CLI options
 * @param {string} [input.tokenServerUrl] Root URL of the TEA server that may
 *   receive the token. Defaults to `rootUrl`.
 * @returns {Promise<Object|null>} TEA Collection object
 */
export declare function fetchLatestCollection({ rootUrl, version, releaseUuid, scope, options, tokenServerUrl, }?: {
    rootUrl: string;
    version: string;
    releaseUuid: string;
    scope?: string;
    options?: Object;
    tokenServerUrl?: string;
}): Promise<Object | null>;
/**
 * Download the BOM artifacts of a TEA Collection and verify their checksums.
 * Only artifacts whose format is a CycloneDX or SPDX JSON media type are
 * downloaded; other formats (XML, signatures) are skipped. A checksum mismatch
 * rejects the artifact rather than merging untrusted content.
 *
 * The Collection names the artifact URLs, and they can point at any host, so
 * the TEA token goes only to an artifact on the same origin as the TEA server
 * that may receive it. Any other artifact is downloaded without it.
 *
 * @param {Object} collection TEA Collection object
 * @param {Object} [options] CLI options
 * @param {string} [serverUrl] Root URL of the TEA server that may receive the
 *   token. Without it no artifact request carries the token.
 * @returns {Promise<Array<{name: string, url: string, content: string, format: Object}>>}
 */
export declare function fetchBomArtifacts(collection: Object, options?: Object, serverUrl?: string): Promise<Array<{
    name: string;
    url: string;
    content: string;
    format: Object;
}>>;
/**
 * Build the POST /collection payload per the draft TEA publisher API.
 *
 * Collection versioning is owned by the server: the client publishes with a
 * reason (INITIAL_RELEASE for the first collection, ARTIFACT_UPDATED /
 * ARTIFACT_ADDED / VEX_UPDATED for updates) and the server increments the
 * collection `version` counter.
 *
 * @param {Object} input Payload inputs
 * @param {string} input.leafIdentifier UUID of the release/leaf this collection belongs to
 * @param {string} input.productName Product name
 * @param {string} input.productVersion Product version
 * @param {string} input.authorName Author name
 * @param {string} [input.authorEmail] Author email
 * @param {string} [input.reasonType] Collection update reason enum value
 * @param {string} [input.reasonComment] Free-text reason comment
 * @param {string} input.artifactName Artifact name
 * @param {string} input.artifactUrl Hosted URL of the BOM artifact
 * @param {string} input.artifactContent BOM content used for checksum/size
 * @param {string} [input.artifactMediaType] Media type of the BOM
 * @param {string} [input.artifactDescription] Description of the artifact
 * @returns {Object} Publish payload
 */
export declare function buildPublishCollectionPayload({ leafIdentifier, productName, productVersion, authorName, authorEmail, reasonType, reasonComment, artifactName, artifactUrl, artifactContent, artifactMediaType, artifactDescription, }: {
    leafIdentifier: string;
    productName: string;
    productVersion: string;
    authorName: string;
    authorEmail?: string;
    reasonType?: string;
    reasonComment?: string;
    artifactName: string;
    artifactUrl: string;
    artifactContent: string;
    artifactMediaType?: string;
    artifactDescription?: string;
}): Object;
/**
 * Publish a TEA Collection via the draft publisher API's POST /collection.
 *
 * A publish failure is reported as an error to the caller; it never deletes or
 * rewrites the locally written BOM. The caller decides the exit status.
 *
 * @param {string} serverUrl TEA server base URL (e.g. https://tea.example.com)
 * @param {Object} payload POST /collection payload
 * @param {Object} [options] CLI options
 * @returns {Promise<{status: number, body: Object}>} Server response
 */
export declare function publishTeaCollection(serverUrl: string, payload: Object, options?: Object): Promise<{
    status: number;
    body: Object;
}>;
/**
 * Merge fetched TEA SBOM documents into the generated BOM with the same rule
 * PEP 770 embedded SBOMs follow: an upstream document is a stronger assertion
 * than cdxgen's inference, so its components win on conflict and the conflict
 * is recorded by the property union rather than discarded. Returns the
 * components, dependencies, and citations; the caller merges them.
 *
 * @param {Object[]} artifacts Fetched artifacts (`{name, url, content}`)
 * @param {Object} [context] Merge context
 * @param {string} [context.collectionUuid] UUID of the TEA collection
 * @param {string} [context.attributedTo] bom-ref to attribute the fetched data to
 * @returns {{components: Object[], dependencies: Object[], citations: Object[]}}
 */
export declare function mergeTeaBom(artifacts: Object[], context?: {
    collectionUuid?: string;
    attributedTo?: string;
}): {
    components: Object[];
    dependencies: Object[];
    citations: Object[];
};
/**
 * Resolve a TEI, retrieve the latest Collection's BOM artifacts, and merge them
 * into a generated BOM in place.
 *
 * Retrieval is an enrichment, never a precondition: any failure is reported and
 * the locally generated BOM is left as it stands.
 *
 * @param {Object} bomNSData BOM namespace data (`bomJson`, `parentComponent`, `citations`)
 * @param {Object} options CLI options carrying `teaFetch` and credentials
 * @returns {Promise<Object>} The same `bomNSData`, enriched where possible
 */
export declare function applyTeaFetch(bomNSData: Object, options?: Object): Promise<Object>;
//# sourceMappingURL=tea.d.ts.map