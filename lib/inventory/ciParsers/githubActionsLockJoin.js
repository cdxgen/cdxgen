// Join between the actions lockfile reader (`githubActionsLock.js`) and the
// GitHub Actions workflow parser (`githubActions.js`).
//
// When a repository ships `.github/workflows/actions.lock`, every `uses:`
// step of a workflow can be joined to the lock entry that resolves it: the
// lockfile lists pins per repository-relative workflow path, and the parser
// knows the same path for the file it reads. The join module owns the
// lockfile lookup, the pin-key matching and the document-level summary, so
// the workflow parser only gains call sites. CycloneDX concepts stay out of
// the lockfile reader, and lockfile concepts stay out of the join's callers.

import path from "node:path";

import { safeExistsSync } from "../../core/fs.js";
import { applyPurl, tryBuildPurl } from "../purl.js";
import { parseActionsLockfile } from "./githubActionsLock.js";

/**
 * Path of the actions lockfile relative to the scanned project root, in the
 * form the lockfile itself, the workflow parser and the BOM properties use.
 * @type {string}
 */
export const ACTIONS_LOCKFILE_RELATIVE_PATH = ".github/workflows/actions.lock";

// A workflow ref that names a version prefix rather than a full version:
// `v4` or `v4.2`. A lockfile key written this way covers the refs that
// extend it, because `gh actions-lock` resolves the prefix to the highest
// matching full tag when it pins.
const VERSION_PREFIX_PATTERN = /^v(\d+(?:\.\d+)?)$/;
const VERSION_FULL_PATTERN = /^v(\d+(?:\.\d+)+)$/;

/**
 * Reduce a workflow `uses:` value to the repository-scoped pin key form the
 * lockfile normalises to: the sub-action path is stripped, the owner and
 * repository are lower case, and the ref keeps its case. Values that are not
 * action pins (a scheme such as `docker://`, a missing ref, a single
 * segment) return undefined, because no lock entry can name them.
 *
 * @param {string} uses Raw `uses:` value of a step
 * @returns {string|undefined} Pin key such as `actions/cache@v4`
 */
export function pinKeyForUses(uses) {
  if (typeof uses !== "string" || !uses.length || uses.includes("://")) {
    return undefined;
  }
  const atIndex = uses.indexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  const ownerRepoPath = uses.slice(0, atIndex);
  const ref = uses.slice(atIndex + 1);
  if (!ref.length) {
    return undefined;
  }
  const ownerEnd = ownerRepoPath.indexOf("/");
  if (ownerEnd <= 0 || ownerEnd === ownerRepoPath.length - 1) {
    return undefined;
  }
  const owner = ownerRepoPath.slice(0, ownerEnd).toLowerCase();
  const repoAndPath = ownerRepoPath.slice(ownerEnd + 1);
  const repoEnd = repoAndPath.indexOf("/");
  const repo =
    repoEnd === -1
      ? repoAndPath.toLowerCase()
      : repoAndPath.slice(0, repoEnd).toLowerCase();
  if (!repo.length) {
    return undefined;
  }
  return `${owner}/${repo}@${ref}`;
}

function versionComponents(ref) {
  return ref
    .slice(1)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

/**
 * Reduce a workflow `uses:` value to its pin key when the value names an
 * action at a ref the scan can read. A `${{ }}` expression resolves at run
 * time, so no offline comparison can say whether it drifts; the pin-key
 * checks of `pinKeyForUses` already reject the values that name no
 * repository pin at all (`docker://`, `./`, `$/`, a missing ref).
 *
 * @param {unknown} uses Raw `uses:` value of a step
 * @returns {string|undefined} Pin key such as `actions/cache@v4`
 */
function staticActionPinKey(uses) {
  if (typeof uses !== "string" || uses.includes("${{")) {
    return undefined;
  }
  return pinKeyForUses(uses);
}

/**
 * The pin key of the `uses:` value a component recorded, or undefined for
 * components that reference no statically readable action pin, which the
 * drift findings never name.
 *
 * @param {Object} component Component with a `cdx:github:action:uses` property
 * @returns {string|undefined} Pin key such as `actions/cache@v4`
 */
export function componentUsesPinKey(component) {
  return staticActionPinKey(
    component.properties?.find(
      (property) => property.name === "cdx:github:action:uses",
    )?.value,
  );
}

/**
 * The pin keys a workflow's references are matched against: its own pin list
 * when the lockfile onboards it, else the whole dependency map as the
 * broadest diagnostic. This is the same candidate list `matchLockEntry`
 * searches, so the drift findings never name a reference class the join
 * would have matched.
 *
 * @param {Object} lockfile Parsed lockfile from the reader
 * @param {string} workflowKey Repository-relative workflow path
 * @returns {string[]} Candidate pin keys
 */
function candidateKeysFor(lockfile, workflowKey) {
  return Object.hasOwn(lockfile.workflows, workflowKey)
    ? lockfile.workflows[workflowKey]
    : Object.keys(lockfile.dependencies);
}

/**
 * Whether a workflow ref of the prefix form `vN` or `vN.M` covers a
 * candidate ref that carries the same components and more, such as `v4`
 * covering `v4.2.1`. A ref with a different major, a different number of
 * leading components, or no version shape at all is not covered.
 *
 * @param {string} workflowRef Ref as written in the workflow
 * @param {string} candidateRef Ref recorded in the lockfile
 * @returns {boolean} Whether the prefix covers the candidate
 */
function versionPrefixCovers(workflowRef, candidateRef) {
  if (
    !VERSION_PREFIX_PATTERN.test(workflowRef) ||
    !VERSION_FULL_PATTERN.test(candidateRef)
  ) {
    return false;
  }
  const workflowParts = versionComponents(workflowRef);
  const candidateParts = versionComponents(candidateRef);
  return (
    candidateParts.length > workflowParts.length &&
    workflowParts.every((part, index) => part === candidateParts[index])
  );
}

/**
 * Locate and read the actions lockfile that sits beside a workflow file.
 * `gh actions-lock` only writes the lockfile into the workflow directory, so
 * that is the only place looked at. The file is re-read per workflow file:
 * lockfiles are at most 1 MiB and repositories hold a handful of workflows,
 * and a path-keyed cache would go stale across the scans of one server
 * process.
 *
 * @param {string} f Absolute path to a workflow YAML file
 * @returns {{ lockfile: Object, lockfilePath: string, lockPresent: boolean, lockReadable: boolean }|undefined}
 *   The parsed lockfile, or undefined when no lockfile exists beside the
 *   workflow. `lockReadable` is false when the reader collapsed the file to
 *   its empty shape, which is how an unreadable or unsupported version
 *   reaches the caller.
 */
export function loadActionsLockForWorkflow(f) {
  if (!f) {
    return undefined;
  }
  const lockfilePath = path.join(path.dirname(f), "actions.lock");
  if (!safeExistsSync(lockfilePath)) {
    return undefined;
  }
  const lockfile = parseActionsLockfile(lockfilePath);
  return {
    lockfile,
    lockfilePath,
    lockPresent: true,
    lockReadable: lockfile.version !== null,
  };
}

/**
 * Compute the workflow path a lockfile key compares against: the
 * repository-relative path with "/" separators. The parser records that form
 * when a project root was given; otherwise it is derived from the lockfile
 * location, because the workflow file sits in the lockfile's own directory.
 *
 * @param {string} f Absolute path to the workflow file
 * @param {string} workflowFile Path the parser recorded for the workflow
 * @param {string} lockfilePath Absolute path of the lockfile
 * @param {string} [rootDir] Scanned project root
 * @returns {string} Repository-relative workflow path
 */
export function resolveWorkflowLockKey(f, workflowFile, lockfilePath, rootDir) {
  if (rootDir) {
    return workflowFile;
  }
  // Without a project root the repository root is derived from the lockfile
  // location: the lockfile sits in `.github/workflows`, two levels below it.
  const repositoryRoot = path.join(path.dirname(lockfilePath), "..", "..");
  return path.relative(repositoryRoot, f).split("\\").join("/");
}

/**
 * Match one workflow `uses:` value to the lock entry that resolves it.
 *
 * Candidates come from the workflow's own pin list first, so a repository
 * pinning two versions of one action in different workflows joins each
 * workflow to its own version instead of depending on key order. Only a
 * workflow the lockfile does not onboard falls back to the whole dependency
 * map, as the broadest diagnostic. Within one candidate list an exact key
 * match wins, then a ref match (the workflow ref equals the key's ref or the
 * entry's resolved ref, which is how a workflow writing a tag reaches an
 * entry keyed by its commit), then a version-prefix match (`v4` covers the
 * locked `v4.2.1`).
 *
 * @param {Object} lockfile Parsed lockfile from the reader
 * @param {string} workflowKey Repository-relative workflow path
 * @param {string} uses Raw `uses:` value of a step
 * @returns {{ key: string, entry: Object }|undefined} Matched pin and entry
 */
export function matchLockEntry(lockfile, workflowKey, uses) {
  const pinKey = pinKeyForUses(uses);
  if (!pinKey || !lockfile || lockfile.version === null) {
    return undefined;
  }
  const workflowRef = pinKey.slice(pinKey.indexOf("@") + 1);
  const candidates = candidateKeysFor(lockfile, workflowKey);
  const entryFor = (key) =>
    Object.hasOwn(lockfile.dependencies, key)
      ? lockfile.dependencies[key]
      : undefined;
  const findMatch = (isMatch) => {
    for (const key of candidates) {
      const entry = entryFor(key);
      if (entry && isMatch(key, entry)) {
        return { key, entry };
      }
    }
    return undefined;
  };
  const refOf = (key) => key.slice(key.indexOf("@") + 1);
  return (
    findMatch((key) => key === pinKey) ||
    findMatch((key, entry) => {
      const keyRef = refOf(key);
      return workflowRef === keyRef || workflowRef === entry.ref;
    }) ||
    findMatch(
      (key, entry) =>
        versionPrefixCovers(workflowRef, refOf(key)) ||
        versionPrefixCovers(workflowRef, entry.ref),
    )
  );
}

/**
 * Compare one workflow's action references against its lockfile entries the
 * way the structural pass of `gh actions-lock --verify` does, without any
 * network access: a reference of an onboarded workflow that no entry
 * resolves, a reference whose ref differs from the locked one, and the pin
 * list entries no step reaches any more. Every finding is a pin key; cdxgen
 * does not check commit reachability or `owner_id`/`repo_id` against
 * GitHub, which stays with `gh actions-lock --verify`.
 *
 * A reference the scan cannot read statically (a `${{ }}` expression) and a
 * value that names no repository pin (`docker://`, `./`, `$/`) is nobody's
 * finding, because there is no ref to compare. A repository is recognised by
 * its pin key: an unmatched reference whose owner/repository appears in the
 * candidate list under another ref is a ref mismatch, and one whose
 * repository the candidates never mention is a missing pin.
 *
 * @param {Object} lockfile Parsed lockfile from the reader
 * @param {string} workflowKey Repository-relative workflow path
 * @param {string[]} stepUses Every step-level `uses:` value of the workflow
 * @returns {{ missingPins: string[], refMismatches: string[], stalePins: string[] }}
 *   The pin keys with no lock entry at all, the pin keys that only an entry
 *   under another ref could cover, and the workflow's own pin list entries
 *   reached by no step directly or through a composite action. Empty lists
 *   for an unreadable lockfile.
 */
export function analyzeWorkflowDrift(lockfile, workflowKey, stepUses) {
  const missingPins = [];
  const refMismatches = [];
  const stalePins = [];
  if (!lockfile || lockfile.version === null) {
    return { missingPins, refMismatches, stalePins };
  }
  const onboarded = Object.hasOwn(lockfile.workflows, workflowKey);
  const candidates = candidateKeysFor(lockfile, workflowKey);
  const repositoryOf = (key) => key.slice(0, key.indexOf("@"));
  const reached = new Set();
  const compared = new Set();
  for (const uses of stepUses || []) {
    const pinKey = staticActionPinKey(uses);
    if (!pinKey || compared.has(pinKey)) {
      continue;
    }
    compared.add(pinKey);
    const match = matchLockEntry(lockfile, workflowKey, uses);
    if (match) {
      reached.add(match.key);
    } else if (
      candidates.some((key) => repositoryOf(key) === repositoryOf(pinKey))
    ) {
      refMismatches.push(pinKey);
    } else {
      missingPins.push(pinKey);
    }
  }
  for (const key of collectTransitiveKeys(lockfile, [...reached])) {
    reached.add(key);
  }
  if (onboarded) {
    for (const key of candidates) {
      if (!reached.has(key)) {
        stalePins.push(key);
      }
    }
  }
  return { missingPins, refMismatches, stalePins };
}

function plural(count, singular) {
  if (count === 1) {
    return singular;
  }
  return singular.endsWith("y")
    ? `${singular.slice(0, -1)}ies`
    : `${singular}s`;
}

/**
 * One-line drift summary of a workflow, listing only the findings that
 * apply. A workflow the readable lockfile leaves out is a finding of its
 * own, so the summary names it even when every reference resolves through
 * the diagnostic fallback.
 *
 * @param {{ missingPins: string[], refMismatches: string[], stalePins: string[] }} drift
 *   Findings of `analyzeWorkflowDrift`
 * @param {boolean} onboarded Whether the lockfile onboards the workflow
 * @returns {string} Summary, or an empty string for a workflow with no drift
 */
export function summarizeWorkflowDrift(drift, onboarded) {
  const parts = [];
  if (drift.missingPins.length) {
    const count = drift.missingPins.length;
    parts.push(`${count} ${plural(count, "ref")} with no lock entry`);
  }
  if (drift.refMismatches.length) {
    const count = drift.refMismatches.length;
    parts.push(
      `${count} ${plural(count, "ref")} that differ${count === 1 ? "s" : ""} from the locked ref`,
    );
  }
  if (drift.stalePins.length) {
    const count = drift.stalePins.length;
    parts.push(`${count} lock ${plural(count, "entry")} no step uses any more`);
  }
  if (!onboarded) {
    parts.push("workflow is not onboarded to the lockfile");
  }
  return parts.join("; ");
}

/**
 * Build the lock properties recorded on one matched action component, in the
 * documented order. The hostname is recorded only when the entry carries
 * one, because its absence means the home host.
 *
 * @param {Object} entry Lockfile entry the step matched
 * @returns {Array<{name: string, value: string}>} Property list
 */
export function buildLockProperties(entry) {
  const properties = [
    { name: "cdx:github:lock:commit", value: entry.commit },
    { name: "cdx:github:lock:hashAlgo", value: entry.hashAlgo },
    { name: "cdx:github:lock:ref", value: entry.ref },
    { name: "cdx:github:lock:ownerId", value: String(entry.ownerId) },
    { name: "cdx:github:lock:repoId", value: String(entry.repoId) },
  ];
  if (entry.hostname !== undefined) {
    properties.push({
      name: "cdx:github:lock:hostname",
      value: entry.hostname,
    });
  }
  return properties;
}

/**
 * Collect the pin keys an onboarded workflow reaches only through the `uses`
 * lists of its lock entries, that is the actions its composite actions call.
 * The walk starts from the workflow's directly matched keys and follows the
 * entries' `uses` lists breadth-first, so the returned order is stable. Keys
 * the workflow steps directly are never returned, and a `uses` entry that no
 * lock entry resolves is skipped, because it names nothing this module can
 * describe.
 *
 * @param {Object} lockfile Parsed lockfile from the reader
 * @param {string[]} directKeys Pin keys the workflow's steps matched
 * @returns {string[]} Transitive pin keys in discovery order
 */
export function collectTransitiveKeys(lockfile, directKeys) {
  if (!lockfile || lockfile.version === null) {
    return [];
  }
  const entryFor = (key) =>
    Object.hasOwn(lockfile.dependencies, key)
      ? lockfile.dependencies[key]
      : undefined;
  const visited = new Set(directKeys);
  const queue = directKeys.filter((key) => entryFor(key));
  const found = [];
  while (queue.length) {
    const entry = entryFor(queue.shift());
    for (const use of entry.uses || []) {
      if (visited.has(use)) {
        continue;
      }
      visited.add(use);
      if (entryFor(use)) {
        found.push(use);
        queue.push(use);
      }
    }
  }
  return found;
}

// Context a transitive action inherits from the direct action that reaches it:
// the file the scan saw, and the workflow and job context lists that audit
// rules use to scope components. The direct action's step-level properties
// (its own `uses` value, pinning analysis, step heuristics) describe another
// reference and stay behind.
const INHERITED_CONTEXT_PREFIXES = ["cdx:github:workflow:", "cdx:github:job:"];

/**
 * Build the component for one transitive pin key. The identity comes from the
 * entry: owner and repository lower case, and the version is the ref part of
 * the pin key, which is often a commit SHA whose tag the entry records in its
 * `ref` field (emitted as `cdx:github:lock:ref`).
 *
 * @param {string} key Transitive pin key such as `example-org/helper-b@v3.0.0`
 * @param {Object} entry Lockfile entry the key resolves to
 * @param {Object} referencingComponent Direct action component whose closure
 *   reached this key; its workflow and job context is inherited so audit rules
 *   can scope the transitive action without traversing edges
 * @returns {Object} CycloneDX component with scope `required`
 */
export function buildTransitiveComponent(key, entry, referencingComponent) {
  const keyRef = key.slice(key.indexOf("@") + 1);
  const properties = [];
  for (const property of referencingComponent?.properties || []) {
    if (
      property.name === "internal:SrcFile" ||
      INHERITED_CONTEXT_PREFIXES.some((prefix) =>
        property.name.startsWith(prefix),
      )
    ) {
      properties.push({ name: property.name, value: property.value });
    }
  }
  properties.push(...buildLockProperties(entry));
  properties.push({ name: "cdx:github:action:isTransitive", value: "true" });
  properties.push({ name: "cdx:github:action:isLocked", value: "true" });
  const component = {
    type: "application",
    group: entry.owner,
    name: entry.repo,
    version: keyRef,
    properties,
    scope: "required",
    tags: ["transitive-action"],
  };
  // A pin key always carries owner and repository, so the purl builds; the
  // fallback keeps the component describable should that ever change.
  applyPurl(
    component,
    tryBuildPurl({
      type: "github",
      namespace: entry.owner || null,
      name: entry.repo,
      version: keyRef || null,
    }),
    `github-action:${key}`,
  );
  return component;
}

/**
 * Reconstruct the pin key a transitive component was built from, or undefined
 * for any other component.
 *
 * @param {Object} component Candidate component
 * @returns {string|undefined} Pin key such as `example-org/helper-b@v3.0.0`
 */
function transitivePinKeyOf(component) {
  const isTransitive = component.properties?.some(
    (property) =>
      property.name === "cdx:github:action:isTransitive" &&
      property.value === "true",
  );
  if (
    !isTransitive ||
    !component.group ||
    !component.name ||
    !component.version
  ) {
    return undefined;
  }
  return `${component.group}/${component.name}@${component.version}`;
}

/**
 * Drop transitive components a previous one already covered, first occurrence
 * winning. Two workflows that share a composite action each build the
 * composite's own actions, and the BOM must carry them once.
 *
 * @param {Object[]} components Component list of one parse
 * @returns {Object[]} The same list without duplicate transitive components
 */
export function dedupeTransitiveComponents(components) {
  const seen = new Set();
  const kept = [];
  for (const component of components || []) {
    const pinKey = transitivePinKeyOf(component);
    if (pinKey === undefined) {
      kept.push(component);
    } else if (!seen.has(pinKey)) {
      seen.add(pinKey);
      kept.push(component);
    }
  }
  return kept;
}

/**
 * Build the transitive action components of one onboarded workflow together
 * with the CycloneDX dependency edges that reach them: one edge per direct
 * action to the transitive actions its entry calls, and one edge per
 * transitive action to the ones its entry calls. Every `dependsOn` list names
 * transitive refs only, so the job's own edge stays the sole parent of the
 * direct actions and the hierarchy reads workflow, job, direct action,
 * transitive action.
 *
 * @param {Object} lockfile Parsed lockfile from the reader
 * @param {{ key: string, ref: string, component: Object }[]} directActions
 *   The workflow's matched direct actions in step order: pin key, the ref the
 *   direct component is listed under in the job's `dependsOn`, and the
 *   component itself
 * @returns {{ components: Object[], dependencies: Object[] }} Components for
 *   the transitive pins (first referencing action wins) and their edges
 */
export function collectTransitiveActions(lockfile, directActions) {
  const directKeys = [];
  for (const direct of directActions || []) {
    if (direct?.key && !directKeys.includes(direct.key)) {
      directKeys.push(direct.key);
    }
  }
  const directKeySet = new Set(directKeys);
  const expandedDirect = new Set();
  const refFor = new Map();
  const components = [];
  for (const direct of directActions || []) {
    if (!direct?.key || expandedDirect.has(direct.key)) {
      continue;
    }
    expandedDirect.add(direct.key);
    const closure = collectTransitiveKeys(lockfile, [direct.key]);
    for (const key of closure) {
      if (directKeySet.has(key) || refFor.has(key)) {
        continue;
      }
      const entry = Object.hasOwn(lockfile.dependencies, key)
        ? lockfile.dependencies[key]
        : undefined;
      if (!entry) {
        continue;
      }
      const component = buildTransitiveComponent(key, entry, direct.component);
      refFor.set(key, component["bom-ref"]);
      components.push(component);
    }
  }
  const dependencies = [];
  const edged = [];
  for (const direct of directActions || []) {
    if (direct?.key && direct.ref && !edged.includes(direct.key)) {
      edged.push(direct.key);
      dependencies.push({ key: direct.key, ref: direct.ref });
    }
  }
  for (const key of refFor.keys()) {
    dependencies.push({ key, ref: refFor.get(key) });
  }
  const edges = [];
  for (const node of dependencies) {
    const entry = Object.hasOwn(lockfile.dependencies, node.key)
      ? lockfile.dependencies[node.key]
      : undefined;
    const dependsOn = [...new Set(entry?.uses || [])]
      .filter((use) => refFor.has(use))
      .map((use) => refFor.get(use));
    if (dependsOn.length) {
      edges.push({ ref: node.ref, dependsOn });
    }
  }
  return { components, dependencies: edges };
}

function upsertMetadataProperty(properties, name, value) {
  const existing = properties.find((property) => property.name === name);
  if (existing) {
    existing.value = value;
    return;
  }
  properties.push({ name, value });
}

function propertyValueOf(object, name) {
  return object.properties?.find((property) => property.name === name)?.value;
}

/**
 * Count the drift findings recorded on the finished document: the refs and
 * ref mismatches on the action components of the components and formulation
 * sections, and the stale pin list entries and unonboarded workflows of the
 * formulation workflows. A `-t github` document carries no workflows, so its
 * workflow level counts stay zero there, while the component level counts
 * work in both modes.
 *
 * Ref mismatches are counted first, so a drifted ref contributes to its own
 * count and not to the unlocked refs, which stay the references that no
 * entry and no same-repository pin could cover. References the scan cannot
 * read statically (`${{ }}` expressions, `docker://` images) are neither,
 * because they name no lockfile pin to compare against.
 *
 * @param {Object} bomJson BOM JSON whose sections are complete
 * @returns {{ unlockedRefs: number, refMismatches: number, staleEntries: number, unonboardedWorkflows: number }}
 */
function countWorkflowDriftFindings(bomJson) {
  let unlockedRefs = 0;
  let refMismatches = 0;
  let staleEntries = 0;
  let unonboardedWorkflows = 0;
  const componentLists = [bomJson.components];
  const workflowLists = [];
  for (const formulation of bomJson.formulation || []) {
    componentLists.push(formulation?.components);
    workflowLists.push(formulation?.workflows);
  }
  for (const list of componentLists) {
    for (const component of list || []) {
      if (
        propertyValueOf(component, "cdx:github:action:lockRefMismatch") ===
        "true"
      ) {
        refMismatches += 1;
      } else if (
        propertyValueOf(component, "cdx:github:action:isLocked") === "false" &&
        componentUsesPinKey(component) !== undefined
      ) {
        unlockedRefs += 1;
      }
    }
  }
  for (const list of workflowLists) {
    for (const workflow of list || []) {
      const stalePins = propertyValueOf(
        workflow,
        "cdx:github:workflow:lockStalePins",
      );
      if (stalePins) {
        staleEntries += stalePins.split(",").filter(Boolean).length;
      }
      if (
        propertyValueOf(workflow, "cdx:github:workflow:lockfileOnboarded") ===
          "false" &&
        propertyValueOf(workflow, "cdx:github:workflow:lockfilePresent") ===
          "true" &&
        propertyValueOf(workflow, "cdx:github:workflow:lockfileReadable") !==
          "false"
      ) {
        unonboardedWorkflows += 1;
      }
    }
  }
  return { unlockedRefs, refMismatches, staleEntries, unonboardedWorkflows };
}

/**
 * Record the actions lockfile summary on the document's `metadata.properties`:
 * the lockfile path, its version and the counts of onboarded workflows and
 * dependency entries, followed by the offline drift counts read back from the
 * finished document: the references no lock entry covers, the references that
 * differ from the locked ref, the pin list entries no step uses any more, and
 * the workflows the readable lockfile leaves out. Repositories without a
 * lockfile at the scan root get no properties, so the summary never describes
 * a file the scan did not see. Re-running the helper rewrites the same names
 * instead of adding duplicates.
 *
 * The caller decides the placement: the counts read the finished formulation
 * section, so this runs after the formulation and component-type stages.
 *
 * @param {Object} bomJson BOM JSON object to extend
 * @param {string} sourceDir Directory the scan started from
 * @returns {Object} The same `bomJson`
 */
export function appendActionsLockMetadataProperties(bomJson, sourceDir) {
  if (!bomJson || !sourceDir) {
    return bomJson;
  }
  const lockfilePath = path.join(sourceDir, ACTIONS_LOCKFILE_RELATIVE_PATH);
  if (!safeExistsSync(lockfilePath)) {
    return bomJson;
  }
  const lockfile = parseActionsLockfile(lockfilePath);
  // An unreadable or unsupported lockfile has no version and no counts to
  // record; the per-workflow properties already flag it.
  if (lockfile.version === null) {
    return bomJson;
  }
  if (!bomJson.metadata) {
    bomJson.metadata = {};
  }
  if (!bomJson.metadata.properties) {
    bomJson.metadata.properties = [];
  }
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:path",
    ACTIONS_LOCKFILE_RELATIVE_PATH,
  );
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:version",
    lockfile.version,
  );
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:onboardedWorkflows",
    String(Object.keys(lockfile.workflows).length),
  );
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:dependencies",
    String(Object.keys(lockfile.dependencies).length),
  );
  const drift = countWorkflowDriftFindings(bomJson);
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:unlockedRefs",
    String(drift.unlockedRefs),
  );
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:refMismatches",
    String(drift.refMismatches),
  );
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:staleEntries",
    String(drift.staleEntries),
  );
  upsertMetadataProperty(
    bomJson.metadata.properties,
    "cdx:github:lockfile:unonboardedWorkflows",
    String(drift.unonboardedWorkflows),
  );
  return bomJson;
}
