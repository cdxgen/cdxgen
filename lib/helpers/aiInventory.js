import { agentFormulationParser } from "./agentFormulationParser.js";
import {
  collectHuggingFaceRepoAiInventory,
  collectJsAiInventory,
  collectNotebookAiInventory,
  collectPromptConfigAiInventory,
  collectPythonAiInventory,
} from "./aiCollector.js";
import { communityAiConfigParser } from "./communityAiConfigParser.js";
import { mergeServices, trimComponents } from "./depsUtils.js";
import { classifyMcpReference } from "./mcp.js";
import { mcpConfigParser } from "./mcpConfigParser.js";
import { getAllFiles } from "./utils.js";

export const AI_INVENTORY_PROJECT_TYPES = ["mcp", "ai-skill", "ai"];
export const AI_INSTRUCTION_FILE_KINDS = new Set([
  "agent-config",
  "agent-definition",
  "agent-instructions",
  "ai-agent-file",
  "copilot-instructions",
  "copilot-setup-workflow",
  "crew-agent",
  "crew-task",
  "crew-tool",
  "custom-command",
  "custom-tool",
  "graph-definition",
]);
export const AI_SKILL_FILE_KIND = "skill-file";
export const MCP_CONFIG_FILE_KIND = "mcp-config";

const AI_INVENTORY_FILE_KINDS = new Set([
  "agent-config",
  "agent-definition",
  "agent-instructions",
  "ai-agent-file",
  "copilot-instructions",
  "copilot-setup-workflow",
  "crew-agent",
  "crew-task",
  "crew-tool",
  "custom-command",
  "custom-tool",
  "graph-definition",
  AI_SKILL_FILE_KIND,
]);

const AI_INVENTORY_PARSERS = [
  {
    id: agentFormulationParser.id,
    parser: agentFormulationParser,
    types: ["mcp", "ai-skill"],
  },
  {
    id: mcpConfigParser.id,
    parser: mcpConfigParser,
    types: ["mcp"],
  },
  {
    id: communityAiConfigParser.id,
    parser: communityAiConfigParser,
    types: ["ai-skill"],
  },
];

const AI_LANGUAGE_COLLECTORS = [
  {
    id: "javascript-ai",
    collect: collectJsAiInventory,
  },
  {
    id: "python-ai",
    collect: collectPythonAiInventory,
  },
  {
    id: "notebook-ai",
    collect: collectNotebookAiInventory,
  },
  {
    id: "prompt-config-ai",
    collect: collectPromptConfigAiInventory,
  },
  {
    id: "huggingface-repo-ai",
    collect: collectHuggingFaceRepoAiInventory,
  },
];

/**
 * Read a property value from an inventory subject.
 *
 * @param {Object} subject component or service
 * @param {string} name property name
 * @returns {string|undefined} matching property value
 */
export function inventoryPropertyValue(subject, name) {
  return subject?.properties?.find((property) => property.name === name)?.value;
}

function hasPropertyPrefix(subject, prefix) {
  return (subject?.properties || []).some((property) =>
    property?.name?.startsWith(prefix),
  );
}

function uniqueNonEmptyTypes(types) {
  return [...new Set((types || []).filter(Boolean))];
}

/**
 * Determine whether CLI project type options include an AI inventory selector.
 *
 * @param {string|string[]|undefined} optionValue raw CLI option value
 * @param {string} type AI inventory type
 * @returns {boolean} true when the requested type is enabled
 */
export function optionIncludesAiInventoryProjectType(optionValue, type) {
  const values = Array.isArray(optionValue)
    ? optionValue
    : optionValue
      ? [optionValue]
      : [];
  return values.some((value) => {
    const normalizedValue = String(value).toLowerCase();
    if (type === "ai-skill") {
      return ["ai-skill", "skill", "skills"].includes(normalizedValue);
    }
    if (type === "ai") {
      return ["ai", "aibom", "ai-bom"].includes(normalizedValue);
    }
    return normalizedValue === type;
  });
}

/**
 * Classify an inventory subject into AI inventory types.
 *
 * @param {Object} subject component or service
 * @returns {string[]} matching inventory types
 */
export function inventoryTypesForSubject(subject) {
  const types = new Set();
  const fileKind = inventoryPropertyValue(subject, "cdx:file:kind");
  if (
    subject?.group === "mcp" ||
    classifyMcpReference(subject).isMcp ||
    hasPropertyPrefix(subject, "cdx:mcp:") ||
    (subject?.tags || []).some((tag) => String(tag || "").startsWith("mcp"))
  ) {
    types.add("mcp");
  }
  if (
    AI_INVENTORY_FILE_KINDS.has(fileKind) ||
    hasPropertyPrefix(subject, "cdx:agent:") ||
    hasPropertyPrefix(subject, "cdx:skill:") ||
    hasPropertyPrefix(subject, "cdx:tool:") ||
    hasPropertyPrefix(subject, "cdx:langgraph:") ||
    hasPropertyPrefix(subject, "cdx:crewai:")
  ) {
    types.add("ai-skill");
  }
  if (hasPropertyPrefix(subject, "cdx:ai:")) {
    types.add("ai");
  }
  if (
    inventoryPropertyValue(subject, "cdx:mcp:inventorySource") === "agent-file"
  ) {
    types.add("ai-skill");
  }
  return Array.from(types);
}

/**
 * Check whether a subject belongs to a specific AI inventory type.
 *
 * @param {Object} subject component or service
 * @param {string} type AI inventory type
 * @returns {boolean} true when the subject matches
 */
export function matchesAiInventoryType(subject, type) {
  return inventoryTypesForSubject(subject).includes(type);
}

/**
 * Check whether a subject should be excluded by an AI inventory type filter.
 *
 * @param {Object} subject component or service
 * @param {string} type AI inventory type
 * @returns {boolean} true when the subject matches the exclusion
 */
export function matchesAiInventoryExcludeType(subject, type) {
  if (type === "mcp") {
    const fileKind = inventoryPropertyValue(subject, "cdx:file:kind");
    return (
      fileKind === MCP_CONFIG_FILE_KIND ||
      subject?.group === "mcp" ||
      inventoryPropertyValue(subject, "cdx:mcp:inventorySource") !==
        undefined ||
      inventoryPropertyValue(subject, "cdx:mcp:role") !== undefined
    );
  }
  return matchesAiInventoryType(subject, type);
}

/**
 * Filter components or services by requested AI inventory types.
 *
 * @param {Object[]} subjects inventory subjects
 * @param {string[]} types allowed AI inventory types
 * @returns {Object[]} filtered subjects
 */
export function filterInventorySubjectsByTypes(subjects, types) {
  const allowedTypes = uniqueNonEmptyTypes(types);
  if (!allowedTypes.length) {
    return [];
  }
  return (subjects || []).filter((subject) =>
    inventoryTypesForSubject(subject).some((type) =>
      allowedTypes.includes(type),
    ),
  );
}

/**
 * Filter dependency edges to include only retained AI inventory subjects.
 *
 * @param {Object[]} dependencies dependency edges
 * @param {Object[]} components retained components
 * @param {Object[]} services retained services
 * @returns {Object[]} filtered dependency edges
 */
export function filterInventoryDependencies(
  dependencies,
  components,
  services,
) {
  const allowedRefs = new Set(
    []
      .concat(components || [])
      .concat(services || [])
      .map((subject) => subject?.["bom-ref"])
      .filter(Boolean),
  );
  return (dependencies || [])
    .filter((dependency) => allowedRefs.has(dependency.ref))
    .map((dependency) => {
      const filteredDependency = {
        ref: dependency.ref,
      };
      if (dependency.dependsOn?.length) {
        filteredDependency.dependsOn = dependency.dependsOn.filter((ref) =>
          allowedRefs.has(ref),
        );
      }
      if (dependency.provides?.length) {
        filteredDependency.provides = dependency.provides.filter((ref) =>
          allowedRefs.has(ref),
        );
      }
      return filteredDependency;
    });
}

/**
 * Collect AI inventory subjects and dependency edges for the requested types.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} options collection options
 * @param {string[]} types requested inventory types
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectAiInventory(discoveryPath, options, types) {
  const requestedTypes = uniqueNonEmptyTypes(types);
  if (!requestedTypes.length) {
    return { components: [], dependencies: [], services: [] };
  }
  let components = [];
  const dependencies = [];
  let services = [];
  for (const parserEntry of AI_INVENTORY_PARSERS) {
    if (!parserEntry.types.some((type) => requestedTypes.includes(type))) {
      continue;
    }
    const matchedFiles = [];
    for (const pattern of parserEntry.parser.patterns) {
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
      result = parserEntry.parser.parse(uniqueMatchedFiles, options);
    } catch (err) {
      console.warn(
        `[aiInventory] Parser "${parserEntry.id}" threw an error:`,
        err.message,
      );
      continue;
    }
    if (result?.components?.length) {
      components = components.concat(result.components);
    }
    if (result?.services?.length) {
      services = mergeServices(services, result.services);
    }
    if (result?.dependencies?.length) {
      dependencies.push(...result.dependencies);
    }
  }
  if (requestedTypes.includes("ai")) {
    for (const collectorEntry of AI_LANGUAGE_COLLECTORS) {
      let collectorInventory = {
        components: [],
        dependencies: [],
        services: [],
      };
      try {
        collectorInventory = collectorEntry.collect(discoveryPath, options);
      } catch (err) {
        console.warn(
          `[aiInventory] ${collectorEntry.id} collector threw an error:`,
          err.message,
        );
        continue;
      }
      if (collectorInventory.components?.length) {
        components = components.concat(collectorInventory.components);
      }
      if (collectorInventory.services?.length) {
        services = mergeServices(services, collectorInventory.services);
      }
      if (collectorInventory.dependencies?.length) {
        dependencies.push(...collectorInventory.dependencies);
      }
    }
  }

  components = trimComponents(
    filterInventorySubjectsByTypes(components, requestedTypes),
  );
  services = mergeServices(
    [],
    filterInventorySubjectsByTypes(services, requestedTypes),
  );
  return {
    components,
    dependencies: filterInventoryDependencies(
      dependencies,
      components,
      services,
    ),
    services,
  };
}

/**
 * Summarize collected AI inventory counts for reporting.
 *
 * @param {{ components?: Object[], services?: Object[] }} inventory collected AI inventory
 * @returns {{
 *   aiComponentCount: number,
 *   aiServiceCount: number,
 *   instructionCount: number,
 *   mcpConfigCount: number,
 *   skillComponentCount: number,
 * }} summary counts
 */
export function summarizeAiInventory(inventory) {
  const components = inventory?.components || [];
  const services = inventory?.services || [];
  return {
    aiComponentCount: components.filter((component) =>
      inventoryTypesForSubject(component).includes("ai"),
    ).length,
    aiServiceCount: services.filter((service) =>
      inventoryTypesForSubject(service).includes("ai"),
    ).length,
    instructionCount: components.filter((component) =>
      AI_INSTRUCTION_FILE_KINDS.has(
        inventoryPropertyValue(component, "cdx:file:kind"),
      ),
    ).length,
    mcpConfigCount: components.filter(
      (component) =>
        inventoryPropertyValue(component, "cdx:file:kind") ===
        MCP_CONFIG_FILE_KIND,
    ).length,
    mcpServiceCount: services.filter((service) =>
      inventoryTypesForSubject(service).includes("mcp"),
    ).length,
    skillCount: components.filter(
      (component) =>
        inventoryPropertyValue(component, "cdx:file:kind") ===
        AI_SKILL_FILE_KIND,
    ).length,
  };
}
