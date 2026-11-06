import { fileURLToPath, pathToFileURL } from "node:url";

import { safeExistsSync } from "../core/fs.js";

const LOCAL_HBOM_MODULE_URL = new URL(
  "../../cdx-hbom/index.js",
  import.meta.url,
);
const LOCAL_HBOM_MODULE_PATH = fileURLToPath(LOCAL_HBOM_MODULE_URL);
// The ./cdx20 export of @cdxgen/cdx-hbom (cdx-hbom#26), at the same place
// relative to a local checkout as the package's exports map gives it.
const LOCAL_HBOM_MAPPER_PATH = fileURLToPath(
  new URL("../../cdx-hbom/src/common/cdx20.js", import.meta.url),
);

/**
 * The places cdx-hbom is loaded from, in order: a local checkout next to
 * cdxgen, else the installed package.
 */
export const HBOM_MODULE_LOCATIONS = Object.freeze({
  localModulePath: LOCAL_HBOM_MODULE_PATH,
  localMapperPath: LOCAL_HBOM_MAPPER_PATH,
  packageMapperSpecifier: "@cdxgen/cdx-hbom/cdx20",
});

/**
 * Resolve the optional cdx-hbom module.
 *
 * @returns {Promise<object>} Loaded cdx-hbom module namespace.
 */
export async function importHbomModule() {
  if (safeExistsSync(LOCAL_HBOM_MODULE_PATH)) {
    return await import(pathToFileURL(LOCAL_HBOM_MODULE_PATH).href);
  }
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
  return hbomModule;
}

/**
 * Load the optional CycloneDX 2.0 hardware mapper,
 * `toCdx20HardwareComponent`, from the same cdx-hbom that importHbomModule
 * loads: the local checkout when it exists (its src/common/cdx20.js), else
 * the installed package's `./cdx20` export. A cdx-hbom without the mapper
 * (the published 0.7.0 has no `./cdx20` export) or one that fails to load
 * gives null, and the 2.0 render then keeps its generic conversion.
 *
 * @param {object} [locations] Where to look; defaults to
 *   HBOM_MODULE_LOCATIONS
 * @returns {Promise<Function|null>} The mapper, or null
 */
export async function loadHardwareMapper(locations = HBOM_MODULE_LOCATIONS) {
  let specifier = locations.packageMapperSpecifier;
  if (safeExistsSync(locations.localModulePath)) {
    if (!safeExistsSync(locations.localMapperPath)) {
      return null;
    }
    specifier = pathToFileURL(locations.localMapperPath).href;
  }
  try {
    const mapperModule = await import(specifier);
    return typeof mapperModule.toCdx20HardwareComponent === "function"
      ? mapperModule.toCdx20HardwareComponent
      : null;
  } catch {
    return null;
  }
}

/** The identifier policy cdx-hbom records when raw identifiers were kept. */
export const RAW_IDENTIFIER_POLICY = "raw-identifiers-enabled";

/**
 * The identifier policy the collector recorded for the run, on the HBOM
 * subject (`metadata.component`) or in `metadata.properties`.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {string|undefined} The `cdx:hbom:identifierPolicy` value
 */
export function recordedIdentifierPolicy(internalBom) {
  for (const properties of [
    internalBom?.metadata?.component?.properties,
    internalBom?.metadata?.properties,
  ]) {
    const value = (Array.isArray(properties) ? properties : []).find(
      (property) => property?.name === "cdx:hbom:identifierPolicy",
    )?.value;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * The renderCycloneDx20 context for an internal model: the hardware mapper
 * and its identifier options when the model has a component with a
 * cdx:hbom:* property and a mapper is available, otherwise an empty context,
 * so a BOM without hardware never loads cdx-hbom. Hardware identifiers are
 * asserted only when the collector recorded `raw-identifiers-enabled` for the
 * run (it does when HBOM generation was asked to include sensitive
 * identifiers); a redacted run never yields identifiers, whichever command
 * renders it.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @param {object} [locations] Passed to loadHardwareMapper
 * @returns {Promise<{hardwareMapper?: Function, hardwareOptions?: {includeSensitiveIdentifiers: boolean, identifierPolicy?: string}}>}
 *   The render context
 */
export async function hardwareRenderContext(internalBom, locations) {
  if (!hasHardwareComponent(internalBom)) {
    return {};
  }
  const hardwareMapper = await loadHardwareMapper(locations);
  if (!hardwareMapper) {
    return {};
  }
  const identifierPolicy = recordedIdentifierPolicy(internalBom);
  const hardwareOptions = {
    includeSensitiveIdentifiers: identifierPolicy === RAW_IDENTIFIER_POLICY,
  };
  if (identifierPolicy !== undefined) {
    hardwareOptions.identifierPolicy = identifierPolicy;
  }
  return { hardwareMapper, hardwareOptions };
}

function hasHardwareComponent(internalBom) {
  const pending = [
    internalBom?.metadata?.component,
    ...(Array.isArray(internalBom?.components) ? internalBom.components : []),
  ];
  while (pending.length) {
    const component = pending.pop();
    if (!component || typeof component !== "object") {
      continue;
    }
    if (
      (component.properties || []).some((property) =>
        `${property?.name ?? ""}`.startsWith("cdx:hbom:"),
      )
    ) {
      return true;
    }
    if (Array.isArray(component.components)) {
      pending.push(...component.components);
    }
  }
  return false;
}
