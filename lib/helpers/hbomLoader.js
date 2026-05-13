import { fileURLToPath, pathToFileURL } from "node:url";

import { safeExistsSync } from "./utils.js";

const LOCAL_HBOM_MODULE_URL = new URL(
  "../../cdx-hbom/index.js",
  import.meta.url,
);
const LOCAL_HBOM_MODULE_PATH = fileURLToPath(LOCAL_HBOM_MODULE_URL);

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
