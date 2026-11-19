/**
 * Read a JSON value that must be a scalar as text.
 *
 * Metadata files in a scanned tree can hold a nested array or an object where
 * a name, version or label is expected. Converting such a value with String()
 * or join() copies its content once per nesting level, and an object whose own
 * toString is not callable makes the conversion throw. Only a string, a finite
 * number or a boolean is read; anything else yields an empty string. A string
 * longer than maxLength is cut to it and copied, so the cut text does not keep
 * the whole parent string alive.
 *
 * @param {unknown} value Value of any JSON type
 * @param {number} [maxLength] Longest result in characters
 * @returns {string} Text of the scalar, or "" for any other value
 */
export function scalarText(value, maxLength = Number.POSITIVE_INFINITY) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
  } else if (typeof value === "boolean") {
    text = String(value);
  } else {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return Buffer.from(text.slice(0, maxLength)).toString();
}
