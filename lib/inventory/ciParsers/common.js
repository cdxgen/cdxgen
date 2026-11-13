import { readScanFileText } from "../../core/boundedFile.js";
import {
  redactCommandCredentials,
  sanitizeBomPropertyValue,
  sanitizeBomText,
} from "../../core/propertySanitizer.js";
import { registerRunReset } from "../../core/runState.js";

// CI files of this run that a parser could not analyse.
const ciParseFailures = [];

/**
 * Record a CI file that a parser could not analyse, so that a BOM audit can
 * tell an empty result from a file it never read. A secure-mode audit fails
 * on any recorded file.
 *
 * @param {string} parserId Parser id, such as `github-actions`
 * @param {string} file Path of the file
 * @param {unknown} error Error the parser raised
 * @returns {void}
 */
export function recordCiParseFailure(parserId, file, error) {
  ciParseFailures.push({
    file: `${file}`,
    parserId,
    reason: `${error?.message || error}`.slice(0, 200),
  });
}

/**
 * The CI files of this run that a parser could not analyse.
 *
 * @returns {{parserId: string, file: string, reason: string}[]} One entry
 *   per failure, in the order they happened
 */
export function getCiParseFailures() {
  return [...ciParseFailures];
}

/**
 * Forget the recorded CI parse failures.
 *
 * @returns {void}
 */
export function resetCiParseFailures() {
  ciParseFailures.length = 0;
}

registerRunReset("ci-parsers:failures", resetCiParseFailures);

/**
 * The largest CI configuration file read. A larger file is skipped.
 *
 * @type {number}
 */
export const MAX_CI_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Read a CI configuration file found in the scanned tree. The file must be a
 * regular file no larger than MAX_CI_FILE_BYTES that resolves inside rootDir,
 * so a symbolic link out of the tree is not followed.
 *
 * @param {string} f path of the file
 * @param {string} [rootDir] scanned project root
 * @returns {string} the text
 * @throws {Error} when the file cannot be read under those rules
 */
export function readCiFile(f, rootDir) {
  const raw = readScanFileText(f, MAX_CI_FILE_BYTES, rootDir);
  if (raw === undefined) {
    throw new Error(`Skipped ${f}: not a regular file inside the scan root`);
  }
  return raw;
}

/**
 * Ensure all step objects in the array are unique (CycloneDX `uniqueItems: true`).
 *
 * Identical steps are disambiguated by appending a ` (N)` counter to the step name.
 * The first occurrence is always left unchanged.
 *
 * @param {Object[]} steps
 * @returns {Object[]|undefined}
 */
export function disambiguateSteps(steps) {
  if (!steps?.length) {
    return undefined;
  }
  const seenKeys = new Map();
  return steps.map((step) => {
    const key = JSON.stringify(step);
    const count = seenKeys.get(key) ?? 0;
    seenKeys.set(key, count + 1);
    if (count === 0) {
      return step;
    }
    return { ...step, name: `${step.name} (${count + 1})` };
  });
}

function sanitizeProperties(properties, seen) {
  if (!Array.isArray(properties)) {
    return;
  }
  for (const property of properties) {
    if (!property || typeof property !== "object" || seen.has(property)) {
      continue;
    }
    seen.add(property);
    if (typeof property.value === "string") {
      const value = String(property.name).endsWith(":command")
        ? redactCommandCredentials(property.value)
        : property.value;
      property.value = sanitizeBomPropertyValue(property.name, value);
    }
  }
}

function sanitizeFormulationEntry(entry, seen) {
  if (!entry || typeof entry !== "object" || seen.has(entry)) {
    return;
  }
  seen.add(entry);
  for (const field of ["name", "description"]) {
    if (typeof entry[field] === "string") {
      // Step names often repeat the command they run.
      entry[field] = sanitizeBomText(redactCommandCredentials(entry[field]));
    }
  }
  sanitizeProperties(entry.properties, seen);
  if (Array.isArray(entry.commands)) {
    for (const command of entry.commands) {
      if (typeof command?.executed === "string") {
        command.executed = sanitizeBomText(
          redactCommandCredentials(command.executed),
        );
      }
      sanitizeProperties(command?.properties, seen);
    }
  }
  if (Array.isArray(entry.tasks)) {
    for (const task of entry.tasks) {
      sanitizeFormulationEntry(task, seen);
    }
  }
  if (Array.isArray(entry.steps) && entry.steps.length) {
    for (const step of entry.steps) {
      sanitizeFormulationEntry(step, seen);
    }
    // Two steps that differed only in a removed credential are now equal.
    entry.steps = disambiguateSteps(entry.steps);
  }
}

/**
 * Sanitize, in place, the text a formulation parser copied from a scanned
 * file: the names, descriptions and properties of its workflows, tasks,
 * steps, components and services, and the commands of its steps. URL
 * userinfo, queries and fragments are removed and known token shapes are
 * redacted, as in every other BOM property. Commands, step names and
 * `*:command` properties also lose credential values passed as literal
 * arguments (see redactCommandCredentials()). Identifiers such as `bom-ref`,
 * `purl` and `version` are left alone.
 *
 * @param {Object} result Parser result with workflows, components, services and properties
 * @returns {Object} The same result
 */
export function sanitizeFormulationResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const seen = new WeakSet();
  for (const key of ["workflows", "components", "services"]) {
    if (Array.isArray(result[key])) {
      for (const entry of result[key]) {
        sanitizeFormulationEntry(entry, seen);
      }
    }
  }
  sanitizeProperties(result.properties, seen);
  return result;
}
