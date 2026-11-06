/**
 * Longest exclude or include pattern cdxgen accepts from an untrusted source,
 * such as a server request or a config file in the scanned directory.
 */
export const UNTRUSTED_GLOB_PATTERN_MAX_LENGTH = 512;

/**
 * Most patterns a list of untrusted exclude or include patterns may stand
 * for once brace expressions are expanded. Every expanded pattern is matched
 * against every file the scan walks, so the total, not the length of the
 * list as written, is what decides the cost.
 */
export const UNTRUSTED_GLOB_EXPANSION_BUDGET = 128;

function isIntegerText(text) {
  const digits = text.startsWith("-") ? text.slice(1) : text;
  return (
    digits.length > 0 && [...digits].every((char) => char >= "0" && char <= "9")
  );
}

function isLetter(text) {
  return (
    text.length === 1 &&
    ((text >= "a" && text <= "z") || (text >= "A" && text <= "Z"))
  );
}

/**
 * Count the members of a brace range such as `1..10`, `a..z` or `0..100..5`.
 *
 * @param {string} body text between the braces
 * @param {number} limit value returned for ranges at or beyond the limit
 * @returns {number|undefined} member count, or undefined when the body is
 *   not a range
 */
function braceRangeSize(body, limit) {
  const parts = body.split("..");
  if (parts.length !== 2 && parts.length !== 3) {
    return undefined;
  }
  const [start, end, step = "1"] = parts;
  if (!isIntegerText(step)) {
    return undefined;
  }
  const increment = Math.abs(Number(step)) || 1;
  let distance;
  if (isIntegerText(start) && isIntegerText(end)) {
    distance = Math.abs(Number(end) - Number(start));
  } else if (isLetter(start) && isLetter(end)) {
    distance = Math.abs(end.charCodeAt(0) - start.charCodeAt(0));
  } else {
    return undefined;
  }
  const size = Math.floor(distance / increment) + 1;
  return Number.isFinite(size) && size < limit ? size : limit;
}

function newBraceGroup(start) {
  return {
    current: 1,
    hasAnyComma: false,
    hasComma: false,
    hasDots: false,
    hasGroup: false,
    start,
    sum: 0,
  };
}

/**
 * Count, from above, how many patterns a glob's brace expressions expand to,
 * following the brace-expansion package that minimatch uses:
 *
 * - alternatives in `{a,b}` add up, and groups side by side or inside one
 *   another multiply;
 * - a range such as `{1..9}`, `{a..z}` or `{0..100..5}` counts its members;
 * - a group with no comma of its own but a list inside it, such as
 *   `{{a,b}c}`, is expanded and each result is braced and expanded again,
 *   so it counts as its contents, unless its text holds `..` and a result
 *   could become a range of any size.
 *
 * brace-expansion reads braces that form neither a list nor a range in ways
 * that depend on the rest of the pattern, so a group that is neither, a
 * closing brace with no group open, a group left open, and the `..` case
 * above all count as more than `cap`. Patterns that list alternatives or
 * ranges, such as `{test,tests}` or `*.{js,ts}`, get the exact count, or one
 * slightly above it where a letter range such as `{Z..c}` spans the `\` that
 * brace-expansion leaves out. `\` escapes the next character. The count stops growing at
 * `cap + 1` and each character is read once, so a pattern that would expand
 * to millions costs no more to count than its length.
 *
 * @param {string} pattern glob pattern
 * @param {number} [cap] largest count of interest
 * @returns {number} upper bound on the number of expanded patterns, at most
 *   `cap + 1`
 */
export function globBraceExpansionCount(
  pattern,
  cap = Number.MAX_SAFE_INTEGER - 1,
) {
  const limit = cap + 1;
  const clamp = (value) => Math.min(value, limit);
  const groups = [newBraceGroup(0)];
  const text = String(pattern);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    const group = groups.at(-1);
    if (character === "{") {
      group.hasGroup = true;
      groups.push(newBraceGroup(index + 1));
    } else if (character === "." && text[index + 1] === ".") {
      group.hasDots = true;
    } else if (character === "," && groups.length > 1) {
      group.sum = clamp(group.sum + group.current);
      group.current = 1;
      group.hasComma = true;
      group.hasAnyComma = true;
    } else if (character === "}") {
      if (groups.length === 1) {
        return limit;
      }
      let count;
      if (group.hasComma) {
        count = clamp(group.sum + group.current);
      } else if (group.hasAnyComma) {
        count = group.hasDots ? limit : group.current;
      } else if (!group.hasGroup) {
        count = braceRangeSize(text.slice(group.start, index), limit);
      }
      if (count === undefined) {
        return limit;
      }
      groups.pop();
      const parent = groups.at(-1);
      parent.current = clamp(parent.current * count);
      parent.hasAnyComma ||= group.hasAnyComma;
      parent.hasDots ||= group.hasDots;
    }
  }
  return groups.length === 1 ? groups[0].current : limit;
}

/**
 * Split exclude or include patterns from an untrusted source into the ones
 * cdxgen uses and the ones it refuses. Patterns are taken in order while
 * they fit the expansion budget, so a list cannot multiply the work of a
 * scan by brace expansion or sheer number.
 *
 * @param {unknown} patterns a pattern, a list of patterns, or nothing
 * @param {Object} [options] bound options
 * @param {boolean} [options.allowBraces=true] refuse every pattern with a
 *   brace when false
 * @param {number} [options.budget] expanded patterns allowed in all
 * @param {number} [options.used=0] expanded patterns earlier lists have
 *   already taken from the budget
 * @returns {{accepted: string[], refused: {pattern: string, reason: string}[], expansions: number}}
 *   the patterns to use, the ones refused with the reason, and the expanded
 *   patterns the accepted ones use
 */
export function boundUntrustedGlobPatterns(
  patterns,
  {
    allowBraces = true,
    budget = UNTRUSTED_GLOB_EXPANSION_BUDGET,
    used = 0,
  } = {},
) {
  const entries =
    patterns === undefined || patterns === null
      ? []
      : Array.isArray(patterns)
        ? patterns
        : [patterns];
  const accepted = [];
  const refused = [];
  let expansions = 0;
  for (const entry of entries) {
    if (typeof entry !== "string" && typeof entry !== "number") {
      refused.push({ pattern: String(entry), reason: "is not a string" });
      continue;
    }
    const pattern = String(entry);
    if (pattern.length > UNTRUSTED_GLOB_PATTERN_MAX_LENGTH) {
      refused.push({
        pattern,
        reason: `is longer than ${UNTRUSTED_GLOB_PATTERN_MAX_LENGTH} characters`,
      });
      continue;
    }
    if (!allowBraces && pattern.includes("{")) {
      refused.push({ pattern, reason: "uses braces" });
      continue;
    }
    const count = globBraceExpansionCount(pattern, budget);
    if (count > budget) {
      refused.push({
        pattern,
        reason: `expands to more than ${budget} patterns`,
      });
      continue;
    }
    if (used + expansions + count > budget) {
      refused.push({
        pattern,
        reason: `would bring the patterns past ${budget} after brace expansion`,
      });
      continue;
    }
    expansions += count;
    accepted.push(pattern);
  }
  return { accepted, expansions, refused };
}
