/**
 * Pure extractor for the Terraform / OpenTofu configuration files in one
 * directory: `*.tf`, `*.tf.json`, `*.tofu` and `*.tofu.json`.
 *
 * Only three things in a configuration matter for a BOM: the `module` blocks
 * (name, `source`, `version`), the `required_providers` entries inside the
 * `terraform` block, and `required_version`. Full HCL is a much larger
 * grammar, so this module scans characters directly — comments, quoted
 * strings with `${…}`/`%{…}` template sequences, heredocs, and
 * bracket-depth-aware attribute boundaries — and skips everything else with
 * balanced matching. It never throws and always terminates: every loop either
 * consumes input or stops at EOF.
 *
 * An expression counts as a literal only when it is exactly one quoted string
 * without template sequences; module inputs, provider configuration and
 * backend settings are never captured, let alone emitted.
 */
/**
 * Parse one configuration file.
 *
 * @param {string} text File contents
 * @param {Object} [options]
 * @param {boolean} [options.json] Parse as the JSON variant (`.tf.json`)
 * @returns {{ moduleCalls: object[], requiredProviders: object[], requiredVersions: string[], errors: string[] }}
 */
export declare function parseTerraformConfig(text: string, { json }?: {
    json?: boolean;
}): {
    moduleCalls: object[];
    requiredProviders: object[];
    requiredVersions: string[];
    errors: string[];
};
/**
 * Whether a file is a Terraform override file: base name `override` or ending
 * `_override`, with a `.tf`/`.tf.json`/`.tofu`/`.tofu.json` extension.
 *
 * @param {string} fileName File name (a bare name or a path)
 * @returns {boolean}
 */
export declare function isTerraformOverrideFile(fileName: string): boolean;
/**
 * Split one directory's configuration file names into primary and override
 * files, applying OpenTofu's `.tofu` precedence when any `.tofu` file exists.
 *
 * @param {string[]} fileNames File names within a single directory
 * @returns {{ primary: string[], overrides: string[] }} Sorted lists
 */
export declare function terraformConfigFileSet(fileNames: string[]): {
    primary: string[];
    overrides: string[];
};
/**
 * Merge parsed configuration files (primary files first, then overrides, each
 * group in the given order).
 *
 * @param {{ file: string, override: boolean, result: object }[]} parsedFiles
 * @returns {{ moduleCalls: object[], requiredProviders: object[], requiredVersions: string[], errors: string[] }}
 */
export declare function mergeTerraformConfigs(parsedFiles: {
    file: string;
    override: boolean;
    result: object;
}[]): {
    moduleCalls: object[];
    requiredProviders: object[];
    requiredVersions: string[];
    errors: string[];
};
//# sourceMappingURL=terraformConfig.d.ts.map