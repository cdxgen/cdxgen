import { readFileSync } from "node:fs";

import { v4 as uuidv4 } from "uuid";

import { disambiguateSteps } from "./common.js";

/**
 * Very lightweight declarative Jenkinsfile parser using regex heuristics.
 *
 * Only parses the declarative pipeline syntax (`pipeline { ... }`).
 * Full Groovy/scripted pipelines are not supported.
 *
 * @param {string} f Path to Jenkinsfile
 * @param {Object} _options CLI options
 * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
 */
function parseJenkinsfile(f, _options) {
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
  const workflowProperties = [{ name: "cdx:jenkins:file", value: f }];

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
    const whenMatch = stageBody.match(/when\s*\{([^}]+)\}/);
    if (whenMatch) {
      taskProperties.push({
        name: "cdx:jenkins:stage:when",
        value: whenMatch[1].trim(),
      });
    }

    // Extract sh/echo/script steps
    const shPattern = /(?:sh|bat|powershell)\s+['"]([^'"]+)['"]/g;
    let shMatch;
    while ((shMatch = shPattern.exec(stageBody)) !== null) {
      steps.push({
        name: `sh: ${shMatch[1].substring(0, 60)}`,
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
 * Parser contract: `parse(files, options)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export const jenkinsParser = {
  id: "jenkins",
  patterns: ["**/Jenkinsfile", "**/Jenkinsfile.*"],

  /**
   * @param {string[]} files Matched Jenkinsfile paths
   * @param {Object} options CLI options
   * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
   */
  parse(files, options) {
    const workflows = [];
    const components = [];
    const dependencies = [];

    for (const f of files) {
      const result = parseJenkinsfile(f, options);
      workflows.push(...result.workflows);
      components.push(...result.components);
      dependencies.push(...result.dependencies);
    }

    return {
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    };
  },
};
