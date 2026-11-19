/**
 * Path of the actions lockfile relative to the scanned project root, in the
 * form the lockfile itself, the workflow parser and the BOM properties use.
 * @type {string}
 */
export declare const ACTIONS_LOCKFILE_RELATIVE_PATH: string;
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
export declare function pinKeyForUses(uses: string): string | undefined;
/**
 * The pin key of the `uses:` value a component recorded, or undefined for
 * components that reference no statically readable action pin, which the
 * drift findings never name.
 *
 * @param {Object} component Component with a `cdx:github:action:uses` property
 * @returns {string|undefined} Pin key such as `actions/cache@v4`
 */
export declare function componentUsesPinKey(component: Object): string | undefined;
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
export declare function loadActionsLockForWorkflow(f: string): {
    lockfile: Object;
    lockfilePath: string;
    lockPresent: boolean;
    lockReadable: boolean;
} | undefined;
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
export declare function resolveWorkflowLockKey(f: string, workflowFile: string, lockfilePath: string, rootDir?: string): string;
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
export declare function matchLockEntry(lockfile: Object, workflowKey: string, uses: string): {
    key: string;
    entry: Object;
} | undefined;
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
export declare function analyzeWorkflowDrift(lockfile: Object, workflowKey: string, stepUses: string[]): {
    missingPins: string[];
    refMismatches: string[];
    stalePins: string[];
};
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
export declare function summarizeWorkflowDrift(drift: {
    missingPins: string[];
    refMismatches: string[];
    stalePins: string[];
}, onboarded: boolean): string;
/**
 * Build the lock properties recorded on one matched action component, in the
 * documented order. The hostname is recorded only when the entry carries
 * one, because its absence means the home host.
 *
 * @param {Object} entry Lockfile entry the step matched
 * @returns {Array<{name: string, value: string}>} Property list
 */
export declare function buildLockProperties(entry: Object): Array<{
    name: string;
    value: string;
}>;
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
export declare function collectTransitiveKeys(lockfile: Object, directKeys: string[]): string[];
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
export declare function buildTransitiveComponent(key: string, entry: Object, referencingComponent: Object): Object;
/**
 * Drop transitive components a previous one already covered, first occurrence
 * winning. Two workflows that share a composite action each build the
 * composite's own actions, and the BOM must carry them once.
 *
 * @param {Object[]} components Component list of one parse
 * @returns {Object[]} The same list without duplicate transitive components
 */
export declare function dedupeTransitiveComponents(components: Object[]): Object[];
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
export declare function collectTransitiveActions(lockfile: Object, directActions: {
    key: string;
    ref: string;
    component: Object;
}[]): {
    components: Object[];
    dependencies: Object[];
};
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
export declare function appendActionsLockMetadataProperties(bomJson: Object, sourceDir: string): Object;
//# sourceMappingURL=githubActionsLockJoin.d.ts.map