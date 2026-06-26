/**
 * CLI argument → options conversion for cdxgen.
 *
 * Extracts the complex arg-to-options mapping from `bin/cdxgen.js` into
 * pure, testable functions with no side-effects (no process.exit, no
 * console output).
 *
 * Architecture note: This module is a helper and must NOT import from
 * `lib/cli/index.js` or `lib/stages/`. See AGENTS.md "Module layering
 * rules".
 *
 */

import { join, resolve } from "node:path";

import { normalizeCycloneDxComponentTypeFilter } from "../helpers/bomUtils.js";
import { isHbomOnlyProjectTypes } from "../helpers/hbom.js";
import { isSecureMode } from "../helpers/utils.js";

/**
 * The set of valid CycloneDX lifecycle values for the `post-build`
 * lifecycle that have dedicated SBOM support.
 * @type {ReadonlySet<string>}
 */
const POST_BUILD_SUPPORTED_PROJECT_TYPES = new Set([
  "csharp",
  "dotnet",
  "container",
  "docker",
  "podman",
  "oci",
  "android",
  "apk",
  "aab",
  "go",
  "golang",
  "rust",
  "rust-lang",
  "cargo",
  "caxa",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a value was explicitly provided by the user (i.e., is not
 * the yargs default). Yargs always populates default values, so we cannot
 * simply check for truthiness.
 *
 * We detect "user-provided" by checking whether the actual value differs
 * from the declared yargs default. This is robust for primitive types
 * (number, string, boolean) which is the case for all cdxgen CLI flags.
 *
 * @param {*} value    The value from the parsed args
 * @param {*} yaDefault The default declared in yargs `.option()`
 * @returns {boolean}  True when the user explicitly set this flag
 */
export function isUserProvided(value, yaDefault) {
  return value !== undefined && value !== yaDefault;
}

/**
 * Apply command-name-based defaults to the raw parsed args. When cdxgen is
 * invoked via a symlink or alias (e.g. `obom`, `cbom`, `spdxgen`, `aibom`),
 * certain args receive implicit values.
 *
 * **Pure function** — returns a shallow copy of `args` with mutations; the
 * original `args` object is not modified.
 *
 * @param {object} args               Parsed yargs argv
 * @param {string} invokedCommandName Binary name without extension
 * @returns {object} A shallow copy of args with alias-based defaults applied
 */
export function applyCommandNameDefaults(args, invokedCommandName) {
  const result = { ...args };

  if (invokedCommandName.includes("obom") && !result.type) {
    result.type = ["os"];
  }
  if (invokedCommandName.includes("spdxgen") && !result.format) {
    result.format = "spdx";
  }
  if (invokedCommandName.includes("aibom") && !result.type) {
    result.type = ["ai"];
    result.includeFormulation = true;
    if (!result.bomAuditCategories) {
      result.bomAuditCategories = "ai-bom";
    }
  }

  return result;
}

/**
 * Build the initial `options` object from parsed CLI args. This performs
 * the field renames and derived-value computations that create the shape
 * expected by `createBom`.
 *
 * @param {object} args               Parsed yargs argv (after command-name
 *                                    defaults have been applied)
 * @param {object} context
 * @param {string} context.filePath          Resolved source path
 * @param {boolean} context.isRemoteOrPurl   True when source is a URL or purl
 * @returns {object} The initial options object
 */
export function buildInitialOptions(args, { filePath, isRemoteOrPurl }) {
  return Object.assign({}, args, {
    projectType: args.type,
    multiProject: args.recurse,
    noBabel: args.noBabel || args.babel === false,
    project: args.projectId,
    deep: args.deep || args.evidence,
    output:
      isSecureMode && args.output === "bom.json"
        ? isRemoteOrPurl
          ? resolve(args.output)
          : resolve(join(filePath, args.output))
        : args.output,
    exclude: args.exclude || args.excludeRegex,
    include: args.include || args.includeRegex,
    noIgnore: args.noIgnore,
  });
}

/**
 * @typedef {object} OptionsWarning
 * @property {"info"|"warn"|"error"} level   Severity level
 * @property {string}                message Human-readable description
 */

/**
 * Apply command-specific, standard, and security overrides to the options
 * object. This covers:
 *
 * - Dedup of `projectType`
 * - `cbom` / `saasbom` command overrides
 * - `cdxgen-secure` mode
 * - Dry-run mode
 * - Standards-driven specVersion default
 * - HBOM formulation suppression
 *
 * **Mutates `options` in place** and returns a list of warnings that the
 * caller should surface to the user (e.g. via `console.warn`).
 *
 * @param {object} options               The options object from Phase 2
 * @param {object} context
 * @param {string} context.invokedCommandName  Binary name (e.g. "cbom")
 * @param {boolean} context.userSetSpecVersion True when the user explicitly
 *                                             passed `--spec-version`
 * @param {boolean} [context.isDryRun=false]   Current dry-run state
 * @returns {OptionsWarning[]} Warnings to surface to the user
 */
export function applyPostConstructionOverrides(options, context) {
  const { invokedCommandName, userSetSpecVersion, isDryRun = false } = context;
  const warnings = [];

  if (options.projectType && Array.isArray(options.projectType)) {
    options.projectType = Array.from(new Set(options.projectType));
  }

  // --- cbom / saasbom command overrides ----------------------------------
  if (["cbom", "saasbom"].includes(invokedCommandName)) {
    if (invokedCommandName.includes("cbom")) {
      if (normalizeCycloneDxComponentTypeFilter(options.componentType).length) {
        warnings.push({
          level: "error",
          message:
            "The cbom command does not support --component-type. Use cdxgen with --include-crypto when you need component-type filtering.",
        });
      }
      options.includeCrypto = true;
    }
    options.evidence = true;
    // Only set specVersion to 1.7 if the user did not explicitly provide one
    if (!userSetSpecVersion) {
      options.specVersion = 1.7;
    }
    options.deep = true;
  }

  // --- cdxgen-secure command overrides -----------------------------------
  if (invokedCommandName.includes("cdxgen-secure")) {
    warnings.push({
      level: "info",
      message:
        "NOTE: Secure mode only restricts cdxgen from performing certain activities such as package installation. It does not provide security guarantees in the presence of malicious code.",
    });
    options.installDeps = false;
  }

  // --- Dry-run mode overrides --------------------------------------------
  if (isDryRun) {
    options.installDeps = false;
  }

  // When a standard is requested, the minimum spec version is 1.6
  if (options.standard) {
    if (!userSetSpecVersion) {
      options.specVersion = 1.7;
    } else if (options.specVersion < 1.6) {
      warnings.push({
        level: "warn",
        message:
          "WARNING: Standards (definition.standards) requires CycloneDX specifications version 1.6 or above. Overriding the version to 1.6 automatically.",
      });
      options.specVersion = 1.6;
    }
  }

  // --- HBOM formulation suppression --------------------------------------
  const isHbomOnly = isHbomOnlyProjectTypes(options.projectType);
  if (options.includeFormulation && isHbomOnly) {
    warnings.push({
      level: "info",
      message:
        "NOTE: Ignoring formulation collection for HBOM-only invocations because the resulting hardware BOM does not need workflow or dependency-tree enrichment.",
    });
    options.includeFormulation = false;
  } else if (options.includeFormulation) {
    if (options.serverUrl) {
      warnings.push({
        level: "warn",
        message: `WARNING: The formulation section may include sensitive data such as emails and secrets. This data will be submitted to '${options.serverUrl}' automatically.`,
      });
    } else {
      warnings.push({
        level: "info",
        message:
          "NOTE: The formulation section may include sensitive data such as emails and secrets.\nPlease review the generated SBOM before distribution or LLM training.",
      });
    }
  }

  return warnings;
}

/**
 * Apply advanced option expansion based on `profile`, `lifecycle`, and
 * `technique` settings. This is the extracted form of the
 * `applyAdvancedOptions()` function that was previously inline in
 * `bin/cdxgen.js`.
 *
 * **Mutates `options` in place.**
 *
 * Design note: Several profiles unconditionally override user flags like
 * `deep`, `evidence`, and `installDeps`. This is intentional — the profile
 * is a "meta-flag" that sets a curated combination. When users select a
 * profile, they opt into its opinionated defaults.
 *
 * @param {object} options    The options object
 * @param {object} [context]
 * @param {boolean} [context.isSecureMode]  Whether cdxgen runs in secure mode
 * @returns {OptionsWarning[]} Warnings for the caller
 */
export function applyAdvancedOptions(options, context = {}) {
  const secureMode = context.isSecureMode ?? isSecureMode;
  const warnings = [];
  const isHbomOnly = isHbomOnlyProjectTypes(options.projectType);

  // --- Profile expansion -------------------------------------------------
  switch (options.profile) {
    case "appsec":
      options.deep = true;
      options.bomAudit = true;
      break;
    case "research":
      options.deep = true;
      options.evidence = true;
      options.includeCrypto = true;
      break;
    case "operational":
      if (options?.projectType) {
        // Avoid duplicate "os" entries when the user already specified it
        if (!options.projectType.includes("os")) {
          options.projectType.push("os");
        }
      } else {
        options.projectType = ["os"];
      }
      options.bomAudit = true;
      break;
    case "threat-modeling":
      options.deep = true;
      options.evidence = true;
      options.bomAudit = true;
      break;
    case "license-compliance":
      process.env.FETCH_LICENSE = "true";
      break;
    case "ml-tiny":
      process.env.FETCH_LICENSE = "true";
      options.deep = false;
      options.evidence = false;
      options.includeCrypto = false;
      options.installDeps = false;
      options.bomAudit = false;
      break;
    case "machine-learning":
    case "ml":
      process.env.FETCH_LICENSE = "true";
      options.deep = true;
      options.evidence = false;
      options.includeCrypto = false;
      options.installDeps = !secureMode;
      break;
    case "deep-learning":
    case "ml-deep":
      process.env.FETCH_LICENSE = "true";
      options.deep = true;
      options.evidence = true;
      options.includeCrypto = true;
      options.installDeps = !secureMode;
      options.bomAudit = true;
      break;
    default:
      break;
  }

  // --- Lifecycle expansion -----------------------------------------------
  switch (options.lifecycle) {
    case "pre-build":
      options.installDeps = false;
      break;
    case "post-build":
      if (
        !options.projectType ||
        !POST_BUILD_SUPPORTED_PROJECT_TYPES.has(options.projectType[0])
      ) {
        warnings.push({
          level: "error",
          message:
            "PREVIEW: post-build lifecycle SBOM generation is supported only for limited project types.",
        });
      }
      options.installDeps = true;
      break;
    default:
      break;
  }

  // --- Technique expansion -----------------------------------------------
  if (options?.technique && Array.isArray(options.technique)) {
    if (options.technique.includes("source-code-analysis")) {
      options.deep = true;
      options.evidence = true;
    }
  }

  // --- BOM audit → auto-formulation --------------------------------------
  if (options.bomAudit) {
    if (isHbomOnly) {
      // HBOM-only: skip formulation
    } else if (!options.includeFormulation) {
      warnings.push({
        level: "info",
        message:
          "NOTE: Automatically collecting formulation information. The section may include sensitive data such as emails and secrets.\nPlease review the generated SBOM before distribution or LLM training.",
      });
      options.includeFormulation = true;
    }
  }

  return warnings;
}

/**
 * Build the complete `options` object from parsed CLI arguments.
 *
 * This is the single entry point that replaces the ~330 lines of inline
 * imperative code in `bin/cdxgen.js`. It orchestrates all four phases:
 *
 * 1. Command-name alias expansion
 * 2. Initial options construction (field renames, derived values)
 * 3. Post-construction overrides (dedup, command flags, specVersion)
 * 4. Advanced options (profile, lifecycle, technique)
 *
 * Returns both the options object and a list of warnings that the caller
 * (typically `bin/cdxgen.js`) should surface to the user.
 *
 * @param {object} args               Raw parsed yargs argv
 * @param {object} context
 * @param {string} context.invokedCommandName  Binary name without extension
 * @param {string} context.filePath            Resolved source path
 * @param {boolean} context.isRemoteOrPurl     True for URL/purl sources
 * @param {boolean} context.userSetSpecVersion True when the user explicitly
 *                                             passed `--spec-version`
 * @param {boolean} [context.isDryRun=false]   Dry-run mode
 * @param {boolean} [context.isSecureMode]     Secure mode
 * @returns {{ options: object, warnings: OptionsWarning[] }}
 */
export function buildOptionsFromArgs(args, context) {
  const {
    invokedCommandName,
    filePath,
    isRemoteOrPurl,
    userSetSpecVersion,
    isDryRun = false,
  } = context;

  const expandedArgs = applyCommandNameDefaults(args, invokedCommandName);
  const options = buildInitialOptions(expandedArgs, {
    filePath,
    isRemoteOrPurl,
  });
  const phase3Warnings = applyPostConstructionOverrides(options, {
    invokedCommandName,
    userSetSpecVersion,
    isDryRun,
  });
  const phase4Warnings = applyAdvancedOptions(options, {
    isSecureMode: context.isSecureMode,
  });

  return {
    options,
    warnings: [...phase3Warnings, ...phase4Warnings],
  };
}
