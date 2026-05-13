const HBOM_PROJECT_TYPE_SET = new Set(["hardware", "hbom"]);

/**
 * Determine whether the supplied project types include HBOM.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when HBOM is requested.
 */
export function hasHbomProjectType(projectTypes) {
  return normalizeProjectTypes(projectTypes).some((projectType) =>
    HBOM_PROJECT_TYPE_SET.has(projectType),
  );
}

/**
 * Determine whether the supplied project types are exclusively HBOM-oriented.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when at least one project type is supplied and all are HBOM-oriented.
 */
export function isHbomOnlyProjectTypes(projectTypes) {
  const normalizedProjectTypes = normalizeProjectTypes(projectTypes);
  return (
    normalizedProjectTypes.length > 0 &&
    normalizedProjectTypes.every((projectType) =>
      HBOM_PROJECT_TYPE_SET.has(projectType),
    )
  );
}

/**
 * Reject mixed HBOM and non-HBOM project types.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 */
export function ensureNoMixedHbomProjectTypes(projectTypes) {
  const normalizedProjectTypes = normalizeProjectTypes(projectTypes);
  if (
    !normalizedProjectTypes.length ||
    !hasHbomProjectType(normalizedProjectTypes)
  ) {
    return;
  }
  const nonHbomProjectTypes = normalizedProjectTypes.filter(
    (projectType) => !HBOM_PROJECT_TYPE_SET.has(projectType),
  );
  if (nonHbomProjectTypes.length) {
    throw new Error(
      `HBOM project types cannot be mixed with other project types: ${normalizedProjectTypes.join(", ")}. Generate HBOM separately using 'hbom' or 'cdxgen -t hbom'.`,
    );
  }
}

/**
 * Ensure HBOM generation uses the supported CycloneDX version.
 *
 * @param {number|string|undefined|null} specVersion Requested spec version.
 */
export function ensureSupportedHbomSpecVersion(specVersion) {
  if (specVersion === undefined || specVersion === null || specVersion === "") {
    return;
  }
  if (Number(specVersion) !== 1.7) {
    throw new Error("HBOM generation currently supports only CycloneDX 1.7.");
  }
}

/**
 * Translate cdxgen CLI options to cdx-hbom collector options.
 *
 * @param {object} [options={}] CLI options.
 * @returns {object} cdx-hbom collector options.
 */
export function normalizeHbomOptions(options = {}) {
  const timeoutValue = options.timeoutMs ?? options.timeout;
  const timeoutMs =
    timeoutValue === undefined || timeoutValue === null || timeoutValue === ""
      ? undefined
      : Number.parseInt(`${timeoutValue}`, 10);
  const includeCommandEnrichment =
    options.includeCommandEnrichment ?? !options.noCommandEnrichment;
  const allowPartial = options.allowPartial ?? !options.strict;

  return {
    allowPartial,
    architecture: options.arch ?? options.architecture,
    includeCommandEnrichment,
    includePlistEnrichment:
      options.includePlistEnrichment ?? options.plistEnrichment ?? false,
    includePrivilegedEnrichment:
      options.includePrivilegedEnrichment ?? options.privileged ?? false,
    includeSensitiveIdentifiers:
      options.includeSensitiveIdentifiers ?? options.sensitive ?? false,
    platform: options.platform,
    timeoutMs:
      Number.isNaN(timeoutMs) || timeoutMs <= 0 ? undefined : timeoutMs,
  };
}

/**
 * Generate an HBOM using the optional cdx-hbom package.
 *
 * @param {object} [options={}] CLI options.
 * @returns {Promise<object>} CycloneDX HBOM document.
 */
export async function createHbomDocument(options = {}) {
  ensureSupportedHbomSpecVersion(options.specVersion);
  let hbomModule;
  try {
    hbomModule = await import("@cdxgen/cdx-hbom");
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      `${error?.message || ""}`.includes("@cdxgen/cdx-hbom")
    ) {
      throw new Error(
        "HBOM support requires the optional '@cdxgen/cdx-hbom' dependency. Install it or use a build that bundles HBOM support.",
      );
    }
    throw error;
  }
  if (typeof hbomModule.collectHardware !== "function") {
    throw new Error(
      "The installed '@cdxgen/cdx-hbom' package does not expose collectHardware().",
    );
  }
  return hbomModule.collectHardware(normalizeHbomOptions(options));
}

/**
 * Normalize project types to lowercase strings.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {string[]} Normalized project types.
 */
function normalizeProjectTypes(projectTypes) {
  if (!projectTypes) {
    return [];
  }
  const values = Array.isArray(projectTypes) ? projectTypes : [projectTypes];
  return values
    .flatMap((projectType) => `${projectType}`.split(","))
    .map((projectType) => projectType.trim().toLowerCase())
    .filter(Boolean);
}
