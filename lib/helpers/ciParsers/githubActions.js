import { readFileSync } from "node:fs";

import { PackageURL } from "packageurl-js";
import { v4 as uuidv4 } from "uuid";
import { parse as _load } from "yaml";

import { disambiguateSteps } from "./common.js";

/**
 * Known GitHub Actions permission scopes that grant write access.
 * @type {string[]}
 */
const WRITE_SCOPES = [
  "actions",
  "artifact-metadata",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "security-events",
  "statuses",
];

/**
 * Workflow triggers considered high-risk because they can execute code in a
 * privileged context or expose secrets to untrusted input.
 * @type {string[]}
 */
const HIGH_RISK_TRIGGERS = [
  "pull_request_target",
  "issue_comment",
  "workflow_run",
];

/**
 * Analyse a workflow-level or job-level permissions map for any write grants.
 *
 * Accepts the raw `permissions` value from a workflow YAML which can be an
 * object mapping scope names to `"read"` / `"write"`, or the shorthand
 * strings `"write-all"` / `"read-all"`.
 *
 * @param {Object|string|undefined} permissions - The permissions map or shorthand string.
 * @returns {boolean} `true` when at least one scope has write access.
 */
function analyzePermissions(permissions) {
  if (!permissions) {
    return false;
  }
  if (typeof permissions === "string") {
    return permissions === "write-all";
  }
  if (typeof permissions !== "object") {
    return false;
  }
  for (const scope of WRITE_SCOPES) {
    if (permissions[scope] === "write") {
      return true;
    }
  }
  return false;
}

/**
 * Detect if a step uses `actions/checkout` and extract the
 * `persist-credentials` setting (defaults to `true` when absent).
 *
 * @param {Object} step - A single workflow step object.
 * @returns {Array<{name: string, value: string}>} Property entries to append.
 */
function analyzeCheckoutStep(step) {
  const props = [];
  if (step.uses?.includes("actions/checkout")) {
    const persistCreds = step.with?.["persist-credentials"] ?? true;
    props.push({
      name: "cdx:github:checkout:persistCredentials",
      value: String(persistCreds),
    });
  }
  return props;
}

/**
 * Detect `actions/cache` usage and extract key, path, and restore-keys
 * metadata from the step's `with` block.
 *
 * @param {Object} step - A single workflow step object.
 * @returns {Array<{name: string, value: string}>} Property entries to append.
 */
function analyzeCacheStep(step) {
  const props = [];
  if (step.uses?.includes("actions/cache")) {
    if (step.with?.key) {
      props.push({ name: "cdx:github:cache:key", value: step.with.key });
    }
    if (step.with?.path) {
      props.push({ name: "cdx:github:cache:path", value: step.with.path });
    }
    if (step.with?.["restore-keys"]) {
      let keys = step.with["restore-keys"];
      if (Array.isArray(keys)) {
        keys = keys.join(",");
      } else if (typeof keys === "string" && keys.includes("\n")) {
        keys = keys
          .split("\n")
          .map((k) => k.trim())
          .filter((k) => k)
          .join(",");
      }
      props.push({ name: "cdx:github:cache:restoreKeys", value: keys });
    }
  }
  return props;
}

/**
 * Detect untrusted expression interpolation in `run:` blocks.
 *
 * Scans the raw shell string for `${{ … }}` patterns and flags any that
 * reference user-controlled contexts such as `github.event.pull_request.*`,
 * `github.event.issue.*`, `github.event.comment.*`, `github.head_ref`, or
 * `inputs.*`.
 *
 * @param {string|undefined} runValue - The raw `run:` block string.
 * @returns {{ hasInterpolation: boolean, vars: string[] }}
 */
function detectUntrustedInterpolation(runValue) {
  if (!runValue) return { hasInterpolation: false, vars: [] };
  // Capture expression content inside ${{ … }}, allowing nested single braces
  // (e.g. the || operator in `${{ a || b }}` where } appears inside the expr).
  const pattern = /\$\{\{\s*([^}]+(?:}[^}])*)}}/g;
  const matches = [...runValue.matchAll(pattern)];
  const untrustedVars = [];

  for (const match of matches) {
    const expr = match[1].trim();
    if (
      expr.startsWith("github.event.pull_request") ||
      expr.startsWith("github.event.issue") ||
      expr.startsWith("github.event.comment") ||
      expr.startsWith("github.head_ref") ||
      expr.startsWith("inputs.")
    ) {
      untrustedVars.push(expr);
    }
  }

  return {
    hasInterpolation: untrustedVars.length > 0,
    vars: untrustedVars,
  };
}

/**
 * Classify a GitHub Actions version reference as `"sha"`, `"tag"`, or `"branch"`.
 *
 * @param {string|undefined} versionRef - The part after `@` in `uses: owner/action@ref`.
 * @returns {"sha"|"tag"|"branch"|"unknown"} The pinning category.
 */
function getVersionPinningType(versionRef) {
  if (!versionRef) {
    return "unknown";
  }
  if (/^[a-f0-9]{40}$/.test(versionRef) || /^[a-f0-9]{7,}$/.test(versionRef)) {
    return "sha";
  }
  if (
    versionRef === "main" ||
    versionRef === "master" ||
    versionRef.includes("/")
  ) {
    return "branch";
  }
  return "tag";
}

/**
 * Normalise the `on:` trigger value from a workflow YAML into a
 * comma-separated string of trigger names.
 *
 * GitHub Actions supports three forms:
 *  - string:  `on: push`
 *  - array:   `on: [push, pull_request]`
 *  - object:  `on: { push: { branches: [main] } }`
 *
 * @param {string|string[]|Object|undefined} triggers - Raw `on` value.
 * @returns {string} Comma-separated trigger names, or empty string.
 */
function normalizeTriggers(triggers) {
  if (!triggers) return "";
  if (typeof triggers === "string") return triggers;
  if (Array.isArray(triggers)) return triggers.join(",");
  return Object.keys(triggers).join(",");
}

/**
 * Determine whether the given trigger value includes at least one high-risk
 * trigger (`pull_request_target`, `issue_comment`, or `workflow_run`).
 *
 * @param {string|string[]|Object|undefined} triggers - Raw `on` value.
 * @returns {boolean}
 */
function hasHighRiskTrigger(triggers) {
  const csv = normalizeTriggers(triggers);
  if (!csv) return false;
  return csv.split(",").some((t) => HIGH_RISK_TRIGGERS.includes(t.trim()));
}

/**
 * Build the set of common workflow-context properties that are duplicated
 * onto every component (action or run-step) so that policy rules written
 * against `components[…]` can evaluate workflow-level attributes without
 * traversing the formulation tree.
 *
 * @param {Object} ctx
 * @param {boolean} ctx.hasWritePermissions - Whether workflow OR job has write perms.
 * @param {boolean} ctx.hasIdTokenWrite     - Whether `id-token: write` is granted.
 * @param {string}  ctx.triggers            - Comma-separated trigger names.
 * @param {boolean} ctx.isHighRisk          - Whether any trigger is high-risk.
 * @returns {Array<{name: string, value: string}>}
 */
function buildWorkflowContextProperties({
  hasWritePermissions,
  hasIdTokenWrite,
  triggers,
  isHighRisk,
}) {
  const props = [];
  if (hasWritePermissions) {
    props.push({
      name: "cdx:github:workflow:hasWritePermissions",
      value: "true",
    });
  }
  if (hasIdTokenWrite) {
    props.push({
      name: "cdx:github:workflow:hasIdTokenWrite",
      value: "true",
    });
  }
  if (triggers) {
    props.push({ name: "cdx:github:workflow:triggers", value: triggers });
  }
  if (isHighRisk) {
    props.push({
      name: "cdx:github:workflow:hasHighRiskTrigger",
      value: "true",
    });
  }
  return props;
}

/**
 * Parse a single GitHub Actions workflow file and return formulation-shaped data.
 *
 * Reads and parses the YAML, then walks every job and step to produce:
 * - **workflows** – CycloneDX formulation workflow objects with tasks
 * - **components** – action references (`pkg:github/…`) and run-step processes
 * - **dependencies** – workflow→job and job→action/step edges
 *
 * @param {string} f - Absolute path to a workflow YAML file.
 * @param {Object} _options - CLI options (currently unused but kept for interface consistency).
 * @returns {{ workflows: Object[], components: Object[], dependencies: Object[] }}
 */
function parseWorkflowFile(f, _options) {
  const workflows = [];
  const components = [];
  const dependencies = [];

  let raw;
  try {
    raw = readFileSync(f, { encoding: "utf-8" });
  } catch (_e) {
    return { workflows, components, dependencies };
  }

  let yamlObj;
  try {
    yamlObj = _load(raw);
  } catch (_e) {
    return { workflows, components, dependencies };
  }

  if (!yamlObj?.jobs) {
    return { workflows, components, dependencies };
  }

  const workflowName =
    yamlObj.name ||
    f
      .split("/")
      .pop()
      .replace(/\.[^.]+$/, "");
  const workflowTriggers = yamlObj.on || yamlObj.true;
  const workflowPermissions = yamlObj.permissions || {};
  const workflowHasWritePermissions = analyzePermissions(workflowPermissions);
  const hasIdTokenWrite = workflowPermissions?.["id-token"] === "write";
  const triggers = normalizeTriggers(workflowTriggers);
  const isHighRisk = hasHighRiskTrigger(workflowTriggers);

  const workflowRef = uuidv4();
  const tasks = [];
  const workflowDependsOn = [];

  for (const jobName of Object.keys(yamlObj.jobs)) {
    const job = yamlObj.jobs[jobName];
    const jobRef = uuidv4();
    const steps = [];
    const jobDependsOn = [];

    // Job needs (dependency links)
    let jobNeeds = job.needs || [];
    if (!Array.isArray(jobNeeds)) {
      jobNeeds = [jobNeeds];
    }

    const jobRunner = job["runs-on"] || "unknown";
    const jobEnvironment = job.environment?.name || job.environment || "";
    const jobPermissions = job.permissions || {};
    const jobHasWritePermissions = analyzePermissions(jobPermissions);
    const jobServices = job.services ? Object.keys(job.services) : [];
    const effectiveWritePerms =
      workflowHasWritePermissions || jobHasWritePermissions;

    // Shared workflow-context properties for this job's components
    const sharedCtxProps = buildWorkflowContextProperties({
      hasWritePermissions: effectiveWritePerms,
      hasIdTokenWrite,
      triggers,
      isHighRisk,
    });

    const jobProperties = [
      { name: "cdx:github:job:name", value: jobName },
      {
        name: "cdx:github:job:runner",
        value: Array.isArray(jobRunner) ? jobRunner.join(",") : jobRunner,
      },
    ];
    if (jobEnvironment) {
      jobProperties.push({
        name: "cdx:github:job:environment",
        value: jobEnvironment,
      });
    }
    if (jobHasWritePermissions) {
      jobProperties.push({
        name: "cdx:github:job:hasWritePermissions",
        value: "true",
      });
    }
    if (jobServices.length) {
      jobProperties.push({
        name: "cdx:github:job:services",
        value: jobServices.join(","),
      });
    }
    if (jobNeeds.length) {
      jobProperties.push({
        name: "cdx:github:job:needs",
        value: jobNeeds.join(","),
      });
    }
    jobProperties.push(...sharedCtxProps);

    for (const step of job.steps || []) {
      const stepName = step.name || step.uses || "unnamed step";
      const commands = [];
      let actionProperties = [];
      if (step.uses) {
        commands.push({ executed: step.uses });
        // Collect action references as components
        const tmpA = step.uses.split("@");
        if (tmpA.length === 2) {
          const groupName = tmpA[0];
          const tagOrCommit = tmpA[1];
          const versionPinningType = getVersionPinningType(tagOrCommit);
          const isShaPinned = versionPinningType === "sha";

          const tmpB = groupName.split("/");
          const name = tmpB.length >= 2 ? tmpB.pop() : tmpB[0];
          const group = tmpB.join("/");
          const purl = new PackageURL(
            "github",
            group || undefined,
            name,
            tagOrCommit,
            null,
            null,
          ).toString();

          actionProperties = [
            ...actionProperties,
            { name: "SrcFile", value: f },
            { name: "cdx:github:workflow:name", value: workflowName },
            { name: "cdx:github:job:name", value: jobName },
            {
              name: "cdx:github:job:runner",
              value: Array.isArray(jobRunner) ? jobRunner.join(",") : jobRunner,
            },
            { name: "cdx:github:action:uses", value: step.uses },
            {
              name: "cdx:github:action:versionPinningType",
              value: versionPinningType,
            },
            {
              name: "cdx:github:action:isShaPinned",
              value: isShaPinned.toString(),
            },
          ];
          if (step.name) {
            actionProperties.push({
              name: "cdx:github:step:name",
              value: step.name,
            });
          }
          if (step.if) {
            actionProperties.push({
              name: "cdx:github:step:condition",
              value: step.if,
            });
          }
          if (group?.startsWith("github/") || group === "actions") {
            actionProperties.push({
              name: "cdx:actions:isOfficial",
              value: "true",
            });
          }
          if (group?.startsWith("github/")) {
            actionProperties.push({
              name: "cdx:actions:isVerified",
              value: "true",
            });
          }
          actionProperties.push(...analyzeCheckoutStep(step));
          actionProperties.push(...analyzeCacheStep(step));
          actionProperties.push(...sharedCtxProps);

          components.push({
            "bom-ref": purl,
            type: "application",
            group,
            name,
            version: tagOrCommit,
            purl,
            properties: actionProperties,
          });
          jobDependsOn.push(purl);
        }
      } else if (step.run) {
        commands.push({ executed: step.run.trim().split("\n")[0] });
        const stepRef = `${jobRef}-step-${steps.length + 1}`;
        const runProperties = [
          { name: "SrcFile", value: f },
          { name: "cdx:github:workflow:name", value: workflowName },
          { name: "cdx:github:job:name", value: jobName },
          { name: "cdx:github:step:type", value: "run" },
          {
            name: "cdx:github:step:command",
            value: step.run.trim().split("\n")[0],
          },
        ];
        runProperties.push(...sharedCtxProps);

        const { hasInterpolation, vars } = detectUntrustedInterpolation(
          step.run,
        );
        if (hasInterpolation) {
          runProperties.push({
            name: "cdx:github:step:hasUntrustedInterpolation",
            value: "true",
          });
          runProperties.push({
            name: "cdx:github:step:interpolatedVars",
            value: vars.join(","),
          });
        }
        components.push({
          "bom-ref": stepRef,
          type: "application",
          name: stepName,
          purl: new PackageURL(
            "github",
            "workflow",
            workflowName,
            undefined,
            {
              job: jobName,
              step: String(steps.length + 1),
            },
            undefined,
          ).toString(),
          properties: runProperties,
        });

        jobDependsOn.push(stepRef);
      }

      steps.push({
        name: stepName,
        commands: commands.length ? commands : undefined,
      });
    }

    const task = {
      "bom-ref": jobRef,
      uid: jobRef,
      name: jobName,
      taskTypes: ["build"],
      steps: disambiguateSteps(steps),
      properties: jobProperties,
    };

    tasks.push(task);
    workflowDependsOn.push(jobRef);

    // Wire job→action dependencies
    if (jobDependsOn.length) {
      dependencies.push({ ref: jobRef, dependsOn: jobDependsOn });
    }
  }

  // Build workflow-level properties using the same helpers
  const workflowProperties = [
    { name: "cdx:github:workflow:file", value: f },
    ...buildWorkflowContextProperties({
      hasWritePermissions: workflowHasWritePermissions,
      hasIdTokenWrite,
      triggers,
      isHighRisk,
    }),
  ];

  const workflow = {
    "bom-ref": workflowRef,
    uid: workflowRef,
    name: workflowName,
    taskTypes: ["build"],
    tasks: tasks.length ? tasks : undefined,
    properties: workflowProperties,
  };

  workflows.push(workflow);

  if (workflowDependsOn.length) {
    dependencies.push({ ref: workflowRef, dependsOn: workflowDependsOn });
  }

  return { workflows, components, dependencies };
}

/**
 * GitHub Actions formulation parser.
 *
 * Matches `.github/workflows/*.yml` and `*.yaml` files and converts them into
 * CycloneDX formulation workflow objects, with referenced actions as components.
 *
 * Parser contract: `parse(files, options)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export const githubActionsParser = {
  id: "github-actions",
  patterns: [".github/workflows/*.{yml,yaml}"],

  /**
   * @param {string[]} files Matched workflow file paths
   * @param {Object} options CLI options
   * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
   */
  parse(files, options) {
    const workflows = [];
    const components = [];
    const dependencies = [];

    for (const f of files) {
      const result = parseWorkflowFile(f, options);
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
