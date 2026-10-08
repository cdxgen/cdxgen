/**
 * State that lasts for one run.
 *
 * Registry answers, prefetched documents, recorded misses and local cache
 * lookups are kept in module state, so that a package several lockfiles name
 * costs one lookup. A run is one BOM generation. The CLI exits when it ends, but
 * a long-lived process such as the server performs many, and nothing a run
 * remembered should outlive it: the registries publish new releases, builds
 * download new artifacts, and the memory belongs to the next scan.
 *
 * Every module that keeps such state registers a reset when it loads. The
 * server calls {@link resetRunState} between scans. A module that has not
 * loaded yet holds nothing to reset.
 */

/** @type {Map<string, () => void>} */
const runResets = new Map();

/**
 * Register the function that empties a module's per-run state.
 *
 * @param {string} name Unique name, normally the module and what it holds
 * @param {() => void} reset Empties that state
 * @returns {void}
 */
export function registerRunReset(name, reset) {
  runResets.set(name, reset);
}

/**
 * Empty the per-run state of every module that registered one.
 *
 * @returns {void}
 */
export function resetRunState() {
  for (const reset of runResets.values()) {
    reset();
  }
}
