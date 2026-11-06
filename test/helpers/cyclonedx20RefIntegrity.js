// Reference-integrity walk for rendered CycloneDX 2.0 documents, shared by
// the 2.0 renderer tests and the tests of the sections it derives (PQC
// risks, agent blueprints, hardware mapping).
import { assert } from "poku";

// Keys whose string values (or string array items) reference a refId in a
// rendered 2.0 document.
const REFERENCE_KEYS = new Set([
  "ref",
  "dependsOn",
  "provides",
  "targets",
  "subjects",
  "algorithmRef",
  "party",
  "attributedTo",
  "process",
  "tools",
  "affects",
  "actors",
]);

const isRecord = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Collect every declared refId (with its paths) and every reference of a
 * document.
 *
 * @param {object} bom20 Rendered 2.0 document
 * @returns {{declared: Map<string, string[]>, references: Array<{ref: string, path: string}>}}
 */
export function collectRefs(bom20) {
  const declared = new Map();
  const references = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        walk(child, `${path}/${index}`);
      });
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (typeof node.refId === "string") {
      declared.set(node.refId, [
        ...(declared.get(node.refId) || []),
        `${path}/refId`,
      ]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (REFERENCE_KEYS.has(key)) {
        for (const ref of [].concat(value)) {
          if (typeof ref === "string") {
            references.push({ ref, path: `${path}/${key}` });
          }
        }
      }
      walk(value, `${path}/${key}`);
    }
  };
  walk(bom20, "");
  return { declared, references };
}

/**
 * Walk a whole rendered document and assert that every refId is declared
 * once and that every reference (dependency refs, composition targets,
 * annotation subjects, componentReference/system refs, identifier parties,
 * citation attribution, algorithm refs, evidence tools, risk `affects`,
 * behavior `actors`) names a declared refId or is a BOM-Link (urn:cdx:...)
 * into another document.
 *
 * @param {object} bom20 Rendered 2.0 document
 * @param {string} label Assertion message prefix
 */
export function assertRefIntegrity(bom20, label) {
  const { declared, references } = collectRefs(bom20);
  const duplicates = [...declared].filter(([, paths]) => paths.length > 1);
  assert.deepStrictEqual(
    duplicates,
    [],
    `${label}: every refId is declared once`,
  );
  const dangling = references.filter(
    ({ ref }) => !declared.has(ref) && !ref.startsWith("urn:cdx:"),
  );
  assert.deepStrictEqual(
    dangling,
    [],
    `${label}: every reference resolves to a declared refId`,
  );
}
