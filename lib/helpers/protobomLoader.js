const PROTO_BOM_FILE_EXTENSIONS = [".cdx", ".cdx.bin", ".proto"];

/**
 * Determine whether a path looks like a CycloneDX protobuf BOM file.
 *
 * @param {string} filePath File path
 * @returns {boolean} true when the path uses a protobuf BOM extension
 */
export function isProtoBomPath(filePath) {
  const normalizedPath = `${filePath || ""}`.toLowerCase();
  return PROTO_BOM_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension),
  );
}

/**
 * Import protobuf BOM helpers and replace optional-dependency loader failures
 * with actionable command-specific messages.
 *
 * @param {string} [commandName="cdxgen"] CLI command name
 * @param {string} [featureDescription="protobuf support"] Feature being used
 * @returns {Promise<object>} Loaded protobom module namespace
 */
export async function importProtobomModule(
  commandName = "cdxgen",
  featureDescription = "protobuf support",
) {
  try {
    return await import("./protobom.js");
  } catch (error) {
    const message = `${error?.message || ""}`;
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      message.includes("@cdxgen/cdx-proto") ||
      message.includes("@bufbuild/protobuf")
    ) {
      throw new Error(
        `${commandName} ${featureDescription} requires the optional '@cdxgen/cdx-proto' and '@bufbuild/protobuf' dependencies. Install optional dependencies or use a binary that bundles protobuf support.`,
      );
    }
    throw error;
  }
}
