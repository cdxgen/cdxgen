/**
 * Reader converters for CycloneDX 2.0 component evidence
 * (#/$defs/cyclonedx-component-2.0/$defs/componentEvidence and
 * #/$defs/cyclonedx-evidence-2.0) and cryptoProperties
 * (#/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties) back to the 1.x
 * shapes. Each frozen spec is the allowlist of the members 1.x carries.
 */

import { isDeepStrictEqual } from "node:util";

import {
  createRenderStats,
  isNonEmptyString,
  isObjectRecord,
  shadowKey,
} from "./cyclonedx20Common.js";
import { reverseHash } from "./cyclonedx20ReadCommon.js";
import {
  addLoss,
  jsonPointer,
  listOf,
  objectOf,
  reverseFields,
  reverseList,
  reverseObject,
} from "./cyclonedx20ReadContext.js";
import { convertIdentityEntry } from "./cyclonedx20RenderEvidence.js";
import {
  ALGORITHM_FAMILY_1X,
  ALGORITHM_PROPERTY_ENUMS_1X,
  ELLIPTIC_CURVE_1X,
  IDENTITY_EVIDENCE_SCHEME_TO_FIELD,
  IDENTITY_FIELDS_1X,
  IDENTITY_TECHNIQUES_1X,
  PROTOCOL_TYPES_1X,
} from "./cyclonedx20Tables.js";

/** A spec rule keeping a value only when the 1.x enum lists it. */
function enumRule(kind, values) {
  return Object.freeze({
    convert: (ctx, value, pointer) => {
      if (values.has(value)) {
        return value;
      }
      addLoss(ctx, pointer, `${kind} '${value}' is not a 1.x value`);
      return undefined;
    },
  });
}

/** A spec rule keeping the list entries the 1.x enum lists. */
function enumListRule(kind, values) {
  return Object.freeze({
    convert: (ctx, value, pointer) =>
      reverseList(ctx, value, pointer, (_ctx, entry, entryPointer) => {
        if (values.has(entry)) {
          return entry;
        }
        addLoss(ctx, entryPointer, `${kind} '${entry}' is not a 1.x value`);
        return undefined;
      }),
  });
}

/** The 1.x identity `field` for a 2.0 identity-evidence scheme, if any. */
function identityField(scheme) {
  if (typeof scheme === "string") {
    return Object.hasOwn(IDENTITY_EVIDENCE_SCHEME_TO_FIELD, scheme)
      ? IDENTITY_EVIDENCE_SCHEME_TO_FIELD[scheme]
      : undefined;
  }
  // The renderer writes 1.x fields outside the scheme enum (group, name,
  // version, hash) as custom `{name}` schemes.
  return isObjectRecord(scheme) && IDENTITY_FIELDS_1X.has(scheme.name)
    ? scheme.name
    : undefined;
}

/** identificationMethod → 1.x method; `unknown` is the 1.x `other`. */
function reverseIdentityMethod(ctx, value, pointer) {
  if (!isObjectRecord(value)) {
    addLoss(ctx, pointer, "identity method is not an object");
    return undefined;
  }
  const technique = value.technique === "unknown" ? "other" : value.technique;
  if (!IDENTITY_TECHNIQUES_1X.has(technique)) {
    addLoss(
      ctx,
      jsonPointer(pointer, "technique"),
      "identity method technique is not a 1.x technique; method dropped",
    );
    return undefined;
  }
  const method = reverseFields(ctx, "identificationMethod", value, pointer, {
    technique: true,
    confidence: true,
    value: true,
  });
  method.technique = technique;
  return method;
}

const IDENTITY_SPEC = Object.freeze({
  scheme: Object.freeze({
    to: "field",
    convert: (_ctx, value) => identityField(value),
  }),
  concludedValue: true,
  confidence: true,
  methods: listOf(reverseIdentityMethod),
  tools: true,
});

/**
 * componentIdentityEvidence → 1.x identity (requires `field`). 1.x has no
 * `assertion`, `timestamp` or method `result`, so they never reach the 1.x
 * entry. When the 1.x entry renders back to exactly this 2.0 entry, those
 * members are cdxgen's own attributed claim, which renderCycloneDx20 derives
 * again from the entry and the BOM (see convertIdentityEntry), and reading
 * them is no loss. Otherwise (a foreign party's assertion, a timestamp of its
 * own) every such member is a loss, and the entry is noted for an identity
 * shadow so a render of the unchanged 1.x entry restores it.
 */
function reverseIdentityEvidence(ctx, value, pointer) {
  if (!isObjectRecord(value)) {
    addLoss(ctx, pointer, "identity evidence is not an object");
    return undefined;
  }
  if (identityField(value.scheme) === undefined) {
    addLoss(
      ctx,
      jsonPointer(pointer, "scheme"),
      "identity evidence scheme has no 1.x field; entry dropped",
    );
    return undefined;
  }
  const before = ctx.losses.length;
  const identity = reverseFields(
    ctx,
    "identityEvidence",
    value,
    pointer,
    IDENTITY_SPEC,
  );
  const rendered = convertIdentityEntry(
    identity,
    createRenderStats(undefined, ctx.claims),
  );
  const derived = isDeepStrictEqual(rendered, value);
  if (derived) {
    ctx.losses.length = before;
  }
  if (!ctx.shadowSuspended) {
    ctx.keptIdentities.push({
      key: shadowKey(identity),
      original: value,
      needsShadow: !derived,
    });
  }
  return identity;
}

/**
 * Register the identity shadows. An identity shadow is looked up by its 1.x
 * projection alone, whichever component carries it, so a key is registered
 * only when every identity entry read under it needs the same original; a
 * key shared with an entry that renders back by itself, or with a different
 * original, is left to the component shadows.
 *
 * @param {object} ctx Reader context
 */
export function flushIdentityShadows(ctx) {
  const byKey = new Map();
  for (const kept of ctx.keptIdentities) {
    const group = byKey.get(kept.key) || [];
    group.push(kept);
    byKey.set(kept.key, group);
  }
  for (const [key, group] of byKey) {
    const [first] = group;
    if (
      group.every(
        (kept) =>
          kept.needsShadow && isDeepStrictEqual(kept.original, first.original),
      )
    ) {
      const byKind = (ctx.shadows.identity ||= {});
      byKind[key] = [first.original];
    }
  }
}

const OCCURRENCE_SPEC = Object.freeze({
  refId: "bom-ref",
  location: true,
  line: true,
  offset: true,
  symbol: true,
  additionalContext: true,
});

/** occurrence → 1.x occurrence; an occurrenceReference has no 1.x form. */
function reverseOccurrence(ctx, value, pointer) {
  if (isObjectRecord(value) && typeof value.ref === "string") {
    addLoss(ctx, pointer, "occurrence reference has no 1.x form");
    return undefined;
  }
  return reverseObject(ctx, "occurrence", value, pointer, OCCURRENCE_SPEC);
}

const FRAME_SPEC = Object.freeze({
  package: true,
  module: true,
  function: true,
  parameters: true,
  line: true,
  column: true,
  fullFilename: true,
});

const CALL_STACK_SPEC = Object.freeze({
  frames: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "frame", value, pointer, FRAME_SPEC),
  ),
});

/** callStacks → the single 1.x `callstack`; further stacks are losses. */
function reverseCallStacks(ctx, value, pointer) {
  if (!Array.isArray(value) || !value.length) {
    return undefined;
  }
  for (let index = 1; index < value.length; index++) {
    addLoss(
      ctx,
      jsonPointer(pointer, index),
      "1.x evidence holds one call stack; only the first is kept",
    );
  }
  return reverseObject(
    ctx,
    "callStack",
    value[0],
    jsonPointer(pointer, 0),
    CALL_STACK_SPEC,
  );
}

const LICENSE_EVIDENCE_LICENSE_SPEC = Object.freeze({ id: true, name: true });

/** licenseEvidence → 1.x licenseChoice; its refId becomes the bom-ref. */
function reverseLicenseEvidence(ctx, value, pointer) {
  if (!isObjectRecord(value)) {
    addLoss(ctx, pointer, "license evidence is not an object");
    return undefined;
  }
  const carried = { refId: true };
  let choice;
  if (isObjectRecord(value.license)) {
    carried.license = true;
    const license = reverseFields(
      ctx,
      "licenseEvidence.license",
      value.license,
      jsonPointer(pointer, "license"),
      LICENSE_EVIDENCE_LICENSE_SPEC,
    );
    if (isNonEmptyString(value.refId)) {
      license["bom-ref"] = value.refId;
    }
    choice = { license };
  } else if (isNonEmptyString(value.expression)) {
    carried.expression = true;
    choice = { expression: value.expression };
    if (isNonEmptyString(value.refId)) {
      choice["bom-ref"] = value.refId;
    }
  }
  reverseFields(ctx, "licenseEvidence", value, pointer, carried);
  return choice;
}

/** copyrightEvidence → 1.x copyright (`text` only). */
function reverseCopyrightEvidence(ctx, value, pointer) {
  return reverseObject(ctx, "copyrightEvidence", value, pointer, {
    text: true,
  });
}

const EVIDENCE_SPEC = Object.freeze({
  identity: listOf(reverseIdentityEvidence),
  occurrences: listOf(reverseOccurrence),
  callStacks: Object.freeze({ to: "callstack", convert: reverseCallStacks }),
  licenses: listOf(reverseLicenseEvidence),
  copyright: listOf(reverseCopyrightEvidence),
});

/**
 * componentEvidence → 1.x evidence.
 *
 * @param {object} ctx Reader context
 * @param {object} value 2.0 componentEvidence
 * @param {string} pointer JSON pointer of `value`
 * @returns {object|undefined} 1.x evidence
 */
export function reverseEvidence(ctx, value, pointer) {
  return reverseObject(ctx, "evidence", value, pointer, EVIDENCE_SPEC);
}

/** A fingerprint: only the standard-hash branch exists in 1.x. */
function reverseFingerprint(ctx, value, pointer) {
  if (isObjectRecord(value) && value.alg !== undefined) {
    return reverseHash(ctx, value, pointer);
  }
  addLoss(ctx, pointer, "fingerprint is not a standard hash; 1.x has no field");
  return undefined;
}
const FINGERPRINT_RULE = Object.freeze({ convert: reverseFingerprint });

const RELATED_ASSETS_RULE = listOf((ctx, value, pointer) =>
  reverseObject(ctx, "relatedCryptographicAsset", value, pointer, {
    type: true,
    ref: true,
  }),
);

/** implementationPlatform: a 2.0 list, one value in 1.x. */
function reverseImplementationPlatform(ctx, value, pointer) {
  const platforms = Array.isArray(value) ? value : [value];
  const allowed = ALGORITHM_PROPERTY_ENUMS_1X.implementationPlatform;
  let kept;
  platforms.forEach((platform, index) => {
    const entryPointer = Array.isArray(value)
      ? jsonPointer(pointer, index)
      : pointer;
    if (kept === undefined && allowed.has(platform)) {
      kept = platform;
    } else {
      addLoss(
        ctx,
        entryPointer,
        allowed.has(platform)
          ? "1.x holds one implementationPlatform; only the first is kept"
          : `implementationPlatform '${platform}' is not a 1.x value`,
      );
    }
  });
  return kept;
}

const ALGORITHM_SPEC = Object.freeze({
  primitive: enumRule("primitive", ALGORITHM_PROPERTY_ENUMS_1X.primitive),
  algorithmFamily: enumRule("algorithmFamily", ALGORITHM_FAMILY_1X),
  parameterSetIdentifier: true,
  ellipticCurve: enumRule("ellipticCurve", ELLIPTIC_CURVE_1X),
  executionEnvironment: enumRule(
    "executionEnvironment",
    ALGORITHM_PROPERTY_ENUMS_1X.executionEnvironment,
  ),
  implementationPlatform: Object.freeze({
    convert: reverseImplementationPlatform,
  }),
  certificationLevel: true,
  mode: enumRule("mode", ALGORITHM_PROPERTY_ENUMS_1X.mode),
  padding: enumRule("padding", ALGORITHM_PROPERTY_ENUMS_1X.padding),
  cryptoFunctions: enumListRule(
    "cryptoFunctions",
    ALGORITHM_PROPERTY_ENUMS_1X.cryptoFunctions,
  ),
  classicalSecurityLevel: true,
  nistQuantumSecurityLevel: true,
});

const CERTIFICATE_SPEC = Object.freeze({
  serialNumber: true,
  subjectName: true,
  issuerName: true,
  notValidBefore: true,
  notValidAfter: true,
  signatureAlgorithmRef: true,
  subjectPublicKeyRef: true,
  certificateFormat: true,
  certificateExtension: true,
  certificateFileExtension: true,
  fingerprint: FINGERPRINT_RULE,
  certificateState: true,
  creationDate: true,
  activationDate: true,
  deactivationDate: true,
  revocationDate: true,
  destructionDate: true,
  certificateExtensions: true,
  relatedCryptographicAssets: RELATED_ASSETS_RULE,
});

/** securedBy.algorithmRef: a 2.0 list of refIds, one refType in 1.x. */
function reverseSecuredByRef(ctx, value, pointer) {
  if (typeof value === "string") {
    return value;
  }
  const refs = Array.isArray(value) ? value : [];
  for (let index = 1; index < refs.length; index++) {
    addLoss(
      ctx,
      jsonPointer(pointer, index),
      "1.x securedBy holds one algorithmRef; only the first is kept",
    );
  }
  return typeof refs[0] === "string" ? refs[0] : undefined;
}

const RELATED_SPEC = Object.freeze({
  type: true,
  id: true,
  state: true,
  algorithmRef: true,
  creationDate: true,
  activationDate: true,
  updateDate: true,
  expirationDate: true,
  value: true,
  size: true,
  format: true,
  securedBy: objectOf("securedBy", {
    mechanism: true,
    algorithmRef: Object.freeze({ convert: reverseSecuredByRef }),
  }),
  fingerprint: FINGERPRINT_RULE,
  relatedCryptographicAssets: RELATED_ASSETS_RULE,
});

const PROTOCOL_SPEC = Object.freeze({
  type: enumRule("protocolProperties.type", PROTOCOL_TYPES_1X),
  version: true,
  cipherSuites: true,
  ikev2TransformTypes: true,
  cryptoRefArray: true,
  relatedCryptographicAssets: RELATED_ASSETS_RULE,
});

const CRYPTO_SPEC = Object.freeze({
  assetType: true,
  algorithmProperties: objectOf("algorithmProperties", ALGORITHM_SPEC),
  certificateProperties: objectOf("certificateProperties", CERTIFICATE_SPEC),
  relatedCryptoMaterialProperties: objectOf(
    "relatedCryptoMaterialProperties",
    RELATED_SPEC,
  ),
  protocolProperties: objectOf("protocolProperties", PROTOCOL_SPEC),
  oid: true,
});

/**
 * cryptoProperties → 1.x cryptoProperties: list-valued
 * `implementationPlatform` and `securedBy.algorithmRef` become one value,
 * enum values 1.7 does not list are dropped, and 2.0-only members
 * (`secProperties`, `renewal`, `rotation`, `keyUsage`, non-hash
 * fingerprints) are losses.
 *
 * @param {object} ctx Reader context
 * @param {object} value 2.0 cryptoProperties
 * @param {string} pointer JSON pointer of `value`
 * @returns {object|undefined} 1.x cryptoProperties
 */
export function reverseCryptoProperties(ctx, value, pointer) {
  return reverseObject(ctx, "cryptoProperties", value, pointer, CRYPTO_SPEC);
}
