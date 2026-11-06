const SPDX_CONTEXT_PREFIX = "https://spdx.org/rdf/";
const CYCLONEDX_FORMAT = "CycloneDX";

/**
 * The default CycloneDX specification version used across cdxgen when a caller
 * does not specify one (matches the `--spec-version` CLI default).
 */
export const DEFAULT_CDX_SPEC_VERSION = 1.7;

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
const COMPONENT_TYPES_1_4 = [
  "application",
  "framework",
  "library",
  "container",
  "operating-system",
  "device",
  "firmware",
  "file",
];
const COMPONENT_TYPES_1_5 = [
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
];
const COMPONENT_TYPES_1_6 = [...COMPONENT_TYPES_1_5, "cryptographic-asset"];
// CycloneDX 2.0 keeps every 1.6 type and turns services into components of
// type `service` (`#/$defs/cyclonedx-component-2.0/$defs/component/properties/type`),
// next to the new physical type `material`. The draft's enum, quoted:
// application, framework, library, container, platform, operating-system,
// device, device-driver, firmware, file, machine-learning-model, data,
// cryptographic-asset, material, service.
const COMPONENT_TYPES_2_0 = [...COMPONENT_TYPES_1_6, "material", "service"];

/**
 * Frozen map of CycloneDX spec versions (as "major.minor" strings) to the
 * frozen list of component types supported by that version.
 */
export const CYCLONEDX_COMPONENT_TYPES_BY_SPEC_VERSION = Object.freeze({
  1.4: Object.freeze(COMPONENT_TYPES_1_4),
  1.5: Object.freeze(COMPONENT_TYPES_1_5),
  1.6: Object.freeze(COMPONENT_TYPES_1_6),
  1.7: Object.freeze(COMPONENT_TYPES_1_6),
  "2.0": Object.freeze(COMPONENT_TYPES_2_0),
});

/**
 * Determine whether the given BOM object is an SPDX JSON-LD document.
 *
 * @param {object} bomJson BOM JSON object to inspect.
 * @returns {boolean} True when the object carries an SPDX `@context` and an `SpdxDocument` graph entry.
 */
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

/**
 * Normalize a CycloneDX spec version to a numeric major.minor value.
 *
 * @param {string|number} specVersion Spec version string or number (e.g. "1.5", 1.6).
 * @returns {number|undefined} Numeric major.minor version, or undefined when unparseable.
 */
export const normalizeCycloneDxSpecVersion = (specVersion) => {
  const parsed = parseCycloneDxSpecVersion(specVersion);
  if (!parsed) {
    return undefined;
  }
  return Number(`${parsed.major}.${parsed.minor}`);
};

/**
 * Format a CycloneDX spec version as a "major.minor" string.
 *
 * @param {string|number} specVersion Spec version string or number.
 * @returns {string|undefined} "major.minor" string, or undefined when unparseable.
 */
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

/**
 * Determine whether a spec version is greater than or equal to a minimum version,
 * comparing major then minor components.
 *
 * @param {string|number} specVersion The spec version to test.
 * @param {string|number} minimumVersion The minimum required spec version.
 * @returns {boolean} True when specVersion is at least minimumVersion.
 */
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

/**
 * Determine whether a spec version is CycloneDX 2.0 or later.
 *
 * @param {string|number} specVersion The spec version to test.
 * @returns {boolean} True when the spec version is at least 2.0.
 */
export const isCycloneDx20SpecVersion = (specVersion) =>
  isCycloneDxSpecVersionAtLeast(specVersion, 2);

/**
 * Return the list of component types supported by a given CycloneDX spec
 * version, falling back to the 1.7 list when the version is unrecognized.
 *
 * @param {string|number} [specVersion=1.7] CycloneDX spec version.
 * @returns {string[]} Supported component type names for that version.
 */
export const getSupportedCycloneDxComponentTypes = (specVersion = 1.7) => {
  const normalizedSpecVersion = toCycloneDxSpecVersionString(specVersion);
  return [
    ...(CYCLONEDX_COMPONENT_TYPES_BY_SPEC_VERSION[normalizedSpecVersion] ||
      CYCLONEDX_COMPONENT_TYPES_BY_SPEC_VERSION["1.7"]),
  ];
};

/**
 * Normalize a component type filter (single value, array, or falsy) into a
 * deduplicated array of trimmed, non-empty type strings.
 *
 * @param {string|string[]} componentType Component type or array of types.
 * @returns {string[]} Deduplicated, trimmed component type strings.
 */
export const normalizeCycloneDxComponentTypeFilter = (componentType) => {
  if (!componentType) {
    return [];
  }
  const componentTypes = Array.isArray(componentType)
    ? componentType
    : [componentType];
  return Array.from(
    new Set(componentTypes.map((type) => `${type}`.trim()).filter(Boolean)),
  );
};

/**
 * Determine whether a component type is enabled given the configured type
 * filter and spec version.
 *
 * @param {string} componentType The component type to test.
 * @param {object} [options] Options carrying the filter and spec version.
 * @param {string|string[]} [options.componentType] Explicit type filter from CLI options.
 * @param {string|number} [options.specVersion] CycloneDX spec version for default support lookup.
 * @returns {boolean} True when the component type passes the filter.
 */
export const isCycloneDxComponentTypeEnabled = (
  componentType,
  options = {},
) => {
  if (!componentType) {
    return false;
  }
  const requestedComponentTypes = normalizeCycloneDxComponentTypeFilter(
    options.componentType,
  );
  if (requestedComponentTypes.length) {
    return requestedComponentTypes.includes(componentType);
  }
  return getSupportedCycloneDxComponentTypes(options.specVersion).includes(
    componentType,
  );
};

/**
 * Return the appropriate CycloneDX root format key ("bomFormat" or
 * "specFormat") for the given spec version or BOM object.
 *
 * @param {string|number|object} specVersionOrBom Spec version, or a BOM object whose `specVersion` is read.
 * @returns {string} The root format key name to use.
 */
export const getCycloneDxRootFormatKey = (specVersionOrBom) => {
  const specVersion =
    specVersionOrBom && typeof specVersionOrBom === "object"
      ? specVersionOrBom.specVersion
      : specVersionOrBom;
  return isCycloneDx20SpecVersion(specVersion)
    ? MODERN_CYCLONEDX_ROOT_KEY
    : LEGACY_CYCLONEDX_ROOT_KEY;
};

/**
 * Return the BOM format identifier string from a BOM object.
 *
 * @param {object} bomJson BOM JSON object.
 * @returns {string|undefined} The `specFormat` or `bomFormat` value.
 */
export const getCycloneDxFormat = (bomJson) =>
  bomJson?.specFormat || bomJson?.bomFormat;

/**
 * Determine whether a BOM object carries the CycloneDX format identifier.
 *
 * @param {object} bomJson BOM JSON object.
 * @returns {boolean} True when the format identifier equals "CycloneDX".
 */
export const hasCycloneDxFormat = (bomJson) =>
  getCycloneDxFormat(bomJson) === CYCLONEDX_FORMAT;

/**
 * Determine whether an object is a valid CycloneDX BOM by checking both the
 * format identifier and a parseable spec version.
 *
 * @param {object} bomJson BOM JSON object.
 * @returns {boolean} True when the object is a valid CycloneDX BOM.
 */
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

/**
 * Detect the format of a BOM object, distinguishing CycloneDX, SPDX JSON-LD,
 * and unknown formats.
 *
 * @param {object} bomJson BOM JSON object.
 * @returns {string} "cyclonedx", "spdx", or "unknown".
 */
export const detectBomFormat = (bomJson) => {
  if (isCycloneDxBom(bomJson)) {
    return BOM_FORMAT_CYCLONEDX;
  }
  if (isSpdxJsonLd(bomJson)) {
    return BOM_FORMAT_SPDX;
  }
  return BOM_FORMAT_UNKNOWN;
};

/**
 * Build a user-facing error message explaining that the supplied BOM is not a
 * CycloneDX document, tailored to the detected format.
 *
 * @param {object} bomJson BOM JSON object that was rejected.
 * @param {string} [commandName="This command"] Name of the command requiring CycloneDX input.
 * @returns {string} Human-readable error message.
 */
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
