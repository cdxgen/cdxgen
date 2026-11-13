/**
 * Reader over the BOM's formulation section, the third evidence source.
 *
 * Formulation is two things at once, and the distinction governs every
 * confidence decision downstream. The run-derived half — `type: "platform"`
 * components recording the toolchain the generating run probed, and the git
 * provenance components — is what cdxgen itself did. The config-parsed half —
 * the commands, environment variables and task types under
 * `formulation[].workflows[]` — is what the repo's CI declares, and a
 * declared command was never observed to run.
 *
 * This module is pure: the BOM and the caller's run facts are the only
 * inputs, nothing is read from the filesystem, and environment variable
 * *values* are never touched — names only, because the BOM stores them and
 * copying them into a report would republish them.
 */

/**
 * Property carrying the id of the run that stamped a BOM's formulation, set
 * on every formulation workflow by the introspection pass that reflected
 * over the freshly generated document.
 *
 * @type {string}
 */
export const FORMULATION_RUN_ID_PROPERTY = "cdx:introspection:runId";

/** The formulation record was produced by the run being reflected. */
export const FORMULATION_ORIGIN_SAME_RUN = "same-run";

/** The formulation record came with a BOM this run did not generate. */
export const FORMULATION_ORIGIN_FOREIGN = "foreign";

/**
 * The BOM carries no formulation record at all, which is neither of the
 * above: there is no evidence to weigh, so every consumer must behave as it
 * did before formulation became a source.
 */
export const FORMULATION_ORIGIN_ABSENT = "absent";

/**
 * Platform component names, as the environment probes emit them, mapped to
 * the canonical ecosystem whose row their facts can corroborate. Names not
 * listed here have no fidelity row to join.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TOOL_NAME_ECOSYSTEMS = Object.freeze({
  java: "java",
  dotnet: "csharp",
  python: "python",
  "Node.js": "npm",
  gcc: "c",
  rustc: "rust",
  go: "go",
  ruby: "ruby",
  swift: "swift",
});

/**
 * Resolver executables whose presence in a declared command says a build or
 * dependency resolution was attempted, mapped to the ecosystem they drive.
 * Keys are executable basenames, lower-cased.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RESOLVER_EXECUTABLES = Object.freeze({
  mvn: "java",
  mvnw: "java",
  gradle: "java",
  gradlew: "java",
  java: "java",
  ant: "java",
  sbt: "java",
  npm: "npm",
  pnpm: "npm",
  yarn: "npm",
  bun: "npm",
  deno: "npm",
  npx: "npm",
  node: "npm",
  pip: "python",
  pip3: "python",
  poetry: "python",
  uv: "python",
  pdm: "python",
  pipenv: "python",
  conda: "python",
  python: "python",
  python3: "python",
  cargo: "rust",
  go: "go",
  bundle: "ruby",
  gem: "ruby",
  rake: "ruby",
  ruby: "ruby",
  dotnet: "csharp",
  nuget: "csharp",
  composer: "php",
  dart: "dart",
  flutter: "dart",
  helm: "helm",
  lein: "clojure",
  clj: "clojure",
  clojure: "clojure",
  swift: "swift",
  pod: "cocoa",
  mix: "elixir",
  cmake: "c",
  make: "c",
  meson: "c",
  ninja: "c",
  cabal: "haskell",
  stack: "haskell",
});

/**
 * The runtime names the reflection reports, mapped to the family a
 * formulation platform component records for the same runtime.
 *
 * @type {Readonly<Record<string, string>>}
 */
const RUNTIME_FAMILIES = Object.freeze({
  "Node.js": "Node.js",
  node: "Node.js",
  Deno: "Deno",
  deno: "Deno",
  Bun: "Bun",
  bun: "Bun",
});

/**
 * The final path segment of a POSIX- or Windows-flavoured command token.
 *
 * @param {string} token Command token.
 * @returns {string} The token after its last path separator.
 */
function basenameOfToken(token) {
  const slash = token.lastIndexOf("/");
  const backslash = token.lastIndexOf("\\");
  return token.slice(Math.max(slash, backslash) + 1);
}

/**
 * Whether an `executed` value is a CI action reference such as
 * `actions/checkout@<sha>` rather than a shell command. An action reference
 * carries no whitespace, contains a path separator, and names a revision of
 * the repository after the last separator; a relative-path executable such
 * as `./mvnw` carries no revision and stays a command.
 *
 * @param {string|undefined} executed The executed value of a step command.
 * @returns {boolean} True when the value names an action, not a command.
 */
export function isActionReference(executed) {
  if (typeof executed !== "string" || !executed.trim()) {
    return false;
  }
  const text = executed.trim();
  if (/\s/.test(text) || !text.includes("/")) {
    return false;
  }
  const lastSegment = text.slice(text.lastIndexOf("/") + 1);
  return lastSegment.includes("@");
}

/**
 * The executable a command line starts with, as a bare name.
 *
 * @param {string|undefined} commandLine Command line.
 * @returns {string} Basename of the first whitespace token, or "" when absent.
 */
export function executableOf(commandLine) {
  const first = `${commandLine || ""}`.trim().split(/\s+/)[0] || "";
  return basenameOfToken(first);
}

/**
 * The revision a git provenance component records, from its OmniBOR or
 * Software Heritage identifier. Identifiers prefix the raw hash with a
 * scheme and type, so the value after the last colon is the revision itself.
 *
 * @param {Object} component Formulation component of type `file`.
 * @returns {string|undefined} The raw revision, when the component names one.
 */
function revisionOf(component) {
  const identifiers = [
    ...(Array.isArray(component?.omniborId) ? component.omniborId : []),
    ...(Array.isArray(component?.swhid) ? component.swhid : []),
  ];
  for (const identifier of identifiers) {
    if (typeof identifier === "string" && identifier.includes(":")) {
      return identifier.slice(identifier.lastIndexOf(":") + 1) || undefined;
    }
  }
  return undefined;
}

/**
 * Whether a formulation component is one of the git graph nodes the
 * provenance builder adds beside the per-file blobs.
 *
 * @param {Object} component Formulation component.
 * @returns {boolean} True for `git-parent` and `git-tree`.
 */
function isGitGraphNode(component) {
  return component?.name === "git-parent" || component?.name === "git-tree";
}

/**
 * The run id a formulation workflow carries, when the introspection pass
 * that reflected over it stamped one.
 *
 * @param {Object} workflow Formulation workflow.
 * @returns {string|undefined} The stamped run id, when present.
 */
function stampedRunId(workflow) {
  for (const property of Array.isArray(workflow?.properties)
    ? workflow.properties
    : []) {
    if (property?.name === FORMULATION_RUN_ID_PROPERTY) {
      return property?.value;
    }
  }
  return undefined;
}

/**
 * Whether a formulation workflow carries this run's id marker.
 *
 * @param {Object} bomJson CycloneDX BOM.
 * @param {string} runId The reflection's own run id.
 * @returns {boolean} True when the formulation names this run.
 */
function carriesRunIdMarker(bomJson, runId) {
  if (!runId) {
    return false;
  }
  for (const entry of Array.isArray(bomJson?.formulation)
    ? bomJson.formulation
    : []) {
    for (const workflow of Array.isArray(entry?.workflows)
      ? entry.workflows
      : []) {
      if (stampedRunId(workflow) === runId) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Read the provenance-aware formulation evidence out of a BOM.
 *
 * `origin` decides how the evidence may be used. `same-run` means the
 * formulation describes this very run — its platform components are the same
 * probes the ledger recorded as `tool.resolved`, so the evidence corroborates
 * and must never add confidence. `foreign` means the BOM arrived without a
 * ledger for its generation, and the formulation is the only surviving trace
 * of what that build attempted. `absent` is neither: the BOM carries no
 * formulation record, so there is nothing to weigh and every consumer keeps
 * the behaviour it had before formulation became a source.
 *
 * Environment variable names are collected; values are never read.
 *
 * @param {Object} bomJson CycloneDX BOM.
 * @param {Object} [context] Run facts the caller already knows.
 * @param {string} [context.runId] This reflection's run id, matched against the formulation's marker.
 * @param {number} [context.ledgerEventCount] Events the ledger holds for this BOM's generation.
 * @returns {{
 *   origin: "same-run"|"foreign"|"absent",
 *   tools: {name: string|undefined, version: string|undefined, source: "probe"}[],
 *   declaredCommands: {executable: string, commandLine: string, workflow: string|undefined, task: string|undefined, step: string|undefined, source: "ci-config"}[],
 *   sourceTree: {commit: string|undefined, treeId: string|undefined, fileCount: number}|undefined,
 *   environmentKeys: string[]
 * }} The formulation evidence.
 */
export function readFormulationEvidence(bomJson, context = {}) {
  const entries = Array.isArray(bomJson?.formulation)
    ? bomJson.formulation
    : [];
  const sameRun =
    Number(context.ledgerEventCount) > 0 ||
    carriesRunIdMarker(bomJson, context.runId);
  const tools = [];
  let commit;
  let treeId;
  let fileCount = 0;
  const environmentKeys = [];
  const declaredCommands = [];
  for (const entry of entries) {
    for (const component of Array.isArray(entry?.components)
      ? entry.components
      : []) {
      if (component?.type === "platform") {
        tools.push({
          name: component.name,
          version: component.version,
          source: "probe",
        });
      } else if (component?.type === "file") {
        if (isGitGraphNode(component)) {
          if (component.name === "git-parent") {
            commit = revisionOf(component) || commit;
          } else {
            treeId = revisionOf(component) || treeId;
          }
        } else {
          fileCount += 1;
        }
      }
    }
    for (const workflow of Array.isArray(entry?.workflows)
      ? entry.workflows
      : []) {
      for (const input of Array.isArray(workflow?.inputs)
        ? workflow.inputs
        : []) {
        for (const variable of Array.isArray(input?.environmentVars)
          ? input.environmentVars
          : []) {
          // A name-only entry is a plain string.
          const name = typeof variable === "string" ? variable : variable?.name;
          if (name && !environmentKeys.includes(name)) {
            environmentKeys.push(name);
          }
        }
      }
      for (const task of Array.isArray(workflow?.tasks) ? workflow.tasks : []) {
        for (const step of Array.isArray(task?.steps) ? task.steps : []) {
          for (const command of Array.isArray(step?.commands)
            ? step.commands
            : []) {
            const executed = command?.executed;
            if (
              typeof executed !== "string" ||
              !executed.trim() ||
              isActionReference(executed)
            ) {
              continue;
            }
            declaredCommands.push({
              executable: executableOf(executed),
              commandLine: executed.trim(),
              workflow: workflow?.name || workflow?.uid,
              task: task?.name || task?.uid,
              step: step?.name,
              source: "ci-config",
            });
          }
        }
      }
    }
  }
  return {
    origin: !entries.length
      ? FORMULATION_ORIGIN_ABSENT
      : sameRun
        ? FORMULATION_ORIGIN_SAME_RUN
        : FORMULATION_ORIGIN_FOREIGN,
    tools,
    declaredCommands,
    sourceTree:
      commit || treeId || fileCount > 0
        ? { commit, treeId, fileCount }
        : undefined,
    environmentKeys,
  };
}

/**
 * The formulation platform entry for the runtime family this reflection runs
 * on, when the record cannot describe the machine in use: either the
 * recorded version of the family differs from the runtime actually running,
 * or the record names other toolchains but no entry of this family at all. A
 * difference proves the formulation's toolchain record describes a machine
 * other than the one re-scanning the BOM; it says nothing about the other
 * toolchains the record names, which no probe of this run observed.
 *
 * @param {Object} evidence Formulation evidence from readFormulationEvidence.
 * @param {Object} runtime The reflection's runtime facts.
 * @param {string} runtime.name Runtime name, such as "Node.js".
 * @param {string} runtime.version Runtime version.
 * @returns {{tool: string, recordedVersion: string|undefined, runtimeVersion: string}|undefined} The mismatching formulation entry, when one exists.
 */
export function findRuntimeToolMismatch(evidence, runtime) {
  const family = RUNTIME_FAMILIES[`${runtime?.name}`];
  const tools = Array.isArray(evidence?.tools) ? evidence.tools : [];
  if (!family || !runtime?.version || !tools.length) {
    return undefined;
  }
  for (const tool of tools) {
    if (tool?.name === family) {
      if (tool.version !== runtime.version) {
        return {
          tool: family,
          recordedVersion: tool.version,
          runtimeVersion: runtime.version,
        };
      }
      return undefined;
    }
  }
  return {
    tool: family,
    recordedVersion: undefined,
    runtimeVersion: runtime.version,
  };
}

/**
 * The declared CI command a formulation records for one ecosystem, if any.
 * Commands carry no ecosystem tag, so the executable answers: the first
 * declared command whose executable drives that ecosystem's resolver wins,
 * in the order the formulation records them.
 *
 * @param {Object} evidence Formulation evidence from readFormulationEvidence.
 * @param {string} ecosystem Canonical ecosystem name.
 * @returns {Object|undefined} The matching declared command entry.
 */
export function declaredCommandForEcosystem(evidence, ecosystem) {
  for (const command of Array.isArray(evidence?.declaredCommands)
    ? evidence.declaredCommands
    : []) {
    if (RESOLVER_EXECUTABLES[command.executable] === ecosystem) {
      return command;
    }
  }
  return undefined;
}
