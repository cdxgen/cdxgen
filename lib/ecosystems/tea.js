// OWASP Transparency Exchange API (TEA) client — ECMA TC54 TG1.
//
// Two surfaces exist in the spec repository:
//   - The **consumer** API (spec/openapi.yaml, spec version 0.4.0, "Beta 2")
//     is the conformance base: discovery via `/.well-known/tea`, TEI
//     resolution, and retrieval of Collections and Artifacts.
//   - The **publisher** API (spec/publisher/openapi.json, "This specification
//     will be a recommended TEA publisher API") is a draft recommendation,
//     NOT part of the conformance spec. `publishTeaCollection` targets that
//     draft's POST /collection shape (snake_case fields) and is subject to
//     change until the publisher API is standardised.
//
// References: https://github.com/CycloneDX/transparency-exchange-api

import { createHash } from "node:crypto";

import { cdxgenAgent, readEnvironmentVariable } from "../core/activity.js";
import {
  createCitation,
  findCdxgenToolBomRef,
} from "../inventory/citations.js";
import { mergeDependencies, trimComponents } from "../inventory/depsUtils.js";
import {
  chargeSbomElementBudgets,
  createSbomElementBudget,
  MAX_SBOM_DOCUMENT_BYTES,
  parseSbomDocument,
  tagSbomComponents,
} from "../inventory/sbomDocument.js";

// The TEA API version this client implements, per spec/openapi.yaml.
const SUPPORTED_TEA_VERSIONS = ["0.4.0"];

const TEI_PATTERN = /^urn:tei:([a-z0-9]+):([^:]+):(.+)$/i;

/**
 * Parse a Transparency Exchange Identifier (TEI) URN.
 *
 * Syntax: `urn:tei:<type>:<domain-name>:<unique-identifier>` where
 * `<domain-name>` is used for `/.well-known/tea` discovery.
 *
 * @param {string} tei TEI URN string
 * @returns {{type: string, domain: string, id: string}|null} Parsed parts
 */
export function parseTei(tei) {
  const match = TEI_PATTERN.exec(String(tei || "").trim());
  if (!match) {
    return null;
  }
  return { type: match[1], domain: match[2], id: match[3] };
}

/**
 * Compare two semver strings (major.minor.patch with optional prerelease).
 * Returns 1 when a > b, -1 when a < b, 0 when equal.
 *
 * @param {string} a Version string
 * @param {string} b Version string
 * @returns {number} Comparison result
 */
export function compareTeaVersions(a, b) {
  const parse = (value) => {
    const [core, prerelease] = String(value).split("-", 2);
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return { parts, prerelease };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left.parts[index] || 0;
    const rightPart = right.parts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  // A release beats a prerelease at the same core version.
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease) {
    return 1;
  }
  if (!right.prerelease) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease);
}

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
export function selectTeaEndpoint(
  endpoints,
  supported = SUPPORTED_TEA_VERSIONS,
) {
  if (!Array.isArray(endpoints) || !endpoints.length) {
    return null;
  }
  const candidates = [];
  for (const endpoint of endpoints) {
    const url = String(endpoint?.url || endpoint?.rootUrl || "").trim();
    if (!url) {
      continue;
    }
    const versions = Array.isArray(endpoint?.versions) ? endpoint.versions : [];
    // Highest common version; fall back to the endpoint's highest version so a
    // server that has moved ahead of the client still works best-effort.
    let version;
    for (const candidate of supported) {
      const match = versions.find(
        (v) => compareTeaVersions(v, candidate) === 0,
      );
      if (match) {
        version = match;
        break;
      }
    }
    if (!version && versions.length) {
      version = versions.reduce((best, v) =>
        compareTeaVersions(v, best) > 0 ? v : best,
      );
    }
    if (version) {
      candidates.push({
        url,
        version,
        priority: Number(endpoint?.priority) || 0,
      });
    }
  }
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return compareTeaVersions(b.version, a.version);
  });
  return candidates[0] || null;
}

function teaRequestHeaders(options = {}) {
  // Credentials are supplied via --tea-token / TEA_TOKEN and are sent only as
  // an Authorization header. They are never logged and never reach the BOM.
  const token =
    options?.teaToken || readEnvironmentVariable("TEA_TOKEN") || undefined;
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return { headers, token };
}

async function teaJsonGet(url, options = {}) {
  const { headers, token } = teaRequestHeaders(options);
  const response = await cdxgenAgent(url, {
    method: "GET",
    headers,
    responseType: "json",
    throwHttpErrors: true,
    context: {
      activityIntent: "tea-fetch",
      ...(token ? { credentialPresent: true } : {}),
    },
  });
  return response.body ?? response;
}

/**
 * Discover TEA endpoints for a domain via `https://<domain>/.well-known/tea`.
 * The well-known document must conform to the TEA Well-Known schema.
 *
 * @param {string} domain Domain name from the TEI
 * @param {Object} [options] CLI options
 * @returns {Promise<Object|null>} Parsed well-known document
 */
export async function discoverTeaEndpoints(domain, options = {}) {
  const wellKnownUrl = `https://${domain}/.well-known/tea`;
  const doc = await teaJsonGet(wellKnownUrl, options);
  if (!doc || !Array.isArray(doc.endpoints)) {
    return null;
  }
  return doc;
}

/**
 * Resolve a TEI to a product release UUID and a selected TEA server.
 *
 * @param {string} tei TEI URN string
 * @param {Object} [options] CLI options
 * @returns {Promise<{productReleaseUuid: string, server: {url: string, version: string}}|null>}
 */
export async function resolveTei(tei, options = {}) {
  const parsed = parseTei(tei);
  if (!parsed) {
    return null;
  }
  const wellKnown = await discoverTeaEndpoints(parsed.domain, options);
  if (!wellKnown) {
    return null;
  }
  // Servers listed by the discovery endpoint override well-known endpoints.
  let server = selectTeaEndpoint(wellKnown.endpoints, SUPPORTED_TEA_VERSIONS);
  if (!server) {
    console.warn(
      `cdxgen: no usable TEA endpoint advertised by ${parsed.domain}.`,
    );
    return null;
  }
  const discoveryUrl = `${server.url}/v${server.version}/discovery?tei=${encodeURIComponent(tei)}`;
  const discovery = await teaJsonGet(discoveryUrl, options);
  if (!discovery?.productReleaseUuid) {
    return null;
  }
  if (Array.isArray(discovery.servers) && discovery.servers.length) {
    const preferred = selectTeaEndpoint(
      discovery.servers.map((entry) => ({
        url: entry.rootUrl,
        versions: entry.versions,
        priority: entry.priority,
      })),
      SUPPORTED_TEA_VERSIONS,
    );
    if (preferred) {
      server = preferred;
    }
  }
  return {
    productReleaseUuid: discovery.productReleaseUuid,
    server,
  };
}

/**
 * Fetch the latest TEA Collection for a product (or component) release.
 *
 * @param {Object} input Fetch inputs
 * @param {string} input.rootUrl TEA server root URL
 * @param {string} input.version TEA API version
 * @param {string} input.releaseUuid Product or component release UUID
 * @param {string} [input.scope] `productRelease` (default) or `componentRelease`
 * @param {Object} [input.options] CLI options
 * @returns {Promise<Object|null>} TEA Collection object
 */
export async function fetchLatestCollection({
  rootUrl,
  version,
  releaseUuid,
  scope = "productRelease",
  options = {},
} = {}) {
  const url = `${rootUrl}/v${version}/${scope}/${releaseUuid}/collection/latest`;
  return teaJsonGet(url, options);
}

function normalizeChecksumType(algType) {
  const normalized = String(algType || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const mapping = {
    SHA256: "sha256",
    SHA384: "sha384",
    SHA512: "sha512",
    SHA224: "sha224",
    SHA1: "sha1",
    MD5: "md5",
    BLAKE2B512: "blake2b512",
    BLAKE2S256: "blake2s256",
  };
  return mapping[normalized];
}

function computeChecksum(content, algType) {
  const algorithm = normalizeChecksumType(algType);
  if (!algorithm) {
    return undefined;
  }
  return createHash(algorithm).update(content).digest("hex");
}

/**
 * Check downloaded content against the checksums a Collection declares for it.
 *
 * Every checksum whose algorithm this client can compute must match. When the
 * artifact declares checksums but none of them uses an algorithm we support,
 * the content is rejected: accepting it would mean merging remote data whose
 * integrity was asserted and then not checked, which is worse than fetching
 * nothing. An artifact that declares no checksums at all is a publisher
 * decision, and is accepted with a warning.
 *
 * @param {string} content Downloaded artifact content
 * @param {Object[]} checksums Checksum entries (`{algType, algValue}`)
 * @param {string} source URL used in warnings
 * @returns {boolean} true when the content may be used
 */
function checksumsVerified(content, checksums, source) {
  const declared = Array.isArray(checksums) ? checksums : [];
  if (!declared.length) {
    console.warn(
      `cdxgen: TEA artifact ${source} declares no checksum; merging unverified content.`,
    );
    return true;
  }
  let verifiedAny = false;
  for (const checksum of declared) {
    const computed = computeChecksum(content, checksum?.algType);
    if (!computed) {
      continue;
    }
    const expected = String(checksum?.algValue || "")
      .trim()
      .toLowerCase();
    if (!expected) {
      continue;
    }
    if (computed !== expected) {
      console.warn(
        `cdxgen: TEA artifact ${source} failed its ${checksum.algType} checksum; skipping.`,
      );
      return false;
    }
    verifiedAny = true;
  }
  if (!verifiedAny) {
    console.warn(
      `cdxgen: TEA artifact ${source} declares only checksum algorithms this client cannot compute; skipping.`,
    );
  }
  return verifiedAny;
}

// The most BOM documents requested for one Collection, and the most
// components and dependencies merged from them. The Collection is supplied by
// the TEA server and may list any number of artifacts, while every fetched
// document is held in memory until the merge. A release lists a handful.
const MAX_TEA_BOM_DOWNLOADS = 32;
const MAX_TEA_ELEMENTS = 100000;

/**
 * Download the BOM artifacts of a TEA Collection and verify their checksums.
 * Only artifacts whose format is a CycloneDX or SPDX JSON media type are
 * downloaded; other formats (XML, signatures) are skipped. A checksum mismatch
 * rejects the artifact rather than merging untrusted content.
 *
 * @param {Object} collection TEA Collection object
 * @param {Object} [options] CLI options
 * @returns {Promise<Array<{name: string, url: string, content: string, format: Object}>>}
 */
export async function fetchBomArtifacts(collection, options = {}) {
  const artifacts = [];
  const requestedUrls = new Set();
  for (const artifact of Array.isArray(collection?.artifacts)
    ? collection.artifacts
    : []) {
    if (String(artifact?.type || "").toUpperCase() !== "BOM") {
      continue;
    }
    for (const format of Array.isArray(artifact?.formats)
      ? artifact.formats
      : []) {
      const mediaType = String(format?.mediaType || "").toLowerCase();
      const isJsonBom =
        (mediaType.includes("cyclonedx") && mediaType.includes("json")) ||
        (mediaType.includes("spdx") && mediaType.includes("json")) ||
        mediaType === "application/json";
      if (!isJsonBom || !format?.url) {
        continue;
      }
      // The fragment is not sent, so it does not make a URL a new request.
      const requestKey = String(format.url).split("#", 1)[0];
      if (requestedUrls.has(requestKey)) {
        continue;
      }
      if (requestedUrls.size >= MAX_TEA_BOM_DOWNLOADS) {
        console.warn(
          `cdxgen: TEA collection lists more than ${MAX_TEA_BOM_DOWNLOADS} BOM documents; skipping the rest.`,
        );
        return artifacts;
      }
      requestedUrls.add(requestKey);
      const { headers } = teaRequestHeaders(options);
      const response = await cdxgenAgent(format.url, {
        method: "GET",
        headers,
        responseType: "text",
        context: { activityIntent: "tea-fetch" },
      });
      const content = response.body ?? response;
      if (
        typeof content !== "string" ||
        Buffer.byteLength(content) > MAX_SBOM_DOCUMENT_BYTES
      ) {
        console.warn(
          `cdxgen: TEA artifact ${format.url} is not usable text within ${MAX_SBOM_DOCUMENT_BYTES} bytes; skipping.`,
        );
        continue;
      }
      if (!checksumsVerified(content, format.checksums, format.url)) {
        continue;
      }
      artifacts.push({ name: artifact.name, url: format.url, content, format });
      break; // one JSON format per artifact is enough
    }
  }
  return artifacts;
}

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
export function buildPublishCollectionPayload({
  leafIdentifier,
  productName,
  productVersion,
  authorName,
  authorEmail,
  reasonType = "INITIAL_RELEASE",
  reasonComment,
  artifactName,
  artifactUrl,
  artifactContent,
  artifactMediaType = "application/vnd.cyclonedx+json",
  artifactDescription,
}) {
  const checksumType = "SHA256";
  return {
    tea_leaf_identifier: leafIdentifier,
    product_name: productName,
    product_version: productVersion,
    release_date: new Date().toISOString(),
    author: {
      name: authorName,
      ...(authorEmail ? { email: authorEmail } : {}),
    },
    reason: {
      type: reasonType,
      ...(reasonComment ? { comment: reasonComment } : {}),
    },
    artifacts: [
      {
        name: artifactName,
        type: "BOM",
        author: { name: authorName },
        objects: [
          {
            description: artifactDescription || `${artifactName} SBOM`,
            media_type: artifactMediaType,
            artifact_url: artifactUrl,
            artifact_size_in_bytes: Buffer.byteLength(artifactContent),
            artifact_checksum: computeChecksum(artifactContent, checksumType),
            artifact_checksum_type: checksumType,
          },
        ],
      },
    ],
  };
}

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
export async function publishTeaCollection(serverUrl, payload, options = {}) {
  const { headers, token } = teaRequestHeaders(options);
  const response = await cdxgenAgent(`${serverUrl}/collection`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    json: payload,
    responseType: "json",
    throwHttpErrors: true,
    context: {
      activityIntent: "tea-publish",
      ...(token ? { credentialPresent: true } : {}),
    },
  });
  return {
    status: response.statusCode || 201,
    body: response.body ?? response,
  };
}

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
export function mergeTeaBom(artifacts, context = {}) {
  const components = [];
  const dependencies = [];
  const citations = [];
  const budgets = [
    createSbomElementBudget(MAX_TEA_ELEMENTS, "from one TEA collection"),
  ];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const source = artifact?.url || artifact?.name || "unknown";
    const parsed = parseSbomDocument(artifact?.content, { source });
    if (!parsed) {
      continue;
    }
    if (!chargeSbomElementBudgets(parsed, budgets, source)) {
      continue;
    }
    tagSbomComponents(parsed.components, [
      { name: "cdx:tea:source", value: source },
      { name: "cdx:tea:collection", value: context.collectionUuid },
    ]);
    // Appended one by one: spreading a long list into push() overflows the
    // call stack.
    for (const component of parsed.components) {
      components.push(component);
    }
    for (const dependency of parsed.dependencies) {
      dependencies.push(dependency);
    }
    // Attribution needs a bom-ref that exists in the BOM. The TEA server is not
    // a BOM object, so the claim is attributed to the cdxgen tool component that
    // performed the retrieval; with no such ref the citation is dropped rather
    // than pointed at something invented.
    const citation = createCitation({
      expressions: [
        `$.components[?(@.properties[?(@.name == 'cdx:tea:source' && @.value == '${source.replace(/'/g, "")}')])]`,
      ],
      attributedTo: context.attributedTo,
      note: `Components retrieved over the Transparency Exchange API from ${source} (collection ${context.collectionUuid || "unknown"}).`,
    });
    if (citation) {
      citations.push(citation);
    }
  }
  return { components, dependencies, citations };
}

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
export async function applyTeaFetch(bomNSData, options = {}) {
  const bomJson = bomNSData?.bomJson;
  if (!options?.teaFetch || !bomJson) {
    return bomNSData;
  }
  try {
    const resolved = await resolveTei(options.teaFetch, options);
    if (!resolved) {
      console.warn(
        `cdxgen: TEA fetch could not resolve ${options.teaFetch}. Continuing with the locally generated BOM.`,
      );
      return bomNSData;
    }
    const collection = await fetchLatestCollection({
      rootUrl: resolved.server.url,
      version: resolved.server.version,
      releaseUuid: resolved.productReleaseUuid,
      options,
    });
    if (!collection) {
      return bomNSData;
    }
    const artifacts = await fetchBomArtifacts(collection, options);
    const merged = mergeTeaBom(artifacts, {
      collectionUuid: collection.uuid,
      attributedTo: findCdxgenToolBomRef(bomJson),
    });
    if (merged.components.length) {
      // Upstream components are placed first so the dedupe keeps them when they
      // collide with an inferred component.
      bomJson.components = trimComponents([
        ...merged.components,
        ...(bomJson.components || []),
      ]);
    }
    if (merged.dependencies.length) {
      bomJson.dependencies = mergeDependencies(
        bomJson.dependencies || [],
        merged.dependencies,
        bomNSData.parentComponent,
      );
    }
    if (merged.citations.length) {
      bomNSData.citations = [
        ...(bomNSData.citations || []),
        ...merged.citations,
      ];
    }
  } catch (err) {
    console.error(
      `cdxgen: TEA fetch failed: ${err?.message || err}. Continuing with the locally generated BOM.`,
    );
  }
  return bomNSData;
}
