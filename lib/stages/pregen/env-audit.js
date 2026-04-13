import process from "node:process";

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
const CODE_EXECUTION_PATTERNS = [
  /--require\b/i,
  /--eval\b/i,
  /--print\b/i,
  /--import\b/i,
  /--loader\b/i,
  /--inspect(-brk)?\b/i,
  /--env-file\b/i,
];

// JVM flags that allow class/agent injection.
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

// Pattern to detect environment variables that likely contain credentials.
// Uses an end-of-string anchor ($) so that common system variables like
// SSH_AUTH_SOCK (ends with _SOCK) and __CF_USER_TEXT_ENCODING (ends with _ENCODING)
// are NOT flagged as false positives.
// `cred` is kept alongside `credential(?:s)?` to also catch short-form names like MY_CRED.
const CREDENTIAL_VAR_PATTERN =
  /_(?:token|key|secret|pass(?:word)?|credential(?:s)?|cred|user|email|auth|session)$/i;

// Proxy variables — NO_PROXY is a bypass-list and should not trigger a finding on its own.
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

const PERMISSION_FLAG_PATTERNS = PERMISSION_FLAGS.map(
  (f) => new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);

export function auditEnvironment(env = process.env) {
  const findings = [];
  const nodeOptions = env.NODE_OPTIONS || "";
  const cdxgenNodeOptions = env.CDXGEN_NODE_OPTIONS || "";
  const hasPermission = PERMISSION_FLAG_PATTERNS.some((re) =>
    re.test(nodeOptions),
  );
  const cdxgenHasPermission = PERMISSION_FLAG_PATTERNS.some((re) =>
    re.test(cdxgenNodeOptions),
  );
  const cdxgenHasCodeExecutionRisk = CODE_EXECUTION_PATTERNS.some((re) =>
    re.test(cdxgenNodeOptions),
  );

  if (cdxgenHasPermission) {
    findings.push({
      type: "environment-variable",
      variable: "CDXGEN_NODE_OPTIONS",
      severity: "high",
      message:
        "CDXGEN_NODE_OPTIONS enables Node.js permission flags. These flags can alter filesystem, network, environment, worker, or child-process access during cdxgen execution.",
      mitigation:
        "Remove permission-related flags from CDXGEN_NODE_OPTIONS unless they are explicitly required and reviewed for safety.",
    });
  }

  if (cdxgenHasCodeExecutionRisk) {
    findings.push({
      type: "environment-variable",
      variable: "CDXGEN_NODE_OPTIONS",
      severity: "high",
      message:
        "CDXGEN_NODE_OPTIONS contains Node.js flags that can inject code, load arbitrary modules, read env files, or enable debugger attachment.",
      mitigation:
        "Unset CDXGEN_NODE_OPTIONS or remove flags such as --require, --import, --loader, --eval, --print, --inspect, or --env-file.",
    });
  }
  // NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification; any other value is benign.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    findings.push({
      type: "environment-variable",
      variable: "NODE_TLS_REJECT_UNAUTHORIZED",
      severity: "high",
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

  // JVM option injection
  for (const jvmVar of [
    "MVN_ARGS",
    "GRADLE_ARGS",
    "BAZEL_ARGS",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
  ]) {
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

  // Proxy interception — informational
  const activeProxy = PROXY_VARS.find((v) => env[v] != null && env[v] !== "");
  if (activeProxy) {
    findings.push({
      type: "network-interception",
      variable: activeProxy,
      severity: "low",
      message: `An outbound proxy is configured via ${activeProxy}. Registry lookups, dependency downloads, and SBOM uploads will be routed through this proxy.`,
      mitigation:
        "Verify the proxy is trusted and uses TLS. Remove the variable if not required for this scan.",
    });
  }

  // Credential exposure — detect any env var whose name follows a credential-naming convention.
  for (const [varName, varValue] of Object.entries(env)) {
    if (varValue && CREDENTIAL_VAR_PATTERN.test(varName)) {
      findings.push({
        type: "credential-exposure",
        variable: varName,
        severity: "low",
        message: `${varName} matches a credential naming pattern and is set in the environment. Build tools or install scripts invoked during SBOM generation may read environment variables.`,
        mitigation: `Unset ${varName} when scanning untrusted repositories. Prefer ephemeral, scoped CI credentials injected at the workflow step rather than inherited shell variables.`,
      });
    }
  }

  // Running as root — skip inside official cdxgen container images, which run as root by design.
  if (
    typeof process.getuid === "function" &&
    process.getuid() === 0 &&
    env?.CDXGEN_IN_CONTAINER !== "true"
  ) {
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

  // Deno-specific checks

  // DENO_CERT installs a custom TLS CA; combined with an outbound proxy this enables MITM attacks
  // on SBOM uploads and registry lookups.
  if (
    env.DENO_CERT !== undefined &&
    env.DENO_CERT !== null &&
    env.DENO_CERT !== ""
  ) {
    findings.push({
      type: "environment-variable",
      variable: "DENO_CERT",
      severity: "high",
      message:
        "DENO_CERT is set to a custom TLS certificate authority. A custom CA combined with an outbound proxy can enable man-in-the-middle attacks on registry lookups and SBOM uploads.",
      mitigation:
        "Unset DENO_CERT unless you explicitly require a private CA bundle. Prefer the system trust store.",
    });
  }

  // Deno live permission model: check whether shell execution is broadly granted.
  // cdxgen legitimately needs --allow-run for specific build tools; unrestricted shell access
  // (sh/bash/cmd/powershell being granted) is a strong signal that --allow-all or
  // --allow-run without restrictions was used, which allows package manager hooks to execute
  // arbitrary commands during SBOM generation.
  if (
    typeof globalThis.Deno !== "undefined" &&
    typeof globalThis.Deno?.permissions?.querySync === "function"
  ) {
    try {
      const shellCmds =
        globalThis.Deno.build?.os === "windows"
          ? ["cmd", "powershell"]
          : ["sh", "bash"];
      const shellAllowed = shellCmds.some(
        (cmd) =>
          globalThis.Deno.permissions.querySync({ name: "run", command: cmd })
            .state === "granted",
      );
      if (shellAllowed) {
        findings.push({
          type: "permission-misuse",
          variable: "DENO_PERMISSIONS",
          severity: "high",
          message:
            "cdxgen is running under Deno with unrestricted shell execution (--allow-all or --allow-run without restrictions). Package manager scripts invoked during SBOM generation can execute arbitrary commands.",
          mitigation:
            "Replace --allow-all with granular --allow-run=<tool> flags. Only allow the specific build tools required for this scan.",
        });
      }
    } catch {
      // Deno.permissions.querySync may throw in restricted or future Deno environments; ignore silently.
    }
  }

  return findings;
}
