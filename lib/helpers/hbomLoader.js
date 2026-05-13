/**
 * Resolve the cdx-hbom module, preferring the local workspace checkout when the
 * installed dependency does not yet expose the newer trace API.
 *
 * @returns {Promise<object>} Loaded cdx-hbom module namespace.
 */
export async function importHbomModule() {
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
