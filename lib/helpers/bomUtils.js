const SPDX_CONTEXT_PREFIX = "https://spdx.org/rdf/";
const CYCLONEDX_FORMAT = "CycloneDX";
const BOM_FORMAT_CYCLONEDX = "cyclonedx";
const BOM_FORMAT_SPDX = "spdx";
const BOM_FORMAT_UNKNOWN = "unknown";

export const isSpdxJsonLd = (bomJson) =>
  Boolean(
    bomJson?.["@context"]?.startsWith(SPDX_CONTEXT_PREFIX) &&
      Array.isArray(bomJson?.["@graph"]) &&
      bomJson["@graph"].some((element) => element?.type === "SpdxDocument"),
  );

export const isCycloneDxBom = (bomJson) =>
  bomJson?.bomFormat === CYCLONEDX_FORMAT && Boolean(bomJson?.specVersion);

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
