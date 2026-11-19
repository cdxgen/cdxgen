import { Glob } from "glob";

/**
 * Longest exclude or include pattern cdxgen accepts from an untrusted source,
 * such as a server request or a config file in the scanned directory.
 */
export const UNTRUSTED_GLOB_PATTERN_MAX_LENGTH = 512;

/**
 * Tell whether a pattern can name something outside the directory it is
 * searched from: an absolute path, a drive or UNC root, or a `..` segment.
 * glob starts an absolute pattern at the filesystem root whatever its working
 * directory is, so such a pattern would walk the host.
 *
 * @param {string} pattern glob pattern
 * @returns {boolean} true when any brace-expanded form of the pattern leaves
 *   the search directory, or the pattern cannot be parsed
 */
function globLeavesSearchDir(pattern) {
  try {
    return new Glob(pattern, {}).patterns.some((parsed) => {
      if (parsed.isAbsolute() || parsed.isDrive() || parsed.isUNC()) {
        return true;
      }
      for (let part = parsed; part; part = part.rest()) {
        if (part.pattern() === "..") {
          return true;
        }
      }
      return false;
    });
  } catch (_e) {
    return true;
  }
}

/**
 * Most patterns a list of untrusted exclude or include patterns may stand
 * for once brace expressions and comma separated lists are expanded and glob
 * has split the `..` segments from the `**` segments before them. Every
 * expanded pattern is matched against every file the scan walks, so the
 * total, not the length of the list as written, is what decides the cost.
 */
export const UNTRUSTED_GLOB_EXPANSION_BUDGET = 128;

/**
 * Terms a filter or only list from an untrusted source may hold. Every term is
 * searched for in the purl, and for filter in every property, of every
 * component.
 */
export const UNTRUSTED_FILTER_TERM_LIMIT = 128;

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
    const first = Number(start);
    const last = Number(end);
    distance = Math.abs(last - first);
    // brace-expansion computes no size: it steps from one end to the other
    // in doubles, and from 2 ** 53 on a step can leave the value where it
    // is, so the walk only stops at brace-expansion's own limit of 100,000.
    // The distance gives the number of steps only between safe integers.
    if (![first, last, distance].every(Number.isSafeInteger)) {
      return limit;
    }
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

// What brace expansion takes out of a pattern, so the characters on either
// side of one of these can end up next to each other.
const BRACE_SYNTAX = "{},\\";

/**
 * Count, from above, how many patterns glob makes of one brace-expanded
 * pattern that has `..` segments after `**` segments.
 *
 * At the optimization level glob uses, minimatch replaces a pattern in which
 * `..` follows `**` by two: one without that `**` and one with a `**` in
 * place of the `..`. It does the same to both until no `**` is followed by
 * `..`, so a `**`, a `..` and a name written n times over stand for about
 * 2^n patterns without a single brace. A pattern with g `**` segments and d
 * `..` segments after the first of them is split into at most the binomial
 * coefficient C(g + d, d) patterns, which is at most 2^(g + d - 1).
 *
 * Braces and escapes can hide either segment, as in `{..,x}`, `.{.,x}`,
 * `*{*,x}` or, next to a brace list, `\.\.`. An expanded pattern keeps the
 * characters of the pattern in their order, so each `*` of a `**` segment and
 * each `.` of a `..` segment has nothing next to it in the pattern as written
 * but a `/`, its twin, brace syntax, `\` or an end. Half the number of such
 * characters is therefore the most segments any expansion can hold. Patterns
 * such as `*.{test,spec}.js`, `{.github,.vscode}` or `{1..9}` have none.
 *
 * @param {string} pattern glob pattern
 * @param {number} [cap] largest count of interest
 * @returns {number} upper bound on the patterns each brace-expanded pattern
 *   is split into, at most `cap + 1`
 */
function globParentSplitCount(pattern, cap = Number.MAX_SAFE_INTEGER - 1) {
  const text = String(pattern);
  const standsAlone = (index) =>
    [text[index - 1], text[index + 1]].every(
      (near) =>
        near === undefined ||
        near === "/" ||
        near === text[index] ||
        BRACE_SYNTAX.includes(near),
    );
  let stars = 0;
  let dots = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "*" && standsAlone(index)) {
      stars += 1;
    } else if (text[index] === "." && stars > 1 && standsAlone(index)) {
      dots += 1;
    }
  }
  const globstars = Math.floor(stars / 2);
  const parents = Math.floor(dots / 2);
  return parents ? Math.min(2 ** (globstars + parents - 1), cap + 1) : 1;
}

/**
 * Split an exclude pattern into the patterns the evidence filters read from
 * it. File discovery hands a pattern to glob as written, but the atom and
 * dosai exclude filters read a pattern with a comma and no brace as a comma
 * separated list. boundUntrustedGlobPatterns counts with this function too,
 * so a list is charged for every pattern it becomes.
 *
 * @param {string} pattern glob pattern, or comma separated glob patterns
 * @returns {string[]} the patterns, trimmed, without the empty ones
 */
export function splitGlobPatternList(pattern) {
  const text = String(pattern);
  const entries =
    text.includes(",") && !text.includes("{") ? text.split(",") : [text];
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Split exclude or include patterns from an untrusted source into the ones
 * cdxgen uses and the ones it refuses. Patterns are taken in order while
 * they fit the expansion budget, so a list cannot multiply the work of a
 * scan by brace expansion, comma separated lists, `..` segments after `**`,
 * or sheer number.
 *
 * @param {unknown} patterns a pattern, a list of patterns, or nothing
 * @param {Object} [options] bound options
 * @param {boolean} [options.allowBraces=true] refuse every pattern with a
 *   brace when false
 * @param {boolean} [options.keepInTree=false] refuse a pattern that is
 *   absolute or has a `..` segment, for patterns that select files inside
 *   the directory being scanned
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
    keepInTree = false,
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
    // Glob reads a comma outside braces as a character, but the evidence
    // filters split the pattern there, so it stands for one pattern per entry.
    const listed = splitGlobPatternList(pattern).length;
    const count = Math.max(
      globBraceExpansionCount(pattern, budget) *
        globParentSplitCount(pattern, budget),
      listed,
    );
    if (count > budget) {
      refused.push({
        pattern,
        reason: `expands to more than ${budget} patterns`,
      });
      continue;
    }
    if (keepInTree && globLeavesSearchDir(pattern)) {
      refused.push({
        pattern,
        reason: "is absolute or climbs out of the scanned directory",
      });
      continue;
    }
    if (used + expansions + count > budget) {
      refused.push({
        pattern,
        reason: `would bring the patterns past ${budget} after ${listed > 1 ? "comma list" : "brace"} expansion`,
      });
      continue;
    }
    expansions += count;
    accepted.push(pattern);
  }
  return { accepted, expansions, refused };
}
