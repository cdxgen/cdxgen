/**
 * Frozen lookup tables for the CycloneDX 2.0 renderer and reader: schema enums,
 * the aggregate spelling table, the pinned 2.0 cryptography enums and the field
 * lists that say which 1.x members each converter carries. Every value is
 * quoted from the pinned draft schema
 * (data/cyclonedx-2.0-bundled.schema.json, CycloneDX/specification 2.0-dev at
 * ea8c3605829d1da13339a0790b6da73548e42a6b).
 */
/**
 * Internal key that carries 2.0-only sections (risks, blueprints, threats,
 * controls, perspectives, profiles, declarations and definitions.parties)
 * through the 1.x-shaped model so a read-then-render round trip preserves
 * them. Never serialized: renderCycloneDx20 re-emits them and
 * applySpecVersionCompatibility strips the key for 1.x output.
 */
export declare const CDX20_INTERNAL_SECTIONS_KEY = "cdx20Sections";
/** refId of the cdxgen party declared in definitions.parties. */
export declare const CDXGEN_PARTY_REF_ID = "party-cdxgen";
/**
 * Message shown when a CycloneDX 2.0 document would be uploaded to
 * Dependency-Track, which ingests CycloneDX 1.x only.
 */
export declare const DEPENDENCY_TRACK_CDX20_ERROR = "Dependency-Track does not ingest the CycloneDX 2.0 draft, so a 2.0 document cannot be uploaded with --server-url. Generate with --spec-version 1.7 to upload to Dependency-Track.";
/** identityScheme enum (#/$defs/cyclonedx-component-2.0/$defs/identityScheme). */
export declare const IDENTITY_SCHEME_ENUM: Set<string>;
export declare const FORBIDDEN_IDENTITY_TECHNIQUES: Set<string>;
export declare const ANALYSIS_TECHNIQUE_ENUM: Set<string>;
export declare const AGGREGATE_1X_TO_20: Readonly<{
    complete: "complete";
    incomplete: "incomplete";
    incomplete_first_party_only: "incomplete-first-party-only";
    incomplete_first_party_proprietary_only: "incomplete-first-party-proprietary-only";
    incomplete_first_party_opensource_only: "incomplete-first-party-opensource-only";
    incomplete_third_party_only: "incomplete-third-party-only";
    incomplete_third_party_proprietary_only: "incomplete-third-party-proprietary-only";
    incomplete_third_party_opensource_only: "incomplete-third-party-opensource-only";
    unknown: "unknown";
    not_specified: "not-specified";
}>;
/** The inverse of AGGREGATE_1X_TO_20. */
export declare const AGGREGATE_20_TO_1X: Readonly<{
    [k: string]: string;
}>;
/** 2.0 algorithmFamily values (pinned 2.0 cryptography defs). */
export declare const ALGORITHM_FAMILY_ENUM: Readonly<Set<any>>;
/** 2.0 protocolProperties.type values (pinned 2.0 cryptography defs). */
export declare const PROTOCOL_FAMILY_ENUM: Readonly<Set<any>>;
export declare const COMPONENT_DATA_TYPE_ENUM: Set<string>;
export declare const DATA_CLASSIFICATION_ENUM: Set<string>;
export declare const POSTAL_ADDRESS_FIELDS: string[];
export declare const COMPONENT_ENTRY_ARRAY_KEYS: Set<string>;
export declare const LICENSE_EVIDENCE_DETAIL_FIELDS: string[];
/** 1.x componentData members the renderer handles. */
export declare const COMPONENT_DATA_FIELDS: Set<string>;
export declare const COMPONENT_COPY_FIELDS: string[];
/** 1.x component members the renderer handles; the rest are counted. */
export declare const COMPONENT_HANDLED_FIELDS: Set<string>;
export declare const SERVICE_COPY_FIELDS: string[];
/**
 * 1.x service members without a 2.0 field, carried at 2.0 as the documented
 * cdx:service:* properties (docs/CUSTOM_PROPERTIES.md) so the mcp-server
 * audit rules keep firing on a document read back from 2.0. Each entry is
 * [1.x field, property name, value kind]; the renderer appends them in this
 * order and the reader turns them back into the 1.x fields.
 */
export declare const CARRIED_SERVICE_PROPERTIES: readonly (readonly string[])[];
/** 1.x service members the renderer handles; the rest are counted. */
export declare const SERVICE_HANDLED_FIELDS: Set<string>;
/** 1.x algorithmFamily values (cryptography-defs algorithmFamiliesEnum). */
export declare const ALGORITHM_FAMILY_1X: Readonly<Set<any>>;
/** 1.x ellipticCurve values (cryptography-defs ellipticCurvesEnum). */
export declare const ELLIPTIC_CURVE_1X: Readonly<Set<any>>;
/** 1.7 externalReference.type values. */
export declare const EXTERNAL_REFERENCE_TYPES_1X: Readonly<Set<string>>;
/** 1.7 component.type values. */
export declare const COMPONENT_TYPES_1X: Readonly<Set<string>>;
/** 1.7 componentIdentityEvidence.field values. */
export declare const IDENTITY_FIELDS_1X: Readonly<Set<string>>;
/** 1.7 identity-evidence method techniques. */
export declare const IDENTITY_TECHNIQUES_1X: Readonly<Set<string>>;
/** 1.7 vulnerability rating `method` values (scoreMethod). */
export declare const SCORE_METHODS_1X: Readonly<Set<string>>;
/**
 * 1.7 cryptoProperties algorithmProperties enums, by member name. Members
 * whose 2.0 value is a list in 1.7 too are checked entry by entry.
 */
export declare const ALGORITHM_PROPERTY_ENUMS_1X: Readonly<{
    primitive: Readonly<Set<string>>;
    executionEnvironment: Readonly<Set<string>>;
    implementationPlatform: Readonly<Set<string>>;
    mode: Readonly<Set<string>>;
    padding: Readonly<Set<string>>;
    cryptoFunctions: Readonly<Set<string>>;
}>;
/** 1.7 protocolProperties.type values. */
export declare const PROTOCOL_TYPES_1X: Readonly<Set<string>>;
/**
 * Party roles (#/$defs/cyclonedx-party-2.0/$defs/preDefinedRole) the 1.x
 * component and service fields can hold, with the 1.x field.
 */
export declare const PARTY_ROLE_FIELDS_1X: Readonly<{
    supplier: "supplier";
    manufacturer: "manufacturer";
    author: "authors";
    publisher: "publisher";
    provider: "provider";
}>;
/**
 * Identity schemes (#/$defs/cyclonedx-component-2.0/$defs/identityScheme) the
 * 1.x identifier fields hold, with the 1.x field. `omniborid` and `swhid` are
 * lists in 1.x; the others hold one value.
 */
export declare const IDENTITY_SCHEME_FIELDS_1X: Readonly<{
    purl: "purl";
    cpe: "cpe";
    swid: "swid";
    omniborid: "omniborId";
    swhid: "swhid";
}>;
/** 2.0 identity-evidence scheme → 1.x field, for the predefined schemes. */
export declare const IDENTITY_EVIDENCE_SCHEME_TO_FIELD: Readonly<{
    purl: "purl";
    cpe: "cpe";
    swid: "swid";
    swhid: "swhid";
    omniborid: "omniborId";
}>;
//# sourceMappingURL=cyclonedx20Tables.d.ts.map