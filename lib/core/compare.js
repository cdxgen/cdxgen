/**
 * Order two strings by their UTF-16 code units, as `<` and `>` do. A missing
 * value orders as the empty string.
 *
 * Use it to sort text read from scanned files, tool output or network
 * responses when the order only has to be stable. `localeCompare()` applies
 * ICU collation, whose cost grows with the cube of the length of two strings
 * that differ in an accent and continue with the same run of combining marks.
 *
 * @param {string} [a] A string
 * @param {string} [b] Another string
 * @returns {number} Negative, zero or positive as `a` sorts before, with or
 *   after `b`
 */
export function compareCodeUnits(a, b) {
  const left = a ?? "";
  const right = b ?? "";
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
