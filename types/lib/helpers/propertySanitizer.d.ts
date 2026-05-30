/**
 * Recursively sanitize structured values before embedding them in a BOM.
 *
 * @param {unknown} value structured value
 * @returns {unknown} sanitized value
 */
export function sanitizeStructuredValueForBom(value: unknown): unknown;
/**
 * Sanitize a URL value for safe BOM emission.
 *
 * @param {string} value URL value
 * @returns {string} sanitized URL
 */
export function sanitizeBomUrl(value: string): string;
/**
 * Sanitize a property value before serializing it into BOM properties.
 *
 * @param {string} name property name
 * @param {unknown} value property value
 * @returns {string|unknown} sanitized property value
 */
export function sanitizeBomPropertyValue(name: string, value: unknown): string | unknown;
//# sourceMappingURL=propertySanitizer.d.ts.map