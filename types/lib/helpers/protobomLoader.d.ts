/**
 * Determine whether a path looks like a CycloneDX protobuf BOM file.
 *
 * @param {string} filePath File path
 * @returns {boolean} true when the path uses a protobuf BOM extension
 */
export function isProtoBomPath(filePath: string): boolean;
/**
 * Import protobuf BOM helpers and replace optional-dependency loader failures
 * with actionable command-specific messages.
 *
 * @param {string} [commandName="cdxgen"] CLI command name
 * @param {string} [featureDescription="protobuf support"] Feature being used
 * @returns {Promise<object>} Loaded protobom module namespace
 */
export function importProtobomModule(commandName?: string, featureDescription?: string): Promise<object>;
//# sourceMappingURL=protobomLoader.d.ts.map