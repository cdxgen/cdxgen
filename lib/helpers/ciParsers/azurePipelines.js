import { readFileSync } from "node:fs";

import { v4 as uuidv4 } from "uuid";
import { parse as _load } from "yaml";

import { disambiguateSteps } from "./common.js";

/**
 * Parse a single Azure Pipelines YAML file and return formulation-shaped data.
 *
 * @param {string} f Absolute path to the YAML file
 * @param {Object} _options CLI options
 * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
 */
function parseAzurePipelinesFile(f, _options) {
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

  let yamlObj;
  try {
    yamlObj = _load(raw);
  } catch (_e) {
    return {
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    };
  }

  if (!yamlObj || typeof yamlObj !== "object") {
    return {
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    };
  }

  // Not an Azure Pipelines file (heuristic: must have at least one of pool, stages, jobs, steps
  // and must not look like a GitLab CI file which uses a top-level `image` key)
  const looksLikeAzure =
    !yamlObj.image &&
    (yamlObj.pool ||
      yamlObj.stages ||
      yamlObj.jobs ||
      yamlObj.steps ||
      yamlObj.trigger);
  if (!looksLikeAzure) {
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
  const workflowProperties = [{ name: "cdx:azure:config", value: f }];

  // Collect pool image as component
  const poolImage = yamlObj.pool?.vmImage || "";
  if (poolImage) {
    components.push({ type: "platform", name: poolImage });
    workflowProperties.push({
      name: "cdx:azure:pool:vmImage",
      value: poolImage,
    });
  }

  // Collect trigger branches
  const triggerBranches = [];
  if (Array.isArray(yamlObj.trigger?.branches?.include)) {
    triggerBranches.push(...yamlObj.trigger.branches.include);
  } else if (typeof yamlObj.trigger === "string") {
    triggerBranches.push(yamlObj.trigger);
  } else if (Array.isArray(yamlObj.trigger)) {
    triggerBranches.push(...yamlObj.trigger);
  }
  if (triggerBranches.length) {
    workflowProperties.push({
      name: "cdx:azure:trigger:branches",
      value: triggerBranches.join(","),
    });
  }

  // Stage-based pipelines.
  // CycloneDX Task schema has additionalProperties: false and does NOT allow a
  // nested `tasks` property — only Workflow does.  We therefore flatten
  // stage → job into individual tasks and record stage context via properties.
  const stages = Array.isArray(yamlObj.stages) ? yamlObj.stages : [];
  for (const stage of stages) {
    const stageName = stage.stage || stage.displayName || "unnamed-stage";

    const stageDepOn = stage.dependsOn
      ? Array.isArray(stage.dependsOn)
        ? stage.dependsOn
        : [stage.dependsOn]
      : [];

    const jobs = Array.isArray(stage.jobs) ? stage.jobs : [];
    for (const jobDef of jobs) {
      const jobName =
        jobDef.job || jobDef.deployment || jobDef.displayName || "unnamed-job";
      const jobRef = uuidv4();
      const steps = [];
      // Combine stage- and job-level context into the task properties.
      const jobProperties = [
        { name: "cdx:azure:stage:name", value: stageName },
        { name: "cdx:azure:job:name", value: jobName },
      ];

      if (stageDepOn.length) {
        jobProperties.push({
          name: "cdx:azure:stage:dependsOn",
          value: stageDepOn.join(","),
        });
      }

      if (stage.condition) {
        jobProperties.push({
          name: "cdx:azure:stage:condition",
          value: stage.condition,
        });
      }

      if (jobDef.pool?.vmImage) {
        jobProperties.push({
          name: "cdx:azure:job:pool:vmImage",
          value: jobDef.pool.vmImage,
        });
        components.push({ type: "platform", name: jobDef.pool.vmImage });
      }

      if (jobDef.environment) {
        const envName =
          typeof jobDef.environment === "string"
            ? jobDef.environment
            : jobDef.environment?.name || "";
        if (envName) {
          jobProperties.push({
            name: "cdx:azure:job:environment",
            value: envName,
          });
        }
      }

      // Collect deployment strategy steps
      const strategySteps =
        jobDef.strategy?.runOnce?.deploy?.steps ||
        jobDef.strategy?.rolling?.deploy?.steps ||
        jobDef.strategy?.canary?.deploy?.steps ||
        jobDef.steps ||
        [];

      for (const step of Array.isArray(strategySteps) ? strategySteps : []) {
        if (typeof step !== "object") {
          continue;
        }
        const stepName =
          step.displayName ||
          step.task ||
          (step.script ? "script" : undefined) ||
          "step";
        const command = step.script || step.bash || step.powershell;
        steps.push({
          name: stepName,
          commands: command
            ? [{ executed: command.trim().split("\n")[0] }]
            : undefined,
        });
      }

      tasks.push({
        "bom-ref": jobRef,
        uid: jobRef,
        name: `${stageName}/${jobName}`,
        taskTypes: ["build"],
        steps: disambiguateSteps(steps),
        properties: jobProperties,
      });
      workflowDependsOn.push(jobRef);
    }
  }

  // Flat (non-stage) jobs list
  if (stages.length === 0 && Array.isArray(yamlObj.jobs)) {
    for (const jobDef of yamlObj.jobs) {
      const jobName = jobDef.job || jobDef.displayName || "unnamed-job";
      const taskRef = uuidv4();
      const steps = [];
      const taskProperties = [{ name: "cdx:azure:job:name", value: jobName }];

      for (const step of Array.isArray(jobDef.steps) ? jobDef.steps : []) {
        if (typeof step !== "object") {
          continue;
        }
        const stepName = step.displayName || step.task || "step";
        const command = step.script || step.bash;
        steps.push({
          name: stepName,
          commands: command
            ? [{ executed: command.trim().split("\n")[0] }]
            : undefined,
        });
      }

      tasks.push({
        "bom-ref": taskRef,
        uid: taskRef,
        name: jobName,
        taskTypes: ["build"],
        steps: disambiguateSteps(steps),
        properties: taskProperties,
      });
      workflowDependsOn.push(taskRef);
    }
  }

  const workflow = {
    "bom-ref": workflowRef,
    uid: workflowRef,
    name: "Azure Pipelines",
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
 * Azure Pipelines formulation parser.
 *
 * Matches `azure-pipelines.yml`, `azure-pipelines.yaml`, and
 * `.azure-pipelines/*.yml` files and converts them into CycloneDX formulation
 * workflow objects.
 *
 * Parser contract: `parse(files, options)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export const azurePipelinesParser = {
  id: "azure-pipelines",
  patterns: ["**/azure-pipelines.{yml,yaml}", ".azure-pipelines/*.{yml,yaml}"],

  /**
   * @param {string[]} files Matched pipeline file paths
   * @param {Object} options CLI options
   * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
   */
  parse(files, options) {
    const workflows = [];
    const components = [];
    const dependencies = [];

    for (const f of files) {
      const result = parseAzurePipelinesFile(f, options);
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
