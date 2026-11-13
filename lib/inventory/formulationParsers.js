import { randomUUID as uuidv4 } from "node:crypto";
import { basename } from "node:path";
import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import { getAllFiles } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import {
  hasInlineCredential,
  stripUrlCredentials,
} from "../core/propertySanitizer.js";
import { collectOSCryptoLibs } from "./cbomutils.js";
import { azurePipelinesParser } from "./ciParsers/azurePipelines.js";
import { circleCiParser } from "./ciParsers/circleCi.js";
import {
  readCiFile,
  recordCiParseFailure,
  sanitizeFormulationResult,
} from "./ciParsers/common.js";
import { githubActionsParser } from "./ciParsers/githubActions.js";
import { gitlabCiParser } from "./ciParsers/gitlabCi.js";
import { jenkinsParser } from "./ciParsers/jenkins.js";
import { trimComponents } from "./depsUtils.js";
import {
  dotnetProjectFormulationParser,
  formulationSourcePath,
  goModuleFormulationParser,
  makefileFormulationParser,
  pythonRequirementsFormulationParser,
} from "./ecosystemFormulationParsers.js";
import {
  collectEnvInfo,
  getBranch,
  getOriginUrl,
  gitTreeHashes,
  listFiles,
} from "./envcontext.js";
import { rustFormulationParser } from "./rustFormulationParser.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const README_PATTERNS = [
  "**/README*.{adoc,asciidoc,markdown,md,mdx,rst,txt}",
  "**/readme*.{adoc,asciidoc,markdown,md,mdx,rst,txt}",
];

function buildReadmeSecurityComponents(discoveryPath, options) {
  const matchedFiles = [];
  for (const pattern of README_PATTERNS) {
    const found = getAllFiles(discoveryPath, pattern, options);
    for (const f of found || []) {
      matchedFiles.push(f);
    }
  }
  const components = [];
  for (const filePath of [...new Set(matchedFiles)]) {
    let raw;
    try {
      raw = readCiFile(filePath, discoveryPath);
    } catch {
      continue;
    }
    const scan = scanTextForHiddenUnicode(raw, { syntax: "markdown" });
    if (!scan.hasHiddenUnicode) {
      continue;
    }
    const sourcePath = formulationSourcePath(filePath, discoveryPath);
    const properties = [
      { name: "internal:SrcFile", value: sourcePath },
      { name: "cdx:file:kind", value: "readme" },
      { name: "cdx:file:hasHiddenUnicode", value: "true" },
      {
        name: "cdx:file:hiddenUnicodeCodePoints",
        value: scan.codePoints.join(","),
      },
      {
        name: "cdx:file:hiddenUnicodeLineNumbers",
        value: scan.lineNumbers.join(","),
      },
    ];
    if (scan.inComments) {
      properties.push({
        name: "cdx:file:hiddenUnicodeInComments",
        value: "true",
      });
      properties.push({
        name: "cdx:file:hiddenUnicodeCommentCodePoints",
        value: scan.commentCodePoints.join(","),
      });
    }
    components.push({
      "bom-ref": `file:${sourcePath}`,
      name: basename(filePath),
      properties,
      type: "file",
    });
  }
  return components;
}

/**
 * The parser registry. Pre-populated with the five built-in CI system parsers.
 *
 * External parsers added via {@link registerParser} are appended here.
 *
 * Each entry must satisfy the FormulationParser contract:
 * ```
 * {
 *   id:       string,                         // unique stable identifier
 *   patterns: string[],                       // non-empty array of glob patterns for file discovery
 *   parse(files: string[], options: Object, context: { rootDir: string }):
 *                                             // synchronous function
 *     { workflows?, components?, services?, properties?, dependencies? }
 * }
 * ```
 *
 * `context.rootDir` is the scanned project root. A parser that records file
 * paths records them relative to it, so no path of the scanning machine
 * reaches the BOM.
 */
const _parsers = [
  rustFormulationParser,
  makefileFormulationParser,
  goModuleFormulationParser,
  pythonRequirementsFormulationParser,
  dotnetProjectFormulationParser,
  githubActionsParser,
  gitlabCiParser,
  jenkinsParser,
  circleCiParser,
  azurePipelinesParser,
];

// The parsers of CI configuration, whose failures a BOM audit must know of.
const CI_PARSERS = new Set([
  githubActionsParser,
  gitlabCiParser,
  jenkinsParser,
  circleCiParser,
  azurePipelinesParser,
]);

/**
 * Register an external formulation parser.
 *
 * The parser is appended to the registry and will be invoked by
 * {@link addFormulationSection} on the next call.
 *
 * @param {{ id: string, patterns: string[], parse: Function }} parser
 */
export function registerParser(parser) {
  const hasValidPatterns =
    Array.isArray(parser?.patterns) &&
    parser.patterns.length > 0 &&
    parser.patterns.every(
      (pattern) => typeof pattern === "string" && pattern.trim().length > 0,
    );
  if (
    typeof parser?.id !== "string" ||
    parser.id.trim().length === 0 ||
    !hasValidPatterns ||
    typeof parser?.parse !== "function"
  ) {
    throw new TypeError(
      "registerParser: parser must have id (string), patterns (non-empty string[]), and parse (function)",
    );
  }
  _parsers.push(parser);
}

/**
 * Return a shallow copy of the currently registered parsers.
 *
 * @returns {Array<{ id: string, patterns: string[], parse: Function }>}
 */
export function getParsers() {
  return [..._parsers];
}

/**
 * Environment-variable prefixes that the formulation section looks at. All
 * other variables are ignored.
 */
const ENV_PREFIXES = [
  "GIT_",
  "ANDROID_",
  "DENO_",
  "DOTNET_",
  "JAVA_",
  "SDKMAN_",
  "CARGO_",
  "CONDA_",
  "RUST",
  "GEM_",
  "SCALA_",
  "MAVEN_",
  "GRADLE_",
];

/**
 * Names whose values describe the build environment and carry no
 * credential: tool locations, versions and the git revision being built.
 * Every other variable under ENV_PREFIXES is recorded by name only.
 */
const ENV_VALUE_ALLOWED_NAMES = new Set([
  "CONDA_DEFAULT_ENV",
  "CONDA_SHLVL",
  "DENO_DIR",
  "DOTNET_ROOT",
  "GIT_BRANCH",
  "GIT_COMMIT",
  "GIT_DEPTH",
  "GIT_LOCAL_BRANCH",
  "GIT_PREVIOUS_COMMIT",
  "GIT_PREVIOUS_SUCCESSFUL_COMMIT",
  "GIT_STRATEGY",
  "RUSTUP_TOOLCHAIN",
]);

/**
 * Name suffixes whose values are local paths or version strings.
 */
const ENV_VALUE_ALLOWED_SUFFIXES = ["_HOME", "_PATH", "_ROOT", "_VERSION"];

/**
 * Whether the value of an environment variable may be recorded, judged by
 * its name alone.
 *
 * @param {string} name variable name
 * @returns {boolean} true for names on the allowlist
 */
function isEnvValueAllowed(name) {
  return (
    ENV_VALUE_ALLOWED_NAMES.has(name) ||
    ENV_VALUE_ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/**
 * Sub-strings that, when found (case-insensitively) in the variable *name*
 * or *value*, cause the variable to be excluded from the formulation section.
 *
 * This blocklist is intentionally conservative to avoid leaking secrets.
 * Common CI tokens and credentials patterns are enumerated explicitly.
 */
const ENV_BLOCKLIST = [
  "key",
  "token",
  "pass",
  "secret",
  "user",
  "email",
  "auth",
  "session",
  "proxy",
  "cred",
  "askpass",
  "api_key",
  "apikey",
  "private",
  "signature",
  "webhook",
  "pwd",
  "psw",
];

/**
 * Short credential words that exclude a variable when they are a whole
 * `_`-separated word of its *name*, trailing digits aside: GIT_PAT, GIT_PAT2,
 * MAVEN_REPO_PSW (the suffix the Jenkins `credentials()` helper gives a
 * password) or NEXUS_PW. As sub-strings they would also match harmless
 * names: `pat` is in GEM_PATH.
 */
const ENV_BLOCKED_NAME_WORDS = new Set([
  "jwt",
  "otp",
  "pat",
  "pin",
  "psw",
  "pw",
  "pwd",
  "sas",
  "sig",
  "usr",
]);

/**
 * Whether an environment variable name, or the value it holds, may carry a
 * credential, so that the variable is left out of the formulation section.
 *
 * @param {string} name variable name
 * @param {string} value variable value
 * @param {Set<string>} envNames names of every variable in the environment
 * @returns {boolean} true when the variable must not be recorded
 */
function isCredentialEnvVar(name, value, envNames) {
  const lowerName = name.toLowerCase();
  const lowerValue = value.toLowerCase();
  if (
    ENV_BLOCKLIST.some((b) => lowerName.includes(b) || lowerValue.includes(b))
  ) {
    return true;
  }
  if (
    lowerName
      .split("_")
      .some((word) => ENV_BLOCKED_NAME_WORDS.has(word.replace(/\d+$/, "")))
  ) {
    return true;
  }
  // The Jenkins credentials() helper sets NAME to `user:password` next to
  // NAME_USR and NAME_PSW.
  if (envNames.has(`${name}_USR`) || envNames.has(`${name}_PSW`)) {
    return true;
  }
  return hasInlineCredential(value);
}

// The project types a scan asked for, as given on the command line.
function requestedProjectTypes(options) {
  return [].concat(options?.projectType || []).flatMap((type) =>
    `${type}`
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Build the formulation section for a CycloneDX BOM.
 *
 * This function is the top-level aggregator: it collects git metadata,
 * invokes every registered CI parser, and merges the results into a single
 * CycloneDX formulation entry.
 *
 * The function falls back to a minimal stub workflow when no CI config files
 * are detected at the given path.
 *
 * @param {string} filePath         File path
 * @param {Object} options          CLI options; `options.path` is used as the
 *                                  project root for file discovery.
 * @param {Object} [context={}]     Optional context object.  If it contains a
 *                                  non-empty `formulationList` array those
 *                                  components are merged into the result.
 *
 * @returns {{ formulation: Object[], dependencies: Object[] }}
 *   `formulation` – array to be placed at `bomJson.formulation`
 *   `dependencies` – dependency objects to be merged into
 *                    `bomJson.dependencies` via `mergeDependencies`
 */
export function addFormulationSection(filePath, options, context = {}) {
  const projectPath = filePath;
  const formulation = [];
  const dependencies = [];

  // ── Git metadata ─────────────────────────────────────────────────────────
  const gitBranch = getBranch(undefined, projectPath);
  const originUrl = getOriginUrl(projectPath);
  const gitFiles = listFiles(projectPath);
  const treeHashes = gitTreeHashes(projectPath);

  let components = [];

  // Reuse any existing formulation components (e.g. from Pixi lock data)
  // See: PR #1172
  if (context?.formulationList?.length) {
    components = components.concat(trimComponents(context.formulationList));
  }

  // OmniBOR / Artifact Dependency Graph components (spec 1.6+)
  let parentOmniborId;
  let treeOmniborId;
  if (options.specVersion >= 1.6 && Object.keys(treeHashes).length === 2) {
    // treeHashes.parent is the parent commit SHA → gitoid:commit:sha1:
    // treeHashes.tree is the git tree object SHA → gitoid:tree:sha1:
    parentOmniborId = `gitoid:commit:sha1:${treeHashes.parent}`;
    treeOmniborId = `gitoid:tree:sha1:${treeHashes.tree}`;
    components.push({
      type: "file",
      name: "git-parent",
      description: "Git Parent Node.",
      "bom-ref": parentOmniborId,
      omniborId: [parentOmniborId],
      swhid: [`swh:1:rev:${treeHashes.parent}`],
    });
    components.push({
      type: "file",
      name: "git-tree",
      description: "Git Tree Node.",
      "bom-ref": treeOmniborId,
      omniborId: [treeOmniborId],
      swhid: [`swh:1:dir:${treeHashes.tree}`],
    });
    // OmniBOR linkage goes into the top-level dependencies array
    dependencies.push({ ref: parentOmniborId, provides: [treeOmniborId] });
  }

  // Git file list
  if (gitBranch && gitFiles?.length) {
    const gitFileComponents = gitFiles.map((f) =>
      options.specVersion >= 1.6
        ? {
            type: "file",
            name: f.name,
            version: f.hash,
            "bom-ref": f.omniborId,
            omniborId: [f.omniborId],
            swhid: [f.swhid],
          }
        : {
            type: "file",
            name: f.name,
            version: f.hash,
          },
    );
    components = components.concat(gitFileComponents);

    // Complete the Artifact Dependency Graph: tree → blob links
    if (options.specVersion >= 1.6 && treeOmniborId) {
      dependencies.push({
        ref: treeOmniborId,
        provides: gitFiles.map((f) => f.omniborId).filter(Boolean),
      });
    }
  }

  // The toolchains and OS crypto libraries are probed on the machine cdxgen
  // runs on. A container image or root filesystem was built elsewhere, so the
  // scanning host's tools say nothing about it.
  // Only an explicit container type counts: hasAnyProjectType treats
  // `universal` as every type, and a universal source scan runs on the host.
  const requestedTypes = requestedProjectTypes(options);
  const describesScanningHost = !requestedTypes.some((type) =>
    PROJECT_TYPE_ALIASES.oci.includes(type),
  );
  // An OS inventory (obom) describes the live host. Its path is usually the
  // working directory, such as a home directory or /, so the build-input,
  // CI and README discovery below would walk a tree that is not a project.
  const describesLiveHost =
    requestedTypes.length > 0 &&
    requestedTypes.every((type) => PROJECT_TYPE_ALIASES.os.includes(type));
  if (!describesScanningHost) {
    thoughtLog(
      "Skipping the toolchain and OS crypto library probes for formulation, since they would describe the scanning host and not the image.",
    );
  }

  // Build environment details (Java, .NET, Python, Node, GCC, Rust, Go, Ruby,
  // RubyGems, Bundler, PHP, Composer)
  const infoComponents = describesScanningHost
    ? collectEnvInfo(projectPath, options)
    : [];
  if (infoComponents?.length) {
    components = components.concat(infoComponents);
  }

  // OS crypto libraries (cbom mode). The queries also read the host's
  // certificates, authorized keys and keychain items, so they run only when
  // formulation was requested explicitly, not when CI, a profile, an OS type
  // or the cbom command turned it on, and not when includeCrypto came from a
  // request to the server instead of its operator.
  if (
    options.includeCrypto &&
    describesScanningHost &&
    !options.formulationAutomatic &&
    options.hostCryptoInventory !== false
  ) {
    const cryptoLibs = collectOSCryptoLibs(options, context?.executeOsQuery);
    if (cryptoLibs?.length) {
      components = components.concat(cryptoLibs);
    }
  }

  // ── CI parser dispatch ────────────────────────────────────────────────────
  const ciWorkflows = [];
  const ciComponents = [];
  const ciServices = [];
  const ciProperties = [];

  const discoveryPath = projectPath || ".";
  if (describesLiveHost) {
    thoughtLog(
      "Skipping build-input, CI and README discovery for formulation, since an OS inventory describes the host and not a project tree.",
    );
  }

  for (const parser of describesLiveHost ? [] : _parsers) {
    const matchedFiles = [];
    for (const pattern of parser.patterns) {
      const found = getAllFiles(discoveryPath, pattern, options);
      for (const f of found || []) {
        matchedFiles.push(f);
      }
    }
    const uniqueMatchedFiles = [...new Set(matchedFiles)];
    if (!uniqueMatchedFiles.length) {
      continue;
    }

    let result;
    try {
      // A parser copies text from the scanned files, so its output is
      // sanitized like every other BOM property.
      result = sanitizeFormulationResult(
        parser.parse(uniqueMatchedFiles, options, {
          rootDir: discoveryPath,
        }),
      );
    } catch (err) {
      // A broken parser must not kill SBOM generation
      console.warn(
        `[formulationParsers] Parser "${parser.id}" threw an error:`,
        err.message,
      );
      if (CI_PARSERS.has(parser)) {
        for (const f of uniqueMatchedFiles) {
          recordCiParseFailure(parser.id, f, err);
        }
      }
      continue;
    }

    // Appended one at a time: these lists grow with the scanned files, one
    // entry per step, beyond what a spread call can take as arguments.
    for (const workflow of result?.workflows || []) {
      ciWorkflows.push(workflow);
    }
    for (const component of result?.components || []) {
      ciComponents.push(component);
    }
    for (const service of result?.services || []) {
      ciServices.push(service);
    }
    for (const property of result?.properties || []) {
      ciProperties.push(property);
    }
    for (const dependency of result?.dependencies || []) {
      dependencies.push(dependency);
    }
  }

  // Merge CI components into the formulation component list
  if (ciComponents.length) {
    components = components.concat(ciComponents);
  }

  const readmeSecurityComponents = describesLiveHost
    ? []
    : buildReadmeSecurityComponents(discoveryPath, options);
  if (readmeSecurityComponents.length) {
    components = components.concat(readmeSecurityComponents);
  }

  // ── Environment variables ─────────────────────────────────────────────────
  let environmentVars = gitBranch?.length
    ? [{ name: "internal:GIT_BRANCH", value: gitBranch }]
    : [];

  const envNames = new Set(Object.keys(process.env));
  for (const aevar of envNames) {
    if (!ENV_PREFIXES.some((p) => aevar.startsWith(p))) {
      continue;
    }
    const value = readEnvironmentVariable(aevar) ?? "";
    if (!value.length) {
      continue;
    }
    if (
      isEnvValueAllowed(aevar) &&
      !isCredentialEnvVar(aevar, value, envNames)
    ) {
      // A tool path can still be a URL with a password before `@` or a
      // token in its query string, so only the scheme, host and path stay.
      environmentVars.push({ name: aevar, value: stripUrlCredentials(value) });
    } else {
      // Only the name: a value outside the allowlist may hold a credential
      // in a shape no check recognises.
      environmentVars.push(aevar);
    }
  }

  if (!environmentVars.length) {
    environmentVars = undefined;
  }

  // ── Assemble formulation object ───────────────────────────────────────────
  const aformulation = {
    "bom-ref": uuidv4(),
    components: trimComponents(components),
  };

  if (ciServices.length) {
    aformulation.services = ciServices;
  }

  if (ciProperties.length) {
    aformulation.properties = ciProperties;
  }

  // Use CI-detected workflows; fall back to a minimal stub when none found
  if (ciWorkflows.length) {
    aformulation.workflows = ciWorkflows;
  } else {
    let sourceInput;
    if (environmentVars) {
      sourceInput = { environmentVars };
    }
    const sourceWorkflow = {
      "bom-ref": uuidv4(),
      uid: uuidv4(),
      taskTypes: originUrl ? ["build", "clone"] : ["build"],
    };
    if (sourceInput) {
      sourceWorkflow.inputs = [sourceInput];
    }
    aformulation.workflows = [sourceWorkflow];
  }

  formulation.push(aformulation);
  return { formulation, dependencies };
}
