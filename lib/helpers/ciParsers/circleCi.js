import { readFileSync } from "node:fs";

import { v4 as uuidv4 } from "uuid";
import { parse as _load } from "yaml";

import { disambiguateSteps } from "./common.js";

/**
 * Parse a single CircleCI config file and return formulation-shaped data.
 *
 * @param {string} f Absolute path to the config file
 * @param {Object} _options CLI options
 * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
 */
function parseCircleCiFile(f, _options) {
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

  // Collect orbs as components
  if (yamlObj.orbs && typeof yamlObj.orbs === "object") {
    for (const [orbAlias, orbRef] of Object.entries(yamlObj.orbs)) {
      if (typeof orbRef === "string") {
        const atIdx = orbRef.lastIndexOf("@");
        const fullName = atIdx >= 0 ? orbRef.substring(0, atIdx) : orbRef;
        const version = atIdx >= 0 ? orbRef.substring(atIdx + 1) : "";
        const slashIdx = fullName.indexOf("/");
        const namespace = slashIdx >= 0 ? fullName.substring(0, slashIdx) : "";
        const name =
          slashIdx >= 0 ? fullName.substring(slashIdx + 1) : fullName;
        components.push({
          "bom-ref": orbRef,
          type: "application",
          group: namespace,
          name,
          version,
          properties: [
            { name: "SrcFile", value: f },
            { name: "cdx:circleci:orb:alias", value: orbAlias },
          ],
        });
      }
    }
  }

  // Collect executor images as components
  if (yamlObj.executors && typeof yamlObj.executors === "object") {
    for (const [exName, exDef] of Object.entries(yamlObj.executors)) {
      const image =
        exDef?.docker?.[0]?.image ||
        exDef?.machine?.image ||
        exDef?.macos?.xcode ||
        "";
      if (image) {
        components.push({
          type: "container",
          name: image,
          properties: [
            { name: "SrcFile", value: f },
            { name: "cdx:circleci:executor:name", value: exName },
          ],
        });
      }
    }
  }

  // Build a workflow/task tree per CircleCI workflow
  const circleCiWorkflows =
    yamlObj.workflows && typeof yamlObj.workflows === "object"
      ? Object.entries(yamlObj.workflows).filter(([key]) => key !== "version")
      : [];

  for (const [wfName, wfDef] of circleCiWorkflows) {
    if (!wfDef || typeof wfDef !== "object") {
      continue;
    }
    const workflowRef = uuidv4();
    const tasks = [];
    const workflowDependsOn = [];

    const wfJobs = Array.isArray(wfDef.jobs) ? wfDef.jobs : [];
    for (const jobEntry of wfJobs) {
      // Each entry is either a string (job name) or { jobName: { requires, ... } }
      let jobName;
      let jobConfig = {};
      if (typeof jobEntry === "string") {
        jobName = jobEntry;
      } else if (typeof jobEntry === "object") {
        jobName = Object.keys(jobEntry)[0];
        jobConfig = jobEntry[jobName] || {};
      }
      if (!jobName) {
        continue;
      }

      const taskRef = uuidv4();
      const taskProperties = [
        { name: "cdx:circleci:job:name", value: jobName },
      ];

      const requires = Array.isArray(jobConfig.requires)
        ? jobConfig.requires
        : [];
      if (requires.length) {
        taskProperties.push({
          name: "cdx:circleci:job:requires",
          value: requires.join(","),
        });
      }

      const jobFilters = jobConfig.filters;
      if (jobFilters?.branches) {
        const only = Array.isArray(jobFilters.branches.only)
          ? jobFilters.branches.only.join(",")
          : jobFilters.branches.only || "";
        if (only) {
          taskProperties.push({
            name: "cdx:circleci:job:branch:only",
            value: only,
          });
        }
      }

      // Look up job definition for steps
      const jobDef = yamlObj.jobs?.[jobName] || {};
      const steps = [];
      for (const step of Array.isArray(jobDef.steps) ? jobDef.steps : []) {
        if (typeof step === "string") {
          steps.push({ name: step });
        } else if (typeof step === "object") {
          const stepKey = Object.keys(step)[0];
          const stepVal = step[stepKey];
          const stepName =
            typeof stepVal?.name === "string" ? stepVal.name : stepKey;
          const command =
            typeof stepVal?.command === "string" ? stepVal.command : undefined;
          steps.push({
            name: stepName,
            commands: command ? [{ executed: command }] : undefined,
          });
        }
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

    const workflow = {
      "bom-ref": workflowRef,
      uid: workflowRef,
      name: wfName,
      taskTypes: ["build"],
      tasks: tasks.length ? tasks : undefined,
      properties: [
        { name: "cdx:circleci:config", value: f },
        { name: "cdx:circleci:workflow:name", value: wfName },
      ],
    };

    workflows.push(workflow);
    if (workflowDependsOn.length) {
      dependencies.push({ ref: workflowRef, dependsOn: workflowDependsOn });
    }
  }

  // Fallback: if no workflows block, create a single workflow from jobs
  if (
    workflows.length === 0 &&
    yamlObj.jobs &&
    typeof yamlObj.jobs === "object"
  ) {
    const workflowRef = uuidv4();
    const tasks = [];
    const workflowDependsOn = [];

    for (const jobName of Object.keys(yamlObj.jobs)) {
      const taskRef = uuidv4();
      tasks.push({
        "bom-ref": taskRef,
        uid: taskRef,
        name: jobName,
        taskTypes: ["build"],
        properties: [{ name: "cdx:circleci:job:name", value: jobName }],
      });
      workflowDependsOn.push(taskRef);
    }

    workflows.push({
      "bom-ref": workflowRef,
      uid: workflowRef,
      name: "CircleCI Pipeline",
      taskTypes: ["build"],
      tasks: tasks.length ? tasks : undefined,
      properties: [{ name: "cdx:circleci:config", value: f }],
    });
    if (workflowDependsOn.length) {
      dependencies.push({ ref: workflowRef, dependsOn: workflowDependsOn });
    }
  }

  return { workflows, components, services: [], properties: [], dependencies };
}

/**
 * CircleCI formulation parser.
 *
 * Matches `.circleci/config.yml` and `.circleci/config.yaml` and converts them
 * into CycloneDX formulation workflow objects. Referenced orbs are captured as
 * components.
 *
 * Parser contract: `parse(files, options)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export const circleCiParser = {
  id: "circleci",
  patterns: [".circleci/config.{yml,yaml}"],

  /**
   * @param {string[]} files Matched config file paths
   * @param {Object} options CLI options
   * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
   */
  parse(files, options) {
    const workflows = [];
    const components = [];
    const dependencies = [];

    for (const f of files) {
      const result = parseCircleCiFile(f, options);
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
