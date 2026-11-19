import { join } from "node:path";

import {
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { isDeno } from "../core/env.js";
import { safeExistsSync, safeReadFileSync } from "../core/fs.js";

/**
 * Upper bound on the content read from a single tool-requirements file, so a
 * corrupt or hostile file cannot force unbounded reads.
 *
 * @type {number}
 */
const MAX_REQUIREMENTS_FILE_BYTES = 256 * 1024;

/**
 * Upper bound on the length of a single declared version. A real pin or
 * range is a few dozen characters; anything longer is not a version and is
 * dropped rather than carried through the ledger and both reports.
 *
 * @type {number}
 */
const MAX_WANTED_VERSION_LENGTH = 256;

/**
 * Maps a declared build-tool name to the cdxgen ecosystem whose events it
 * belongs to. Tools outside the map are attributed to the reserved
 * "generic" ecosystem so `.tool-versions` entries for arbitrary tools
 * (terraform, ghc, …) stay recordable without inventing ecosystems.
 *
 * @type {Object<string, string>}
 */
const TOOL_ECOSYSTEMS = {
  bazel: "java",
  cargo: "rust",
  cc: "c",
  clang: "c",
  cmake: "c",
  conda: "python",
  dart: "dart",
  deno: "npm",
  dotnet: "csharp",
  flutter: "dart",
  gem: "ruby",
  go: "go",
  golang: "go",
  gradle: "java",
  java: "java",
  javac: "java",
  mix: "elixir",
  mvn: "java",
  maven: "java",
  node: "npm",
  nodejs: "npm",
  npm: "npm",
  pnpm: "npm",
  poetry: "python",
  python: "python",
  python3: "python",
  pip: "python",
  pip3: "python",
  rbenv: "ruby",
  ruby: "ruby",
  rust: "rust",
  rustc: "rust",
  rustup: "rust",
  sbt: "java",
  scala: "java",
  swift: "swift",
  uv: "python",
  yarn: "npm",
  bundler: "ruby",
  bun: "npm",
};

/**
 * Resolve the ecosystem a declared tool belongs to.
 *
 * @param {string} tool Declared tool name
 * @returns {string} cdxgen ecosystem name, or "generic" for unknown tools.
 */
export function ecosystemForTool(tool) {
  return TOOL_ECOSYSTEMS[`${tool}`.toLowerCase()] || "generic";
}

/**
 * Check whether a version identifier carries a prerelease suffix such as
 * `-rc-3`, `-M2`, or `-milestone-1`. The marker list is exact so that vendor
 * suffixes that merely begin with the same letters, such as the `-crac` java
 * distributions, stay classified as stable.
 *
 * @param {string} version Version identifier
 * @returns {boolean} True for prerelease versions.
 */
export function isPrereleaseVersion(version) {
  if (typeof version !== "string") {
    return false;
  }
  const separatorIndex = version.indexOf("-");
  if (separatorIndex < 0) {
    return false;
  }
  return /^(rc-?\d*|m\d+|milestone|alpha|beta|ea)\b/i.test(
    version.slice(separatorIndex + 1),
  );
}

/**
 * Compare two dotted version identifiers. Numeric components are compared
 * numerically, stable releases rank above prereleases, and prerelease
 * suffixes are compared token-wise so `rc-9` beats `rc-10` only when
 * numerically larger. Missing components count as zero, so `21` equals
 * `21.0.0`.
 *
 * @param {string} a First version
 * @param {string} b Second version
 * @returns {number} Negative when a < b, positive when a > b, zero on equality.
 */
export function compareVersions(a, b) {
  const aCore = `${a}`.split("-")[0];
  const bCore = `${b}`.split("-")[0];
  const aComponents = aCore.split(".");
  const bComponents = bCore.split(".");
  const maxComponents = Math.max(aComponents.length, bComponents.length);
  for (let i = 0; i < maxComponents; i++) {
    const aPart = Number.parseInt(aComponents[i] ?? "0", 10) || 0;
    const bPart = Number.parseInt(bComponents[i] ?? "0", 10) || 0;
    if (aPart !== bPart) {
      return aPart - bPart;
    }
  }
  const aPre = isPrereleaseVersion(`${a}`);
  const bPre = isPrereleaseVersion(`${b}`);
  if (aPre !== bPre) {
    return aPre ? -1 : 1;
  }
  if (!aPre) {
    return 0;
  }
  const aTokens = `${a}`.slice(aCore.length + 1).split(/[.-]/);
  const bTokens = `${b}`.slice(bCore.length + 1).split(/[.-]/);
  const maxTokens = Math.max(aTokens.length, bTokens.length);
  for (let i = 0; i < maxTokens; i++) {
    const aToken = aTokens[i] ?? "";
    const bToken = bTokens[i] ?? "";
    const aNum = Number.parseInt(aToken, 10);
    const bNum = Number.parseInt(bToken, 10);
    let comparison;
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
      comparison = aNum - bNum;
    } else {
      comparison = aToken.localeCompare(bToken);
    }
    if (comparison !== 0) {
      return comparison;
    }
  }
  return aTokens.length - bTokens.length;
}

/**
 * Extract the JDK major from a `java --version` style description such as
 * `openjdk 21.0.11 2025-04-15` or a bare sdkman java identifier such as
 * `25-tem`. General availability releases print an undotted major
 * (`openjdk 25 2025-09-16`), so the first token starting with a digit is
 * used rather than requiring a dotted version.
 *
 * @param {string} versionDesc Version description string
 * @returns {number|undefined} JDK major version.
 */
export function extractJavaMajor(versionDesc) {
  if (typeof versionDesc !== "string") {
    return undefined;
  }
  for (const rawToken of versionDesc.trim().split(/\s+/)) {
    // `java -version` quotes the identifier, e.g. openjdk version "17.0.9"
    const token = rawToken.replaceAll('"', "");
    const match = token.match(/^(\d+)(?:[.\-+_].*)?$/);
    if (!match) {
      continue;
    }
    const major = Number.parseInt(match[1], 10);
    if (Number.isNaN(major)) {
      continue;
    }
    // Legacy identifiers such as 1.8.0_452 name the major after the leading 1.
    if (major === 1) {
      const legacyMatch = token.match(/^1\.(\d+)/);
      return legacyMatch ? Number.parseInt(legacyMatch[1], 10) : undefined;
    }
    return major;
  }
  return undefined;
}

/**
 * Extract the first version-looking token from a tool version description,
 * such as `go version go1.23.1 darwin/arm64` or `rustc 1.82.0 (f6e511eec
 * 2024-10-08)`. Leading letters (`v20.11.1`, `go1.23.1`) and quoting are
 * stripped before validation.
 *
 * @param {string} versionDesc Raw version description
 * @returns {string|undefined} The version token, when one is found.
 */
export function extractVersionToken(versionDesc) {
  if (typeof versionDesc !== "string") {
    return undefined;
  }
  for (const rawToken of versionDesc.trim().split(/\s+/)) {
    const token = rawToken.replaceAll('"', "").replace(/^[^0-9]+/, "");
    if (!token || !/^\d/.test(token)) {
      continue;
    }
    if (/^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/.test(token)) {
      return token;
    }
  }
  return undefined;
}

/**
 * Verdict of a declared-requirement check. `unparseable` means the wanted or
 * found value carries no comparable version, which is never evidence of a
 * defect: an unparseable requirement must not produce a mismatch.
 *
 * @typedef {"satisfied"|"violated"|"unparseable"} RequirementVerdict
 */

/**
 * Check whether a found version satisfies a declared requirement. Wanted
 * forms handled: exact versions (`3.9.9`), major-only and partial pins
 * (`21`, `20.11`), `.x` ranges (`20.x`), caret and tilde ranges (`^20.11`,
 * `~4.9`), comparison ranges (`>=18`, `<21`), hyphen ranges (`1.9 - 2.3`),
 * whitespace-conjoined ranges (`>=18 <=20`), `||` alternatives, and the
 * unconstrained `*`/`latest`. Anything else is unparseable and never
 * violates.
 *
 * @param {string} found Version actually present, possibly embedded in a
 *   longer description such as `go version go1.23.1 darwin/arm64`.
 * @param {string} wanted Declared requirement.
 * @returns {RequirementVerdict} Verdict of the check.
 */
export function checkVersionRequirement(found, wanted) {
  const wantedText = `${wanted ?? ""}`.trim();
  if (!wantedText || ["*", "x", "latest"].includes(wantedText.toLowerCase())) {
    return "satisfied";
  }
  const foundToken = extractVersionToken(found);
  if (!foundToken) {
    return "unparseable";
  }
  let anyUnparseable = false;
  for (const alternative of wantedText.split("||")) {
    const verdict = checkAlternativeRequirement(foundToken, alternative.trim());
    if (verdict === "satisfied") {
      return "satisfied";
    }
    if (verdict === "unparseable") {
      anyUnparseable = true;
    }
  }
  return anyUnparseable ? "unparseable" : "violated";
}

/**
 * Check one `||` alternative, which may itself conjoin several whitespace
 * separated constraints or a hyphen range.
 *
 * @param {string} foundToken Extracted found version token
 * @param {string} alternative One alternative of the wanted expression
 * @returns {RequirementVerdict} Verdict of the check.
 */
function checkAlternativeRequirement(foundToken, alternative) {
  if (!alternative) {
    return "satisfied";
  }
  const hyphenRange = alternative.match(/^(\S+)\s+-\s+(\S+)$/);
  if (hyphenRange) {
    const lower = extractVersionToken(hyphenRange[1]);
    const upper = extractVersionToken(hyphenRange[2]);
    if (!lower || !upper) {
      return "unparseable";
    }
    return compareVersions(foundToken, lower) >= 0 &&
      compareVersions(foundToken, upper) <= 0
      ? "satisfied"
      : "violated";
  }
  let unparseable = false;
  for (const constraint of alternative.split(/\s+/).filter(Boolean)) {
    const verdict = checkSingleConstraint(foundToken, constraint);
    if (verdict === "violated") {
      return "violated";
    }
    if (verdict === "unparseable") {
      unparseable = true;
    }
  }
  return unparseable ? "unparseable" : "satisfied";
}

/**
 * Check one constraint token against a found version token.
 *
 * @param {string} foundToken Extracted found version token
 * @param {string} constraint A single constraint such as `>=18` or `^20.11`
 * @returns {RequirementVerdict} Verdict of the check.
 */
function checkSingleConstraint(foundToken, constraint) {
  const operatorMatch = constraint.match(/^(>=|<=|==|=|>|<)\s*(.+)$/);
  if (operatorMatch) {
    const bound = extractVersionToken(operatorMatch[2]);
    if (!bound) {
      return "unparseable";
    }
    const comparison = compareVersions(foundToken, bound);
    const satisfied = {
      ">=": comparison >= 0,
      ">": comparison > 0,
      "<=": comparison <= 0,
      "<": comparison < 0,
      "=": comparison === 0,
      "==": comparison === 0,
    }[operatorMatch[1]];
    return satisfied ? "satisfied" : "violated";
  }
  if (constraint.startsWith("^") || constraint.startsWith("~")) {
    const bound = extractVersionToken(constraint.slice(1));
    if (!bound) {
      return "unparseable";
    }
    const core = bound.split("-")[0].split(".");
    const major = Number.parseInt(core[0], 10) || 0;
    const minor = Number.parseInt(core[1], 10) || 0;
    let upper;
    if (constraint.startsWith("^")) {
      upper =
        major > 0
          ? `${major + 1}.0.0`
          : minor > 0
            ? `0.${minor + 1}.0`
            : `0.0.${Number.parseInt(core[2], 10) ? Number.parseInt(core[2], 10) + 1 : 1}`;
    } else {
      upper = `${major}.${minor + 1}.0`;
    }
    return compareVersions(foundToken, bound) >= 0 &&
      compareVersions(foundToken, upper) < 0
      ? "satisfied"
      : "violated";
  }
  // Trailing `.x`/`.*` segments lower the pin's precision: `20.x` is a
  // major-line pin, `20.11.x` a minor-line pin.
  let cleaned = constraint;
  while (/\.(x|X|\*)$/.test(cleaned)) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf("."));
  }
  const core = cleaned.split("-")[0];
  const parts = core.split(".");
  if (!/^\d+$/.test(parts[0] || "")) {
    return "unparseable";
  }
  if (parts.length === 1) {
    // A bare major names the major line rather than an exact release.
    return Number.parseInt(foundToken, 10) === Number.parseInt(parts[0], 10)
      ? "satisfied"
      : "violated";
  }
  if (parts.length === 2) {
    const foundMajor = extractMajorMinor(foundToken);
    if (!foundMajor) {
      return "unparseable";
    }
    return foundMajor.major === Number.parseInt(parts[0], 10) &&
      foundMajor.minor === Number.parseInt(parts[1], 10)
      ? "satisfied"
      : "violated";
  }
  return compareVersions(foundToken, cleaned) === 0 ? "satisfied" : "violated";
}

/**
 * Extract the major and minor components of a version token.
 *
 * @param {string} versionToken Version token such as `20.11.1`
 * @returns {Object|undefined} `{ major, minor }`, when both are present.
 */
function extractMajorMinor(versionToken) {
  const core = `${versionToken}`.split("-")[0].split(".");
  if (!core[1]) {
    return undefined;
  }
  const major = Number.parseInt(core[0], 10);
  const minor = Number.parseInt(core[1], 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return undefined;
  }
  return { major, minor };
}

/**
 * Classify the result of a failed tool probe. A probe that was denied the
 * right to run must be reported as `denied` — the tool may well be present —
 * while only evidence that the command does not exist counts as `missing`.
 *
 * @param {Object|string|undefined} result Result object from spawnSync, or
 *   undefined when no result shape is known.
 * @returns {"found"|"denied"|"missing"} Classification of the probe result.
 */
export function classifyProbeResult(result) {
  if (!result || typeof result !== "object") {
    return "denied";
  }
  if (result.status === 0 && !result.error) {
    return "found";
  }
  if (
    result.pid === undefined &&
    result.status === undefined &&
    result.signal === undefined &&
    result.stdout === undefined &&
    result.stderr === undefined
  ) {
    // Deno's node:child_process returns an empty result when the runtime
    // denies the spawn outright.
    return "denied";
  }
  const error = result.error;
  const errorCode = error?.code;
  if (errorCode === "EACCES" || errorCode === "EPERM") {
    return "denied";
  }
  const errorText =
    typeof error === "string" ? error : `${error?.message || ""}`;
  if (
    error?.dryRun ||
    errorCode === "CDXGEN_DRY_RUN" ||
    /dry run|permission/i.test(errorText)
  ) {
    return "denied";
  }
  return "missing";
}

/**
 * Classify the active environment restriction that would stop a command from
 * running, without the human-readable wording. `describeSpawnRestriction`
 * derives its message from this classifier, and consumers that need to act on
 * the cause rather than the prose use it directly.
 *
 * @param {string} command Command that would run
 * @returns {"dry-run"|"secure-mode"|"allowlist"|"deno"|undefined} Restriction cause, or undefined when nothing restricts the command.
 */
export function classifySpawnRestriction(command) {
  if (isDryRun) {
    return "dry-run";
  }
  if (
    isSecureMode &&
    globalThis.process?.permission?.has &&
    !globalThis.process.permission.has("child")
  ) {
    return "secure-mode";
  }
  const commandName = `${command}`.trim().split(" ")[0];
  const allowlist = readEnvironmentVariable("CDXGEN_ALLOWED_COMMANDS");
  if (
    allowlist &&
    !allowlist
      .split(",")
      .map((entry) => entry.trim())
      .includes(commandName)
  ) {
    return "allowlist";
  }
  if (isDeno) {
    const query = globalThis.Deno?.permissions?.querySync?.({
      name: "run",
      command: commandName,
    });
    if (query && query.state !== "granted") {
      return "deno";
    }
  }
  return undefined;
}

const SPAWN_RESTRICTION_DESCRIPTIONS = {
  "dry-run": "dry-run mode blocks command execution",
  "secure-mode": "secure mode denies child process execution",
  allowlist: "the command is not present in CDXGEN_ALLOWED_COMMANDS",
  deno: "the Deno run permission is not granted for this command",
};

/**
 * Explain why a command probe may not run in the current environment, so a
 * failed probe can be reported as degraded evidence rather than a missing
 * tool.
 *
 * @param {string} command Command that was probed
 * @returns {string|undefined} Human-readable restriction, or undefined when
 *   the environment does not restrict the command.
 */
export function describeSpawnRestriction(command) {
  const cause = classifySpawnRestriction(command);
  return cause ? SPAWN_RESTRICTION_DESCRIPTIONS[cause] : undefined;
}

/**
 * Drop a trailing `#` comment from a line of a tool pin file. This replaces
 * `/#.*$/`, which is quadratic in the number of `#` characters when the line
 * still holds a lone `\r`, U+2028 or U+2029: none of them ends a line for
 * `split(/\r?\n/)`, `.` stops at them, `$` fails, and the engine retries from
 * every earlier `#`.
 *
 * @param {string} line Line of a tool pin file
 * @returns {string} The line up to its first `#`.
 */
function stripComment(line) {
  const commentIndex = line.indexOf("#");
  return commentIndex < 0 ? line : line.slice(0, commentIndex);
}

/**
 * Parse the content of an asdf/mise `.tool-versions` file into the first
 * version each tool declares. Comment lines and inline comments are ignored;
 * a tool line listing several versions keeps the first.
 *
 * @param {string} content `.tool-versions` file content
 * @returns {Object|undefined} Map of tool name to declared version.
 */
export function parseToolVersionsFile(content) {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  const pins = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const pieces = line.split(/\s+/);
    const tool = (pieces.shift() || "").toLowerCase();
    const wanted = pieces.find((piece) => /^[\w.+-]+$/.test(piece));
    if (!tool || !/^[a-z][a-z0-9-]*$/.test(tool) || !wanted) {
      continue;
    }
    if (!(tool in pins)) {
      pins[tool] = wanted;
    }
  }
  return Object.keys(pins).length ? pins : undefined;
}

/**
 * Parse the `go` and `toolchain` directives of a `go.mod` file. The
 * `toolchain` directive wins when both are present because it names the
 * exact toolchain the module asks for.
 *
 * @param {string} content `go.mod` file content
 * @returns {Object|undefined} `{ tool, version, directive }` with
 *   `directive` naming the line the version came from.
 */
export function parseGoModFile(content) {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  let goDirective;
  let toolchainDirective;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = line.match(/^toolchain\s+(\S+)$/);
    if (match) {
      toolchainDirective = match[1];
      continue;
    }
    match = line.match(/^go\s+(\S+)$/);
    if (match) {
      goDirective = match[1];
    }
  }
  const directive = toolchainDirective ? "toolchain" : "go";
  const declared = toolchainDirective || goDirective;
  if (!declared) {
    return undefined;
  }
  // Toolchain identifiers spell the prefix out (`go1.24.1`); the directive
  // line does not (`1.23.0`).
  const version = declared.replace(/^go(?=\d)/, "");
  if (!/^\d[\w.-]*$/.test(version)) {
    return undefined;
  }
  return { tool: "go", version, directive };
}

/**
 * Check whether a rust channel value looks plausible: a semver, a channel
 * name such as `stable`, or a dated nightly.
 *
 * @param {string} channel Raw channel value
 * @returns {boolean} True when the value is a plausible channel.
 */
function isPlausibleRustChannel(channel) {
  return /^[\w][\w.-]*$/.test(channel);
}

/**
 * Parse a `rust-toolchain.toml` or plain `rust-toolchain` file into its
 * channel. Target-specific subsections are ignored, so only the `[toolchain]`
 * section's `channel` key is read.
 *
 * @param {string} content Toolchain file content
 * @returns {Object|undefined} `{ channel }` when a channel is declared.
 */
export function parseRustToolchainFile(content) {
  if (typeof content !== "string") {
    return undefined;
  }
  const lines = content
    .split(/\r?\n/)
    .map((line) => stripComment(line).trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  if (!content.includes("=")) {
    // Plain toolchain files hold just the channel string.
    return isPlausibleRustChannel(lines[0]) ? { channel: lines[0] } : undefined;
  }
  let channel;
  let inToolchainSection = false;
  for (const line of lines) {
    if (line.startsWith("[")) {
      inToolchainSection = line.replace(/^\[|\]$/g, "").trim() === "toolchain";
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0 || !inToolchainSection) {
      continue;
    }
    if (line.slice(0, separatorIndex).trim() !== "channel") {
      continue;
    }
    channel = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return channel && isPlausibleRustChannel(channel) ? { channel } : undefined;
}

/**
 * Parse a `package.json` content into the tool requirements it declares
 * through `engines` and `packageManager`. The `packageManager` pin's
 * integrity-hash suffix (`pnpm@9.1.0+sha512.…`) is stripped to the bare
 * version.
 *
 * @param {string} content `package.json` content
 * @returns {Object|undefined} Map of tool name to declared version.
 */
export function parsePackageJsonToolRequirements(content) {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const requirements = {};
  const enginesNode = parsed.engines?.node;
  if (typeof enginesNode === "string" && enginesNode.trim()) {
    requirements.node = enginesNode.trim();
  }
  const packageManager = parsed.packageManager;
  if (typeof packageManager === "string") {
    const atSignIndex = packageManager.indexOf("@");
    if (atSignIndex > 0) {
      const name = packageManager.slice(0, atSignIndex).toLowerCase();
      const version = packageManager.slice(atSignIndex + 1).split("+")[0];
      if (/^[a-z][a-z0-9-]*$/.test(name) && /^[\w.+-]+$/.test(version)) {
        requirements[name] = version;
      }
    }
  }
  return Object.keys(requirements).length ? requirements : undefined;
}

/**
 * Parse a `global.json` file into the .NET SDK version it pins.
 *
 * @param {string} content `global.json` content
 * @returns {Object|undefined} Map with the `dotnet` requirement.
 */
export function parseGlobalJsonToolRequirements(content) {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const version = parsed?.sdk?.version;
  if (typeof version !== "string" || !/^[\w.+-]+$/.test(version.trim())) {
    return undefined;
  }
  return { dotnet: version.trim() };
}

/**
 * Parse the `requires-python` declaration of a `pyproject.toml` file.
 *
 * @param {string} content `pyproject.toml` content
 * @returns {Object|undefined} Map with the `python` requirement.
 */
export function parsePyprojectRequiresPython(content) {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/);
    if (match) {
      return { python: match[1].trim() };
    }
  }
  return undefined;
}

/**
 * Parse an `.nvmrc` file into the Node.js version it requests.
 *
 * @param {string} content `.nvmrc` content
 * @returns {Object|undefined} Map with the `node` requirement.
 */
export function parseNvmrc(content) {
  if (typeof content !== "string") {
    return undefined;
  }
  const value = stripComment(content.split(/\r?\n/)[0])
    .trim()
    .replace(/^v/, "");
  return value ? { node: value } : undefined;
}

/**
 * Parse a `.python-version` file into the interpreter version it requests.
 *
 * @param {string} content `.python-version` content
 * @returns {Object|undefined} Map with the `python` requirement.
 */
export function parsePythonVersionFile(content) {
  if (typeof content !== "string") {
    return undefined;
  }
  const value = stripComment(content.split(/\r?\n/)[0]).trim();
  return value ? { python: value } : undefined;
}

/**
 * Parse a `.java-version` file into the JDK version it pins. Both the bare
 * major (`21`) and a full version (`21.0.5`) occur in the wild, and both are
 * passed through verbatim — an install command needs the exact declaration.
 *
 * The legacy `1.N` spelling of a pre-9 release (`1.8`, `1.8.0_302`) is
 * normalised to its modern major (`8`), because it is the major line that
 * names a package: the literal declaration yields `Temurin.1.JDK`, which no
 * provisioner offers.
 *
 * Distribution-prefixed values written by version managers (`temurin-21`,
 * `openjdk64-17.0.1`) name a vendor build rather than a release, so they are
 * left unparsed rather than turned into an install argument no provisioner
 * accepts; the run then reports the version as unresolved and the agent asks.
 *
 * @param {string} content `.java-version` content
 * @returns {Object|undefined} Map with the `java` requirement.
 */
export function parseJavaVersionFile(content) {
  if (typeof content !== "string") {
    return undefined;
  }
  const value = stripComment(content.split(/\r?\n/)[0]).trim();
  if (!/^\d[\w.+-]*$/.test(value)) {
    return undefined;
  }
  const legacy = /^1\.(\d+)(?:[._-].*)?$/.exec(value);
  return { java: legacy ? legacy[1] : value };
}

/**
 * Parse the `BUNDLED WITH` section of a `Gemfile.lock` into the bundler
 * version the lockfile was written with.
 *
 * @param {string} content `Gemfile.lock` content
 * @returns {string|undefined} Bundler version, when declared.
 */
export function parseGemfileLockBundlerVersion(content) {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "BUNDLED WITH") {
      continue;
    }
    for (
      let next = index + 1;
      next < Math.min(index + 3, lines.length);
      next++
    ) {
      const value = lines[next].trim();
      if (!value) {
        continue;
      }
      return /^\d[\w.-]*$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Read every declared tool requirement a project directory declares through
 * its well-known tool pin files: `.tool-versions`, `.nvmrc`, `.java-version`,
 * `.python-version`, `pyproject.toml`, `go.mod`, `rust-toolchain.toml`,
 * `rust-toolchain`, `package.json`, and `global.json`. Missing files are
 * skipped; each entry names the file that declared it so the report can
 * trace every expectation back to its source.
 *
 * @param {string} projectPath Project directory to inspect
 * @returns {Array<{tool: string, wanted: string, source: string, ecosystem: string, path: string}>}
 *   Declared requirements, empty when the directory declares none.
 */
export function readDeclaredToolRequirements(projectPath) {
  const requirements = [];
  if (!projectPath) {
    return requirements;
  }
  const addRequirements = (pins, fileName) => {
    if (!pins) {
      return;
    }
    const filePath = join(projectPath, fileName);
    for (const [tool, wanted] of Object.entries(pins)) {
      const trimmedWanted = `${wanted}`.trim();
      if (
        !tool ||
        !trimmedWanted ||
        trimmedWanted.length > MAX_WANTED_VERSION_LENGTH
      ) {
        continue;
      }
      requirements.push({
        tool,
        wanted: trimmedWanted,
        source: fileName,
        ecosystem: ecosystemForTool(tool),
        path: filePath,
      });
    }
  };
  const readRequirementFile = (fileName) => {
    const filePath = join(projectPath, fileName);
    if (!safeExistsSync(filePath)) {
      return undefined;
    }
    const content = safeReadFileSync(filePath, "utf-8");
    return typeof content === "string"
      ? content.slice(0, MAX_REQUIREMENTS_FILE_BYTES)
      : undefined;
  };
  const toolVersionsPins = parseToolVersionsFile(
    readRequirementFile(".tool-versions"),
  );
  addRequirements(toolVersionsPins, ".tool-versions");
  addRequirements(parseNvmrc(readRequirementFile(".nvmrc")), ".nvmrc");
  addRequirements(
    parseJavaVersionFile(readRequirementFile(".java-version")),
    ".java-version",
  );
  addRequirements(
    parsePythonVersionFile(readRequirementFile(".python-version")),
    ".python-version",
  );
  const pyprojectPins = parsePyprojectRequiresPython(
    readRequirementFile("pyproject.toml"),
  );
  if (pyprojectPins) {
    addRequirements(
      { python: pyprojectPins.python },
      "pyproject.toml:requires-python",
    );
  }
  const goMod = parseGoModFile(readRequirementFile("go.mod"));
  if (goMod) {
    addRequirements(
      { [goMod.tool]: goMod.version },
      `go.mod:${goMod.directive}`,
    );
  }
  const rustToml = parseRustToolchainFile(
    readRequirementFile("rust-toolchain.toml"),
  );
  if (rustToml) {
    addRequirements({ rustc: rustToml.channel }, "rust-toolchain.toml");
  } else {
    const rustPlain = parseRustToolchainFile(
      readRequirementFile("rust-toolchain"),
    );
    if (rustPlain) {
      addRequirements({ rustc: rustPlain.channel }, "rust-toolchain");
    }
  }
  addRequirements(
    parsePackageJsonToolRequirements(readRequirementFile("package.json")),
    "package.json",
  );
  addRequirements(
    parseGlobalJsonToolRequirements(readRequirementFile("global.json")),
    "global.json",
  );
  return requirements;
}
