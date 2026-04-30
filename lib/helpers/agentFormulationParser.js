import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import {
  credentialIndicatorsForText,
  isLocalHost,
  providerNamesForText,
  sanitizeMcpRefToken,
} from "./mcpDiscovery.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const AGENT_FILE_PATTERNS = [
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "Cursor.md",
  ".github/copilot-instructions.md",
  ".github/instructions/**/*.{md,mdx,markdown,txt}",
  ".github/workflows/copilot-setup-steps.yml",
  "**/*.{prompt,mdc}",
];

const MCP_PACKAGE_REF_PATTERN =
  /@modelcontextprotocol\/[a-z0-9._/-]+|@[a-z0-9._-]+\/mcp[a-z0-9._/-]*/giu;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]}]+/giu;
const AUTH_HINT_PATTERNS = [
  ["bearer", /\bbearer\b/i],
  ["oauth", /\boauth\b|authorization_endpoint|token_endpoint|issuer/i],
  ["api-key", /\bapi[_ -]?key\b/i],
  ["token", /\btoken\b|authorization:/i],
];
const TUNNEL_HOST_PATTERNS = [
  /\.ngrok(?:-free)?\.app$/i,
  /\.ngrok\.io$/i,
  /\.trycloudflare\.com$/i,
  /\.localhost\.run$/i,
  /\.serveo\.net$/i,
];

function syntaxForFile(filePath) {
  const extension = extname(filePath).toLowerCase();
  if ([".md", ".mdx", ".markdown"].includes(extension)) {
    return "markdown";
  }
  if ([".yaml", ".yml"].includes(extension)) {
    return "yaml";
  }
  return "text";
}

function kindForFile(filePath) {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith("copilot-setup-steps.yml")) {
    return "copilot-setup-workflow";
  }
  if (lowerPath.endsWith("copilot-instructions.md")) {
    return "copilot-instructions";
  }
  if (lowerPath.endsWith("agents.md") || lowerPath.endsWith("claude.md")) {
    return "agent-instructions";
  }
  if (lowerPath.endsWith(".prompt") || lowerPath.endsWith(".mdc")) {
    return "skill-file";
  }
  return "ai-agent-file";
}

function authHintsForText(text) {
  return AUTH_HINT_PATTERNS.flatMap(([name, pattern]) =>
    pattern.test(text) ? [name] : [],
  );
}

function packageRefsForText(text) {
  return [...new Set(text.match(MCP_PACKAGE_REF_PATTERN) || [])].sort();
}

function mcpUrlsForText(text) {
  const urls = [];
  for (const match of text.match(URL_PATTERN) || []) {
    try {
      const parsed = new URL(match);
      if (
        parsed.pathname.toLowerCase().includes("/mcp") ||
        parsed.hostname.toLowerCase().includes("modelcontextprotocol")
      ) {
        urls.push(parsed.toString());
      }
    } catch {
      // Ignore malformed URLs in untrusted agent instructions.
    }
  }
  return [...new Set(urls)].sort();
}

function buildInferredMcpServices(filePath, mcpUrls, authHints, providerNames) {
  return mcpUrls.map((urlValue, index) => {
    const parsed = new URL(urlValue);
    const hostname = parsed.hostname.toLowerCase();
    const exposureType = isLocalHost(hostname)
      ? "local-only"
      : "networked-public";
    const properties = [
      { name: "SrcFile", value: filePath },
      { name: "cdx:mcp:serviceType", value: "inferred-endpoint" },
      { name: "cdx:mcp:inventorySource", value: "agent-file" },
      { name: "cdx:mcp:usageConfidence", value: "medium" },
      { name: "cdx:mcp:reviewNeeded", value: "true" },
      { name: "cdx:mcp:exposureType", value: exposureType },
      { name: "cdx:mcp:agentReference", value: "true" },
    ];
    if (providerNames.length) {
      properties.push({
        name: "cdx:mcp:providerNames",
        value: providerNames.join(","),
      });
    }
    if (authHints.length) {
      properties.push({
        name: "cdx:mcp:authMode",
        value: authHints.join(","),
      });
    }
    return {
      "bom-ref": `urn:service:agent-mcp:${sanitizeMcpRefToken(hostname || basename(filePath))}:${index + 1}`,
      group: "mcp",
      name: hostname || `${basename(filePath)}-mcp-endpoint`,
      endpoints: [urlValue],
      properties,
      version: "inferred",
    };
  });
}

/**
 * Discover AI agent instruction and skill files that can hide MCP/runtime
 * surfaces from package-only inventory.
 */
export const agentFormulationParser = {
  id: "agent-formulation",
  patterns: AGENT_FILE_PATTERNS,
  parse(files, _options = {}) {
    const components = [];
    const services = [];
    for (const filePath of files || []) {
      let raw;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const hiddenUnicodeScan = scanTextForHiddenUnicode(raw, {
        syntax: syntaxForFile(filePath),
      });
      const packageRefs = packageRefsForText(raw);
      const providerNames = providerNamesForText(raw);
      const mcpUrls = mcpUrlsForText(raw);
      const authHints = authHintsForText(raw);
      const credentialIndicators = credentialIndicatorsForText(raw);
      const mcpHosts = mcpUrls.map((urlValue) => new URL(urlValue).hostname);
      const hasPublicMcpEndpoint = mcpHosts.some((host) => !isLocalHost(host));
      const hasTunnelReference = mcpHosts.some((host) =>
        TUNNEL_HOST_PATTERNS.some((pattern) => pattern.test(host)),
      );
      const hasMcpReferences =
        mcpUrls.length > 0 ||
        packageRefs.length > 0 ||
        /\bmcp\b/i.test(raw) ||
        /modelcontextprotocol/i.test(raw);
      if (!hiddenUnicodeScan.hasHiddenUnicode && !hasMcpReferences) {
        continue;
      }
      const hiddenComponentKinds = [];
      if (mcpUrls.length) {
        hiddenComponentKinds.push("mcp-endpoint");
      }
      if (providerNames.length) {
        hiddenComponentKinds.push("provider");
      }
      if (packageRefs.length) {
        hiddenComponentKinds.push("mcp-package-reference");
      }
      const properties = [
        { name: "SrcFile", value: filePath },
        { name: "cdx:file:kind", value: kindForFile(filePath) },
        { name: "cdx:agent:inventorySource", value: "agent-file" },
        { name: "cdx:agent:hasMcpReferences", value: String(hasMcpReferences) },
        {
          name: "cdx:agent:hiddenEndpointCount",
          value: String(mcpUrls.length),
        },
      ];
      if (hiddenUnicodeScan.hasHiddenUnicode) {
        properties.push(
          { name: "cdx:file:hasHiddenUnicode", value: "true" },
          {
            name: "cdx:file:hiddenUnicodeCodePoints",
            value: hiddenUnicodeScan.codePoints.join(","),
          },
          {
            name: "cdx:file:hiddenUnicodeLineNumbers",
            value: hiddenUnicodeScan.lineNumbers.join(","),
          },
        );
        if (hiddenUnicodeScan.inComments) {
          properties.push(
            {
              name: "cdx:file:hiddenUnicodeInComments",
              value: "true",
            },
            {
              name: "cdx:file:hiddenUnicodeCommentCodePoints",
              value: hiddenUnicodeScan.commentCodePoints.join(","),
            },
          );
        }
      }
      if (packageRefs.length) {
        properties.push({
          name: "cdx:agent:mcpPackageRefs",
          value: packageRefs.join(","),
        });
        if (
          packageRefs.some((ref) => !ref.startsWith("@modelcontextprotocol/"))
        ) {
          properties.push({
            name: "cdx:agent:hasNonOfficialMcpReference",
            value: "true",
          });
        }
      }
      if (mcpUrls.length) {
        properties.push(
          {
            name: "cdx:agent:hiddenMcpUrls",
            value: mcpUrls.join(","),
          },
          {
            name: "cdx:agent:hiddenMcpHosts",
            value: [...new Set(mcpHosts)].sort().join(","),
          },
        );
      }
      if (providerNames.length) {
        properties.push({
          name: "cdx:agent:providerNames",
          value: providerNames.join(","),
        });
      }
      if (authHints.length) {
        properties.push({
          name: "cdx:agent:authHints",
          value: authHints.join(","),
        });
      }
      if (credentialIndicators.length) {
        properties.push(
          {
            name: "cdx:agent:credentialExposure",
            value: "true",
          },
          {
            name: "cdx:agent:credentialRiskIndicators",
            value: credentialIndicators.join(","),
          },
        );
      }
      if (hasPublicMcpEndpoint) {
        properties.push({
          name: "cdx:agent:hasPublicMcpEndpoint",
          value: "true",
        });
      }
      if (hasTunnelReference) {
        properties.push({
          name: "cdx:agent:hasTunnelReference",
          value: "true",
        });
      }
      if (hiddenComponentKinds.length) {
        properties.push({
          name: "cdx:agent:hiddenComponentKinds",
          value: hiddenComponentKinds.join(","),
        });
      }
      if (
        hiddenUnicodeScan.hasHiddenUnicode ||
        hasPublicMcpEndpoint ||
        hasTunnelReference ||
        packageRefs.length > 0 ||
        credentialIndicators.length > 0
      ) {
        properties.push({
          name: "cdx:agent:reviewNeeded",
          value: "true",
        });
      }
      components.push({
        "bom-ref": `file:${filePath}`,
        name: basename(filePath),
        properties,
        type: "file",
      });
      services.push(
        ...buildInferredMcpServices(
          filePath,
          mcpUrls,
          authHints,
          providerNames,
        ),
      );
    }
    return { components, services };
  },
};
