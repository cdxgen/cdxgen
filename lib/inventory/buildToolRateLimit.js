import { recordDegradation } from "../core/buildLedger.js";
import { registerRunReset } from "../core/runState.js";

/**
 * Text a build tool prints when its Maven repository answers HTTP 429, as
 * recorded from each tool against a repository that rate limits. One small
 * matcher per tool, plain substring tests on the combined output: the tools
 * reword their messages between versions, so the matched fragment is the one
 * every observed phrasing keeps (the status number in the tool's own wording).
 *
 * sbt, Mill and scala-cli resolve through Coursier, so they share the
 * coursier matcher. The Coursier inside sbt 1.x reports the JDK's
 * `Server returned HTTP response code: 429`; the one in sbt 2, Mill and
 * scala-cli reports `retryable HTTP error: <url> (HTTP 429)`, with a
 * `Retry-After` inside the parentheses when the server sent one.
 *
 * @type {Object<string, string[]>}
 */
const RATE_LIMIT_MARKERS = {
  maven: ["status code: 429", "Too Many Requests"],
  gradle: ["Received status code 429", "[HTTP 429: http"],
  coursier: ["response code: 429", "(HTTP 429"],
};

/**
 * The matcher family a tool belongs to.
 *
 * @type {Object<string, string>}
 */
const TOOL_MATCHER = {
  maven: "maven",
  gradle: "gradle",
  sbt: "coursier",
  mill: "coursier",
  "scala-cli": "coursier",
};

/**
 * How each tool is moved to a mirror, named in one hint per tool and scan.
 * sbt reads its own repositories file; Mill and scala-cli read Coursier's
 * mirror.properties, whose entry spells the semicolon-separated format
 * because a comma list is silently ignored.
 *
 * @type {Object<string, string>}
 */
const MIRROR_SETTINGS = {
  maven:
    "Point Maven at a mirror with a <mirror> entry in the Maven settings.xml, or set MVNW_REPOURL for the Maven wrapper.",
  gradle:
    "Point Gradle at a mirror by declaring the repository in a Gradle init script.",
  sbt: "Point sbt at a mirror by listing it in ~/.sbt/repositories and passing -Dsbt.override.build.repos=true in SBT_OPTS or .sbtopts.",
  coursier:
    "Point Coursier at a mirror with mirror.properties, setting central.from and central.to (separate several central.from URLs with semicolons, not commas).",
};

/**
 * Tools whose later invocations or retries cdxgen skips once one met a rate
 * limit. Mill and scala-cli resolve in a single invocation.
 *
 * @type {Set<string>}
 */
const STOPPED_TOOLS = new Set(["maven", "gradle", "sbt"]);

/**
 * Tools whose repository answered HTTP 429 during the current scan. Further
 * invocations of that tool would only pay the same back-off for the same
 * empty answer.
 *
 * @type {Set<string>}
 */
const rateLimitedTools = new Set();

registerRunReset("inventory.buildToolRateLimit", () => {
  rateLimitedTools.clear();
});

/**
 * Whether a tool's combined output names a rate limit from its repository.
 * The answer text is treated as untrusted: only fixed substrings are looked
 * for, nothing from the output is kept.
 *
 * @param {string} output Combined stdout and stderr of one invocation.
 * @param {string} tool One of maven, gradle, sbt, mill, scala-cli.
 * @returns {boolean} True when the output names an HTTP 429 answer.
 */
export function detectBuildToolRateLimit(output, tool) {
  const markers = RATE_LIMIT_MARKERS[TOOL_MATCHER[tool]];
  if (!markers || typeof output !== "string" || !output) {
    return false;
  }
  return markers.some((marker) => output.includes(marker));
}

/**
 * Whether a tool was already found rate limited in this scan, so the caller
 * can skip its remaining invocations.
 *
 * @param {string} tool One of maven, gradle, sbt, mill, scala-cli.
 * @returns {boolean}
 */
export function isBuildToolRateLimited(tool) {
  return rateLimitedTools.has(tool);
}

/**
 * Read a completed invocation's output for a rate limit. When one is found,
 * the tool is remembered for the scan, one hint naming the tool's mirror
 * setting is printed, and the `build.rate-limited` degradation is recorded.
 * The first invocation that shows the rate limit is the one recorded; later
 * ones add nothing, because the same answer ends them all.
 *
 * @param {string} tool One of maven, gradle, sbt, mill, scala-cli.
 * @param {string|undefined} output Combined output, as commandOutputText
 *   returns it for a spawn result.
 * @param {Object} [context] Call-site facts for the degradation event.
 * @param {string} [context.command] The redacted command that was attempted.
 * @param {number} [context.exitCode] The invocation's exit status.
 * @returns {boolean} True when this output names a rate limit.
 */
export function noteBuildToolRateLimit(tool, output, context = {}) {
  if (!detectBuildToolRateLimit(output, tool)) {
    return false;
  }
  if (isBuildToolRateLimited(tool)) {
    return true;
  }
  rateLimitedTools.add(tool);
  const stopped = STOPPED_TOOLS.has(tool)
    ? `, so cdxgen runs no further ${tool} resolution in this scan and`
    : ", so";
  console.warn(
    `The repository ${tool} downloads from is rate limiting this machine (HTTP 429)${stopped} its dependency tree is incomplete. ${MIRROR_SETTINGS[tool] || MIRROR_SETTINGS[TOOL_MATCHER[tool]]} cdxgen's own lookups can be moved with MAVEN_CENTRAL_URL.`,
  );
  recordDegradation("build.rate-limited", {
    ecosystem: "java",
    tool,
    impact: "transitive-deps",
    command: context.command,
    exitCode: context.exitCode,
    detail: `The repository ${tool} downloads from answered HTTP 429, so ${tool} resolved no dependencies.`,
    outputExcerpt: output,
  });
  return true;
}
