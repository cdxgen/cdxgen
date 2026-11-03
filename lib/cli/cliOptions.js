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

import { isSecureMode, readEnvironmentVariable } from "../core/activity.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  METADATA_PROPERTY_CONFIG_KEYS,
  parseMetadataProperties,
} from "../core/metadataProperties.js";
import { toCamel } from "../core/paths.js";
import {
  DEFAULT_CDX_SPEC_VERSION,
  normalizeCycloneDxComponentTypeFilter,
} from "../inventory/bomUtils.js";
import { isHbomOnlyProjectTypes } from "../inventory/hbom.js";

/**
 * CycloneDX spec versions accepted as generation targets in v13.
 * 1.4 and 1.5 are below the floor; output downgrade is still supported
 * internally by postgen.js.
 * @type {number[]}
 */
const ACCEPTED_SPEC_VERSIONS = [1.6, 1.7, 2.0];

/**
 * Validate the `--spec-version` value against the v13 spec floor (1.6).
 *
 * Returns `null` when the value is an accepted generation target, or an
 * actionable error string when it is rejected. The error message for
 * sub-floor versions (1.4 / 1.5) explains that output downgrade still
 * exists, so users are not left without a migration path.
 *
 * @param {number} specVersion  The parsed `--spec-version` value.
 * @param {string} [commandName]  The invoked binary name for the message.
 * @returns {string|null}  Error message, or `null` when valid.
 */
export function validateSpecVersion(specVersion, commandName = "cdxgen") {
  if (specVersion === 1.4 || specVersion === 1.5) {
    return (
      `${commandName}: --spec-version ${specVersion} is below the v13 spec floor (1.6) and is no longer accepted as a generation target. ` +
      "Accepted values: --spec-version 1.6, --spec-version 1.7, or --spec-version 2.0. " +
      `Generating with 1.6 or 1.7 produces a 1.6 or 1.7 document — it will not emit CycloneDX ${specVersion}. ` +
      `cdxgen still contains the ${specVersion} output-downgrade logic and it remains reachable by library callers that pass \`specVersion: ${specVersion}\` to createBom(); only the CLI target is restricted. ` +
      `To get a ${specVersion} document from the CLI, generate 1.6 and convert the result with an external tool such as \`cyclonedx-cli convert --output-version v1_${String(specVersion).split(".")[1]}\`. ` +
      "See MIGRATING-TO-V13.md for details."
    );
  }
  if (!ACCEPTED_SPEC_VERSIONS.includes(Number(specVersion))) {
    const shown = Number.isNaN(Number(specVersion))
      ? `'${specVersion}' (not a number)`
      : String(specVersion);
    return `${commandName}: --spec-version ${shown} is not supported. Accepted values: 1.6, 1.7, 2.0.`;
  }
  return null;
}

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
 * The formulation privacy notice, shared by every path that turns formulation
 * collection on automatically: the warning about emails and secrets is
 * identical whichever caller adds the section.
 *
 * @returns {OptionsWarning} The notice.
 */
function formulationPrivacyNotice() {
  return {
    level: "info",
    message:
      "NOTE: Automatically collecting formulation information. The section may include sensitive data such as emails and secrets.\nPlease review the generated SBOM before distribution or LLM training.",
  };
}

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
 * The value the operator gave an option on the command line or through its
 * CDXGEN_* environment variable. yargs also fills options in from defaults
 * and from a config file, which cannot be told apart in its output.
 *
 * @param {string} option kebab-case option name
 * @param {object} [context]
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @param {boolean} [context.boolean] Read the option as a boolean flag
 * @returns {string|boolean|undefined} The operator's value, or undefined
 */
export function operatorOptionChoice(
  option,
  { argv = process.argv.slice(2), env = process.env, boolean = false } = {},
) {
  const spellings = [...new Set([option, toCamel(option)])];
  const toBoolean = (value) =>
    ["true", "1"].includes(`${value}`.trim().toLowerCase());
  let choice;
  for (let i = 0; i < argv.length; i++) {
    const arg = `${argv[i]}`;
    if (arg === "--") {
      break;
    }
    for (const name of spellings) {
      if (boolean && arg === `--no-${name}`) {
        choice = false;
      } else if (arg === `--${name}`) {
        const next = argv[i + 1] === undefined ? "" : `${argv[i + 1]}`;
        if (!boolean) {
          choice = next;
          i++;
        } else if (["true", "false"].includes(next.toLowerCase())) {
          choice = toBoolean(next);
          i++;
        } else {
          choice = true;
        }
      } else if (arg.startsWith(`--${name}=`)) {
        const value = arg.slice(name.length + 3);
        choice = boolean ? toBoolean(value) : value;
      }
    }
  }
  if (choice !== undefined) {
    return choice;
  }
  const envValue =
    env[`CDXGEN_${option.toUpperCase().replaceAll("-", "_")}`] ?? "";
  if (`${envValue}`.trim() === "") {
    return undefined;
  }
  return boolean ? toBoolean(envValue) : `${envValue}`;
}

/**
 * Make the operator's choice about running the scanned project's own code
 * final. A config file is read from the working directory, which is usually
 * the scanned project, so it carries that project's trust. Neither the config
 * file nor a profile or lifecycle may turn installs on when the operator
 * disabled them, and secure mode keeps installs off unless the operator
 * passes --install-deps. Introspection keeps the project's build tools
 * running with installs off, which is likewise the operator's decision, so
 * introspection asked for only by the config file does not do that.
 *
 * **Mutates `options` in place.**
 *
 * @param {object} options The options object, after applyAdvancedOptions
 * @param {object} [context]
 * @param {object} [context.projectConfig] Sanitized config file contents
 * @param {boolean} [context.isSecureMode] Whether cdxgen runs in secure mode
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @returns {void}
 */
export function applyOperatorToolingChoice(options, context = {}) {
  const { projectConfig, argv, env } = context;
  const secureMode = context.isSecureMode ?? isSecureMode;
  const installChoice = operatorOptionChoice("install-deps", {
    argv,
    env,
    boolean: true,
  });
  if (installChoice === false || (secureMode && installChoice !== true)) {
    options.installDeps = false;
  }
  const configAsksIntrospect =
    ["true", "1"].includes(`${projectConfig?.introspect}`.toLowerCase()) ||
    projectConfig?.profile === "introspect";
  if (
    options.introspect === true &&
    configAsksIntrospect &&
    operatorOptionChoice("introspect", { argv, env, boolean: true }) !== true &&
    operatorOptionChoice("profile", { argv, env }) !== "introspect"
  ) {
    options.introspectFromConfigFile = true;
  }
}

/**
 * Combine the custom metadata properties of every source (discussion 4391):
 * the `--metadata-property` flag, the CDXGEN_METADATA_PROPERTY and
 * CDXGEN_METADATA_PROPERTIES environment variables, and a config file's
 * `metadata-property` or `metadataProperties` entry.
 *
 * yargs would let the highest-precedence source replace the others outright,
 * so each is read on its own and they are merged instead. A name set by more
 * than one source takes its values from the one that wins in the usual order
 * — the command line, then the environment, then the config file — while a
 * source may repeat a name for a multi-valued property.
 *
 * @param {object} args Parsed yargs argv
 * @param {object} [context]
 * @param {string[]} [context.argv] Raw command-line arguments, which tell a
 *   flag on the command line from one yargs filled in from elsewhere
 * @param {object} [context.projectConfig] The sanitized config file contents.
 *   Without it, a programmatic caller's `args` are taken as the config.
 * @returns {{name: string, value: string}[]} The merged properties
 */
export function resolveMetadataProperties(
  args,
  { argv = process.argv, projectConfig } = {},
) {
  const flagGiven = argv.some((argument) =>
    ["--metadata-property", "--metadataProperty"].includes(
      `${argument}`.split("=")[0],
    ),
  );
  const fromConfig = projectConfig
    ? METADATA_PROPERTY_CONFIG_KEYS.flatMap((key) =>
        parseMetadataProperties(projectConfig[key]),
      )
    : flagGiven
      ? []
      : [
          ...parseMetadataProperties(args?.metadataProperty),
          ...parseMetadataProperties(args?.metadataProperties),
        ];
  const sources = [
    flagGiven ? parseMetadataProperties(args?.metadataProperty) : [],
    [
      ...parseMetadataProperties(
        readEnvironmentVariable("CDXGEN_METADATA_PROPERTY"),
      ),
      ...parseMetadataProperties(
        readEnvironmentVariable("CDXGEN_METADATA_PROPERTIES"),
      ),
    ],
    fromConfig,
  ];
  const properties = [];
  const claimedNames = new Set();
  for (const source of sources) {
    const sourceNames = new Set();
    for (const aprop of source) {
      if (
        claimedNames.has(aprop.name) ||
        properties.some(
          (prop) => prop.name === aprop.name && prop.value === aprop.value,
        )
      ) {
        continue;
      }
      properties.push(aprop);
      sourceNames.add(aprop.name);
    }
    for (const name of sourceNames) {
      claimedNames.add(name);
    }
  }
  return properties;
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
 * @param {string[]} [context.argv]          Raw command-line arguments
 * @param {object} [context.projectConfig]   Sanitized config file contents
 * @returns {object} The initial options object
 */
/**
 * Resolve the BOM output target.
 *
 * `-` is the stdout marker and is kept literal rather than resolved to a path,
 * so downstream logic recognizes it before any sandbox check treats it as a
 * writable file. Under secure mode the default filename is resolved to an
 * absolute path so the permission prompt names a real location.
 *
 * @param {object} args Parsed CLI arguments
 * @param {object} context Resolution context
 * @param {string} context.filePath Scan path
 * @param {boolean} context.isRemoteOrPurl Whether the scan target is remote
 * @returns {string} Output path, or "-" for stdout
 */
function resolveOutputTarget(args, { filePath, isRemoteOrPurl }) {
  if (args.output === "-") {
    return "-";
  }
  if (!isSecureMode || args.output !== "bom.json") {
    return args.output;
  }
  return isRemoteOrPurl
    ? resolve(args.output)
    : resolve(join(filePath, args.output));
}

/**
 * Resolve the introspection opt-in from the flag and the environment.
 *
 * The parser maps `CDXGEN_INTROSPECT` onto the same boolean the flag sets, so
 * a value outside the documented opt-in vocabulary — an exported but empty
 * variable most of all — arrives indistinguishable from `--no-introspect`.
 * The command line is therefore the authority on refusal, and the environment
 * speaks only through `true` and `1`. An unmentioned flag stays undefined so a
 * profile can still enable it.
 *
 * @param {Object} args Parsed CLI arguments.
 * @param {string[]} argv Raw command-line arguments the parser was given.
 * @returns {boolean|undefined} The requested state, or undefined when nothing asked.
 */
function resolveIntrospectOption(args, argv) {
  const refused =
    args.introspect === false &&
    argv.some((argument) =>
      ["--no-introspect", "--introspect=false"].includes(argument),
    );
  if (refused) {
    return false;
  }
  return args.introspect === true ||
    ["true", "1"].includes(readEnvironmentVariable("CDXGEN_INTROSPECT"))
    ? true
    : undefined;
}

export function buildInitialOptions(
  args,
  { filePath, isRemoteOrPurl, argv = process.argv, projectConfig },
) {
  const metadataProperties = resolveMetadataProperties(args, {
    argv,
    projectConfig,
  });
  const res = Object.assign({}, args, {
    projectType: args.type,
    multiProject: args.recurse,
    noBabel: args.noBabel || args.babel === false,
    project: args.projectId,
    deep: args.deep || args.evidence,
    aiProvenance: args.aiProvenance,
    output: resolveOutputTarget(args, { filePath, isRemoteOrPurl }),
    exclude: args.exclude || args.excludeRegex,
    include: args.include || args.includeRegex,
    noIgnore: args.noIgnore,
    gitAiNotesRef: args.gitAiNotesRef || "refs/notes/ai",
    metadataProperties: metadataProperties.length
      ? metadataProperties
      : undefined,
    // Introspection: the flag or the documented environment opt-in. An
    // explicit --no-introspect stays `false` and beats both, while an
    // unmentioned flag stays undefined so a profile can still enable it.
    introspect: resolveIntrospectOption(args, argv),
    // License normalization and enrichment are on by default; the only escape
    // hatch is the corresponding environment variable.
    licenseEnhance:
      readEnvironmentVariable("CDXGEN_LICENSE_ENHANCE") !== "false",
    licenseEnrich: readEnvironmentVariable("CDXGEN_LICENSE_ENRICH") !== "false",
    licensePolicy:
      args.licensePolicy || readEnvironmentVariable("CDXGEN_LICENSE_POLICY"),
    licenseRef:
      args.licenseRef === true ||
      readEnvironmentVariable("CDXGEN_LICENSE_REF") === "true",
  });

  if (res.licenseEnhance !== undefined) {
    process.env.CDXGEN_LICENSE_ENHANCE = String(res.licenseEnhance);
  }
  if (res.licenseEnrich !== undefined) {
    process.env.CDXGEN_LICENSE_ENRICH = String(res.licenseEnrich);
  }
  if (res.licensePolicy !== undefined) {
    process.env.CDXGEN_LICENSE_POLICY = String(res.licensePolicy);
  } else {
    delete process.env.CDXGEN_LICENSE_POLICY;
  }
  if (res.licenseRef !== undefined) {
    process.env.CDXGEN_LICENSE_REF = String(res.licenseRef);
  }

  return res;
}

/**
 * Check whether the supplied project types include an OS inventory type
 * (`os` or an alias such as `linux`, `windows`, `macos`).
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when an OS inventory type is requested.
 */
function hasOsProjectType(projectTypes) {
  if (!projectTypes) {
    return false;
  }
  const values = Array.isArray(projectTypes) ? projectTypes : [projectTypes];
  const osTypes = new Set(["os", ...(PROJECT_TYPE_ALIASES.os || [])]);
  return values
    .flatMap((projectType) => `${projectType}`.split(","))
    .some((projectType) => osTypes.has(projectType.trim().toLowerCase()));
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
      // Crypto evidence collection analyses source code with atom, which is
      // meaningless and extremely slow for OS inventories (discussion #4310).
      // Refuse the combination and direct users to obom.
      if (hasOsProjectType(options.projectType)) {
        warnings.push({
          level: "error",
          message:
            "The cbom command does not support OS inventory project types (-t os). Use the obom command instead to generate an OBOM for an operating system installation.",
        });
        return warnings;
      }
      options.includeCrypto = true;
    }
    options.evidence = true;
    // Only set the default spec version if the user did not explicitly provide one
    if (!userSetSpecVersion) {
      options.specVersion = DEFAULT_CDX_SPEC_VERSION;
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

  // --- Introspection CI gate threshold -----------------------------------
  if (options.introspectFailBelow !== undefined) {
    const threshold = Number(options.introspectFailBelow);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      warnings.push({
        level: "error",
        message:
          "--introspect-fail-below requires a number between 0 and 100, where absent means the gate never fails.",
      });
    } else {
      options.introspectFailBelow = threshold;
    }
  }

  // When a standard is requested, the minimum spec version is 1.6
  if (options.standard) {
    if (!userSetSpecVersion) {
      options.specVersion = DEFAULT_CDX_SPEC_VERSION;
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
  const includeFormulationBeforeProfiles = options.includeFormulation === true;
  const introspectExplicitlyDisabled = options.introspect === false;

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
    case "introspect":
      options.introspect = true;
      options.introspectAnnotate = options.introspectAnnotate !== false;
      // The ledger's own record of what ran; formulation is where a consumer
      // looks for the build environment the SBOM was produced in.
      options.includeFormulation = !isHbomOnly;
      options.evidence = true;
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
      // A profile may skip installs but never turn them back on once they
      // were disabled, which would run the scanned project's code.
      options.installDeps = !secureMode && options.installDeps !== false;
      break;
    case "deep-learning":
    case "ml-deep":
      process.env.FETCH_LICENSE = "true";
      options.deep = true;
      options.evidence = true;
      options.includeCrypto = true;
      options.installDeps = !secureMode && options.installDeps !== false;
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
      // The project is already built, so installs are on only where they
      // would have been anyway: a disabled install stays disabled.
      if (options.installDeps !== false) {
        options.installDeps = true;
      }
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

  // An explicit --no-introspect negates the introspect profile's headline
  // capability while keeping the bundle's other effects: the user asked for
  // the profile minus introspection.
  if (options.profile === "introspect" && introspectExplicitlyDisabled) {
    options.introspect = false;
    warnings.push({
      level: "info",
      message:
        "NOTE: Introspection stays off because --no-introspect was passed explicitly; the other introspect profile settings still apply.",
    });
  }

  // --- Auto-formulation: BOM audit, research profile, CI, obom and cbom ----
  // Formulation supplies the generation context element of the 2026 minimum
  // elements, so it is included without a flag when an audit needs it, when
  // the research or introspect profile runs, in CI environments, and for
  // obom and cbom output (cdxgen#859).
  const profileAddsFormulation =
    ["research", "introspect"].includes(options.profile) &&
    !includeFormulationBeforeProfiles;
  const runsInCi =
    (readEnvironmentVariable("CI") || "").toLowerCase() === "true";
  const typeAddsFormulation =
    options.projectType?.includes("os") ||
    options.projectType?.includes("crypto");
  if (
    options.bomAudit ||
    profileAddsFormulation ||
    runsInCi ||
    typeAddsFormulation
  ) {
    if (isHbomOnly) {
      // HBOM-only: skip formulation
    } else if (!options.includeFormulation) {
      warnings.push(formulationPrivacyNotice());
      options.includeFormulation = true;
    } else if (profileAddsFormulation) {
      warnings.push(formulationPrivacyNotice());
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
 * @param {object} [context.projectConfig]     Sanitized config file contents,
 *                                             whose metadata properties merge
 *                                             with the other sources'
 * @returns {{ options: object, warnings: OptionsWarning[] }}
 */
export function buildOptionsFromArgs(args, context) {
  const {
    invokedCommandName,
    filePath,
    isRemoteOrPurl,
    userSetSpecVersion,
    isDryRun = false,
    projectConfig,
  } = context;

  const expandedArgs = applyCommandNameDefaults(args, invokedCommandName);
  const options = buildInitialOptions(expandedArgs, {
    filePath,
    isRemoteOrPurl,
    projectConfig,
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
