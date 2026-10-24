// BOM components for the Brotli decoders compiled into native files. The
// detection itself, and why its markers can be trusted, is in
// lib/core/brotliProbe.js.

import {
  MAX_BROTLI_PROBE_BYTES,
  MAX_BROTLI_PROBES,
  readBrotliDecoder,
} from "../core/brotliProbe.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

export { MAX_BROTLI_PROBE_BYTES, MAX_BROTLI_PROBES, readBrotliDecoder };

/**
 * The properties a file component carries once it has been probed: the fix
 * state of each decoder found in it, or why it could not be read.
 *
 * @param {Object} decoder result of readBrotliDecoder
 * @returns {{name: string, value: string}[]} properties to append
 */
export function brotliDecoderProperties(decoder) {
  const properties = [];
  if (decoder?.skipped) {
    properties.push({ name: "cdx:brotli:probe", value: decoder.skipped });
  }
  if (decoder?.c) {
    properties.push(
      { name: "cdx:brotli:c:blockSwitchFix", value: decoder.c.blockSwitchFix },
      { name: "cdx:brotli:c:evidence", value: decoder.c.evidence },
    );
  }
  if (decoder?.go) {
    properties.push({
      name: "cdx:brotli:go:blockSwitchFix",
      value: decoder.go.blockSwitchFix,
    });
  }
  return properties;
}

/**
 * The library component every embedded decoder links to. It has no version:
 * no build records one, and only the per-file cdx:brotli:*:blockSwitchFix
 * properties say whether a copy is vulnerable. The `vcs_url` qualifier names
 * the project and keeps the identity apart from an unpackaged `brotli`
 * executable, which is `pkg:generic/brotli`. The purl has no namespace: a
 * `pkg:github` purl is typed as an application and `pkg:generic/google` as a
 * framework when the BOM is assembled, and this is neither.
 *
 * @returns {Object} component with `purl` and `bom-ref`
 */
export function createBrotliComponent() {
  return applyPurl(
    {
      type: "library",
      name: "brotli",
      description:
        "Brotli decoder compiled into native files; see the cdx:brotli properties on each file",
      properties: [],
    },
    tryBuildPurl({
      type: "generic",
      name: "brotli",
      qualifiers: { vcs_url: "git+https://github.com/google/brotli" },
    }),
  );
}

/**
 * Start collecting the decoder copies of one scan.
 *
 * @returns {{component: Object|undefined, dependencies: Object[], copies: number, unpatched: number, unknown: number}}
 */
export function createBrotliInventory() {
  return {
    component: undefined,
    dependencies: [],
    copies: 0,
    unpatched: 0,
    unknown: 0,
  };
}

/**
 * Tag a probed file component and, when it holds a decoder, link it to the
 * shared brotli component, creating that component on first use. Mutates the
 * file component in place.
 *
 * @param {Object} inventory accumulator from createBrotliInventory
 * @param {Object} fileComponent file component with a `properties` array
 * @param {Object} decoder result of readBrotliDecoder
 */
export function attachBrotliDecoder(inventory, fileComponent, decoder) {
  const properties = brotliDecoderProperties(decoder);
  if (!properties.length) {
    return;
  }
  fileComponent.properties.push(...properties);
  if (!decoder.c && !decoder.go) {
    return;
  }
  if (!inventory.component) {
    inventory.component = createBrotliComponent();
  }
  const states = [decoder.c?.blockSwitchFix, decoder.go?.blockSwitchFix];
  inventory.copies += 1;
  if (states.includes("false")) {
    inventory.unpatched += 1;
  } else if (states.includes("unknown")) {
    inventory.unknown += 1;
  }
  if (fileComponent["bom-ref"] && inventory.component["bom-ref"]) {
    inventory.dependencies.push({
      ref: fileComponent["bom-ref"],
      dependsOn: [inventory.component["bom-ref"]],
    });
  }
}

/**
 * Finish an inventory: record the copy counts on the brotli component.
 *
 * @param {Object} inventory accumulator from createBrotliInventory
 * @returns {{components: Object[], dependencies: Object[]}} what to add to the BOM
 */
export function finishBrotliInventory(inventory) {
  if (!inventory?.component) {
    return { components: [], dependencies: [] };
  }
  inventory.component.properties = [
    { name: "cdx:brotli:embeddedCopies", value: String(inventory.copies) },
    { name: "cdx:brotli:unpatchedCopies", value: String(inventory.unpatched) },
    { name: "cdx:brotli:unknownCopies", value: String(inventory.unknown) },
  ];
  return {
    components: [inventory.component],
    dependencies: [
      { ref: inventory.component["bom-ref"], dependsOn: [] },
      ...inventory.dependencies,
    ],
  };
}
