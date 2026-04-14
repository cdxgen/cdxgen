import { readFileSync } from "node:fs";

import { v4 as uuidv4 } from "uuid";
import { parse as _load } from "yaml";

import { disambiguateSteps } from "./common.js";

/**
 * Parse a single .gitlab-ci.yml file and return formulation-shaped data.
 *
 * @param {string} f Absolute path to the YAML file
 * @param {Object} _options CLI options
 * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
 */
function parseGitlabCiFile(f, _options) {
  const workflows = [];
  const components = [];
  const services = [];
  const dependencies = [];

  let raw;
  try {
    raw = readFileSync(f, { encoding: "utf-8" });
  } catch (_e) {
    return { workflows, components, services, properties: [], dependencies };
  }

  let yamlObj;
  try {
    yamlObj = _load(raw);
  } catch (_e) {
    return { workflows, components, services, properties: [], dependencies };
  }

  if (!yamlObj || typeof yamlObj !== "object") {
    return { workflows, components, services, properties: [], dependencies };
  }

  // Top-level reserved keys that are not job names
  const RESERVED_KEYS = new Set([
    "image",
    "services",
    "stages",
    "types",
    "before_script",
    "after_script",
    "variables",
    "cache",
    "include",
    "workflow",
    "default",
    "pages",
    ".pre",
    ".post",
  ]);

  const globalImage = yamlObj.image?.name || yamlObj.image || "";
  const stages = Array.isArray(yamlObj.stages) ? yamlObj.stages : [];

  // Collect global services as CycloneDX service objects
  const globalServices = Array.isArray(yamlObj.services)
    ? yamlObj.services
    : [];
  for (const svc of globalServices) {
    const svcName = typeof svc === "string" ? svc : svc?.name || "";
    if (svcName) {
      services.push({ name: svcName });
    }
  }

  const tasks = [];
  const workflowRef = uuidv4();
  const workflowDependsOn = [];

  for (const key of Object.keys(yamlObj)) {
    if (RESERVED_KEYS.has(key) || key.startsWith(".")) {
      continue;
    }
    const job = yamlObj[key];
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      continue;
    }

    const jobRef = uuidv4();
    const steps = [];
    const jobProperties = [{ name: "cdx:gitlab:job:name", value: key }];

    const jobStage = job.stage || "test";
    jobProperties.push({ name: "cdx:gitlab:job:stage", value: jobStage });

    const jobImage = job.image?.name || job.image || globalImage;
    if (jobImage) {
      jobProperties.push({ name: "cdx:gitlab:job:image", value: jobImage });
      components.push({ type: "container", name: jobImage });
    }

    const jobEnv = job.environment?.name || job.environment || "";
    if (jobEnv) {
      jobProperties.push({ name: "cdx:gitlab:job:environment", value: jobEnv });
    }

    // Collect job-level services
    const jobServices = Array.isArray(job.services) ? job.services : [];
    for (const svc of jobServices) {
      const svcName = typeof svc === "string" ? svc : svc?.name || "";
      if (svcName) {
        services.push({ name: svcName });
      }
    }
    if (jobServices.length) {
      jobProperties.push({
        name: "cdx:gitlab:job:services",
        value: jobServices
          .map((s) => (typeof s === "string" ? s : s?.name || ""))
          .join(","),
      });
    }

    const jobNeeds = Array.isArray(job.needs) ? job.needs : [];
    if (jobNeeds.length) {
      const jobNeedNames = jobNeeds
        .map((need) => (typeof need === "string" ? need : need?.job || ""))
        .filter(Boolean);
      if (jobNeedNames.length) {
        jobProperties.push({
          name: "cdx:gitlab:job:needs",
          value: jobNeedNames.join(","),
        });
      }
    }

    // before_script
    for (const cmd of Array.isArray(job.before_script)
      ? job.before_script
      : []) {
      steps.push({ name: "before_script", commands: [{ executed: cmd }] });
    }
    // script (main)
    for (const cmd of Array.isArray(job.script) ? job.script : []) {
      steps.push({ name: "script", commands: [{ executed: cmd }] });
    }
    // after_script
    for (const cmd of Array.isArray(job.after_script) ? job.after_script : []) {
      steps.push({ name: "after_script", commands: [{ executed: cmd }] });
    }

    tasks.push({
      "bom-ref": jobRef,
      uid: jobRef,
      name: key,
      taskTypes: ["build"],
      steps: disambiguateSteps(steps),
      properties: jobProperties,
    });
    workflowDependsOn.push(jobRef);
  }

  const stagesProperty = stages.length
    ? [{ name: "cdx:gitlab:stages", value: stages.join(",") }]
    : [];

  const workflow = {
    "bom-ref": workflowRef,
    uid: workflowRef,
    name: "GitLab CI Pipeline",
    taskTypes: ["build"],
    tasks: tasks.length ? tasks : undefined,
    properties: [{ name: "cdx:gitlab:config", value: f }, ...stagesProperty],
  };

  workflows.push(workflow);
  if (workflowDependsOn.length) {
    dependencies.push({ ref: workflowRef, dependsOn: workflowDependsOn });
  }

  return { workflows, components, services, properties: [], dependencies };
}

/**
 * GitLab CI formulation parser.
 *
 * Matches `.gitlab-ci.yml` files and converts them into CycloneDX formulation
 * workflow objects. Each GitLab job becomes a task; script lines become steps.
 *
 * Parser contract: `parse(files, options)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export const gitlabCiParser = {
  id: "gitlab-ci",
  patterns: ["**/.gitlab-ci.yml", ".gitlab-ci.yml"],

  /**
   * @param {string[]} files Matched CI config file paths
   * @param {Object} options CLI options
   * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
   */
  parse(files, options) {
    const workflows = [];
    const components = [];
    const services = [];
    const dependencies = [];

    for (const f of files) {
      const result = parseGitlabCiFile(f, options);
      workflows.push(...result.workflows);
      components.push(...result.components);
      services.push(...result.services);
      dependencies.push(...result.dependencies);
    }

    return { workflows, components, services, properties: [], dependencies };
  },
};
