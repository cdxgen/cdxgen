import { randomUUID as uuidv4 } from "node:crypto";
import { readFileSync } from "node:fs";

import { redactCommandCredentials } from "../../core/propertySanitizer.js";
import { formulationSourcePath } from "../ecosystemFormulationParsers.js";
import { disambiguateSteps, sanitizeFormulationResult } from "./common.js";

const JENKINS_WHEN_DIRECTIVES = new Set([
  "allOf",
  "anyOf",
  "beforeAgent",
  "beforeInput",
  "beforeOptions",
  "branch",
  "buildingTag",
  "changeRequest",
  "changelog",
  "changeset",
  "environment",
  "equals",
  "expression",
  "isRestartedRun",
  "not",
  "tag",
  "triggeredBy",
]);

/**
 * The directive names of the first `when { ... }` block in a stage body,
 * comma-separated in the order they appear. Arguments are left out: an
 * `expression` or `environment` condition can compare against a literal
 * credential.
 *
 * @param {string} stageBody Text of the stage
 * @returns {string|undefined} Directive names, or undefined without a block
 */
function jenkinsWhenDirectives(stageBody) {
  const whenMatch = /\bwhen\s*\{/.exec(stageBody);
  if (!whenMatch) {
    return undefined;
  }
  const start = whenMatch.index + whenMatch[0].length;
  let depth = 1;
  let end = start;
  while (end < stageBody.length && depth > 0) {
    if (stageBody[end] === "{") {
      depth += 1;
    } else if (stageBody[end] === "}") {
      depth -= 1;
    }
    end += 1;
  }
  const body = stageBody
    .slice(start, depth === 0 ? end - 1 : end)
    .replace(/'[^'\n]*'|"[^"\n]*"/g, "");
  const names = [];
  for (const [word] of body.matchAll(/[A-Za-z]+/g)) {
    if (JENKINS_WHEN_DIRECTIVES.has(word) && !names.includes(word)) {
      names.push(word);
    }
  }
  return names.length ? names.join(",") : undefined;
}

/**
 * Very lightweight declarative Jenkinsfile parser using regex heuristics.
 *
 * Only parses the declarative pipeline syntax (`pipeline { ... }`).
 * Full Groovy/scripted pipelines are not supported.
 *
 * @param {string} f Path to Jenkinsfile
 * @param {Object} _options CLI options
 * @param {string} [rootDir] Scanned project root. The file path is recorded
 * relative to it.
 * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
 */
function parseJenkinsfile(f, _options, rootDir) {
  const sourcePath = formulationSourcePath(f, rootDir);
  const workflows = [];
  const components = [];
  const dependencies = [];

  let raw;
  try {
    raw = readFileSync(f, { encoding: "utf-8" });
  } catch (_e) {
    return {
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    };
  }

  // Quick check: must look like a declarative pipeline
  if (!raw.includes("pipeline") || !raw.includes("stages")) {
    return {
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    };
  }

  const workflowRef = uuidv4();
  const tasks = [];
  const workflowDependsOn = [];
  const workflowProperties = [{ name: "cdx:jenkins:file", value: sourcePath }];

  // Extract agent info
  const agentMatch = raw.match(
    /agent\s*\{[^}]*docker\s*\{[^}]*image\s+['"]([^'"]+)['"]/s,
  );
  if (agentMatch) {
    const agentImage = agentMatch[1];
    components.push({ type: "container", name: agentImage });
    workflowProperties.push({
      name: "cdx:jenkins:agent:image",
      value: agentImage,
    });
  } else {
    const simpleAgentMatch = raw.match(/agent\s+['"]?(\w+)['"]?/);
    if (simpleAgentMatch) {
      workflowProperties.push({
        name: "cdx:jenkins:agent",
        value: simpleAgentMatch[1],
      });
    }
  }

  // Extract stage blocks using a regex heuristic.
  // NOTE: This only works reliably for declarative pipelines with simple,
  // non-deeply-nested stage blocks. Scripted pipelines or stages with heavily
  // nested closures may produce incomplete or incorrect results.
  const stagePattern =
    /stage\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\{([\s\S]*?)(?=stage\s*\(|post\s*\{|$)/g;
  let stageMatch;
  while ((stageMatch = stagePattern.exec(raw)) !== null) {
    const stageName = stageMatch[1];
    const stageBody = stageMatch[2];
    const taskRef = uuidv4();
    const steps = [];
    const taskProperties = [
      { name: "cdx:jenkins:stage:name", value: stageName },
    ];

    // Detect parallel stages
    if (stageBody.includes("parallel")) {
      taskProperties.push({
        name: "cdx:jenkins:stage:parallel",
        value: "true",
      });
    }

    // Detect when conditions
    const whenDirectives = jenkinsWhenDirectives(stageBody);
    if (whenDirectives) {
      taskProperties.push({
        name: "cdx:jenkins:stage:when",
        value: whenDirectives,
      });
    }

    // Extract sh/echo/script steps
    const shPattern = /(?:sh|bat|powershell)\s+['"]([^'"]+)['"]/g;
    let shMatch;
    while ((shMatch = shPattern.exec(stageBody)) !== null) {
      steps.push({
        // Redacted before it is cut, so a cut cannot split a flag from its value.
        name: `sh: ${redactCommandCredentials(shMatch[1]).substring(0, 60)}`,
        commands: [{ executed: shMatch[1] }],
      });
    }

    tasks.push({
      "bom-ref": taskRef,
      uid: taskRef,
      name: stageName,
      taskTypes: ["build"],
      steps: disambiguateSteps(steps),
      properties: taskProperties,
    });
    workflowDependsOn.push(taskRef);
  }

  const workflow = {
    "bom-ref": workflowRef,
    uid: workflowRef,
    name: "Jenkinsfile Pipeline",
    taskTypes: ["build"],
    tasks: tasks.length ? tasks : undefined,
    properties: workflowProperties,
  };

  workflows.push(workflow);
  if (workflowDependsOn.length) {
    dependencies.push({ ref: workflowRef, dependsOn: workflowDependsOn });
  }

  return { workflows, components, services: [], properties: [], dependencies };
}

/**
 * Jenkins formulation parser.
 *
 * Matches `Jenkinsfile` and `Jenkinsfile.*` at any directory depth and converts
 * declarative pipeline syntax into CycloneDX formulation workflow objects.
 *
 * Parser contract: `parse(files, options, context)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export const jenkinsParser = {
  id: "jenkins",
  patterns: ["**/Jenkinsfile", "**/Jenkinsfile.*"],

  /**
   * @param {string[]} files Matched Jenkinsfile paths
   * @param {Object} options CLI options
   * @param {{ rootDir?: string }} [context] Scanned project root
   * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
   */
  parse(files, options, context) {
    const workflows = [];
    const components = [];
    const dependencies = [];

    for (const f of files) {
      let result;
      try {
        result = parseJenkinsfile(f, options, context?.rootDir);
      } catch (err) {
        // One file the parser cannot handle must not hide the other
        // pipelines of the project from the formulation and the audit
        console.warn(`[jenkins] Unable to parse ${f}:`, err.message);
        continue;
      }
      for (const workflow of result.workflows) {
        workflows.push(workflow);
      }
      for (const component of result.components) {
        components.push(component);
      }
      for (const dependency of result.dependencies) {
        dependencies.push(dependency);
      }
    }

    return sanitizeFormulationResult({
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    });
  },
};
