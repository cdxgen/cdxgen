import { lstatSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import {
  credentialIndicatorsForText,
  isLocalHost,
  providerNamesForText,
  sanitizeMcpRefToken,
} from "./mcpDiscovery.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const AGENT_FILE_PATTERNS = [
  // The discovery glob is case-insensitive, so a single entry covers AGENTS.md
  // and agents.md; AGENT.md is a distinct singular filename.
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "GEMINI.md",
  "QWEN.md",
  "Cursor.md",
  "CONVENTIONS.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".clinerules/**/*.{md,markdown,txt}",
  ".aider.conf.yml",
  ".github/copilot-instructions.md",
  ".github/instructions/**/*.{md,mdx,markdown,txt}",
  ".github/workflows/copilot-setup-steps.yml",
  "**/*.{prompt,mdc}",
];

const MCP_PACKAGE_REF_PATTERN =
  /@modelcontextprotocol\/[a-z0-9._/-]+|@[a-z0-9._-]+\/mcp[a-z0-9._/-]*/giu;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]}]+/giu;
// An agent instruction or configuration file larger than this is skipped
// unread.
const MAX_AGENT_FILE_BYTES = 4 * 1024 * 1024;
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

/**
 * Determine whether a CONVENTIONS.md file is an Aider conventions file rather
 * than an ordinary docs file, by looking for a sibling Aider marker.
 *
 * The original (not lower-cased) path must be passed: on a case-sensitive
 * filesystem a lower-cased directory does not exist, which would silently make
 * every CONVENTIONS.md look unmarked.
 *
 * Only a regular file counts as a marker. A symbolic link is not followed, so
 * the result never depends on where a link in the scanned tree points.
 *
 * @param {string} filePath Original file path as discovered
 * @returns {boolean} true when an Aider marker sits alongside the file
 */
function hasAiderMarker(filePath) {
  const directory = dirname(filePath);
  return [
    ".aider.conf.yml",
    ".aider.conf.yaml",
    ".aider.model.settings.yml",
  ].some((markerName) => {
    try {
      return (
        lstatSync(join(directory, markerName), {
          throwIfNoEntry: false,
        })?.isFile() === true
      );
    } catch {
      return false;
    }
  });
}

function kindForFile(filePath) {
  // Normalize separators so the endsWith/includes checks below behave the same
  // on Windows (backslash) and POSIX (forward slash) absolute paths.
  const lowerPath = filePath.replaceAll("\\", "/").toLowerCase();
  if (lowerPath.endsWith("copilot-setup-steps.yml")) {
    return "copilot-setup-workflow";
  }
  if (lowerPath.endsWith("copilot-instructions.md")) {
    return "copilot-instructions";
  }
  if (lowerPath.endsWith(".aider.conf.yml")) {
    return "agent-config";
  }
  // CONVENTIONS.md is an Aider convention but also an ordinary docs filename.
  // Only classify it as agent instructions when an Aider marker sits beside it;
  // otherwise treat it as a generic file so unrelated repos are not tagged.
  if (lowerPath.endsWith("conventions.md")) {
    return hasAiderMarker(filePath) ? "agent-instructions" : "ai-agent-file";
  }
  if (
    lowerPath.endsWith("agents.md") ||
    lowerPath.endsWith("agent.md") ||
    lowerPath.endsWith("claude.md") ||
    lowerPath.endsWith("gemini.md") ||
    lowerPath.endsWith("qwen.md") ||
    lowerPath.endsWith("cursor.md") ||
    lowerPath.endsWith(".cursorrules") ||
    lowerPath.endsWith(".windsurfrules") ||
    lowerPath.endsWith(".clinerules") ||
    lowerPath.includes("/.clinerules/")
  ) {
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
      { name: "internal:SrcFile", value: filePath },
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
      endpoints: [sanitizeBomUrl(urlValue)],
      properties,
      version: "inferred",
    };
  });
}

/**
 * Discover AI agent instruction and skill files that can hide MCP/runtime
 * surfaces from package-only inventory. Only regular files inside
 * `context.rootDir`, the scanned root, are read; a symbolic link is never
 * followed.
 */
export const agentFormulationParser = {
  id: "agent-formulation",
  patterns: AGENT_FILE_PATTERNS,
  parse(files, _options = {}, context = {}) {
    const components = [];
    const services = [];
    for (const filePath of files || []) {
      const raw = readRegularTextFile(
        filePath,
        MAX_AGENT_FILE_BYTES,
        context?.rootDir,
      );
      if (raw === undefined) {
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
      // Inventory all matched agent/instruction files, even when they do not
      // yet contain hidden Unicode or explicit MCP references, so shipped files
      // such as CLAUDE.md and AGENTS.md still surface in build/post-build BOMs.
      if (!raw.trim().length) {
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
        { name: "internal:SrcFile", value: filePath },
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
        const sanitizedMcpUrls = mcpUrls.map((urlValue) =>
          sanitizeBomUrl(urlValue),
        );
        properties.push(
          {
            name: "cdx:agent:hiddenMcpUrls",
            value: sanitizedMcpUrls.join(","),
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
