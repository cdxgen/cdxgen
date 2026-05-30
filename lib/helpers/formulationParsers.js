import { readFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";

import { v4 as uuidv4 } from "uuid";

import { collectOSCryptoLibs } from "./cbomutils.js";
import { azurePipelinesParser } from "./ciParsers/azurePipelines.js";
import { circleCiParser } from "./ciParsers/circleCi.js";
import { githubActionsParser } from "./ciParsers/githubActions.js";
import { gitlabCiParser } from "./ciParsers/gitlabCi.js";
import { jenkinsParser } from "./ciParsers/jenkins.js";
import { trimComponents } from "./depsUtils.js";
import {
  collectEnvInfo,
  getBranch,
  getOriginUrl,
  gitTreeHashes,
  listFiles,
} from "./envcontext.js";
import { rustFormulationParser } from "./rustFormulationParser.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";
import { getAllFiles } from "./utils.js";

const README_PATTERNS = [
  "**/README*.{adoc,asciidoc,markdown,md,mdx,rst,txt}",
  "**/readme*.{adoc,asciidoc,markdown,md,mdx,rst,txt}",
];

function buildReadmeSecurityComponents(discoveryPath, options) {
  const matchedFiles = [];
  for (const pattern of README_PATTERNS) {
    const found = getAllFiles(discoveryPath, pattern, options);
    if (found?.length) {
      matchedFiles.push(...found);
    }
  }
  const components = [];
  for (const filePath of [...new Set(matchedFiles)]) {
    let raw;
    try {
      raw = readFileSync(filePath, { encoding: "utf-8" });
    } catch {
      continue;
    }
    const scan = scanTextForHiddenUnicode(raw, { syntax: "markdown" });
    if (!scan.hasHiddenUnicode) {
      continue;
    }
    const properties = [
      { name: "SrcFile", value: filePath },
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
      "bom-ref": `file:${filePath}`,
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
 *   parse(files: string[], options: Object):  // synchronous function
 *     { workflows?, components?, services?, properties?, dependencies? }
 * }
 * ```
 */
const _parsers = [
  rustFormulationParser,
  githubActionsParser,
  gitlabCiParser,
  jenkinsParser,
  circleCiParser,
  azurePipelinesParser,
];

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
 * Environment-variable prefixes whose values are safe to include in the
 * formulation section.  All other variables are ignored.
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
];

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

  // Build environment details (Java, .NET, Python, Node, GCC, Rust, Go, Ruby)
  const infoComponents = collectEnvInfo(projectPath);
  if (infoComponents?.length) {
    components = components.concat(infoComponents);
  }

  // OS crypto libraries (cbom mode)
  if (options.includeCrypto) {
    const cryptoLibs = collectOSCryptoLibs(options);
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

  for (const parser of _parsers) {
    const matchedFiles = [];
    for (const pattern of parser.patterns) {
      const found = getAllFiles(discoveryPath, pattern, options);
      if (found?.length) {
        matchedFiles.push(...found);
      }
    }
    const uniqueMatchedFiles = [...new Set(matchedFiles)];
    if (!uniqueMatchedFiles.length) {
      continue;
    }

    let result;
    try {
      result = parser.parse(uniqueMatchedFiles, options);
    } catch (err) {
      // A broken parser must not kill SBOM generation
      console.warn(
        `[formulationParsers] Parser "${parser.id}" threw an error:`,
        err.message,
      );
      continue;
    }

    if (result?.workflows?.length) {
      ciWorkflows.push(...result.workflows);
    }
    if (result?.components?.length) {
      ciComponents.push(...result.components);
    }
    if (result?.services?.length) {
      ciServices.push(...result.services);
    }
    if (result?.properties?.length) {
      ciProperties.push(...result.properties);
    }
    if (result?.dependencies?.length) {
      dependencies.push(...result.dependencies);
    }
  }

  // Merge CI components into the formulation component list
  if (ciComponents.length) {
    components = components.concat(ciComponents);
  }

  const readmeSecurityComponents = buildReadmeSecurityComponents(
    discoveryPath,
    options,
  );
  if (readmeSecurityComponents.length) {
    components = components.concat(readmeSecurityComponents);
  }

  // ── Environment variables ─────────────────────────────────────────────────
  let environmentVars = gitBranch?.length
    ? [{ name: "GIT_BRANCH", value: gitBranch }]
    : [];

  for (const aevar of Object.keys(process.env)) {
    const lower = aevar.toLowerCase();
    const value = process.env[aevar] ?? "";
    if (
      ENV_PREFIXES.some((p) => aevar.startsWith(p)) &&
      !ENV_BLOCKLIST.some((b) => lower.includes(b)) &&
      !ENV_BLOCKLIST.some((b) => value.toLowerCase().includes(b)) &&
      value.length
    ) {
      environmentVars.push({ name: aevar, value });
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
