const SPDX_CONTEXT_PREFIX = "https://spdx.org/rdf/";
const CYCLONEDX_FORMAT = "CycloneDX";
const LEGACY_CYCLONEDX_ROOT_KEY = "bomFormat";
const MODERN_CYCLONEDX_ROOT_KEY = "specFormat";
const BOM_FORMAT_CYCLONEDX = "cyclonedx";
const BOM_FORMAT_SPDX = "spdx";
const BOM_FORMAT_UNKNOWN = "unknown";
const CYCLONEDX_SPEC_VERSION_PATTERN = /^(\d+)(?:\.(\d+))?$/u;
const CYCLONEDX_FORMAT_KEYS = new Set([
  LEGACY_CYCLONEDX_ROOT_KEY,
  MODERN_CYCLONEDX_ROOT_KEY,
  "specVersion",
]);

export const isSpdxJsonLd = (bomJson) =>
  Boolean(
    bomJson?.["@context"]?.startsWith(SPDX_CONTEXT_PREFIX) &&
      Array.isArray(bomJson?.["@graph"]) &&
      bomJson["@graph"].some((element) => element?.type === "SpdxDocument"),
  );

const parseCycloneDxSpecVersion = (specVersion) => {
  const match = `${specVersion ?? ""}`
    .trim()
    .match(CYCLONEDX_SPEC_VERSION_PATTERN);
  if (!match) {
    return undefined;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2] || "0", 10),
    minorText: match[2] || "0",
  };
};

export const normalizeCycloneDxSpecVersion = (specVersion) => {
  const parsed = parseCycloneDxSpecVersion(specVersion);
  if (!parsed) {
    return undefined;
  }
  return Number(`${parsed.major}.${parsed.minor}`);
};

export const toCycloneDxSpecVersionString = (specVersion) => {
  const parsed = parseCycloneDxSpecVersion(specVersion);
  if (!parsed) {
    return undefined;
  }
  if (typeof specVersion === "string" && parsed.minorText !== "0") {
    return `${parsed.major}.${parsed.minorText}`;
  }
  return `${parsed.major}.${parsed.minor}`;
};

export const isCycloneDxSpecVersionAtLeast = (specVersion, minimumVersion) => {
  const parsedSpecVersion = parseCycloneDxSpecVersion(specVersion);
  const parsedMinimumVersion = parseCycloneDxSpecVersion(minimumVersion);
  if (!parsedSpecVersion || !parsedMinimumVersion) {
    return false;
  }
  if (parsedSpecVersion.major !== parsedMinimumVersion.major) {
    return parsedSpecVersion.major > parsedMinimumVersion.major;
  }
  return parsedSpecVersion.minor >= parsedMinimumVersion.minor;
};

export const isCycloneDx20SpecVersion = (specVersion) =>
  isCycloneDxSpecVersionAtLeast(specVersion, 2);

export const getCycloneDxRootFormatKey = (specVersionOrBom) => {
  const specVersion =
    specVersionOrBom && typeof specVersionOrBom === "object"
      ? specVersionOrBom.specVersion
      : specVersionOrBom;
  return isCycloneDx20SpecVersion(specVersion)
    ? MODERN_CYCLONEDX_ROOT_KEY
    : LEGACY_CYCLONEDX_ROOT_KEY;
};

export const getCycloneDxFormat = (bomJson) =>
  bomJson?.specFormat || bomJson?.bomFormat;

export const hasCycloneDxFormat = (bomJson) =>
  getCycloneDxFormat(bomJson) === CYCLONEDX_FORMAT;

export const isCycloneDxBom = (bomJson) =>
  hasCycloneDxFormat(bomJson) &&
  normalizeCycloneDxSpecVersion(bomJson?.specVersion) !== undefined;

const rewriteCycloneDxRootFields = (
  bomJson,
  rootKey,
  specVersion,
  preserveLegacyBomFormat,
) => {
  const remainingEntries = Object.entries(bomJson).filter(
    ([key]) => !CYCLONEDX_FORMAT_KEYS.has(key),
  );
  for (const key of Object.keys(bomJson)) {
    delete bomJson[key];
  }
  if (rootKey === LEGACY_CYCLONEDX_ROOT_KEY) {
    bomJson.bomFormat = CYCLONEDX_FORMAT;
    if (specVersion !== undefined) {
      bomJson.specVersion = specVersion;
    }
  } else if (preserveLegacyBomFormat) {
    bomJson.bomFormat = CYCLONEDX_FORMAT;
    if (specVersion !== undefined) {
      bomJson.specVersion = specVersion;
    }
    bomJson.specFormat = CYCLONEDX_FORMAT;
  } else {
    bomJson.specFormat = CYCLONEDX_FORMAT;
    if (specVersion !== undefined) {
      bomJson.specVersion = specVersion;
    }
  }
  for (const [key, value] of remainingEntries) {
    bomJson[key] = value;
  }
};

/**
 * Mutates a CycloneDX BOM object so the appropriate root format key is present
 * for the requested spec version, while preserving conventional serialized
 * root-key ordering (`bomFormat`/`specFormat` and `specVersion` first). Only the currently
 * supported CycloneDX major.minor version shape is accepted; multi-component
 * future versions such as `2.0.1` intentionally return `undefined` from the
 * normalizer rather than being silently truncated.
 *
 * @param {object} bomJson BOM JSON object to mutate.
 * @param {string|number} specVersion Desired CycloneDX spec version.
 * @param {object} options Root-key compatibility options.
 * @returns {object} The same `bomJson` object, after in-place mutation.
 */
export const setCycloneDxFormat = (
  bomJson,
  specVersion,
  { preserveLegacyBomFormat = false } = {},
) => {
  if (!bomJson || typeof bomJson !== "object" || Array.isArray(bomJson)) {
    return bomJson;
  }
  const resolvedSpecVersion =
    toCycloneDxSpecVersionString(specVersion ?? bomJson.specVersion) ||
    bomJson.specVersion;
  if (resolvedSpecVersion !== undefined) {
    bomJson.specVersion = resolvedSpecVersion;
  }
  if (
    getCycloneDxRootFormatKey(resolvedSpecVersion) === MODERN_CYCLONEDX_ROOT_KEY
  ) {
    rewriteCycloneDxRootFields(
      bomJson,
      MODERN_CYCLONEDX_ROOT_KEY,
      resolvedSpecVersion,
      preserveLegacyBomFormat,
    );
    return bomJson;
  }
  rewriteCycloneDxRootFields(
    bomJson,
    LEGACY_CYCLONEDX_ROOT_KEY,
    resolvedSpecVersion,
    false,
  );
  return bomJson;
};

export const detectBomFormat = (bomJson) => {
  if (isCycloneDxBom(bomJson)) {
    return BOM_FORMAT_CYCLONEDX;
  }
  if (isSpdxJsonLd(bomJson)) {
    return BOM_FORMAT_SPDX;
  }
  return BOM_FORMAT_UNKNOWN;
};

export const getNonCycloneDxErrorMessage = (
  bomJson,
  commandName = "This command",
) => {
  const detectedFormat = detectBomFormat(bomJson);
  if (detectedFormat === BOM_FORMAT_SPDX) {
    return `${commandName} expects a CycloneDX BOM. SPDX input is not supported for this command.`;
  }
  return `${commandName} expects a CycloneDX JSON BOM.`;
};
