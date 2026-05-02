import { agentFormulationParser } from "./agentFormulationParser.js";
import { communityAiConfigParser } from "./communityAiConfigParser.js";
import { mergeServices, trimComponents } from "./depsUtils.js";
import { classifyMcpReference } from "./mcp.js";
import { mcpConfigParser } from "./mcpConfigParser.js";
import { getAllFiles } from "./utils.js";

export const AI_INVENTORY_PROJECT_TYPES = ["mcp", "ai-skill"];

const AI_SKILL_FILE_KINDS = new Set([
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
  "skill-file",
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

function propertyValue(subject, name) {
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
    return normalizedValue === type;
  });
}

export function inventoryTypesForSubject(subject) {
  const types = new Set();
  const fileKind = propertyValue(subject, "cdx:file:kind");
  if (
    subject?.group === "mcp" ||
    classifyMcpReference(subject).isMcp ||
    hasPropertyPrefix(subject, "cdx:mcp:") ||
    (subject?.tags || []).some((tag) => String(tag || "").startsWith("mcp"))
  ) {
    types.add("mcp");
  }
  if (
    AI_SKILL_FILE_KINDS.has(fileKind) ||
    hasPropertyPrefix(subject, "cdx:agent:") ||
    hasPropertyPrefix(subject, "cdx:skill:") ||
    hasPropertyPrefix(subject, "cdx:tool:") ||
    hasPropertyPrefix(subject, "cdx:langgraph:") ||
    hasPropertyPrefix(subject, "cdx:crewai:")
  ) {
    types.add("ai-skill");
  }
  if (propertyValue(subject, "cdx:mcp:inventorySource") === "agent-file") {
    types.add("ai-skill");
  }
  return Array.from(types);
}

export function matchesAiInventoryType(subject, type) {
  return inventoryTypesForSubject(subject).includes(type);
}

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
