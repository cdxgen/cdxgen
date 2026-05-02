import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { parseJsonLike } from "./jsonLike.js";
import { classifyMcpReference } from "./mcp.js";
import {
  credentialIndicatorsForText,
  isLocalHost,
  providerNamesForText,
  sanitizeMcpRefToken,
} from "./mcpDiscovery.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const MCP_CONFIG_PATTERNS = [
  ".mcp.json",
  "**/.mcp.json",
  "mcp.json",
  "**/mcp.json",
  ".vscode/mcp.json",
  "**/.vscode/mcp.json",
  ".cursor/mcp.json",
  "**/.cursor/mcp.json",
  "claude_desktop_config.json",
  "**/claude_desktop_config.json",
  "opencode.json",
  "**/opencode.json",
  "opencode.jsonc",
  "**/opencode.jsonc",
];

const LOCAL_TUNNEL_HOST_PATTERNS = [
  /\.ngrok(?:-free)?\.app$/iu,
  /\.ngrok\.io$/iu,
  /\.trycloudflare\.com$/iu,
  /\.localhost\.run$/iu,
  /\.serveo\.net$/iu,
];
const SECRET_FIELD_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|client[_-]?secret|authorization)/iu;
const ENV_REFERENCE_PATTERN = /(?:\$\{?[A-Z0-9_]+\}?|%[A-Z0-9_]+%)/u;

function addUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (properties.some((prop) => prop.name === name && prop.value === value)) {
    return;
  }
  properties.push({ name, value: String(value) });
}

function normalizeFilePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function configFormat(filePath) {
  const lowerPath = normalizeFilePath(filePath).toLowerCase();
  if (lowerPath.endsWith("claude_desktop_config.json")) {
    return "claude-desktop";
  }
  if (lowerPath.endsWith(".mcp.json")) {
    return "dot-mcp-json";
  }
  if (
    lowerPath.endsWith("opencode.json") ||
    lowerPath.endsWith("opencode.jsonc")
  ) {
    return "opencode";
  }
  if (
    lowerPath.includes("/.vscode/") ||
    lowerPath.endsWith(".vscode/mcp.json")
  ) {
    return "vscode";
  }
  if (
    lowerPath.includes("/.cursor/") ||
    lowerPath.endsWith(".cursor/mcp.json")
  ) {
    return "cursor";
  }
  return "generic-mcp-json";
}

function syntaxForFile(filePath) {
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".json") || lowerPath.endsWith(".jsonc")
    ? "json"
    : "text";
}

function extractServerMaps(config) {
  const serverMaps = [];
  for (const [key, value] of Object.entries(config || {})) {
    if (["mcpServers", "context_servers", "servers", "mcp"].includes(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        serverMaps.push({ configKey: key, servers: Object.entries(value) });
      } else if (Array.isArray(value)) {
        serverMaps.push({
          configKey: key,
          servers: value.map((entry, index) => [
            entry?.name || `server-${index + 1}`,
            entry,
          ]),
        });
      }
    }
  }
  return serverMaps;
}

function authHintsFromValue(value, hints = new Set()) {
  const text = JSON.stringify(value || {});
  if (!text || text === "{}") {
    return hints;
  }
  if (/\bbearer\b|authorization/iu.test(text)) {
    hints.add("bearer");
  }
  if (
    /\boauth\b|authorization_endpoint|token_endpoint|issuer|registration_endpoint/iu.test(
      text,
    )
  ) {
    hints.add("oauth");
  }
  if (/\bapi[_ -]?key\b/iu.test(text)) {
    hints.add("api-key");
  }
  if (/\btoken\b/iu.test(text)) {
    hints.add("token");
  }
  return hints;
}

function isEnvReference(value) {
  return typeof value === "string" && ENV_REFERENCE_PATTERN.test(value);
}

function detectInlineCredentialIndicators(value) {
  if (typeof value !== "string" || isEnvReference(value)) {
    return new Set();
  }
  return new Set(credentialIndicatorsForText(value));
}

function detectConfigCredentialSignals(serverConfig) {
  const inlineIndicators = new Set();
  const exposureFields = new Set();
  const credentialRefs = new Set();
  const envConfig = serverConfig?.env || serverConfig?.environment || {};
  for (const [envKey, envValue] of Object.entries(envConfig)) {
    if (typeof envValue === "string" && isEnvReference(envValue)) {
      credentialRefs.add(envKey);
      continue;
    }
    if (
      SECRET_FIELD_NAME_PATTERN.test(envKey) ||
      detectInlineCredentialIndicators(envValue).size
    ) {
      exposureFields.add(`env:${envKey}`);
      detectInlineCredentialIndicators(envValue).forEach((item) => {
        inlineIndicators.add(item);
      });
      if (
        typeof envValue === "string" &&
        !detectInlineCredentialIndicators(envValue).size
      ) {
        inlineIndicators.add("secret-env-value");
      }
    }
  }
  const args = Array.isArray(serverConfig?.args) ? serverConfig.args : [];
  for (let index = 0; index < args.length; index++) {
    const argValue = String(args[index] || "");
    const priorArg = index > 0 ? String(args[index - 1] || "") : "";
    const indicators = detectInlineCredentialIndicators(argValue);
    const secretFlag =
      SECRET_FIELD_NAME_PATTERN.test(argValue) ||
      (priorArg.startsWith("--") && SECRET_FIELD_NAME_PATTERN.test(priorArg));
    if (indicators.size || (secretFlag && !isEnvReference(argValue))) {
      exposureFields.add(
        priorArg.startsWith("--") ? `arg:${priorArg}` : `arg:${index}`,
      );
      indicators.forEach((item) => {
        inlineIndicators.add(item);
      });
      if (secretFlag && !indicators.size) {
        inlineIndicators.add("secret-arg-value");
      }
    }
    if (isEnvReference(argValue)) {
      credentialRefs.add(argValue);
    }
  }
  for (const [headerName, headerValue] of Object.entries(
    serverConfig?.headers || {},
  )) {
    if (
      SECRET_FIELD_NAME_PATTERN.test(headerName) ||
      detectInlineCredentialIndicators(headerValue).size
    ) {
      exposureFields.add(`header:${headerName}`);
      detectInlineCredentialIndicators(headerValue).forEach((item) => {
        inlineIndicators.add(item);
      });
      if (
        typeof headerValue === "string" &&
        SECRET_FIELD_NAME_PATTERN.test(headerName) &&
        !detectInlineCredentialIndicators(headerValue).size
      ) {
        inlineIndicators.add("secret-header-value");
      }
    }
  }
  return {
    credentialIndicatorCount: inlineIndicators.size,
    credentialReferenceCount: credentialRefs.size,
    exposureFieldCount: exposureFields.size,
    credentialRefs: Array.from(credentialRefs).sort(),
    exposureFields: Array.from(exposureFields).sort(),
    inlineIndicators: Array.from(inlineIndicators).sort(),
  };
}

function inferTransport(serverConfig, endpoints) {
  const declaredTransport = String(
    serverConfig?.transport || serverConfig?.type || "",
  ).toLowerCase();
  if (declaredTransport === "local") {
    return "stdio";
  }
  if (declaredTransport.includes("sse")) {
    return "sse";
  }
  if (declaredTransport.includes("websocket") || declaredTransport === "ws") {
    return "websocket";
  }
  if (
    declaredTransport.includes("http") ||
    declaredTransport === "remote" ||
    endpoints.some((endpoint) => endpoint.startsWith("http"))
  ) {
    return "streamable-http";
  }
  return "stdio";
}

function extractEndpoints(serverConfig) {
  const endpoints = new Set();
  for (const candidateKey of ["endpoint", "url", "uri"]) {
    const value = serverConfig?.[candidateKey];
    if (typeof value === "string" && /^https?:\/\//iu.test(value)) {
      endpoints.add(value);
    }
  }
  for (const arg of Array.isArray(serverConfig?.args)
    ? serverConfig.args
    : []) {
    if (typeof arg === "string" && /^https?:\/\//iu.test(arg)) {
      endpoints.add(arg);
    }
  }
  return Array.from(endpoints).sort();
}

function extractPackageRefs(command, args) {
  const packageRefs = new Set();
  const candidates = [command]
    .concat(Array.isArray(args) ? args : [])
    .filter((value) => typeof value === "string");
  for (const candidate of candidates) {
    const normalized = candidate.replace(/^[./]+/u, "");
    if (!normalized || normalized.startsWith("-")) {
      continue;
    }
    const classification = classifyMcpReference(normalized);
    if (classification.isMcp) {
      packageRefs.add(classification.packageName || normalized);
    }
  }
  return Array.from(packageRefs).sort();
}

function normalizeCommandAndArgs(serverConfig) {
  if (Array.isArray(serverConfig?.command)) {
    const [command, ...args] = serverConfig.command;
    return {
      args,
      command: String(command || ""),
    };
  }
  return {
    args: Array.isArray(serverConfig?.args) ? serverConfig.args : [],
    command: String(
      serverConfig?.command ||
        serverConfig?.cmd ||
        serverConfig?.executable ||
        "",
    ),
  };
}

function authPostureForConfig(serverConfig, endpoints, authHints) {
  const posture = new Set();
  if (authHints.has("oauth")) {
    posture.add("oauth");
  }
  if (authHints.has("bearer")) {
    posture.add("bearer");
  }
  if (
    serverConfig?.resourceServerUrl ||
    serverConfig?.protectedResourceMetadata
  ) {
    posture.add("protected-resource-metadata");
  }
  if (!posture.size && endpoints.length) {
    posture.add("none");
  }
  return Array.from(posture).sort();
}

function dynamicClientRegistrationConfig(serverConfig) {
  return Boolean(
    serverConfig?.dynamicClientRegistration ||
      serverConfig?.supportsDCR ||
      serverConfig?.registration_endpoint ||
      serverConfig?.auth?.registration_endpoint ||
      serverConfig?.oauth?.registration_endpoint,
  );
}

function staticClientIdPresent(serverConfig) {
  const clientId =
    serverConfig?.client_id ||
    serverConfig?.clientId ||
    serverConfig?.oauth?.client_id ||
    serverConfig?.oauth?.clientId;
  return (
    typeof clientId === "string" && clientId.length && !isEnvReference(clientId)
  );
}

function tokenPassthroughRisk(serverConfig) {
  const serialized = JSON.stringify(serverConfig || {});
  if (
    /forward(?:ing)?(?:authorization|auth|access)?token/iu.test(serialized) ||
    /tokenPassthrough|passthroughToken/iu.test(serialized)
  ) {
    return "high";
  }
  return "none";
}

function trustProfile(officialSdk, exposureType, authPosture) {
  const hasAuth = authPosture.some((value) => value !== "none");
  if (officialSdk && exposureType === "local-only" && hasAuth) {
    return "official-sdk+auth+localhost-only";
  }
  if (officialSdk && exposureType !== "local-only" && hasAuth) {
    return "official-sdk+networked+auth";
  }
  if (!officialSdk && exposureType !== "local-only") {
    return hasAuth
      ? "non-official-sdk+networked"
      : "non-official-sdk+unauthenticated-networked";
  }
  return officialSdk ? "official-sdk+unknown" : "review-needed";
}

function createServiceFromConfig(
  filePath,
  format,
  configKey,
  serverName,
  serverConfig,
) {
  const normalized = normalizeCommandAndArgs(serverConfig);
  const command = normalized.command;
  const args = normalized.args;
  const endpoints = extractEndpoints(serverConfig);
  const transport = inferTransport(serverConfig, endpoints);
  const authHints = authHintsFromValue(serverConfig);
  const authPosture = authPostureForConfig(serverConfig, endpoints, authHints);
  const packageRefs = extractPackageRefs(command, args);
  const classifications = packageRefs.map((ref) => classifyMcpReference(ref));
  const explicitMcpConfig =
    packageRefs.length > 0 ||
    transport !== "stdio" ||
    Boolean(serverConfig?.mcp || serverConfig?.mcpServer);
  if (!explicitMcpConfig) {
    return undefined;
  }
  const providerNames = providerNamesForText(
    JSON.stringify({
      args,
      command,
      endpoints,
      env: serverConfig?.env || serverConfig?.environment || {},
    }),
  );
  const credentialSignals = detectConfigCredentialSignals(serverConfig);
  const publicNetwork = endpoints.some((endpoint) => {
    try {
      return !isLocalHost(new URL(endpoint).hostname);
    } catch {
      return false;
    }
  });
  const hasTunnelReference = endpoints.some((endpoint) => {
    try {
      return LOCAL_TUNNEL_HOST_PATTERNS.some((pattern) =>
        pattern.test(new URL(endpoint).hostname),
      );
    } catch {
      return false;
    }
  });
  const officialSdk = classifications.some((item) => item.isOfficial)
    ? true
    : classifications.length
      ? false
      : undefined;
  const exposureType = publicNetwork
    ? "networked-public"
    : transport === "stdio"
      ? "stdio-configured"
      : "local-only";
  const supportsDcr = dynamicClientRegistrationConfig(serverConfig);
  const confusedDeputyRisk =
    supportsDcr && staticClientIdPresent(serverConfig) ? "high" : "none";
  const passthroughRisk = tokenPassthroughRisk(serverConfig);
  const version = String(serverConfig?.version || "latest");
  const properties = [{ name: "SrcFile", value: filePath }];
  addUniqueProperty(properties, "cdx:mcp:serviceType", "configured-server");
  addUniqueProperty(properties, "cdx:mcp:inventorySource", "config-file");
  addUniqueProperty(properties, "cdx:mcp:configFormat", format);
  addUniqueProperty(
    properties,
    "cdx:mcp:configKey",
    `${configKey}.${serverName}`,
  );
  addUniqueProperty(properties, "cdx:mcp:transport", transport);
  addUniqueProperty(properties, "cdx:mcp:exposureType", exposureType);
  addUniqueProperty(properties, "cdx:mcp:usageConfidence", "high");
  addUniqueProperty(properties, "cdx:mcp:command", command || "configured");
  addUniqueProperty(properties, "cdx:mcp:reviewNeeded", "true");
  if (typeof officialSdk === "boolean") {
    addUniqueProperty(
      properties,
      "cdx:mcp:officialSdk",
      officialSdk ? "true" : "false",
    );
  }
  if (packageRefs.length) {
    addUniqueProperty(properties, "cdx:mcp:packageRefs", packageRefs.join(","));
  }
  if (providerNames.length) {
    addUniqueProperty(
      properties,
      "cdx:mcp:providerNames",
      providerNames.join(","),
    );
  }
  if (authPosture.length) {
    addUniqueProperty(properties, "cdx:mcp:authPosture", authPosture.join(","));
    addUniqueProperty(properties, "cdx:mcp:authMode", authPosture.join(","));
  }
  if (credentialSignals.inlineIndicators.length) {
    addUniqueProperty(properties, "cdx:mcp:credentialExposure", "true");
    addUniqueProperty(
      properties,
      "cdx:mcp:credentialIndicatorCount",
      String(credentialSignals.credentialIndicatorCount),
    );
  }
  if (credentialSignals.exposureFields.length) {
    addUniqueProperty(
      properties,
      "cdx:mcp:credentialExposureFieldCount",
      String(credentialSignals.exposureFieldCount),
    );
  }
  if (credentialSignals.credentialRefs.length) {
    addUniqueProperty(
      properties,
      "cdx:mcp:credentialReferenceCount",
      String(credentialSignals.credentialReferenceCount),
    );
  }
  if (supportsDcr) {
    addUniqueProperty(properties, "cdx:mcp:auth:supportsDCR", "true");
  }
  if (authHints.has("oauth")) {
    addUniqueProperty(properties, "cdx:mcp:auth:requiresOAuth", "true");
  }
  if (
    serverConfig?.protectedResourceMetadata ||
    serverConfig?.resourceServerUrl ||
    serverConfig?.oauth?.resourceServerUrl
  ) {
    addUniqueProperty(
      properties,
      "cdx:mcp:auth:protectedResourceMetadata",
      "true",
    );
  }
  addUniqueProperty(
    properties,
    "cdx:mcp:security:confusedDeputyRisk",
    confusedDeputyRisk,
  );
  addUniqueProperty(
    properties,
    "cdx:mcp:security:tokenPassthroughRisk",
    passthroughRisk,
  );
  if (hasTunnelReference) {
    addUniqueProperty(properties, "cdx:mcp:hasTunnelReference", "true");
  }
  addUniqueProperty(
    properties,
    "cdx:mcp:trustProfile",
    trustProfile(officialSdk, exposureType, authPosture),
  );
  const serviceName = serverConfig?.name || serverName || basename(filePath);
  const authenticated =
    transport === "stdio"
      ? authPosture.some((value) => value !== "none")
        ? true
        : undefined
      : authPosture.some((value) => value !== "none");
  return {
    "bom-ref": `urn:service:mcp:${sanitizeMcpRefToken(serviceName)}:${sanitizeMcpRefToken(version)}`,
    authenticated,
    endpoints,
    group: "mcp",
    name: serviceName,
    properties,
    version,
  };
}

function createConfigComponent(filePath, format, raw, services) {
  const hiddenUnicodeScan = scanTextForHiddenUnicode(raw, {
    syntax: syntaxForFile(filePath),
  });
  const properties = [
    { name: "SrcFile", value: filePath },
    { name: "cdx:file:kind", value: "mcp-config" },
    { name: "cdx:mcp:inventorySource", value: "config-file" },
    { name: "cdx:mcp:configFormat", value: format },
    { name: "cdx:mcp:configuredServiceCount", value: String(services.length) },
  ];
  if (services.length) {
    addUniqueProperty(
      properties,
      "cdx:mcp:configuredServiceNames",
      services
        .map((service) => service.name)
        .sort()
        .join(","),
    );
    addUniqueProperty(
      properties,
      "cdx:mcp:configuredEndpoints",
      services
        .flatMap((service) => service.endpoints || [])
        .filter(Boolean)
        .sort()
        .join(","),
    );
  }
  if (hiddenUnicodeScan.hasHiddenUnicode) {
    addUniqueProperty(properties, "cdx:file:hasHiddenUnicode", "true");
    addUniqueProperty(
      properties,
      "cdx:file:hiddenUnicodeCodePoints",
      hiddenUnicodeScan.codePoints.join(","),
    );
    addUniqueProperty(
      properties,
      "cdx:file:hiddenUnicodeLineNumbers",
      hiddenUnicodeScan.lineNumbers.join(","),
    );
  }
  const credentialServices = services.filter((service) =>
    service.properties?.some(
      (property) =>
        property.name === "cdx:mcp:credentialExposure" &&
        property.value === "true",
    ),
  );
  if (credentialServices.length) {
    addUniqueProperty(properties, "cdx:mcp:credentialExposure", "true");
    addUniqueProperty(
      properties,
      "cdx:mcp:credentialExposedServiceCount",
      String(credentialServices.length),
    );
  }
  return {
    "bom-ref": `file:${filePath}`,
    name: basename(filePath),
    properties,
    type: "file",
  };
}

export const mcpConfigParser = {
  id: "mcp-config",
  patterns: MCP_CONFIG_PATTERNS,
  parse(files, _options = {}) {
    const components = [];
    const services = [];
    for (const filePath of [...new Set(files || [])]) {
      let raw;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      let configJson;
      try {
        configJson = parseJsonLike(raw);
      } catch {
        continue;
      }
      const format = configFormat(filePath);
      const fileServices = [];
      for (const { configKey, servers } of extractServerMaps(configJson)) {
        for (const [serverName, serverConfig] of servers) {
          const service = createServiceFromConfig(
            filePath,
            format,
            configKey,
            serverName,
            serverConfig,
          );
          if (service) {
            fileServices.push(service);
          }
        }
      }
      if (!fileServices.length) {
        continue;
      }
      services.push(...fileServices);
      components.push(
        createConfigComponent(filePath, format, raw, fileServices),
      );
    }
    return { components, services };
  },
};
