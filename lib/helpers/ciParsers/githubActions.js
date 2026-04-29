import { readFileSync } from "node:fs";
import path from "node:path";

import { PackageURL } from "packageurl-js";
import { v4 as uuidv4 } from "uuid";
import { parse as _load } from "yaml";

import { scanTextForHiddenUnicode } from "../unicodeScan.js";
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

const LOW_RISK_INTERPOLATION_PATTERNS = [
  /^github\.sha$/,
  /^github\.event\.pull_request\.(?:head|base)\.sha$/,
  /^github\.event\.workflow_run\.head_sha$/,
  /^github\.event\.pull_request\.number$/,
  /^github\.event\.issue\.number$/,
  /^github\.run_attempt$/,
  /^github\.run_id$/,
  /^github\.run_number$/,
];

const LEGACY_PUBLISH_TOKEN_ENV_NAMES = new Set([
  "NPM_CONFIG_TOKEN",
  "TWINE_PASSWORD",
]);

const SECRET_LIKE_ENV_NAME_PATTERN =
  /token|secret|password|credential|auth|api[_-]?key|access[_-]?key|client[_-]?secret/i;

const SENSITIVE_ENV_VALUE_PATTERN =
  /secrets\.[A-Za-z0-9_]+|github\.token|ACTIONS_ID_TOKEN_REQUEST_(?:TOKEN|URL)/i;

const SHELL_VARIABLE_REFERENCE_PATTERN =
  /\$[A-Za-z_][A-Za-z0-9_]*\b|\$\{[A-Za-z_][A-Za-z0-9_]*}|%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_][A-Za-z0-9_]*\b/i;

const IMPLICIT_SENSITIVE_ENV_NAMES = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_TOKEN",
];

const OUTBOUND_NETWORK_TOOLS = [
  ["curl", /\bcurl\b/i],
  ["wget", /\bwget\b/i],
  ["invoke-webrequest", /\b(?:invoke-webrequest|iwr)\b/i],
  ["invoke-restmethod", /\b(?:invoke-restmethod|irm)\b/i],
  ["nc", /\b(?:nc|ncat|netcat)\b/i],
  ["scp", /\bscp\b/i],
  ["rsync", /\brsync\b/i],
  ["ftp", /\b(?:ftp|sftp)\b/i],
];

const KNOWN_DISPATCH_ACTIONS = [
  {
    kind: "repository_dispatch",
    mechanism: "repository-dispatch-action",
    pattern: /^peter-evans\/repository-dispatch(?:@|$)/i,
    repoKeys: ["repository"],
    targetKeys: ["event-type"],
  },
  {
    kind: "workflow_dispatch",
    mechanism: "workflow-dispatch-action",
    pattern:
      /^(?:benc-uk\/workflow-dispatch|lasith-kg\/dispatch-workflow|convictional\/trigger-workflow-and-wait-for-workflow)(?:@|$)/i,
    repoKeys: ["repo", "repository"],
    targetKeys: ["workflow", "workflow_id", "event-type", "ref"],
  },
];

const CARGO_TOOLCHAIN_ACTION_PATTERNS = [
  /^dtolnay\/rust-toolchain(?:@|$)/i,
  /^actions-rs\/toolchain(?:@|$)/i,
  /^moonrepo\/setup-rust(?:@|$)/i,
];

const CARGO_CACHE_ACTION_PATTERNS = [/^swatinem\/rust-cache(?:@|$)/i];

const CARGO_TOOL_INSTALL_ACTION_PATTERNS = [/^taiki-e\/install-action(?:@|$)/i];

const FORK_CONTEXT_PATTERNS = [
  [
    "github.event.pull_request.head.repo.fork",
    /github\.event\.pull_request\.head\.repo\.fork/i,
  ],
  [
    "github.event.pull_request.head.repo.full_name",
    /github\.event\.pull_request\.head\.repo\.full_name/i,
  ],
  [
    "github.event.pull_request.head.repo.clone_url",
    /github\.event\.pull_request\.head\.repo\.clone_url/i,
  ],
  [
    "github.event.workflow_run.head_repository.fork",
    /github\.event\.workflow_run\.head_repository\.fork/i,
  ],
  [
    "github.event.workflow_run.head_repository.full_name",
    /github\.event\.workflow_run\.head_repository\.full_name/i,
  ],
  [
    "github.event.pull_request.head.ref",
    /github\.event\.pull_request\.head\.ref/i,
  ],
  ["github.head_ref", /github\.head_ref/i],
];

const UNTRUSTED_CHECKOUT_CONTEXT_PATTERNS = [
  [
    "github.event.pull_request.head.sha",
    /github\.event\.pull_request\.head\.sha/i,
  ],
  [
    "github.event.pull_request.head.ref",
    /github\.event\.pull_request\.head\.ref/i,
  ],
  [
    "github.event.pull_request.head.label",
    /github\.event\.pull_request\.head\.label/i,
  ],
  ["github.head_ref", /github\.head_ref/i],
  [
    "github.event.workflow_run.head_sha",
    /github\.event\.workflow_run\.head_sha/i,
  ],
  [
    "github.event.workflow_run.head_branch",
    /github\.event\.workflow_run\.head_branch/i,
  ],
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

function extractWriteScopes(permissions) {
  if (!permissions) {
    return [];
  }
  if (typeof permissions === "string") {
    return permissions === "write-all" ? ["all"] : [];
  }
  if (typeof permissions !== "object") {
    return [];
  }
  const scopes = [];
  for (const scope of WRITE_SCOPES) {
    if (permissions[scope] === "write") {
      scopes.push(scope);
    }
  }
  return scopes;
}

function hasIdTokenWritePermission(permissions) {
  if (!permissions) {
    return false;
  }
  if (typeof permissions === "string") {
    return permissions === "write-all";
  }
  if (typeof permissions !== "object") {
    return false;
  }
  return permissions["id-token"] === "write";
}

function getPropertyValueFromProperties(properties, propName) {
  return properties.find((property) => property.name === propName)?.value;
}

function appendSensitiveOperationProperties(properties) {
  const sensitiveOperations = new Set();
  if (
    getPropertyValueFromProperties(
      properties,
      "cdx:github:step:referencesSensitiveContext",
    ) === "true"
  ) {
    sensitiveOperations.add("references-sensitive-context");
  }
  if (
    getPropertyValueFromProperties(
      properties,
      "cdx:github:step:dispatchesWorkflow",
    ) === "true"
  ) {
    sensitiveOperations.add("dispatches-workflow");
  }
  if (
    getPropertyValueFromProperties(
      properties,
      "cdx:github:step:mutatesRunnerState",
    ) === "true"
  ) {
    sensitiveOperations.add("mutates-runner-state");
  }
  if (
    getPropertyValueFromProperties(
      properties,
      "cdx:github:step:usesLegacyPublishToken",
    ) === "true"
  ) {
    sensitiveOperations.add("legacy-publish-token");
  }
  if (
    getPropertyValueFromProperties(
      properties,
      "cdx:github:step:hasOutboundNetworkCommand",
    ) === "true" &&
    getPropertyValueFromProperties(
      properties,
      "cdx:github:step:referencesSensitiveContext",
    ) === "true"
  ) {
    sensitiveOperations.add("outbound-network-with-sensitive-context");
  }
  const actionUses = getPropertyValueFromProperties(
    properties,
    "cdx:github:action:uses",
  );
  const persistCredentials = getPropertyValueFromProperties(
    properties,
    "cdx:github:checkout:persistCredentials",
  );
  if (
    actionUses?.includes("actions/checkout") &&
    persistCredentials !== "false"
  ) {
    sensitiveOperations.add("checkout-persist-credentials");
  }
  if (!sensitiveOperations.size) {
    return;
  }
  properties.push({
    name: "cdx:github:step:hasSensitiveOperations",
    value: "true",
  });
  properties.push({
    name: "cdx:github:step:sensitiveOperations",
    value: Array.from(sensitiveOperations).join(","),
  });
}

function normalizeRunnerLabels(runsOn) {
  if (!runsOn) {
    return [];
  }
  if (Array.isArray(runsOn)) {
    return runsOn.map((label) => String(label).trim()).filter(Boolean);
  }
  if (typeof runsOn === "string") {
    return runsOn
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
  }
  return [];
}

function isSelfHostedRunner(runsOn) {
  return normalizeRunnerLabels(runsOn).some((label) =>
    label.toLowerCase().includes("self-hosted"),
  );
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
    const checkoutRef = step.with?.ref;
    const checkoutRepository = step.with?.repository;
    props.push({
      name: "cdx:github:checkout:persistCredentials",
      value: String(persistCreds),
    });
    if (checkoutRef) {
      props.push({ name: "cdx:github:checkout:ref", value: checkoutRef });
    }
    if (checkoutRepository) {
      props.push({
        name: "cdx:github:checkout:repository",
        value: checkoutRepository,
      });
    }
    const untrustedCheckoutContexts = [
      ...detectCheckoutUntrustedContexts(checkoutRef),
      ...detectCheckoutUntrustedContexts(checkoutRepository),
    ];
    if (untrustedCheckoutContexts.length) {
      props.push({
        name: "cdx:github:checkout:checksOutUntrustedRef",
        value: "true",
      });
      props.push({
        name: "cdx:github:checkout:untrustedRefContexts",
        value: [...new Set(untrustedCheckoutContexts)].join(","),
      });
    }
    const forkContextRefs = [
      ...detectForkContextReferences(checkoutRef),
      ...detectForkContextReferences(checkoutRepository),
    ];
    if (forkContextRefs.length) {
      props.push({
        name: "cdx:github:checkout:referencesForkContext",
        value: "true",
      });
      props.push({
        name: "cdx:github:checkout:forkContextRefs",
        value: [...new Set(forkContextRefs)].join(","),
      });
    }
  }
  return props;
}

function detectCheckoutUntrustedContexts(textValue) {
  if (!textValue || typeof textValue !== "string") {
    return [];
  }
  const refs = [];
  UNTRUSTED_CHECKOUT_CONTEXT_PATTERNS.forEach(([name, pattern]) => {
    if (pattern.test(textValue)) {
      refs.push(name);
    }
  });
  return refs;
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
    const cacheKey = step.with?.key;
    if (step.with?.key) {
      props.push({ name: "cdx:github:cache:key", value: cacheKey });
      if (/hashFiles\s*\(/i.test(cacheKey)) {
        props.push({
          name: "cdx:github:cache:keyUsesHashFiles",
          value: "true",
        });
      }
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
      props.push({ name: "cdx:github:cache:hasRestoreKeys", value: "true" });
    }
  }
  return props;
}

function analyzeCargoActionStep(step) {
  const props = [];
  if (!step?.uses || typeof step.uses !== "string") {
    return props;
  }
  const cargoRoles = new Set();
  if (
    CARGO_TOOLCHAIN_ACTION_PATTERNS.some((pattern) => pattern.test(step.uses))
  ) {
    cargoRoles.add("toolchain");
  }
  if (CARGO_CACHE_ACTION_PATTERNS.some((pattern) => pattern.test(step.uses))) {
    cargoRoles.add("cache");
  }
  if (
    CARGO_TOOL_INSTALL_ACTION_PATTERNS.some((pattern) =>
      pattern.test(step.uses),
    )
  ) {
    cargoRoles.add("tool-install");
  }
  if (
    step.uses.includes("actions/cache") &&
    typeof step.with?.path === "string" &&
    /(?:^|[\\/])\.cargo(?:[\\/]|$)|cargo[\\/](?:registry|git)/i.test(
      step.with.path,
    )
  ) {
    cargoRoles.add("cache");
  }
  if (!cargoRoles.size) {
    return props;
  }
  props.push({
    name: "cdx:github:action:ecosystem",
    value: "cargo",
  });
  props.push({
    name: "cdx:github:action:role",
    value: [...cargoRoles].join(","),
  });
  return props;
}

function analyzeCargoRunStep(normalizedRun) {
  const props = [];
  if (!normalizedRun || typeof normalizedRun !== "string") {
    return props;
  }
  const cargoSubcommands = new Set();
  for (const match of normalizedRun.matchAll(/\bcargo\s+([a-z][\w-]*)/gi)) {
    if (match[1]) {
      cargoSubcommands.add(match[1].toLowerCase());
    }
  }
  if (!cargoSubcommands.size) {
    return props;
  }
  props.push({
    name: "cdx:github:step:usesCargo",
    value: "true",
  });
  props.push({
    name: "cdx:github:step:cargoSubcommands",
    value: [...cargoSubcommands].join(","),
  });
  if (/\s--workspace\b|\s--all\b|\s--all-targets\b/i.test(normalizedRun)) {
    props.push({
      name: "cdx:github:step:cargoWorkspaceScope",
      value: "true",
    });
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
  const untrustedVars = new Set();

  for (const match of matches) {
    const expr = match[1].trim();
    if (LOW_RISK_INTERPOLATION_PATTERNS.some((pattern) => pattern.test(expr))) {
      continue;
    }
    if (
      expr.startsWith("github.event.pull_request.title") ||
      expr.startsWith("github.event.pull_request.body") ||
      expr.startsWith("github.event.pull_request.head.ref") ||
      expr.startsWith("github.event.pull_request.head.label") ||
      expr.startsWith("github.event.issue.title") ||
      expr.startsWith("github.event.issue.body") ||
      expr.startsWith("github.event.comment.body") ||
      expr.startsWith("github.event.review.body") ||
      expr.startsWith("github.event.review_comment.body") ||
      expr.startsWith("github.head_ref") ||
      expr.startsWith("inputs.")
    ) {
      untrustedVars.add(expr);
    }
  }

  return {
    hasInterpolation: untrustedVars.size > 0,
    vars: Array.from(untrustedVars),
  };
}

function isLegacyPublishTokenEnvName(envName) {
  if (!envName || typeof envName !== "string") {
    return false;
  }
  return (
    envName.endsWith("_TOKEN") ||
    envName.startsWith("POETRY_PYPI_TOKEN") ||
    LEGACY_PUBLISH_TOKEN_ENV_NAMES.has(envName)
  );
}

function detectPublishEcosystem(runValue) {
  if (!runValue || typeof runValue !== "string") {
    return undefined;
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+publish\b/i.test(runValue)) {
    return "npm";
  }
  if (
    /\btwine\s+upload\b/i.test(runValue) ||
    /\bpoetry\s+publish\b/i.test(runValue) ||
    /\bflit\s+publish\b/i.test(runValue)
  ) {
    return "pypi";
  }
  return undefined;
}

function normalizeRunValueEntry(entry) {
  if (
    typeof entry === "string" ||
    typeof entry === "number" ||
    typeof entry === "boolean"
  ) {
    return String(entry);
  }
  return "";
}

function normalizeRunValue(runValue) {
  if (typeof runValue === "string") {
    return runValue;
  }
  if (typeof runValue === "number" || typeof runValue === "boolean") {
    return String(runValue);
  }
  if (Array.isArray(runValue)) {
    const normalizedEntries = runValue
      .map((entry) => normalizeRunValueEntry(entry))
      .filter(Boolean);
    return normalizedEntries.length ? normalizedEntries.join("\n") : undefined;
  }
  return undefined;
}

function analyzeLegacyPublishStep(step, effectiveEnv) {
  const props = [];
  const normalizedRun = normalizeRunValue(step?.run);
  const publishEcosystem = detectPublishEcosystem(normalizedRun);
  if (!publishEcosystem) {
    return props;
  }
  const tokenSources = [];
  if (normalizedRun && /\B--token(?:=|\s+\S+)/i.test(normalizedRun)) {
    tokenSources.push("cli-flag");
  }
  const legacyEnvNames = Object.keys(effectiveEnv || {}).filter(
    isLegacyPublishTokenEnvName,
  );
  legacyEnvNames.forEach((envName) => {
    tokenSources.push(`env:${envName}`);
  });
  props.push({
    name: "cdx:github:step:isPublishCommand",
    value: "true",
  });
  props.push({
    name: "cdx:github:step:publishEcosystem",
    value: publishEcosystem,
  });
  if (!tokenSources.length) {
    return props;
  }
  props.push({
    name: "cdx:github:step:usesLegacyPublishToken",
    value: "true",
  });
  props.push({
    name: "cdx:github:step:legacyPublishTokenSources",
    value: tokenSources.join(","),
  });
  return props;
}

function detectRunnerStateMutation(runValue) {
  if (!runValue || typeof runValue !== "string") {
    return { hasMutation: false, targets: [] };
  }
  const targets = new Set();
  const patterns = [
    [
      "GITHUB_ENV",
      /(?:>>?|1>>?)\s*["']?(?:\$GITHUB_ENV|\$\{GITHUB_ENV}|%GITHUB_ENV%|\$env:GITHUB_ENV)["']?/i,
    ],
    [
      "GITHUB_PATH",
      /(?:>>?|1>>?)\s*["']?(?:\$GITHUB_PATH|\$\{GITHUB_PATH}|%GITHUB_PATH%|\$env:GITHUB_PATH)["']?/i,
    ],
    [
      "GITHUB_OUTPUT",
      /(?:>>?|1>>?)\s*["']?(?:\$GITHUB_OUTPUT|\$\{GITHUB_OUTPUT}|%GITHUB_OUTPUT%|\$env:GITHUB_OUTPUT)["']?/i,
    ],
  ];
  patterns.forEach(([target, pattern]) => {
    if (pattern.test(runValue)) {
      targets.add(target);
    }
  });
  if (/::set-output\b/i.test(runValue)) {
    targets.add("GITHUB_OUTPUT");
  }
  return {
    hasMutation: targets.size > 0,
    targets: Array.from(targets),
  };
}

function detectOutboundNetworkCommand(runValue) {
  if (!runValue || typeof runValue !== "string") {
    return { hasOutboundCommand: false, tools: [] };
  }
  const tools = [];
  OUTBOUND_NETWORK_TOOLS.forEach(([name, pattern]) => {
    if (pattern.test(runValue)) {
      tools.push(name);
    }
  });
  return {
    hasOutboundCommand: tools.length > 0,
    tools,
  };
}

function collectSensitiveEnvBindings(effectiveEnv) {
  const sensitiveRefs = [];
  Object.entries(effectiveEnv || {}).forEach(([envName, envValue]) => {
    if (isSensitiveEnvBinding(envName, envValue)) {
      sensitiveRefs.push(`env:${envName}`);
    }
  });
  return sensitiveRefs;
}

function isSensitiveEnvBinding(envName, envValue) {
  if (!envName || typeof envName !== "string") {
    return false;
  }
  if (IMPLICIT_SENSITIVE_ENV_NAMES.includes(envName)) {
    return true;
  }
  if (SECRET_LIKE_ENV_NAME_PATTERN.test(envName)) {
    return true;
  }
  if (typeof envValue !== "string") {
    return false;
  }
  return SENSITIVE_ENV_VALUE_PATTERN.test(envValue);
}

function detectSensitiveContextReferences(runValue, effectiveEnv) {
  if (!runValue || typeof runValue !== "string") {
    return [];
  }
  const sensitiveRefs = new Set();
  Object.entries(effectiveEnv || {}).forEach(([envName, envValue]) => {
    if (!isSensitiveEnvBinding(envName, envValue)) {
      return;
    }
    const envPattern = new RegExp(
      `(?:\\$${envName}\\b|\\$\\{${envName}\\}|%${envName}%|\\$env:${envName}\\b|process\\.env\\.${envName}\\b|process\\.env\\[['"]${envName}['"]])`,
      "i",
    );
    if (envPattern.test(runValue)) {
      sensitiveRefs.add(`env:${envName}`);
    }
  });
  const contextPatterns = [
    ["context:github.token", /github\.token/i],
    ["context:secrets", /secrets\.[A-Za-z0-9_]+/i],
    [
      "context:github-token-input",
      /github-token|process\.env\.GITHUB_TOKEN|process\.env\[['"]GITHUB_TOKEN['"]]/i,
    ],
    [
      "context:actions-id-token",
      /ACTIONS_ID_TOKEN_REQUEST_(?:TOKEN|URL)|id-token/i,
    ],
  ];
  contextPatterns.forEach(([name, pattern]) => {
    if (pattern.test(runValue)) {
      sensitiveRefs.add(name);
    }
  });
  return Array.from(sensitiveRefs);
}

function detectOutboundExfiltrationIndicators(runValue, sensitiveContextRefs) {
  if (
    !runValue ||
    typeof runValue !== "string" ||
    !Array.isArray(sensitiveContextRefs) ||
    !sensitiveContextRefs.length
  ) {
    return [];
  }
  const indicators = new Set();
  if (
    /(?:^|\s)(?:--header|-H)\s+[^\n]*(?:authorization|x-(?:api-key|auth-token|github-token)|private-token|token:)/i.test(
      runValue,
    ) &&
    SHELL_VARIABLE_REFERENCE_PATTERN.test(runValue)
  ) {
    indicators.add("auth-header");
  }
  if (
    /\b(?:--data(?:-raw|-binary|-urlencode)?|--body|--form|--upload-file|-InFile|-Body|-Form)\b|(?:^|\s)-[dFT]\b/i.test(
      runValue,
    )
  ) {
    indicators.add("request-payload");
  }
  if (
    /(?:^|\s)(?:-X|--request)\s*(?:POST|PUT|PATCH)\b|\b-Method\s+(?:Post|Put|Patch)\b/i.test(
      runValue,
    )
  ) {
    indicators.add("state-changing-method");
  }
  if (
    /\?[^\n"'\s]*(?:token|sig|signature|auth|secret|key)=/i.test(runValue) &&
    SHELL_VARIABLE_REFERENCE_PATTERN.test(runValue)
  ) {
    indicators.add("query-parameter");
  }
  if (/\b(?:scp|rsync)\b/i.test(runValue)) {
    indicators.add("file-transfer");
  }
  if (
    /\b(?:nc|ncat|netcat)\b[^\n]*(?:<|<<)/i.test(runValue) ||
    /\|\s*(?:nc|ncat|netcat)\b/i.test(runValue)
  ) {
    indicators.add("stream-transfer");
  }
  if (
    /\b(?:base64|openssl\s+enc)\b[^\n|]*\|\s*(?:curl|wget|nc|ncat|netcat)\b/i.test(
      runValue,
    )
  ) {
    indicators.add("encoded-payload");
  }
  if (
    sensitiveContextRefs.some(
      (ref) =>
        ref === "context:actions-id-token" ||
        ref === "context:github.token" ||
        ref.startsWith("context:secrets"),
    )
  ) {
    indicators.add("platform-credential");
  }
  return Array.from(indicators);
}

function detectForkContextReferences(textValue) {
  if (!textValue || typeof textValue !== "string") {
    return [];
  }
  const refs = [];
  FORK_CONTEXT_PATTERNS.forEach(([name, pattern]) => {
    if (pattern.test(textValue)) {
      refs.push(name);
    }
  });
  return refs;
}

function addDispatchTarget(targets, prefix, value) {
  if (!value || typeof value !== "string") {
    return;
  }
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return;
  }
  targets.add(`${prefix}:${normalizedValue}`);
}

function normalizeDispatchTargetPrefix(key) {
  if (!key) {
    return "unknown";
  }
  if (["repository", "repo"].includes(key)) {
    return "repo";
  }
  if (["workflow", "workflow_id"].includes(key)) {
    return "workflow";
  }
  if (key === "event-type") {
    return "event";
  }
  return key.replace(/_/g, "-");
}

function detectWorkflowDispatchInvocations(textValue) {
  const kinds = new Set();
  const mechanisms = new Set();
  const targets = new Set();
  if (!textValue || typeof textValue !== "string") {
    return {
      hasDispatch: false,
      kinds: [],
      mechanisms: [],
      targets: [],
      usesExplicitRepositoryTarget: false,
    };
  }
  const ghWorkflowRunMatch = textValue.match(
    /\bgh\s+workflow\s+run\s+([^\s"'`]+)/i,
  );
  if (ghWorkflowRunMatch) {
    kinds.add("workflow_dispatch");
    mechanisms.add("gh-workflow-run");
    addDispatchTarget(targets, "workflow", ghWorkflowRunMatch[1]);
  }
  const ghRepoMatch = textValue.match(
    /\b--repo\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i,
  );
  if (ghRepoMatch) {
    addDispatchTarget(targets, "repo", ghRepoMatch[1]);
  }
  for (const match of textValue.matchAll(
    /\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/workflows\/([^/\s"'`]+)\/dispatches\b/gi,
  )) {
    kinds.add("workflow_dispatch");
    mechanisms.add("github-api-workflow-dispatch");
    addDispatchTarget(targets, "repo", match[1]);
    addDispatchTarget(targets, "workflow", match[2]);
  }
  for (const match of textValue.matchAll(
    /\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/dispatches\b/gi,
  )) {
    kinds.add("repository_dispatch");
    mechanisms.add("github-api-repository-dispatch");
    addDispatchTarget(targets, "repo", match[1]);
  }
  if (
    /\b(?:github|octokit)\.rest\.actions\.createWorkflowDispatch\b/i.test(
      textValue,
    )
  ) {
    kinds.add("workflow_dispatch");
    mechanisms.add("github-script-workflow-dispatch");
  }
  if (
    /\b(?:github|octokit)\.rest\.repos\.createDispatchEvent\b/i.test(textValue)
  ) {
    kinds.add("repository_dispatch");
    mechanisms.add("github-script-repository-dispatch");
  }
  if (
    /\b(?:github|octokit)\.request\s*\(\s*["'`](?:POST\s+)?\/repos\/\{owner}\/\{repo}\/actions\/workflows\/\{workflow_id}\/dispatches/i.test(
      textValue,
    )
  ) {
    kinds.add("workflow_dispatch");
    mechanisms.add("octokit-request-workflow-dispatch");
  }
  if (
    /\b(?:github|octokit)\.request\s*\(\s*["'`](?:POST\s+)?\/repos\/\{owner}\/\{repo}\/dispatches/i.test(
      textValue,
    )
  ) {
    kinds.add("repository_dispatch");
    mechanisms.add("octokit-request-repository-dispatch");
  }
  const ownerMatch = textValue.match(/\bowner\s*:\s*["'`]([^"'`]+)["'`]/i);
  const repoMatch = textValue.match(/\brepo\s*:\s*["'`]([^"'`]+)["'`]/i);
  const workflowMatch = textValue.match(
    /\bworkflow(?:_id)?\s*:\s*["'`]([^"'`]+)["'`]/i,
  );
  const eventTypeMatch = textValue.match(
    /\bevent_type\s*:\s*["'`]([^"'`]+)["'`]/i,
  );
  const refMatch = textValue.match(/\bref\s*:\s*["'`]([^"'`]+)["'`]/i);
  if (ownerMatch && repoMatch) {
    addDispatchTarget(targets, "repo", `${ownerMatch[1]}/${repoMatch[1]}`);
  }
  if (workflowMatch) {
    addDispatchTarget(targets, "workflow", workflowMatch[1]);
  }
  if (eventTypeMatch) {
    addDispatchTarget(targets, "event", eventTypeMatch[1]);
  }
  if (refMatch) {
    addDispatchTarget(targets, "ref", refMatch[1]);
  }
  const targetList = Array.from(targets);
  return {
    hasDispatch: kinds.size > 0,
    kinds: Array.from(kinds),
    mechanisms: Array.from(mechanisms),
    targets: targetList,
    usesExplicitRepositoryTarget: targetList.some((target) =>
      target.startsWith("repo:"),
    ),
  };
}

function analyzeDispatchActionStep(step) {
  const props = [];
  if (!step?.uses || typeof step.uses !== "string") {
    return props;
  }
  const dispatchAction = KNOWN_DISPATCH_ACTIONS.find((candidate) =>
    candidate.pattern.test(step.uses),
  );
  if (!dispatchAction) {
    return props;
  }
  const targets = new Set();
  dispatchAction.repoKeys.forEach((key) => {
    addDispatchTarget(
      targets,
      normalizeDispatchTargetPrefix(key),
      step.with?.[key],
    );
  });
  dispatchAction.targetKeys.forEach((key) => {
    addDispatchTarget(
      targets,
      normalizeDispatchTargetPrefix(key),
      step.with?.[key],
    );
  });
  props.push({ name: "cdx:github:step:dispatchesWorkflow", value: "true" });
  props.push({
    name: "cdx:github:step:dispatchKinds",
    value: dispatchAction.kind,
  });
  props.push({
    name: "cdx:github:step:dispatchMechanisms",
    value: dispatchAction.mechanism,
  });
  if (targets.size) {
    props.push({
      name: "cdx:github:step:dispatchTargets",
      value: Array.from(targets).join(","),
    });
  }
  if (Array.from(targets).some((target) => target.startsWith("repo:"))) {
    props.push({
      name: "cdx:github:step:dispatchUsesExplicitRepositoryTarget",
      value: "true",
    });
  }
  return props;
}

function appendDispatchProperties(properties, dispatchInfo) {
  if (!dispatchInfo?.hasDispatch) {
    return;
  }
  properties.push({
    name: "cdx:github:step:dispatchesWorkflow",
    value: "true",
  });
  properties.push({
    name: "cdx:github:step:dispatchKinds",
    value: dispatchInfo.kinds.join(","),
  });
  properties.push({
    name: "cdx:github:step:dispatchMechanisms",
    value: dispatchInfo.mechanisms.join(","),
  });
  if (dispatchInfo.targets.length) {
    properties.push({
      name: "cdx:github:step:dispatchTargets",
      value: dispatchInfo.targets.join(","),
    });
  }
  if (dispatchInfo.usesExplicitRepositoryTarget) {
    properties.push({
      name: "cdx:github:step:dispatchUsesExplicitRepositoryTarget",
      value: "true",
    });
  }
}

function appendHiddenUnicodeProperties(properties, scan, prefix) {
  if (!scan?.hasHiddenUnicode) {
    return;
  }
  properties.push({
    name: `${prefix}:hasHiddenUnicode`,
    value: "true",
  });
  properties.push({
    name: `${prefix}:hiddenUnicodeCodePoints`,
    value: scan.codePoints.join(","),
  });
  properties.push({
    name: `${prefix}:hiddenUnicodeLineNumbers`,
    value: scan.lineNumbers.join(","),
  });
  if (scan.inComments) {
    properties.push({
      name: `${prefix}:hiddenUnicodeInComments`,
      value: "true",
    });
    properties.push({
      name: `${prefix}:hiddenUnicodeCommentCodePoints`,
      value: scan.commentCodePoints.join(","),
    });
  }
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
  if (/^[a-f0-9]{40}$/.test(versionRef)) {
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

function extractWorkflowDispatchInputs(triggers) {
  if (!triggers || typeof triggers !== "object") {
    return [];
  }
  if (!triggers.workflow_dispatch?.inputs) {
    return [];
  }
  return Object.keys(triggers.workflow_dispatch.inputs);
}

function extractRepositoryDispatchTypes(triggers) {
  if (!triggers || typeof triggers !== "object") {
    return [];
  }
  const repositoryDispatch = triggers.repository_dispatch;
  if (!repositoryDispatch || typeof repositoryDispatch !== "object") {
    return [];
  }
  if (!Array.isArray(repositoryDispatch.types)) {
    return [];
  }
  return repositoryDispatch.types
    .map((eventType) => String(eventType || "").trim())
    .filter(Boolean);
}

function normalizeTriggerNames(triggers) {
  const csv = normalizeTriggers(triggers);
  if (!csv) {
    return [];
  }
  return csv
    .split(",")
    .map((trigger) => trigger.trim())
    .filter(Boolean);
}

function extractWorkflowCallMetadata(triggers) {
  if (!triggers || typeof triggers !== "object") {
    return { inputs: [], outputs: [], secrets: [] };
  }
  const workflowCall = triggers.workflow_call;
  if (!workflowCall || typeof workflowCall !== "object") {
    return { inputs: [], outputs: [], secrets: [] };
  }
  return {
    inputs: Object.keys(workflowCall.inputs || {}),
    outputs: Object.keys(workflowCall.outputs || {}),
    secrets: Object.keys(workflowCall.secrets || {}),
  };
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
 * @param {string} concurrencyGroup         - Workflow concurrency group.
 * @returns {Array<{name: string, value: string}>}
 */
function buildWorkflowContextProperties({
  hasExplicitPermissionsBlock,
  hasAnyExplicitPermissionsBlock,
  hasWritePermissions,
  hasIdTokenWrite,
  triggers,
  triggerNames,
  isHighRisk,
  concurrencyGroup,
  writeScopes,
  dispatchInputs,
  repositoryDispatchTypes,
  workflowReceiverAliases,
  workflowCallMetadata,
}) {
  const props = [];
  props.push({
    name: "cdx:github:workflow:hasExplicitPermissionsBlock",
    value: String(Boolean(hasExplicitPermissionsBlock)),
  });
  props.push({
    name: "cdx:github:workflow:hasAnyExplicitPermissionsBlock",
    value: String(Boolean(hasAnyExplicitPermissionsBlock)),
  });
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
  if (writeScopes?.length) {
    props.push({
      name: "cdx:github:workflow:writeScopes",
      value: [...new Set(writeScopes)].join(","),
    });
  }
  if (triggers) {
    props.push({ name: "cdx:github:workflow:triggers", value: triggers });
  }
  const triggerSet = new Set(triggerNames || normalizeTriggerNames(triggers));
  const triggerFlags = [
    ["pull_request", "cdx:github:workflow:hasPullRequestTrigger"],
    ["pull_request_target", "cdx:github:workflow:hasPullRequestTargetTrigger"],
    ["issue_comment", "cdx:github:workflow:hasIssueCommentTrigger"],
    ["repository_dispatch", "cdx:github:workflow:hasRepositoryDispatchTrigger"],
    ["workflow_run", "cdx:github:workflow:hasWorkflowRunTrigger"],
    ["workflow_dispatch", "cdx:github:workflow:hasWorkflowDispatchTrigger"],
    ["workflow_call", "cdx:github:workflow:hasWorkflowCallTrigger"],
  ];
  triggerFlags.forEach(([triggerName, propName]) => {
    if (triggerSet.has(triggerName)) {
      props.push({ name: propName, value: "true" });
    }
  });
  if (isHighRisk) {
    props.push({
      name: "cdx:github:workflow:hasHighRiskTrigger",
      value: "true",
    });
  }
  if (concurrencyGroup) {
    props.push({
      name: "cdx:github:workflow:concurrencyGroup",
      value: concurrencyGroup,
    });
  }
  if (dispatchInputs?.length) {
    props.push({
      name: "cdx:github:workflow:hasWorkflowDispatchInputs",
      value: "true",
    });
    props.push({
      name: "cdx:github:workflow:workflowDispatchInputs",
      value: dispatchInputs.join(","),
    });
  }
  if (repositoryDispatchTypes?.length) {
    props.push({
      name: "cdx:github:workflow:repositoryDispatchTypes",
      value: repositoryDispatchTypes.join(","),
    });
  }
  if (workflowReceiverAliases?.length) {
    props.push({
      name: "cdx:github:workflow:workflowDispatchReceiverAliases",
      value: workflowReceiverAliases.join(","),
    });
  }
  if (workflowCallMetadata?.inputs?.length) {
    props.push({
      name: "cdx:github:workflow:workflowCallInputs",
      value: workflowCallMetadata.inputs.join(","),
    });
  }
  if (workflowCallMetadata?.secrets?.length) {
    props.push({
      name: "cdx:github:workflow:workflowCallSecrets",
      value: workflowCallMetadata.secrets.join(","),
    });
  }
  if (workflowCallMetadata?.outputs?.length) {
    props.push({
      name: "cdx:github:workflow:workflowCallOutputs",
      value: workflowCallMetadata.outputs.join(","),
    });
  }
  if (
    workflowCallMetadata?.inputs?.length ||
    workflowCallMetadata?.secrets?.length ||
    workflowCallMetadata?.outputs?.length
  ) {
    props.push({
      name: "cdx:github:workflow:isWorkflowCallProducer",
      value: "true",
    });
  }
  return props;
}

function buildJobContextProperties({
  hasExplicitPermissionsBlock,
  hasWritePermissions,
  hasIdTokenWrite,
  isSelfHosted,
  writeScopes,
  condition,
}) {
  const props = [];
  props.push({
    name: "cdx:github:job:hasExplicitPermissionsBlock",
    value: String(Boolean(hasExplicitPermissionsBlock)),
  });
  if (hasWritePermissions) {
    props.push({
      name: "cdx:github:job:hasWritePermissions",
      value: "true",
    });
  }
  if (hasIdTokenWrite) {
    props.push({
      name: "cdx:github:job:hasIdTokenWrite",
      value: "true",
    });
  }
  if (isSelfHosted) {
    props.push({
      name: "cdx:github:job:isSelfHosted",
      value: "true",
    });
  }
  if (writeScopes?.length) {
    props.push({
      name: "cdx:github:job:writeScopes",
      value: [...new Set(writeScopes)].join(","),
    });
  }
  if (condition) {
    props.push({ name: "cdx:github:job:if", value: condition });
  }
  return props;
}

/**
 * @param {string} filePath workflow file path
 * @returns {string} workflow name derived from the file stem
 */
function deriveWorkflowNameFromPath(filePath) {
  const pathImpl = filePath.includes("\\") ? path.win32 : path.posix;
  return pathImpl.parse(pathImpl.basename(filePath)).name;
}

function deriveWorkflowReceiverAliases(filePath, workflowName) {
  const aliases = new Set();
  if (workflowName) {
    aliases.add(String(workflowName).trim());
  }
  if (filePath) {
    const normalizedPath = String(filePath).replace(/\\/g, "/");
    const fileName = normalizedPath.split("/").pop() || normalizedPath;
    const fileStem = fileName.replace(/\.ya?ml$/i, "");
    aliases.add(fileName);
    aliases.add(fileStem);
    aliases.add(normalizedPath);
  }
  return Array.from(aliases)
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function getPropertyValue(obj, propName) {
  return obj?.properties?.find((property) => property.name === propName)?.value;
}

function upsertCsvProperty(properties, name, values) {
  const normalizedValues = [...new Set((values || []).filter(Boolean))];
  if (!normalizedValues.length) {
    return;
  }
  const existingProperty = properties.find(
    (property) => property.name === name,
  );
  if (!existingProperty) {
    properties.push({ name, value: normalizedValues.join(",") });
    return;
  }
  existingProperty.value = [
    ...new Set([
      ...String(existingProperty.value || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      ...normalizedValues,
    ]),
  ].join(",");
}

function upsertBooleanProperty(properties, name) {
  const existingProperty = properties.find(
    (property) => property.name === name,
  );
  if (existingProperty) {
    existingProperty.value = "true";
    return;
  }
  properties.push({ name, value: "true" });
}

function parseDispatchTargets(value) {
  return String(value || "")
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean)
    .map((target) => {
      const separatorIndex = target.indexOf(":");
      if (separatorIndex === -1) {
        return { type: "unknown", value: target };
      }
      return {
        type: target.slice(0, separatorIndex),
        value: target.slice(separatorIndex + 1),
      };
    });
}

function normalizeDispatchTargetValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function buildLocalDispatchReceiverIndexes(workflows) {
  const workflowDispatchAliasIndex = new Map();
  const repositoryDispatchTypeIndex = new Map();
  (workflows || []).forEach((workflow) => {
    if (
      getPropertyValue(
        workflow,
        "cdx:github:workflow:hasWorkflowDispatchTrigger",
      ) === "true"
    ) {
      const aliases = String(
        getPropertyValue(
          workflow,
          "cdx:github:workflow:workflowDispatchReceiverAliases",
        ) || "",
      )
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      aliases.forEach((alias) => {
        const normalizedAlias = normalizeDispatchTargetValue(alias);
        if (!workflowDispatchAliasIndex.has(normalizedAlias)) {
          workflowDispatchAliasIndex.set(normalizedAlias, []);
        }
        workflowDispatchAliasIndex.get(normalizedAlias).push(workflow);
      });
    }
    if (
      getPropertyValue(
        workflow,
        "cdx:github:workflow:hasRepositoryDispatchTrigger",
      ) === "true"
    ) {
      const eventTypes = String(
        getPropertyValue(
          workflow,
          "cdx:github:workflow:repositoryDispatchTypes",
        ) || "",
      )
        .split(",")
        .map((eventType) => eventType.trim())
        .filter(Boolean);
      eventTypes.forEach((eventType) => {
        const normalizedEventType = normalizeDispatchTargetValue(eventType);
        if (!repositoryDispatchTypeIndex.has(normalizedEventType)) {
          repositoryDispatchTypeIndex.set(normalizedEventType, []);
        }
        repositoryDispatchTypeIndex.get(normalizedEventType).push(workflow);
      });
    }
  });
  return {
    repositoryDispatchTypeIndex,
    workflowDispatchAliasIndex,
  };
}

function enrichLocalDispatchRelationships(workflows, components) {
  const { repositoryDispatchTypeIndex, workflowDispatchAliasIndex } =
    buildLocalDispatchReceiverIndexes(workflows);
  (components || []).forEach((component) => {
    if (
      getPropertyValue(component, "cdx:github:step:dispatchesWorkflow") !==
      "true"
    ) {
      return;
    }
    const dispatchTargets = parseDispatchTargets(
      getPropertyValue(component, "cdx:github:step:dispatchTargets"),
    );
    if (dispatchTargets.some((target) => target.type === "repo")) {
      return;
    }
    const matchedWorkflows = [];
    const matchBases = [];
    dispatchTargets.forEach((target) => {
      if (target.type === "workflow") {
        const candidates =
          workflowDispatchAliasIndex.get(
            normalizeDispatchTargetValue(target.value),
          ) || [];
        if (candidates.length === 1) {
          matchedWorkflows.push(candidates[0]);
          matchBases.push(`workflow:${target.value}`);
        }
      }
      if (target.type === "event") {
        const candidates =
          repositoryDispatchTypeIndex.get(
            normalizeDispatchTargetValue(target.value),
          ) || [];
        if (candidates.length === 1) {
          matchedWorkflows.push(candidates[0]);
          matchBases.push(`repository_dispatch:${target.value}`);
        }
      }
    });
    const uniqueMatchedWorkflows = [...new Set(matchedWorkflows)];
    if (!uniqueMatchedWorkflows.length) {
      return;
    }
    const receiverWorkflowFiles = uniqueMatchedWorkflows
      .map((workflow) => getPropertyValue(workflow, "cdx:github:workflow:file"))
      .filter(Boolean);
    const receiverWorkflowNames = uniqueMatchedWorkflows
      .map((workflow) => getPropertyValue(workflow, "cdx:github:workflow:name"))
      .filter(Boolean);
    upsertBooleanProperty(
      component.properties,
      "cdx:github:step:hasLocalDispatchReceiver",
    );
    upsertCsvProperty(
      component.properties,
      "cdx:github:step:dispatchReceiverWorkflowFiles",
      receiverWorkflowFiles,
    );
    upsertCsvProperty(
      component.properties,
      "cdx:github:step:dispatchReceiverWorkflowNames",
      receiverWorkflowNames,
    );
    upsertCsvProperty(
      component.properties,
      "cdx:github:step:dispatchReceiverMatchBasis",
      matchBases,
    );
    upsertCsvProperty(
      component.properties,
      "cdx:github:step:dispatchReceiverConfidence",
      ["high"],
    );
    uniqueMatchedWorkflows.forEach((workflow) => {
      const senderWorkflowFile = getPropertyValue(
        component,
        "cdx:github:workflow:file",
      );
      const senderWorkflowName = getPropertyValue(
        component,
        "cdx:github:workflow:name",
      );
      upsertBooleanProperty(
        workflow.properties,
        "cdx:github:workflow:hasLocalDispatchSender",
      );
      upsertCsvProperty(
        workflow.properties,
        "cdx:github:workflow:dispatchSenderWorkflowFiles",
        [senderWorkflowFile],
      );
      upsertCsvProperty(
        workflow.properties,
        "cdx:github:workflow:dispatchSenderWorkflowNames",
        [senderWorkflowName],
      );
      upsertCsvProperty(
        workflow.properties,
        "cdx:github:workflow:dispatchSenderMatchBasis",
        matchBases,
      );
    });
  });
}

function buildReusableWorkflowComponent(
  job,
  jobName,
  filePath,
  workflowName,
  jobRunner,
  jobContextProperties,
  workflowContextProperties,
  options,
) {
  const uses = job?.uses;
  if (!uses || typeof uses !== "string") {
    return undefined;
  }
  let group;
  let name = uses;
  let purl;
  let versionRef;
  let versionPinningType = "unknown";
  let isShaPinned = false;
  const isExternal = !uses.startsWith("./");

  if (isExternal) {
    const tmpA = uses.split("@");
    const workflowRef = tmpA[0];
    versionRef = tmpA[1];
    versionPinningType = getVersionPinningType(versionRef);
    isShaPinned = versionPinningType === "sha";
    if (workflowRef.includes("/.github/workflows/")) {
      const [repoPath, workflowPath] = workflowRef.split("/.github/workflows/");
      group = repoPath;
      name = workflowPath;
    } else {
      const refParts = workflowRef.split("/");
      name = refParts.pop() || workflowRef;
      group = refParts.join("/");
    }
    if (versionRef) {
      purl = new PackageURL(
        "github",
        group || undefined,
        name,
        versionRef,
        null,
        null,
      ).toString();
    }
  } else {
    const pathImpl = uses.includes("\\") ? path.win32 : path.posix;
    name = pathImpl.basename(uses);
  }

  const componentRef = purl || `github-workflow:${uses}`;
  const properties = [
    { name: "SrcFile", value: filePath },
    { name: "cdx:github:workflow:name", value: workflowName },
    { name: "cdx:github:workflow:file", value: filePath },
    { name: "cdx:github:job:name", value: jobName },
    {
      name: "cdx:github:job:runner",
      value: Array.isArray(jobRunner) ? jobRunner.join(",") : jobRunner,
    },
    { name: "cdx:github:reusableWorkflow:uses", value: uses },
    {
      name: "cdx:github:reusableWorkflow:isExternal",
      value: String(isExternal),
    },
    {
      name: "cdx:github:reusableWorkflow:versionPinningType",
      value: versionPinningType,
    },
    {
      name: "cdx:github:reusableWorkflow:isShaPinned",
      value: String(isShaPinned),
    },
  ];
  if (versionRef) {
    properties.push({
      name: "cdx:github:reusableWorkflow:ref",
      value: versionRef,
    });
  }
  if (job.secrets === "inherit") {
    properties.push({
      name: "cdx:github:reusableWorkflow:secretsInherit",
      value: "true",
    });
  }
  if (job.with && typeof job.with === "object") {
    const withKeys = Object.keys(job.with);
    if (withKeys.length) {
      properties.push({
        name: "cdx:github:reusableWorkflow:withKeys",
        value: withKeys.join(","),
      });
    }
  }
  properties.push(...jobContextProperties);
  properties.push(...workflowContextProperties);
  const component = {
    "bom-ref": componentRef,
    type: "application",
    group,
    name,
    version: versionRef,
    purl,
    properties,
    scope: isExternal ? "required" : "excluded",
    tags: ["reusable-workflow"],
  };
  if (options?.specVersion >= 1.7 && isExternal) {
    component.isExternal = true;
  }
  return component;
}

/**
 * Parse a single GitHub Actions workflow file into workflow, component, and dependency data.
 *
 * @param {string} f Absolute path to a workflow YAML file
 * @param {Object} options CLI options
 * @returns {{ workflows: Object[], components: Object[], dependencies: Object[] }}
 */

export function parseWorkflowFile(f, options) {
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
  const hiddenUnicodeScan = scanTextForHiddenUnicode(raw, { syntax: "yaml" });
  try {
    yamlObj = _load(raw);
  } catch (_e) {
    return { workflows, components, dependencies };
  }

  if (!yamlObj?.jobs) {
    return { workflows, components, dependencies };
  }
  const workflowName = yamlObj.name || deriveWorkflowNameFromPath(f);
  const workflowTriggers = yamlObj.on || yamlObj.true;
  const workflowHasExplicitPermissionsBlock = Object.hasOwn(
    yamlObj,
    "permissions",
  );
  const workflowPermissions = workflowHasExplicitPermissionsBlock
    ? yamlObj.permissions || {}
    : {};
  const workflowEnv = yamlObj.env || {};
  const workflowHasWritePermissions = analyzePermissions(workflowPermissions);
  const workflowWriteScopes = new Set(extractWriteScopes(workflowPermissions));
  const workflowConcurrency = yamlObj.concurrency || {};
  const workflowHasIdTokenWrite =
    hasIdTokenWritePermission(workflowPermissions);
  const triggers = normalizeTriggers(workflowTriggers);
  const triggerNames = normalizeTriggerNames(workflowTriggers);
  const isHighRisk = hasHighRiskTrigger(workflowTriggers);
  const workflowDispatchInputs =
    extractWorkflowDispatchInputs(workflowTriggers);
  const repositoryDispatchTypes =
    extractRepositoryDispatchTypes(workflowTriggers);
  const workflowCallMetadata = extractWorkflowCallMetadata(workflowTriggers);
  const workflowReceiverAliases = deriveWorkflowReceiverAliases(
    f,
    workflowName,
  );

  const workflowRef = uuidv4();
  const tasks = [];
  const workflowDependsOn = [];
  let anyJobHasExplicitPermissionsBlock = false;
  let anyJobHasWritePermissions = false;
  let anyJobHasIdTokenWrite = false;

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
    const jobEnv = job.env || {};
    const jobTimeout = job["timeout-minutes"] || null;
    const jobHasExplicitPermissionsBlock = Object.hasOwn(job, "permissions");
    const jobPermissions = jobHasExplicitPermissionsBlock
      ? job.permissions || {}
      : {};
    const jobHasWritePermissions = analyzePermissions(jobPermissions);
    const jobWriteScopes = extractWriteScopes(jobPermissions);
    const jobHasIdTokenWrite = hasIdTokenWritePermission(jobPermissions);
    const jobServices = job.services ? Object.keys(job.services) : [];
    const jobIsSelfHosted = isSelfHostedRunner(jobRunner);
    const effectiveWritePerms =
      workflowHasWritePermissions || jobHasWritePermissions;
    const effectiveIdTokenWrite = workflowHasIdTokenWrite || jobHasIdTokenWrite;
    const effectiveWriteScopes = [
      ...workflowWriteScopes,
      ...jobWriteScopes,
    ].filter(Boolean);
    anyJobHasExplicitPermissionsBlock ||= jobHasExplicitPermissionsBlock;
    anyJobHasWritePermissions ||= jobHasWritePermissions;
    anyJobHasIdTokenWrite ||= jobHasIdTokenWrite;
    jobWriteScopes.forEach((scope) => {
      workflowWriteScopes.add(scope);
    });

    // Shared workflow-context properties for this job's components
    const sharedCtxProps = buildWorkflowContextProperties({
      hasExplicitPermissionsBlock: workflowHasExplicitPermissionsBlock,
      hasAnyExplicitPermissionsBlock:
        workflowHasExplicitPermissionsBlock || jobHasExplicitPermissionsBlock,
      hasWritePermissions: effectiveWritePerms,
      hasIdTokenWrite: effectiveIdTokenWrite,
      triggers,
      triggerNames,
      isHighRisk,
      writeScopes: effectiveWriteScopes,
      dispatchInputs: workflowDispatchInputs,
      repositoryDispatchTypes,
      workflowReceiverAliases,
      workflowCallMetadata,
    });
    const sharedJobCtxProps = buildJobContextProperties({
      hasExplicitPermissionsBlock: jobHasExplicitPermissionsBlock,
      hasWritePermissions: jobHasWritePermissions,
      hasIdTokenWrite: jobHasIdTokenWrite,
      isSelfHosted: jobIsSelfHosted,
      writeScopes: jobWriteScopes,
      condition: job.if,
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
    if (jobTimeout) {
      jobProperties.push({
        name: "cdx:github:job:timeoutMinutes",
        value: jobTimeout.toString(),
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
    if (job.uses) {
      jobProperties.push({ name: "cdx:github:job:uses", value: job.uses });
      jobProperties.push({
        name: "cdx:github:job:isReusableWorkflowCall",
        value: "true",
      });
    }
    jobProperties.push(...sharedJobCtxProps);
    jobProperties.push(...sharedCtxProps);

    const reusableWorkflowComponent = buildReusableWorkflowComponent(
      job,
      jobName,
      f,
      workflowName,
      jobRunner,
      sharedJobCtxProps,
      sharedCtxProps,
      options,
    );
    if (reusableWorkflowComponent) {
      components.push(reusableWorkflowComponent);
      jobDependsOn.push(reusableWorkflowComponent["bom-ref"]);
      steps.push({
        name: job.uses,
        commands: [{ executed: job.uses }],
      });
    }

    for (const step of job.steps || []) {
      const stepName = step.name || step.uses || "unnamed step";
      const commands = [];
      let actionProperties = [];
      const effectiveEnv = { ...workflowEnv, ...jobEnv, ...(step.env || {}) };
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
            { name: "cdx:github:workflow:file", value: f },
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
            actionProperties.push({
              name: "cdx:github:step:if",
              value: step.if,
            });
          }
          if (step["continue-on-error"]) {
            actionProperties.push({
              name: "cdx:github:step:continueOnError",
              value: "true",
            });
          }
          if (step.timeout) {
            actionProperties.push({
              name: "cdx:github:step:timeout",
              value: step.timeout.toString(),
            });
          }
          const isOfficial =
            group?.startsWith("github/") || group === "actions";
          const isVerified = group?.startsWith("github/");
          actionProperties.push({
            name: "cdx:actions:isOfficial",
            value: String(isOfficial),
          });
          actionProperties.push({
            name: "cdx:actions:isVerified",
            value: String(isVerified),
          });
          actionProperties.push(...analyzeCheckoutStep(step));
          actionProperties.push(...analyzeCacheStep(step));
          actionProperties.push(...analyzeCargoActionStep(step));
          actionProperties.push(...analyzeDispatchActionStep(step));
          if (
            step.uses?.includes("actions/github-script") &&
            typeof step.with?.script === "string"
          ) {
            const scriptDispatchInfo = detectWorkflowDispatchInvocations(
              step.with.script,
            );
            appendDispatchProperties(actionProperties, scriptDispatchInfo);
            const githubScriptSensitiveRefs = [
              ...detectSensitiveContextReferences(
                step.with.script,
                effectiveEnv,
              ),
              ...collectSensitiveEnvBindings(effectiveEnv),
            ];
            if (step.with["github-token"]) {
              githubScriptSensitiveRefs.push("input:github-token");
            }
            if (githubScriptSensitiveRefs.length) {
              actionProperties.push({
                name: "cdx:github:step:referencesSensitiveContext",
                value: "true",
              });
              actionProperties.push({
                name: "cdx:github:step:sensitiveContextRefs",
                value: [...new Set(githubScriptSensitiveRefs)].join(","),
              });
            }
            const forkContextRefs = detectForkContextReferences(
              step.with.script,
            );
            if (forkContextRefs.length) {
              actionProperties.push({
                name: "cdx:github:step:referencesForkContext",
                value: "true",
              });
              actionProperties.push({
                name: "cdx:github:step:forkContextRefs",
                value: [...new Set(forkContextRefs)].join(","),
              });
            }
          }
          appendSensitiveOperationProperties(actionProperties);
          actionProperties.push(...sharedJobCtxProps);
          actionProperties.push(...sharedCtxProps);
          const evidence = {
            identity: [
              {
                field: "purl",
                confidence: 0.5,
                methods: [
                  {
                    technique: "source-code-analysis",
                    confidence: 0.5,
                    value: f,
                  },
                ],
              },
            ],
          };
          const acomp = {
            "bom-ref": purl,
            type: "application",
            group,
            name,
            version: tagOrCommit,
            purl,
            properties: actionProperties,
            scope: "required",
            evidence,
          };
          if (options?.specVersion >= 1.7) {
            acomp.isExternal = true;
          }
          components.push(acomp);
          jobDependsOn.push(purl);
        }
      } else {
        const normalizedRun = normalizeRunValue(step.run);
        if (normalizedRun === undefined) {
          steps.push({
            name: stepName,
          });
          continue;
        }
        commands.push({ executed: normalizedRun.trim().split("\n")[0] });
        const stepRef = `${jobRef}-step-${steps.length + 1}`;
        const runProperties = [
          { name: "SrcFile", value: f },
          { name: "cdx:github:workflow:name", value: workflowName },
          { name: "cdx:github:workflow:file", value: f },
          { name: "cdx:github:job:name", value: jobName },
          { name: "cdx:github:step:type", value: "run" },
          {
            name: "cdx:github:step:command",
            value: normalizedRun.trim().split("\n")[0],
          },
        ];
        if (step.if) {
          runProperties.push({
            name: "cdx:github:step:condition",
            value: step.if,
          });
          runProperties.push({
            name: "cdx:github:step:if",
            value: step.if,
          });
        }
        if (step["continue-on-error"]) {
          runProperties.push({
            name: "cdx:github:step:continueOnError",
            value: "true",
          });
        }
        runProperties.push(...sharedJobCtxProps);
        runProperties.push(...sharedCtxProps);

        const { hasInterpolation, vars } =
          detectUntrustedInterpolation(normalizedRun);
        runProperties.push(...analyzeCargoRunStep(normalizedRun));
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
        const { hasMutation, targets } =
          detectRunnerStateMutation(normalizedRun);
        if (hasMutation) {
          runProperties.push({
            name: "cdx:github:step:mutatesRunnerState",
            value: "true",
          });
          runProperties.push({
            name: "cdx:github:step:runnerStateTargets",
            value: targets.join(","),
          });
        }
        const { hasOutboundCommand, tools } =
          detectOutboundNetworkCommand(normalizedRun);
        if (hasOutboundCommand) {
          runProperties.push({
            name: "cdx:github:step:hasOutboundNetworkCommand",
            value: "true",
          });
          runProperties.push({
            name: "cdx:github:step:outboundNetworkTools",
            value: tools.join(","),
          });
        }
        const sensitiveContextRefs = detectSensitiveContextReferences(
          normalizedRun,
          effectiveEnv,
        );
        const dispatchInfo = detectWorkflowDispatchInvocations(normalizedRun);
        if (dispatchInfo.hasDispatch) {
          collectSensitiveEnvBindings(effectiveEnv).forEach((ref) => {
            sensitiveContextRefs.push(ref);
          });
        }
        if (sensitiveContextRefs.length) {
          runProperties.push({
            name: "cdx:github:step:referencesSensitiveContext",
            value: "true",
          });
          runProperties.push({
            name: "cdx:github:step:sensitiveContextRefs",
            value: sensitiveContextRefs.join(","),
          });
        }
        appendDispatchProperties(runProperties, dispatchInfo);
        const forkContextRefs = detectForkContextReferences(normalizedRun);
        if (forkContextRefs.length) {
          runProperties.push({
            name: "cdx:github:step:referencesForkContext",
            value: "true",
          });
          runProperties.push({
            name: "cdx:github:step:forkContextRefs",
            value: [...new Set(forkContextRefs)].join(","),
          });
        }
        const exfiltrationIndicators = hasOutboundCommand
          ? detectOutboundExfiltrationIndicators(
              normalizedRun,
              sensitiveContextRefs,
            )
          : [];
        if (exfiltrationIndicators.length) {
          runProperties.push({
            name: "cdx:github:step:likelyExfiltration",
            value: "true",
          });
          runProperties.push({
            name: "cdx:github:step:exfiltrationIndicators",
            value: exfiltrationIndicators.join(","),
          });
        }
        runProperties.push(...analyzeLegacyPublishStep(step, effectiveEnv));
        appendSensitiveOperationProperties(runProperties);
        components.push({
          "bom-ref": stepRef,
          purl: undefined,
          scope: "excluded",
          type: "application",
          name: stepName,
          properties: runProperties,
          tags: ["workflow-step"],
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
    { name: "cdx:github:workflow:name", value: workflowName },
    ...buildWorkflowContextProperties({
      hasExplicitPermissionsBlock: workflowHasExplicitPermissionsBlock,
      hasAnyExplicitPermissionsBlock:
        workflowHasExplicitPermissionsBlock ||
        anyJobHasExplicitPermissionsBlock,
      hasWritePermissions:
        workflowHasWritePermissions || anyJobHasWritePermissions,
      hasIdTokenWrite: workflowHasIdTokenWrite || anyJobHasIdTokenWrite,
      triggers,
      triggerNames,
      isHighRisk,
      concurrencyGroup: workflowConcurrency?.group,
      writeScopes: Array.from(workflowWriteScopes),
      dispatchInputs: workflowDispatchInputs,
      repositoryDispatchTypes,
      workflowReceiverAliases,
      workflowCallMetadata,
    }),
  ];
  appendHiddenUnicodeProperties(
    workflowProperties,
    hiddenUnicodeScan,
    "cdx:github:workflow",
  );
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
    enrichLocalDispatchRelationships(workflows, components);
    return {
      workflows,
      components,
      services: [],
      properties: [],
      dependencies,
    };
  },
};
