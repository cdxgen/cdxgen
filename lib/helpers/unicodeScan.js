const BIDI_CHARS = /[\u202A-\u202E\u2066-\u2069]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Hidden Unicode scanning must detect raw control ranges.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/gu;

function formatCodePoint(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function findMatchesByPattern(text, pattern, kind) {
  const matches = [];
  for (const match of text.matchAll(pattern)) {
    matches.push({
      char: match[0],
      codePoint: formatCodePoint(match[0]),
      index: match.index,
      kind,
    });
  }
  return matches;
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function commentLineNumbers(text, syntax) {
  const commentLines = new Set();
  if (!text) {
    return commentLines;
  }
  const lines = text.split(/\r?\n/u);
  if (syntax === "yaml") {
    lines.forEach((line, lineIndex) => {
      if (line.trim().startsWith("#")) {
        commentLines.add(lineIndex + 1);
      }
    });
    return commentLines;
  }
  if (syntax === "markdown") {
    let inHtmlComment = false;
    lines.forEach((line, lineIndex) => {
      const hasCommentStart = line.includes("<!--");
      const hasCommentEnd = line.includes("-->");
      if (inHtmlComment || hasCommentStart) {
        commentLines.add(lineIndex + 1);
      }
      if (hasCommentStart && !hasCommentEnd) {
        inHtmlComment = true;
      } else if (hasCommentEnd) {
        inHtmlComment = false;
      }
    });
  }
  return commentLines;
}

/**
 * Find dangerous Unicode characters and return their details.
 *
 * @param {string} text string to inspect
 * @returns {{ char: string, codePoint: string, index: number, kind: string }[]} matches
 */
export function findDangerousUnicodeMatches(text) {
  if (!text || typeof text !== "string") {
    return [];
  }
  const matches = [
    ...findMatchesByPattern(text, BIDI_CHARS, "bidirectional-control"),
    ...findMatchesByPattern(text, ZERO_WIDTH_CHARS, "zero-width"),
    ...findMatchesByPattern(text, CONTROL_CHARS, "control"),
  ];
  matches.sort((left, right) => left.index - right.index);
  return matches;
}

/**
 * Scan a text blob for dangerous Unicode characters and summarize where they appear.
 *
 * @param {string} text text to inspect
 * @param {{ syntax?: "markdown" | "text" | "yaml" }} [options] scan options
 * @returns {{
 *   codePoints: string[],
 *   commentCodePoints: string[],
 *   contexts: string[],
 *   hasHiddenUnicode: boolean,
 *   inComments: boolean,
 *   lineNumbers: number[],
 *   matches: { char: string, codePoint: string, index: number, kind: string, lineNumber: number, inComment: boolean }[],
 * }} scan result
 */
export function scanTextForHiddenUnicode(text, options = {}) {
  const matches = findDangerousUnicodeMatches(text);
  if (!matches.length) {
    return {
      codePoints: [],
      commentCodePoints: [],
      contexts: [],
      hasHiddenUnicode: false,
      inComments: false,
      lineNumbers: [],
      matches: [],
    };
  }
  const commentLines = commentLineNumbers(text, options.syntax || "text");
  const enrichedMatches = matches.map((match) => {
    const lineNumber = lineNumberForIndex(text, match.index);
    return {
      ...match,
      inComment: commentLines.has(lineNumber),
      lineNumber,
    };
  });
  const commentCodePoints = [
    ...new Set(
      enrichedMatches
        .filter((match) => match.inComment)
        .map((match) => match.codePoint),
    ),
  ];
  const contentCodePoints = [
    ...new Set(
      enrichedMatches
        .filter((match) => !match.inComment)
        .map((match) => match.codePoint),
    ),
  ];
  const contexts = [];
  if (commentCodePoints.length) {
    contexts.push("comment");
  }
  if (contentCodePoints.length) {
    contexts.push("content");
  }
  return {
    codePoints: [...new Set(enrichedMatches.map((match) => match.codePoint))],
    commentCodePoints,
    contexts,
    hasHiddenUnicode: true,
    inComments: commentCodePoints.length > 0,
    lineNumbers: [
      ...new Set(enrichedMatches.map((match) => match.lineNumber)),
    ].sort((left, right) => left - right),
    matches: enrichedMatches,
  };
}
