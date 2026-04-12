import path from "node:path";
import process from "node:process";

import { table } from "table";

import { isSecureMode, toCamel } from "../../helpers/utils.js";

const PERMISSION_FLAGS = [
  "--permission",
  "--allow-fs-read",
  "--allow-fs-write",
  "--allow-child-process",
  "--allow-addons",
  "--allow-worker",
  "--allow-net",
  "--allow-env",
  "--allow-wasi",
];

// Flags that allow arbitrary code execution or debugger attachment when set via NODE_OPTIONS.
// --test is intentionally omitted: it runs the built-in test runner and is not an exploit vector.
const CODE_EXECUTION_PATTERNS = [
  /--require\b/i,
  /--eval\b/i,
  /--print\b/i,
  /--import\b/i,
  /--loader\b/i,
  /--inspect(-brk)?\b/i,
  /--env-file\b/i,
];

// JVM flags that allow class/agent injection, equivalent to NODE_OPTIONS for the JVM layer.
const JVM_CODE_EXECUTION_PATTERNS = [
  /-javaagent\b/i,
  /-agentlib\b/i,
  /-agentpath\b/i,
  /-Djdk\.module\.illegalAccess/i,
  /--add-opens\b/i,
];

// Environment variables whose mere presence (with any non-empty value) signals a risk.
const RISKY_PRESENCE_VARS = [
  "NODE_PATH",
  "NODE_NO_WARNINGS",
  "NODE_PENDING_DEPRECATION",
  "UV_THREADPOOL_SIZE",
];

// Credential variables: presence means a secret may be leaked into SBOM metadata or logs.
const CREDENTIAL_VARS = [
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "PYPI_TOKEN",
  "CDXGEN_API_KEY",
];

// Proxy variables: any one set means outbound traffic (including SBOM uploads) may be intercepted.
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

// Pre-compiled regexes for the PERMISSION_FLAGS list, used in auditEnvironment.
const PERMISSION_FLAG_PATTERNS = PERMISSION_FLAGS.map(
  (f) => new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);

export function auditEnvironment(env = process.env) {
  const findings = [];
  const nodeOptions = env.NODE_OPTIONS || env.CDXGEN_NODE_OPTIONS || "";
  const hasPermission = PERMISSION_FLAG_PATTERNS.some((re) =>
    re.test(nodeOptions),
  );

  // NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification; any other value is benign.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    findings.push({
      type: "environment-variable",
      variable: "NODE_TLS_REJECT_UNAUTHORIZED",
      severity: "critical",
      message:
        "TLS certificate verification is disabled globally (NODE_TLS_REJECT_UNAUTHORIZED=0). All HTTPS connections, including SBOM uploads, are vulnerable to interception.",
      mitigation:
        "Unset NODE_TLS_REJECT_UNAUTHORIZED or set it to '1'. Use a trusted CA bundle instead of bypassing verification.",
    });
  }

  for (const varName of RISKY_PRESENCE_VARS) {
    if (env[varName] != null && env[varName] !== "") {
      const messages = {
        NODE_PATH:
          "NODE_PATH is set and may cause unexpected modules to be loaded, enabling module-resolution poisoning.",
        NODE_NO_WARNINGS:
          "NODE_NO_WARNINGS suppresses Node.js deprecation and security warnings, which may hide exploitable conditions.",
        NODE_PENDING_DEPRECATION:
          "NODE_PENDING_DEPRECATION may alter runtime behavior in ways that affect cdxgen's dependency resolution.",
        UV_THREADPOOL_SIZE:
          "UV_THREADPOOL_SIZE alters the libuv thread pool and may affect performance or mask resource-exhaustion attacks.",
      };
      findings.push({
        type: "environment-variable",
        variable: varName,
        severity: varName === "NODE_PATH" ? "high" : "medium",
        message:
          messages[varName] ||
          `${varName} is set and may affect module resolution or runtime behavior.`,
        mitigation: `Unset ${varName} before processing untrusted repositories.`,
      });
    }
  }

  // NODE_OPTIONS / CDXGEN_NODE_OPTIONS code-execution flags
  if (nodeOptions) {
    for (const pattern of CODE_EXECUTION_PATTERNS) {
      if (pattern.test(nodeOptions)) {
        findings.push({
          type: "code-execution",
          variable: "NODE_OPTIONS",
          severity: "high",
          message: `NODE_OPTIONS contains a code-execution flag matching '${pattern.source}'. Malicious code in the scanned repository may exploit this to run arbitrary commands.`,
          mitigation: hasPermission
            ? "Remove the flag or tighten --allow-* scopes; code-execution flags can bypass permission-model boundaries."
            : "Remove the flag before scanning untrusted repositories, or add --permission to enable the Node.js permission model.",
        });
      }
    }
    if (hasPermission && !env.CDXGEN_SECURE_MODE && !process.permission) {
      findings.push({
        type: "permission-misuse",
        variable: "NODE_OPTIONS",
        severity: "medium",
        message:
          "Permission flags are present in NODE_OPTIONS but the Node.js permission model is not active. The flags have no protective effect.",
        mitigation:
          "Run cdxgen with Node.js ≥20 and pass --permission on the command line, or remove the redundant flags.",
      });
    }
  }

  // JVM option injection via JAVA_TOOL_OPTIONS / JDK_JAVA_OPTIONS
  for (const jvmVar of ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"]) {
    const jvmOptions = env[jvmVar] || "";
    if (jvmOptions) {
      for (const pattern of JVM_CODE_EXECUTION_PATTERNS) {
        if (pattern.test(jvmOptions)) {
          findings.push({
            type: "code-execution",
            variable: jvmVar,
            severity: "high",
            message: `${jvmVar} contains a JVM agent or module-bypass flag matching '${pattern.source}'. This may allow code injection into Java-based build tools invoked during SBOM generation.`,
            mitigation: `Unset or sanitize ${jvmVar} before scanning Java/Kotlin/Scala projects.`,
          });
        }
      }
    }
  }

  // Proxy interception risk
  const activeProxy = PROXY_VARS.find((v) => env[v] != null && env[v] !== "");
  if (activeProxy) {
    findings.push({
      type: "network-interception",
      variable: activeProxy,
      severity: "medium",
      message: `An outbound proxy is configured via ${activeProxy}. Registry lookups, dependency downloads, and SBOM uploads will be routed through this proxy and may be intercepted or tampered.`,
      mitigation:
        "Verify the proxy is trusted and uses TLS. Remove the variable if not required for this scan.",
    });
  }

  // Credential exposure risk
  for (const credVar of CREDENTIAL_VARS) {
    if (env[credVar] != null && env[credVar] !== "") {
      findings.push({
        type: "credential-exposure",
        variable: credVar,
        severity: "medium",
        message: `${credVar} is set. If cdxgen is run against a malicious repository, install scripts or build tools may exfiltrate this credential.`,
        mitigation: `Use a scoped, read-only token and unset ${credVar} when scanning untrusted code. Prefer CI secret injection over shell environment variables.`,
      });
    }
  }

  // Running as root
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    findings.push({
      type: "privilege",
      variable: "UID",
      severity: "high",
      message:
        "cdxgen is running as root (UID 0). Any code executed during SBOM generation—including package manager install hooks—will run with full system privileges.",
      mitigation:
        "Run cdxgen as a non-privileged user. Use a container or VM with a dedicated low-privilege account.",
    });
  }

  // Debug mode leaks internal details
  if (
    ["debug", "verbose"].includes(env.CDXGEN_DEBUG_MODE) ||
    env.SCAN_DEBUG_MODE === "debug"
  ) {
    findings.push({
      type: "debug-exposure",
      variable: "CDXGEN_DEBUG_MODE",
      severity: "low",
      message:
        "Debug/verbose logging is enabled. Sensitive values such as API tokens, file paths, and build-tool output may appear in terminal output or log files.",
      mitigation:
        "Disable CDXGEN_DEBUG_MODE in production and ensure debug log files are not committed or shared.",
    });
  }

  return findings;
}

export function displaySelfThreatModel(
  filePath,
  config,
  options,
  envAuditFindings = [],
) {
  const TLP = options.tlpClassification || "CLEAR";
  const risks = [];
  let riskScore = 0;

  const addRisk = (level, reason, category = "configuration") => {
    const scores = { low: 1, medium: 3, high: 5, critical: 8 };
    riskScore = Math.min(10, riskScore + scores[level]);
    risks.push({ level, reason, category });
  };

  // Config file risks
  if (Object.keys(config).length > 0) {
    addRisk(
      "medium",
      "A .cdxgenrc config file was loaded from the working directory. It may override security-relevant settings without being visible on the command line.",
      "configuration",
    );
    const sensitive = ["server-url", "api-key", "include-formulation"];
    for (const key of sensitive) {
      if (config[key] || config[toCamel(key)]) {
        addRisk(
          key === "api-key" ? "high" : "medium",
          `Config file sets '${key}', which affects SBOM content or remote submission behavior.`,
          "configuration",
        );
      }
    }
  }

  // Remote submission risks
  if (options.serverUrl) {
    const isHttps = options.serverUrl.startsWith("https://");
    addRisk(
      isHttps ? "medium" : "critical",
      `SBOM will be submitted to ${options.serverUrl}${!isHttps ? " over plain HTTP — contents may be intercepted or tampered in transit." : "."}`,
      "network",
    );
    if (options.skipDtTlsCheck) {
      addRisk(
        "high",
        "TLS certificate validation is disabled for Dependency-Track uploads. SBOM contents may be intercepted or tampered in transit.",
        "network",
      );
    }
  }

  // Data exposure risks
  if (options.includeFormulation) {
    addRisk(
      "medium",
      "Formulation mode is active. The SBOM will include build metadata such as git history, committer identities, and CI environment variables.",
      "data-exposure",
    );
  }
  if (options.evidence || options.deep) {
    addRisk(
      "medium",
      "Evidence / deep mode will invoke build tools and parse source files to collect call graph and reachability evidence. Malicious build scripts may execute.",
      "data-exposure",
    );
  }
  if (options.installDeps) {
    addRisk(
      "high",
      "Dependency auto-install is enabled. Lifecycle hooks (install scripts) from third-party packages will execute in the current environment.",
      "data-exposure",
    );
  }

  // Output path outside the project directory
  if (options.output) {
    const resolvedOutput = path.resolve(options.output);
    const resolvedProject = path.resolve(filePath);
    if (
      !resolvedOutput.startsWith(resolvedProject + path.sep) &&
      resolvedOutput !== resolvedProject
    ) {
      addRisk(
        "medium",
        `Output path '${options.output}' resolves to '${resolvedOutput}', which is outside the project directory '${resolvedProject}'. Ensure this is intentional.`,
        "configuration",
      );
    }
  }

  // Environment variable risks (config-layer only; env-audit covers the rest)
  if (process.env.CDXGEN_SERVER_URL) {
    addRisk(
      "low",
      "CDXGEN_SERVER_URL is set in the environment and will override any --server-url value.",
      "environment",
    );
  }

  // Integrate environment audit findings
  if (envAuditFindings?.length) {
    for (const f of envAuditFindings) {
      const categoryMap = {
        "code-execution": "runtime",
        "debug-exposure": "runtime",
        "environment-variable": "environment",
        "network-interception": "network",
        "credential-exposure": "environment",
        "permission-misuse": "runtime",
        privilege: "runtime",
      };
      addRisk(
        f.severity,
        `${f.variable}: ${f.message}`,
        categoryMap[f.type] || "configuration",
      );
    }
  }

  const nodeOptions = process.env.NODE_OPTIONS || "";
  const riskLevel =
    riskScore >= 8
      ? "CRITICAL"
      : riskScore >= 5
        ? "HIGH"
        : riskScore >= 3
          ? "MEDIUM"
          : "LOW";

  const riskColor = {
    CRITICAL: "\x1b[1;31m",
    HIGH: "\x1b[1;33m",
    MEDIUM: "\x1b[1;36m",
    LOW: "\x1b[1;32m",
  };
  const reset = "\x1b[0m";
  const tlpGuidance = {
    CLEAR: "May be shared publicly. No restrictions.",
    GREEN: "Limited to community/peers. Not for public posting.",
    AMBER:
      "Limited to organisation and trusted partners. Handle-in-confidence.",
    AMBER_AND_STRICT: "Organisation only. No external sharing.",
    RED: "Named recipients only. Do not forward or store beyond session.",
  };
  const headerData = [
    ["TLP Classification", `${TLP} — ${tlpGuidance[TLP]}`],
    ["Risk Score", `${riskScore}/10`],
    ["Risk Level", `${riskColor[riskLevel]}${riskLevel}${reset}`],
  ];
  const headerConfig = {
    header: {
      alignment: "center",
      content:
        "SBOM Generation Environment Assessment\nPre-generation security audit by cdxgen",
    },
    columns: [{ width: 30, alignment: "right" }, { width: 70 }],
    columnDefault: { wrapWord: true },
  };

  console.log(table(headerData, headerConfig));
  if (risks.length > 0) {
    const findingsData = [["#", "Severity", "Category", "Finding"]];
    risks.forEach(({ level, reason, category }, i) => {
      const severityColor =
        level === "critical"
          ? "\x1b[1;31m"
          : level === "high"
            ? "\x1b[1;33m"
            : level === "medium"
              ? "\x1b[1;36m"
              : "\x1b[1;32m";
      findingsData.push([
        `${i + 1}`,
        `${severityColor}${level.toUpperCase()}${reset}`,
        category,
        reason,
      ]);
    });
    const findingsConfig = {
      header: {
        alignment: "center",
        content: `Findings (${risks.length})`,
      },
      columns: [
        { width: 5, alignment: "right" },
        { width: 12 },
        { width: 17 },
        { width: 66 },
      ],
      columnDefault: { wrapWord: true },
    };
    console.log(table(findingsData, findingsConfig));
  } else {
    const noFindingsData = [
      [
        `${riskColor[riskLevel]}✅ No risks detected in the current configuration.${reset}`,
      ],
    ];
    const noFindingsConfig = {
      header: { alignment: "center", content: "📋 Findings" },
      columns: [{ width: 100, alignment: "center" }],
    };
    console.log(table(noFindingsData, noFindingsConfig));
  }

  const configData = [
    ["Setting", "Value"],
    ["Project", options.projectName || filePath],
    ["Type(s)", options.projectType?.join(", ") || "auto-detect"],
    ["Profile", options.profile || "generic"],
    ["Path", filePath],
    ["Output", options.output || "(stdout)"],
    ["Recursive", options.recursive ? "yes" : "no"],
    ["Remote Submission", options.serverUrl || "none"],
    ["Formulation", options.includeFormulation ? "yes" : "no"],
    ["Evidence / Deep Mode", options.evidence || options.deep ? "yes" : "no"],
    ["Auto-install Dependencies", options.installDeps ? "yes" : "no"],
    ["NODE_OPTIONS", nodeOptions || "(not set)"],
  ];
  const effConfigTableConfig = {
    header: { alignment: "center", content: "Effective Configuration" },
    columns: [{ width: 28 }, { width: 72 }],
    columnDefault: { wrapWord: true },
  };
  console.log(table(configData, effConfigTableConfig));

  const recommendations = [];
  if (["AMBER", "AMBER_AND_STRICT", "RED"].includes(TLP)) {
    recommendations.push([
      "High",
      "Omit --include-formulation to avoid embedding committer identities and CI secrets in the SBOM.",
    ]);
    if (TLP === "RED") {
      recommendations.push([
        "Critical",
        "Run cdxgen inside an isolated container or VM with no access to production credentials.",
      ]);
      recommendations.push([
        "Critical",
        "Do not set --server-url; review and handle the output SBOM manually before sharing.",
      ]);
    }
  }
  if (riskScore >= 5) {
    recommendations.push([
      "High",
      "Address the findings above before scanning untrusted repositories.",
    ]);
    recommendations.push([
      "Medium",
      "Pass --no-install-deps to prevent package manager hooks from executing.",
    ]);
  }
  if (envAuditFindings.some((f) => f.type === "code-execution")) {
    recommendations.push([
      "High",
      "Remove code-execution flags (--require, --eval, --loader, --import) from NODE_OPTIONS and JAVA_TOOL_OPTIONS.",
    ]);
  }
  if (envAuditFindings.some((f) => f.variable === "NODE_PATH")) {
    recommendations.push([
      "High",
      "Unset NODE_PATH to prevent module-resolution poisoning by malicious packages.",
    ]);
  }
  if (envAuditFindings.some((f) => f.type === "privilege")) {
    recommendations.push([
      "High",
      "Do not run cdxgen as root. Create a dedicated low-privilege user or use a rootless container.",
    ]);
  }
  if (/--permission\b/i.test(nodeOptions)) {
    recommendations.push([
      "Medium",
      "Audit every --allow-* scope; use absolute paths rather than wildcards to minimise the permission surface.",
    ]);
  }
  recommendations.push([
    "Info",
    "Minimal safe invocation: cdxgen --no-install-deps --output ./sbom.cdx.json <path>",
  ]);
  const recommendationsData = [["Priority", "Action"]];
  recommendations.forEach(([priority, action]) => {
    const priorityColor =
      priority === "Critical"
        ? "\x1b[1;31m"
        : priority === "High"
          ? "\x1b[1;33m"
          : priority === "Medium"
            ? "\x1b[1;36m"
            : "\x1b[1;32m";
    recommendationsData.push([`${priorityColor}${priority}${reset}`, action]);
  });
  const recommendationsConfig = {
    header: {
      alignment: "center",
      content: `Recommendations for TLP:${TLP}`,
    },
    columns: [{ width: 12 }, { width: 88 }],
    columnDefault: { wrapWord: true },
  };

  console.log(table(recommendationsData, recommendationsConfig));
  if (isSecureMode && riskScore >= 5) {
    const abortData = [
      [
        `${riskColor[riskLevel]}🚫 SECURE MODE: High-risk configuration detected. Aborting SBOM generation.${reset}`,
      ],
    ];
    const abortConfig = {
      columns: [{ width: 100, alignment: "center" }],
    };
    console.log(table(abortData, abortConfig));
    process.exit(1);
  }
}
