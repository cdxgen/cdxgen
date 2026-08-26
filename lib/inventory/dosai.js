import { readFileSync } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";

import { DEBUG_MODE } from "../core/activity.js";
import {
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeWriteSync,
} from "../core/fs.js";
import {
  addDosaiSetValue,
  buildDosaiPurlAliasMap,
  dosaiSourceLocation,
  dosaiSourceLocationFromNode,
  resolveDosaiComponentPurl,
} from "./dosaiParsers.js";
import { resolvePluginBinary } from "./plugins.js";

const DOTNET_LANGUAGES = new Set([
  "c#",
  "csharp",
  "cs",
  "dotnet",
  "dotnet-framework",
  "f#",
  "fsharp",
  "fs",
  "nuget",
  "vb",
  "vbnet",
  "visualbasic",
]);

const DOSAI_COMMANDS = new Set(["crypto", "dataflows", "methods"]);

function dosaiBin() {
  return resolvePluginBinary("dosai");
}

function frameFromDosaiNode(node) {
  if (!node) {
    return undefined;
  }
  const fullFilename =
    node.Path || node.FileName || node.CallLocation?.FileName;
  if (!fullFilename || fullFilename === "<unknown>") {
    return undefined;
  }
  return {
    package: node.Namespace || "",
    module: node.ClassName || node.Module || "",
    function: node.MethodName || node.Name || node.CalledMethodName || "",
    line: node.LineNumber || node.CallLocation?.LineNumber || undefined,
    column: node.ColumnNumber || node.CallLocation?.ColumnNumber || undefined,
    fullFilename,
  };
}

function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (
    !properties.some(
      (property) => property.name === name && property.value === String(value),
    )
  ) {
    properties.push({ name, value: String(value) });
  }
}

function sanitizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsedUrl = new URL(value);
      parsedUrl.username = "";
      parsedUrl.password = "";
      parsedUrl.search = "";
      parsedUrl.hash = "";
      return parsedUrl.toString();
    } catch (_err) {
      return undefined;
    }
  }
  const routePath = value.split("?")[0].split("#")[0].slice(0, 512);
  // ASP.NET route templates carry `[controller]` tokens and `{id}` parameters.
  // CycloneDX types `services[].endpoints[]` as an iri-reference, where square
  // brackets are reserved for IPv6 literals and braces are excluded outright,
  // so the template is percent-encoded before it reaches the BOM.
  const encodedPath = routePath.replace(
    /[[\]{}]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodedPath;
}

function serviceNameFromEndpoint(endpoint) {
  const className = endpoint.ClassName || endpoint.FileName || "dotnet";
  const methodName = endpoint.MethodName || endpoint.HttpMethod || "endpoint";
  return `dosai-${className}-${methodName}-service`
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-");
}

function dosaiSdkMessage(result) {
  return (
    result?.stdout?.includes(
      "You must install or update .NET to run this application",
    ) ||
    result?.stderr?.includes(
      "You must install or update .NET to run this application",
    )
  );
}

function safeDosaiPath(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return resolve(value);
}

function safeDosaiPatternPacks(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return value
    .split(delimiter)
    .map((patternPack) => safeDosaiPath(patternPack.trim()))
    .filter(Boolean)
    .join(delimiter);
}

function safeDosaiExecutable(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return value.trim();
}

/**
 * Check whether a language is a .NET language supported by dosai analysis.
 *
 * @param {string} language Project type or language name
 * @returns {boolean} True when the language maps to a supported .NET/dotnet identifier
 */
export function isDosaiDotnetLanguage(language) {
  return DOTNET_LANGUAGES.has(String(language || "").toLowerCase());
}

/**
 * Read and parse a dosai JSON output file.
 *
 * @param {string} jsonFile Path to the dosai JSON file
 * @returns {Object|undefined} Parsed JSON content, or undefined when missing or invalid
 */
export function readDosaiJsonFile(jsonFile) {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(jsonFile, "utf-8"));
  } catch (_err) {
    return undefined;
  }
}

/**
 * Run a dosai subcommand ("methods", "dataflows", or "crypto") against a source
 * tree and write its JSON output to the given file.
 *
 * @param {string} command Dosai subcommand to execute
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the dosai JSON output is written
 * @param {Object} [options] Options carrying dosaiCommand, dataFlowPatterns, or patternPacks overrides
 * @returns {boolean} True when the command succeeded and produced the output file, false otherwise
 */
export function runDosaiCommand(command, src, outputFile, options = {}) {
  if (!DOSAI_COMMANDS.has(command)) {
    return false;
  }
  const executable = safeDosaiExecutable(options.dosaiCommand || dosaiBin());
  const srcPath = safeDosaiPath(src);
  const outputPath = safeDosaiPath(outputFile);
  if (!executable || !srcPath || !outputPath) {
    return false;
  }
  const args = [command, "--path", srcPath, "--o", outputPath];
  if (command === "dataflows") {
    if (options.dataFlowPatterns) {
      const patternsPath = safeDosaiPath(options.dataFlowPatterns);
      if (patternsPath) {
        args.push("--patterns", patternsPath);
      }
    }
    if (options.dataFlowPatternPacks || options.patternPacks) {
      const patternPacks = safeDosaiPatternPacks(
        options.dataFlowPatternPacks || options.patternPacks,
      );
      if (patternPacks) {
        args.push("--pattern-packs", patternPacks);
      }
    }
  } else if (command === "crypto") {
    args.push("--format", "dosai");
  }
  if (DEBUG_MODE) {
    console.log("Executing", executable, args.join(" "));
  }
  const result = safeSpawnSync(executable, args, {
    cwd: srcPath,
    shell: false,
  });
  if (dosaiSdkMessage(result)) {
    console.log(
      "Dotnet SDK is not installed. Please use the cdxgen dotnet container images to analyze this project with dosai.",
    );
    console.log(
      "Alternatively, download the dosai self-contained binary (-full suffix) from https://github.com/owasp-dep-scan/dosai/releases and set DOSAI_CMD to its location.",
    );
  }
  if (result?.status !== 0 || result?.error || !safeExistsSync(outputPath)) {
    if (DEBUG_MODE) {
      if (result?.stderr || result?.stdout) {
        console.error(result.stdout, result.stderr);
      } else {
        console.log("Check if the dosai plugin was installed successfully.");
      }
    }
    return false;
  }
  return true;
}

/**
 * Produce the dosai methods (call graph) slice for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the methods slice JSON is written
 * @param {Object} [options] Options forwarded to runDosaiCommand
 * @returns {boolean} True when the slice was produced successfully
 */
export function createDosaiMethodsSlice(src, outputFile, options = {}) {
  return runDosaiCommand("methods", src, outputFile, options);
}

/**
 * Produce the dosai data-flow slice for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the data-flow slice JSON is written
 * @param {Object} [options] Options carrying dataFlowPatterns or patternPacks overrides
 * @returns {boolean} True when the slice was produced successfully
 */
export function createDosaiDataFlowSlice(src, outputFile, options = {}) {
  return runDosaiCommand("dataflows", src, outputFile, options);
}

/**
 * Produce the dosai crypto analysis output for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the crypto analysis JSON is written
 * @param {Object} [options] Options forwarded to runDosaiCommand
 * @returns {boolean} True when the analysis was produced successfully
 */
export function createDosaiCryptoAnalysis(src, outputFile, options = {}) {
  return runDosaiCommand("crypto", src, outputFile, options);
}

/**
 * Run dosai crypto analysis in a temporary directory and return the parsed result.
 *
 * @param {string} src Source directory to analyze
 * @param {Object} [options] Options forwarded to createDosaiCryptoAnalysis
 * @returns {Object|undefined} Parsed crypto analysis JSON, or undefined when the analysis fails
 */
export function analyzeDosaiCrypto(src, options = {}) {
  const tempDir = safeMkdtempSync(join(getTmpDir(), "dosai-crypto-"));
  const outputFile = join(tempDir, "dosai-crypto.json");
  try {
    if (!createDosaiCryptoAnalysis(src, outputFile, options)) {
      return undefined;
    }
    return readDosaiJsonFile(outputFile);
  } finally {
    if (tempDir?.startsWith(getTmpDir())) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Build the combined native dosai report object persisted for downstream tools.
 *
 * dosai produces TWO native artifacts (methods + dataflows); we wrap them under
 * a single object that carries the producer Metadata plus both sections so
 * downstream consumers (depscan) read one source of truth. The Metadata is
 * taken from the data-flow slice (richest) and falls back to the methods slice.
 * Native/PascalCase keys are preserved losslessly.
 */
function buildCombinedDosaiReport(methodsSlice, dataFlowSlice) {
  const metadata = dataFlowSlice?.Metadata ||
    methodsSlice?.Metadata || {
      Tool: "Dosai",
    };
  return {
    Metadata: metadata,
    methods: methodsSlice || {},
    dataflows: dataFlowSlice || {},
  };
}

/**
 * Persist the combined native dosai report to options.semanticsSlicesFile.
 *
 * Mirrors the rusi/golem persistence contract (analyzeRusiProject /
 * analyzeGolemProject on branch feat/rusi-persist-report): when a semantics-
 * slices path is provided, the FULL native report is written there and kept so
 * downstream tools (depscan) can consume the complete methods + data-flow
 * facts that cdxgen only projects a subset of into the SBOM evidence. dotnet
 * does not otherwise use the semantics slice (atom is never run for dotnet),
 * so the path is free to carry the combined dosai report. Returns the resolved
 * durable path when something was persisted, otherwise undefined.
 */
export function persistDosaiSemanticsReport(
  options,
  methodsSlice,
  dataFlowSlice,
) {
  const durablePath = options?.semanticsSlicesFile
    ? resolve(options.semanticsSlicesFile)
    : undefined;
  if (!durablePath) {
    return undefined;
  }
  if (
    (!methodsSlice || !Object.keys(methodsSlice).length) &&
    (!dataFlowSlice || !Object.keys(dataFlowSlice).length)
  ) {
    return undefined;
  }
  const combined = buildCombinedDosaiReport(methodsSlice, dataFlowSlice);
  safeWriteSync(durablePath, JSON.stringify(combined));
  return durablePath;
}

/**
 * Build a purl alias map for a list of components.
 *
 * @param {Object[]} [components] Component objects with purl fields
 * @returns {Map<string, string>} Map of exact purls and normalized type/namespace/name keys to canonical purls
 */
export function buildPurlAliasMap(components = []) {
  return buildDosaiPurlAliasMap(components);
}

/**
 * Resolve a possibly-aliased purl to the canonical component purl.
 *
 * @param {string} purl Purl from a dosai report
 * @param {Map<string, string>} purlAliasMap Alias map built by buildPurlAliasMap
 * @returns {string|undefined} Canonical component purl, the input purl when unaliased, or undefined when empty
 */
export function resolveComponentPurl(purl, purlAliasMap) {
  return resolveDosaiComponentPurl(purl, purlAliasMap);
}

/**
 * Map a dosai methods slice to per-purl occurrence evidence.
 *
 * Extracts source locations, imported modules, and called methods from the
 * Dependencies and PackageReachability sections of the slice.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @returns {Object} Object with purlLocationMap, purlModulesMap, and purlMethodsMap keyed by purl
 */
export function collectDosaiPurlEvidence(methodsSlice, components = []) {
  const purlAliasMap = buildPurlAliasMap(components);
  const purlLocationMap = {};
  const purlModulesMap = {};
  const purlMethodsMap = {};
  const edgesById = new Map(
    (methodsSlice?.CallGraph?.Edges || []).map((edge) => [edge.Id, edge]),
  );
  const nodesById = new Map(
    (methodsSlice?.CallGraph?.Nodes || []).map((node) => [node.Id, node]),
  );

  for (const dependency of methodsSlice?.Dependencies || []) {
    const purl = resolveComponentPurl(dependency.Purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    addDosaiSetValue(purlLocationMap, purl, dosaiSourceLocation(dependency));
    addDosaiSetValue(
      purlModulesMap,
      purl,
      dependency.Name || dependency.Namespace,
    );
  }

  for (const reachability of methodsSlice?.PackageReachability || []) {
    const purl = resolveComponentPurl(reachability.Purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    let hasExplicitSourceLocations = false;
    for (const sourceLocation of reachability.SourceLocations || []) {
      const location = dosaiSourceLocation(sourceLocation);
      addDosaiSetValue(purlLocationMap, purl, location);
      hasExplicitSourceLocations ||= Boolean(location);
    }
    for (const edgeId of reachability.EdgeIds || []) {
      const edge = edgesById.get(edgeId);
      if (!hasExplicitSourceLocations) {
        addDosaiSetValue(purlLocationMap, purl, dosaiSourceLocation(edge));
      }
      addDosaiSetValue(
        purlMethodsMap,
        purl,
        edge?.CalledMethodName || edge?.TargetName,
      );
    }
    for (const nodeId of reachability.NodeIds || []) {
      const node = nodesById.get(nodeId);
      if (!hasExplicitSourceLocations) {
        addDosaiSetValue(
          purlLocationMap,
          purl,
          dosaiSourceLocationFromNode(node),
        );
      }
      addDosaiSetValue(purlModulesMap, purl, node?.ClassName || node?.Module);
      addDosaiSetValue(
        purlMethodsMap,
        purl,
        node?.Name || node?.Identity?.MethodName,
      );
    }
  }
  return { purlLocationMap, purlModulesMap, purlMethodsMap };
}

/**
 * Extract data-flow call frames per component purl from a dosai data-flow result.
 *
 * Frames are derived from slice and PackageReachability node ids, and grouped
 * under every purl referenced by each flow (source, sink, and intermediate).
 *
 * @param {Object} dataFlowResult Parsed dosai data-flow slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @returns {Object} Map of canonical purl to arrays of call-stack frame objects
 */
export function collectDosaiDataFlowFrames(dataFlowResult, components = []) {
  const purlAliasMap = buildPurlAliasMap(components);
  const nodesById = new Map(
    (dataFlowResult?.Nodes || []).map((node) => [node.Id, node]),
  );
  const dataFlowFrames = {};
  const addFramesForPurl = (purl, frames) => {
    const componentPurl = resolveComponentPurl(purl, purlAliasMap);
    if (!componentPurl || !frames.length) {
      return;
    }
    dataFlowFrames[componentPurl] ??= [];
    dataFlowFrames[componentPurl].push(frames);
  };

  for (const slice of dataFlowResult?.Slices || []) {
    const frames = (slice.NodeIds || [])
      .map((nodeId) => frameFromDosaiNode(nodesById.get(nodeId)))
      .filter(Boolean);
    const purls = new Set(
      [...(slice.Purls || []), slice.SourcePurl, slice.SinkPurl].filter(
        Boolean,
      ),
    );
    for (const purl of purls) {
      addFramesForPurl(purl, frames);
    }
  }

  for (const reachability of dataFlowResult?.PackageReachability || []) {
    const frames = (reachability.NodeIds || [])
      .map((nodeId) => frameFromDosaiNode(nodesById.get(nodeId)))
      .filter(Boolean);
    addFramesForPurl(reachability.Purl, frames);
  }
  return dataFlowFrames;
}

/**
 * Consume dosai's AiComponents[] inventory (schema 4.0.0): model identifiers,
 * on-disk model artifacts with hashes, MCP tools, prompts (redacted), and agents
 * become CycloneDX machine-learning-model / data components with modelCard data.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Array} [components] Component list to mutate in place
 * @returns {Array} The updated component list
 */
export function collectDosaiAiComponents(methodsSlice, components = []) {
  for (const ai of methodsSlice?.AiComponents || []) {
    if (!ai?.Id || !ai?.Name) {
      continue;
    }
    if (components.some((c) => c["bom-ref"] === ai.Id)) {
      continue;
    }
    if (ai.Kind === "model") {
      const modelCard = {
        modelParameters: {},
      };
      if (ai.Task) {
        modelCard.modelParameters.task = ai.Task;
      }
      if (ai.ArchitectureFamily) {
        modelCard.modelParameters.architectureFamily = ai.ArchitectureFamily;
      }
      if (ai.ModelArchitecture) {
        modelCard.modelArchitecture = ai.ModelArchitecture;
      }
      if (Array.isArray(ai.InputFormats) && ai.InputFormats.length) {
        modelCard.modelParameters.inputs = ai.InputFormats.map((format) => ({
          format,
        }));
      }
      if (Array.isArray(ai.OutputFormats) && ai.OutputFormats.length) {
        modelCard.modelParameters.outputs = ai.OutputFormats.map((format) => ({
          format,
        }));
      }
      const component = {
        "bom-ref": ai.Id,
        type: "machine-learning-model",
        name: ai.Name,
        version: ai.Version,
        purl: ai.Purl,
        modelCard,
        properties: [
          { name: "cdx:ai:provider", value: ai.Provider || "unknown" },
          { name: "cdx:ai:deployment", value: ai.Deployment || "unknown" },
        ],
      };
      if (ai.Sha256) {
        component.hashes = [{ alg: "SHA-256", content: ai.Sha256 }];
      }
      if (ai.FilePath) {
        component.properties.push({
          name: "cdx:ai:modelFile",
          value: ai.FilePath,
        });
      }
      components.push(component);
    } else if (ai.Kind === "prompt" || ai.Kind === "dataset") {
      components.push({
        "bom-ref": ai.Id,
        type: "data",
        name: ai.Name,
        properties: [
          { name: "cdx:ai:kind", value: ai.Kind },
          ...(ai.PromptText
            ? [{ name: "cdx:ai:promptText", value: ai.PromptText }]
            : []),
          ...(Object.entries(ai.Properties || {}).map(([name, value]) => ({
            name: `cdx:ai:${name}`,
            value: String(value),
          }))),
        ],
      });
    } else if (ai.Kind === "tool" || ai.Kind === "agent" || ai.Kind === "embedding") {
      const properties = [
        { name: "cdx:ai:kind", value: ai.Kind },
        { name: "cdx:ai:provider", value: ai.Provider || "unknown" },
      ];
      if (ai.ToolSchema) {
        properties.push({ name: "cdx:ai:toolSchema", value: ai.ToolSchema });
      }
      components.push({
        "bom-ref": ai.Id,
        type: "data",
        name: ai.Name,
        properties,
      });
    }
  }
  return components;
}

/**
 * Consume dosai's first-class Services[] inventory (schema 4.0.0) directly: richer
 * than deriving services from ApiEndpoints alone — stable bom-refs, trust zones,
 * data classifications, providers, and per-service evidence occurrences.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object} [servicesMap] Map of service key to service definition, mutated in place
 * @returns {Object} The updated services map
 */
export function collectDosaiServiceComponents(
  methodsSlice,
  servicesMap = {},
) {
  for (const service of methodsSlice?.Services || []) {
    if (!service?.Id || !service?.Name) {
      continue;
    }
    const key = service.Id;
    const definition = (servicesMap[key] ??= {
      name: service.Name,
      bomRef: service.Id,
      endpoints: new Set(),
      authenticated: service.Authenticated ?? undefined,
      trustZone: service.TrustZone,
      "x-trust-boundary":
        service.CrossesTrustBoundary === true ? true : undefined,
      provider:
        service.Provider && service.Direction === "outbound"
          ? { name: service.Provider }
          : undefined,
      properties: [],
    });
    definition.group = definition.group || service.Group;
    definition.version = definition.version || service.Version;
    for (const endpoint of service.Endpoints || []) {
      const sanitized = sanitizeEndpoint(endpoint);
      if (sanitized) {
        definition.endpoints.add(sanitized);
      }
    }
    if (Array.isArray(service.Data) && service.Data.length) {
      // First population of services[].data[] for .NET: flow + classification
      // with auditable descriptions from dosai.
      definition.data = (definition.data || []).concat(
        service.Data.map((entry) => ({
          classification: entry.Classification,
          flow:
            entry.Flow === "inbound"
              ? "inbound"
              : entry.Flow === "outbound"
                ? "outbound"
                : "bi-directional",
          name: entry.Name,
          description: entry.Description,
          source: Array.isArray(entry.Source) ? entry.Source : undefined,
          destination: Array.isArray(entry.Destination)
            ? entry.Destination
            : undefined,
        })),
      );
    }
    const properties = definition.properties;
    appendUniqueProperty(properties, "cdx:service:kind", service.ServiceKind);
    appendUniqueProperty(
      properties,
      "cdx:service:direction",
      service.Direction,
    );
    appendUniqueProperty(properties, "cdx:service:framework", service.Framework);
    appendUniqueProperty(properties, "cdx:dosai:confidence", service.Confidence);
    for (const tag of service.Tags || []) {
      appendUniqueProperty(properties, "cdx:dosai:tag", tag);
    }
    if (service.Location?.Path) {
      definition.evidence = {
        occurrences: [
          {
            location: {
              path: service.Location.Path,
              line: service.Location.LineNumber || undefined,
              column: service.Location.ColumnNumber || undefined,
            },
          },
        ],
      };
    }
  }
  return servicesMap;
}

/**
 * Infer service and endpoint definitions from a dosai methods slice.
 *
 * Sanitizes API endpoint routes, derives stable service names, and records
 * `cdx:dosai:*` properties (http method, auth requirements, claim counts) per
 * service in the supplied map, mutating it in place.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object} [servicesMap] Map of service name to service definition, mutated in place
 * @returns {Object} The updated services map
 */
export function collectDosaiServicesFromMethods(
  methodsSlice,
  servicesMap = {},
) {
  for (const endpoint of methodsSlice?.ApiEndpoints || []) {
    // Endpoints owned by a provider service (ServiceId set and already collected)
    // must not be re-derived into a duplicate service.
    if (endpoint.ServiceId && servicesMap[endpoint.ServiceId]) {
      const owner = servicesMap[endpoint.ServiceId];
      const route = sanitizeEndpoint(endpoint.Path || endpoint.Route);
      if (route) {
        owner.endpoints.add(route);
      }
      continue;
    }
    // Schema 4.0.0: Path is the resolved route (tokens substituted, constraints
    // stripped); Route keeps the verbatim template. Preferring Path is the fix for
    // cdxgen discussion #4333, where [controller] shipped as %5Bcontroller%5D.
    const route = sanitizeEndpoint(endpoint.Path || endpoint.Route);
    if (!route) {
      continue;
    }
    const serviceName = serviceNameFromEndpoint(endpoint);
    servicesMap[serviceName] ??= {
      endpoints: new Set(),
      authenticated: endpoint.AuthorizationRequired,
      xTrustBoundary:
        endpoint.AuthorizationRequired === true ? true : undefined,
      properties: [],
    };
    servicesMap[serviceName].endpoints.add(route);
    const properties = servicesMap[serviceName].properties;
    appendUniqueProperty(
      properties,
      "cdx:service:httpMethod",
      endpoint.HttpMethod || "ANY",
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:endpointKind",
      endpoint.EndpointKind,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationRequired",
      endpoint.AuthorizationRequired,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:allowAnonymous",
      endpoint.AllowAnonymous,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationPolicyCount",
      endpoint.AuthorizationPolicies?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:roleCount",
      endpoint.Roles?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:requiredClaimCount",
      endpoint.RequiredClaims?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:requiredScopeCount",
      endpoint.RequiredScopes?.length,
    );
    appendUniqueProperty(
      properties,
      "internal:SrcFile",
      endpoint.FilePath || endpoint.FileName,
    );
    if (endpoint.LineNumber) {
      appendUniqueProperty(
        properties,
        "cdx:dosai:location",
        `${endpoint.FilePath || endpoint.FileName}:${endpoint.LineNumber}:${endpoint.ColumnNumber || 0}`,
      );
    }
    if (endpoint.Route && endpoint.Path && endpoint.Route !== endpoint.Path) {
      // The verbatim template (e.g. api/[controller]/{id:int}) alongside the resolved path.
      appendUniqueProperty(
        properties,
        "cdx:service:pathTemplate",
        endpoint.Route,
      );
    }
    if (endpoint.Confidence) {
      appendUniqueProperty(properties, "cdx:dosai:confidence", endpoint.Confidence);
    }
  }
  return servicesMap;
}

/**
 * Normalize a services map into a sorted array of CycloneDX service objects.
 *
 * @param {Object} [servicesMap] Map of service name to service definition with Set-backed endpoints
 * @returns {Object[]} Array of service objects with sorted endpoint arrays and properties
 */
export function normalizeDosaiServiceMap(servicesMap = {}) {
  return Object.keys(servicesMap)
    .map((serviceName) => {
      const definition = servicesMap[serviceName];
      const service = {
        name:
          definition.name ||
          serviceName ||
          `dosai-${basename(serviceName)}-service`,
        endpoints: Array.from(definition.endpoints || []).sort(),
        authenticated: definition.authenticated,
        "x-trust-boundary": definition["x-trust-boundary"],
        properties: definition.properties,
      };
      if (definition.bomRef) {
        service["bom-ref"] = definition.bomRef;
      }
      if (definition.group) {
        service.group = definition.group;
      }
      if (definition.version) {
        service.version = definition.version;
      }
      if (definition.trustZone) {
        service.trustZone = definition.trustZone;
      }
      if (definition.provider) {
        service.provider = definition.provider;
      }
      if (definition.data) {
        service.data = definition.data;
      }
      if (definition.evidence) {
        service.evidence = definition.evidence;
      }
      return service;
    })
    .filter((service) => service.name);
}
