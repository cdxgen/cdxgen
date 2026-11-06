/**
 * Frozen lookup tables for the CycloneDX 2.0 renderer and reader: schema enums,
 * the aggregate spelling table, the pinned 2.0 cryptography enums and the field
 * lists that say which 1.x members each converter carries. Every value is
 * quoted from the pinned draft schema
 * (data/cyclonedx-2.0-bundled.schema.json, CycloneDX/specification 2.0-dev at
 * ea8c3605829d1da13339a0790b6da73548e42a6b).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dirNameStr } from "../core/paths.js";

/**
 * Internal key that carries 2.0-only sections (risks, blueprints, threats,
 * controls, perspectives, profiles, declarations and definitions.parties)
 * through the 1.x-shaped model so a read-then-render round trip preserves
 * them. Never serialized: renderCycloneDx20 re-emits them and
 * applySpecVersionCompatibility strips the key for 1.x output.
 */
export const CDX20_INTERNAL_SECTIONS_KEY = "cdx20Sections";

/**
 * The formula property that names, as a JSON array of refIds, the
 * definitions components of a subject-less 2.0 document that belong to the
 * formula (2.0 has no formula member for them).
 */
export const FORMULA_COMPONENT_REFS_PROPERTY = "cdx:formulation:componentRefs";

/** refId of the cdxgen party declared in definitions.parties. */
export const CDXGEN_PARTY_REF_ID = "party-cdxgen";

/**
 * Message shown when a CycloneDX 2.0 document would be uploaded to
 * Dependency-Track, which ingests CycloneDX 1.x only.
 */
export const DEPENDENCY_TRACK_CDX20_ERROR =
  "Dependency-Track does not ingest the CycloneDX 2.0 draft, so a 2.0 document cannot be uploaded with --server-url. Generate with --spec-version 1.7 to upload to Dependency-Track.";

/** identityScheme enum (#/$defs/cyclonedx-component-2.0/$defs/identityScheme). */
export const IDENTITY_SCHEME_ENUM = new Set([
  "purl",
  "cpe",
  "swid",
  "swhid",
  "omniborid",
  "epc-rfid",
  "giai",
  "gln",
  "gmn",
  "gtin-8",
  "gtin-12",
  "gtin-13",
  "gtin-14",
  "mpn",
  "part-number",
  "model-number",
  "sku",
  "serial-number",
  "asset-tag",
  "udi-di",
  "udi-pi",
  "fcc-id",
  "imei",
  "mac-address",
  "tei",
]);

// identificationMethod
// (#/$defs/cyclonedx-evidence-2.0/$defs/identificationMethod) forbids these
// techniques for identity evidence; methods using them are dropped at 2.0.
export const FORBIDDEN_IDENTITY_TECHNIQUES = new Set([
  "signature",
  "reachability-analysis",
  "taint-analysis",
  "penetration-testing",
  "exploitation",
  "runtime-protection",
  "emulation",
  "pipeline-analysis",
  "infrastructure-as-code-analysis",
  "mobile-analysis",
]);

// analysisTechnique enum values; `other` (1.x) is gone and `unknown` was added.
export const ANALYSIS_TECHNIQUE_ENUM = new Set([
  "source-code-analysis",
  "binary-analysis",
  "dynamic-analysis",
  "instrumentation",
  "manifest-analysis",
  "ast-fingerprint",
  "content-match",
  "hash-comparison",
  "filename",
  "software-identifier",
  "signature",
  "reachability-analysis",
  "taint-analysis",
  "penetration-testing",
  "exploitation",
  "runtime-protection",
  "emulation",
  "pipeline-analysis",
  "infrastructure-as-code-analysis",
  "mobile-analysis",
  "visual-inspection",
  "x-ray-inspection",
  "electrical-testing",
  "material-analysis",
  "decapsulation",
  "manual-review",
  "attestation",
  "unknown",
]);

// aggregateType (#/$defs/cyclonedx-composition-2.0/$defs/aggregateType):
// 2.0 spells the incomplete qualifiers with hyphens where 1.x used
// underscores. An explicit, frozen table, never a regex.
export const AGGREGATE_1X_TO_20 = Object.freeze({
  complete: "complete",
  incomplete: "incomplete",
  incomplete_first_party_only: "incomplete-first-party-only",
  incomplete_first_party_proprietary_only:
    "incomplete-first-party-proprietary-only",
  incomplete_first_party_opensource_only:
    "incomplete-first-party-opensource-only",
  incomplete_third_party_only: "incomplete-third-party-only",
  incomplete_third_party_proprietary_only:
    "incomplete-third-party-proprietary-only",
  incomplete_third_party_opensource_only:
    "incomplete-third-party-opensource-only",
  unknown: "unknown",
  not_specified: "not-specified",
});

/** The inverse of AGGREGATE_1X_TO_20. */
export const AGGREGATE_20_TO_1X = Object.freeze(
  Object.fromEntries(
    Object.entries(AGGREGATE_1X_TO_20).map(([oneX, twoOh]) => [twoOh, oneX]),
  ),
);

// The pinned 2.0 cryptography defs
// (data/cyclonedx-2.0-cryptography-defs.schema.json, the
// ../cryptography-defs.schema.json the bundled schema references), read once.
// algorithmFamily
// (#/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties/properties/algorithmProperties/properties/algorithmFamily)
// and protocolProperties.type are closed enums there; unlike 1.x, the 2.0
// protocol enum has no `other`/`unknown`.
const CRYPTO_DEFS_20 = JSON.parse(
  readFileSync(
    join(dirNameStr, "data", "cyclonedx-2.0-cryptography-defs.schema.json"),
    "utf-8",
  ),
);

/** 2.0 algorithmFamily values (pinned 2.0 cryptography defs). */
export const ALGORITHM_FAMILY_ENUM = Object.freeze(
  new Set(CRYPTO_DEFS_20.definitions.algorithmFamiliesEnum.enum),
);

/** 2.0 protocolProperties.type values (pinned 2.0 cryptography defs). */
export const PROTOCOL_FAMILY_ENUM = Object.freeze(
  new Set(CRYPTO_DEFS_20.definitions.protocolFamiliesEnum.enum),
);

// componentData.type (#/$defs/cyclonedx-component-2.0/$defs/componentData).
export const COMPONENT_DATA_TYPE_ENUM = new Set([
  "source-code",
  "configuration",
  "dataset",
  "definition",
  "other",
]);

// dataClassification (#/$defs/cyclonedx-data-2.0/$defs/dataClassification):
// one of these values or a custom `{name}`. 1.x allowed any string.
export const DATA_CLASSIFICATION_ENUM = new Set([
  "confidential",
  "internal",
  "public",
  "restricted",
  "classified",
]);

// postalAddress (#/$defs/cyclonedx-party-2.0/$defs/postalAddress and
// #/$defs/cyclonedx-common-2.0/$defs/postalAddress) fields shared with 1.x.
export const POSTAL_ADDRESS_FIELDS = [
  "country",
  "region",
  "locality",
  "postOfficeBoxNumber",
  "postalCode",
  "streetAddress",
];

// Keys under which a component entry may be replaced by a componentReference
// (#/$defs/cyclonedx-component-2.0/$defs/componentEntry and the pedigree
// ancestor/descendant/variant items).
export const COMPONENT_ENTRY_ARRAY_KEYS = new Set([
  "components",
  "ancestors",
  "descendants",
  "variants",
]);

// licenseEvidence members besides license/expression that a 2.0 document read
// back into the internal model may carry.
export const LICENSE_EVIDENCE_DETAIL_FIELDS = [
  "refId",
  "confidence",
  "methods",
  "tools",
  "occurrences",
  "assertion",
  "timestamp",
];

/** 1.x componentData members the renderer handles. */
export const COMPONENT_DATA_FIELDS = new Set([
  "bom-ref",
  "type",
  "name",
  "contents",
  "classification",
  "sensitiveData",
  "graphics",
  "governance",
]);

// Component fields copied by name; `pedigree` and `licenses` are converted in
// place afterwards so the key order stays stable.
export const COMPONENT_COPY_FIELDS = [
  "type",
  "name",
  "version",
  "group",
  "description",
  "scope",
  "copyright",
  "hashes",
  "properties",
  "externalReferences",
  "tags",
  "pedigree",
  "versionRange",
  "isExternal",
  "patentAssertions",
  "endpoints",
  "releaseNotes",
  "certifications",
  "quantity",
];

/** 1.x component members the renderer handles; the rest are counted. */
export const COMPONENT_HANDLED_FIELDS = new Set([
  ...COMPONENT_COPY_FIELDS,
  "bom-ref",
  "purl",
  "cpe",
  "swid",
  "omniborId",
  "swhid",
  "author",
  "authors",
  "publisher",
  "supplier",
  "manufacturer",
  "licenses",
  "mimeType",
  "mime-type",
  "modelCard",
  "modelProperties",
  "evidence",
  "cryptoProperties",
  "data",
  "components",
  "services",
]);

// Service fields copied by name; `licenses` is converted in place afterwards.
export const SERVICE_COPY_FIELDS = [
  "name",
  "version",
  "group",
  "description",
  "endpoints",
  "licenses",
  "properties",
  "tags",
  "externalReferences",
  "releaseNotes",
  "patentAssertions",
];

/**
 * 1.x service members without a 2.0 field, carried at 2.0 as the documented
 * cdx:service:* properties (docs/CUSTOM_PROPERTIES.md) so the mcp-server
 * audit rules keep firing on a document read back from 2.0. Each entry is
 * [1.x field, property name, value kind]; the renderer appends them in this
 * order and the reader turns them back into the 1.x fields.
 */
export const CARRIED_SERVICE_PROPERTIES = Object.freeze([
  Object.freeze(["authenticated", "cdx:service:authenticated", "boolean"]),
  Object.freeze(["x-trust-boundary", "cdx:service:xTrustBoundary", "boolean"]),
  Object.freeze(["trustZone", "cdx:service:trustZone", "string"]),
]);

/** 1.x service members the renderer handles; the rest are counted. */
export const SERVICE_HANDLED_FIELDS = new Set([
  ...SERVICE_COPY_FIELDS,
  ...CARRIED_SERVICE_PROPERTIES.map(([field]) => field),
  "bom-ref",
  "provider",
  "data",
  "evidence",
  "services",
]);

// ---------------------------------------------------------------------------
// 1.x tables the reader checks 2.0 values against. They are quoted from
// data/bom-1.7.schema.json and data/cryptography-defs.schema.json (the
// newest 1.x the internal model follows); cyclonedx20Read.poku.js compares
// each one with the schema so they cannot drift.
// ---------------------------------------------------------------------------

const CRYPTO_DEFS_1X = JSON.parse(
  readFileSync(
    join(dirNameStr, "data", "cryptography-defs.schema.json"),
    "utf-8",
  ),
);

/** 1.x algorithmFamily values (cryptography-defs algorithmFamiliesEnum). */
export const ALGORITHM_FAMILY_1X = Object.freeze(
  new Set(CRYPTO_DEFS_1X.definitions.algorithmFamiliesEnum.enum),
);

/** 1.x ellipticCurve values (cryptography-defs ellipticCurvesEnum). */
export const ELLIPTIC_CURVE_1X = Object.freeze(
  new Set(CRYPTO_DEFS_1X.definitions.ellipticCurvesEnum.enum),
);

/** 1.7 externalReference.type values. */
export const EXTERNAL_REFERENCE_TYPES_1X = Object.freeze(
  new Set([
    "vcs",
    "issue-tracker",
    "website",
    "advisories",
    "bom",
    "mailing-list",
    "social",
    "chat",
    "documentation",
    "support",
    "source-distribution",
    "distribution",
    "distribution-intake",
    "license",
    "build-meta",
    "build-system",
    "release-notes",
    "security-contact",
    "model-card",
    "log",
    "configuration",
    "evidence",
    "formulation",
    "attestation",
    "threat-model",
    "adversary-model",
    "risk-assessment",
    "vulnerability-assertion",
    "exploitability-statement",
    "pentest-report",
    "static-analysis-report",
    "dynamic-analysis-report",
    "runtime-analysis-report",
    "component-analysis-report",
    "maturity-report",
    "certification-report",
    "codified-infrastructure",
    "quality-metrics",
    "poam",
    "electronic-signature",
    "digital-signature",
    "rfc-9116",
    "patent",
    "patent-family",
    "patent-assertion",
    "citation",
    "other",
  ]),
);

/** 1.7 component.type values. */
export const COMPONENT_TYPES_1X = Object.freeze(
  new Set([
    "application",
    "framework",
    "library",
    "container",
    "platform",
    "operating-system",
    "device",
    "device-driver",
    "firmware",
    "file",
    "machine-learning-model",
    "data",
    "cryptographic-asset",
  ]),
);

/** 1.7 componentIdentityEvidence.field values. */
export const IDENTITY_FIELDS_1X = Object.freeze(
  new Set([
    "group",
    "name",
    "version",
    "purl",
    "cpe",
    "omniborId",
    "swhid",
    "swid",
    "hash",
  ]),
);

/** 1.7 identity-evidence method techniques. */
export const IDENTITY_TECHNIQUES_1X = Object.freeze(
  new Set([
    "source-code-analysis",
    "binary-analysis",
    "manifest-analysis",
    "ast-fingerprint",
    "hash-comparison",
    "instrumentation",
    "dynamic-analysis",
    "filename",
    "attestation",
    "other",
  ]),
);

/** 1.7 vulnerability rating `method` values (scoreMethod). */
export const SCORE_METHODS_1X = Object.freeze(
  new Set(["CVSSv2", "CVSSv3", "CVSSv31", "CVSSv4", "OWASP", "SSVC", "other"]),
);

/**
 * 1.7 cryptoProperties algorithmProperties enums, by member name. Members
 * whose 2.0 value is a list in 1.7 too are checked entry by entry.
 */
export const ALGORITHM_PROPERTY_ENUMS_1X = Object.freeze({
  primitive: Object.freeze(
    new Set([
      "drbg",
      "mac",
      "block-cipher",
      "stream-cipher",
      "signature",
      "hash",
      "pke",
      "xof",
      "kdf",
      "key-agree",
      "kem",
      "ae",
      "combiner",
      "key-wrap",
      "other",
      "unknown",
    ]),
  ),
  executionEnvironment: Object.freeze(
    new Set([
      "software-plain-ram",
      "software-encrypted-ram",
      "software-tee",
      "hardware",
      "other",
      "unknown",
    ]),
  ),
  implementationPlatform: Object.freeze(
    new Set([
      "generic",
      "x86_32",
      "x86_64",
      "armv7-a",
      "armv7-m",
      "armv8-a",
      "armv8-m",
      "armv9-a",
      "armv9-m",
      "s390x",
      "ppc64",
      "ppc64le",
      "other",
      "unknown",
    ]),
  ),
  mode: Object.freeze(
    new Set([
      "cbc",
      "ecb",
      "ccm",
      "gcm",
      "cfb",
      "ofb",
      "ctr",
      "other",
      "unknown",
    ]),
  ),
  padding: Object.freeze(
    new Set(["pkcs5", "pkcs7", "pkcs1v15", "oaep", "raw", "other", "unknown"]),
  ),
  cryptoFunctions: Object.freeze(
    new Set([
      "generate",
      "keygen",
      "encrypt",
      "decrypt",
      "digest",
      "tag",
      "keyderive",
      "sign",
      "verify",
      "encapsulate",
      "decapsulate",
      "other",
      "unknown",
    ]),
  ),
});

/** 1.7 protocolProperties.type values. */
export const PROTOCOL_TYPES_1X = Object.freeze(
  new Set([
    "tls",
    "ssh",
    "ipsec",
    "ike",
    "sstp",
    "wpa",
    "dtls",
    "quic",
    "eap-aka",
    "eap-aka-prime",
    "prins",
    "5g-aka",
    "other",
    "unknown",
  ]),
);

/**
 * Party roles (#/$defs/cyclonedx-party-2.0/$defs/preDefinedRole) the 1.x
 * component and service fields can hold, with the 1.x field.
 */
export const PARTY_ROLE_FIELDS_1X = Object.freeze({
  supplier: "supplier",
  manufacturer: "manufacturer",
  author: "authors",
  publisher: "publisher",
  provider: "provider",
});

/**
 * Identity schemes (#/$defs/cyclonedx-component-2.0/$defs/identityScheme) the
 * 1.x identifier fields hold, with the 1.x field. `omniborid` and `swhid` are
 * lists in 1.x; the others hold one value.
 */
export const IDENTITY_SCHEME_FIELDS_1X = Object.freeze({
  purl: "purl",
  cpe: "cpe",
  swid: "swid",
  omniborid: "omniborId",
  swhid: "swhid",
});

/** 2.0 identity-evidence scheme → 1.x field, for the predefined schemes. */
export const IDENTITY_EVIDENCE_SCHEME_TO_FIELD = Object.freeze({
  purl: "purl",
  cpe: "cpe",
  swid: "swid",
  swhid: "swhid",
  omniborid: "omniborId",
});
