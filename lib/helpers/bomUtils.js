const SPDX_CONTEXT_PREFIX = "https://spdx.org/rdf/";
const CYCLONEDX_FORMAT = "CycloneDX";
const LEGACY_CYCLONEDX_ROOT_KEY = "bomFormat";
const MODERN_CYCLONEDX_ROOT_KEY = "specFormat";
const BOM_FORMAT_CYCLONEDX = "cyclonedx";
const BOM_FORMAT_SPDX = "spdx";
const BOM_FORMAT_UNKNOWN = "unknown";

export const isSpdxJsonLd = (bomJson) =>
  Boolean(
    bomJson?.["@context"]?.startsWith(SPDX_CONTEXT_PREFIX) &&
      Array.isArray(bomJson?.["@graph"]) &&
      bomJson["@graph"].some((element) => element?.type === "SpdxDocument"),
  );

export const normalizeCycloneDxSpecVersion = (specVersion) => {
  const normalized = Number.parseFloat(`${specVersion ?? ""}`);
  return Number.isNaN(normalized) ? undefined : normalized;
};

export const toCycloneDxSpecVersionString = (specVersion) => {
  const normalized = normalizeCycloneDxSpecVersion(specVersion);
  return normalized === undefined ? undefined : normalized.toFixed(1);
};

export const isCycloneDxSpecVersionAtLeast = (specVersion, minimumVersion) => {
  const normalizedSpecVersion = normalizeCycloneDxSpecVersion(specVersion);
  const normalizedMinimumVersion =
    normalizeCycloneDxSpecVersion(minimumVersion);
  if (
    normalizedSpecVersion === undefined ||
    normalizedMinimumVersion === undefined
  ) {
    return false;
  }
  return normalizedSpecVersion >= normalizedMinimumVersion;
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
    bomJson.specFormat = CYCLONEDX_FORMAT;
    if (preserveLegacyBomFormat) {
      bomJson.bomFormat = CYCLONEDX_FORMAT;
    } else {
      delete bomJson.bomFormat;
    }
    return bomJson;
  }
  bomJson.bomFormat = CYCLONEDX_FORMAT;
  delete bomJson.specFormat;
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
