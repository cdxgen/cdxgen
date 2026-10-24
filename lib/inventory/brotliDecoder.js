// BOM components for the Brotli decoders compiled into native files. The
// detection itself, and why its markers can be trusted, is in
// lib/core/brotliProbe.js.

import { MAX_BROTLI_PROBES, readBrotliDecoder } from "../core/brotliProbe.js";
import { applyPurl, tryBuildPurl } from "./purl.js";

export { MAX_BROTLI_PROBES, readBrotliDecoder };

/**
 * The properties a file component carries once a decoder is found in it.
 *
 * @param {{blockSwitchFix: boolean, port: string}} decoder result of readBrotliDecoder
 * @returns {{name: string, value: string}[]} properties to append
 */
export function brotliDecoderProperties(decoder) {
  return [
    { name: "cdx:brotli:decoder", value: decoder.port },
    {
      name: "cdx:brotli:blockSwitchFix",
      value: decoder.blockSwitchFix ? "true" : "false",
    },
  ];
}

/**
 * The library component every embedded decoder links to. It has no version:
 * no build records one, and only the per-file cdx:brotli:blockSwitchFix
 * property says whether a copy is vulnerable. The purl has no namespace: a
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
        "Brotli decoder compiled into native files; see cdx:brotli:blockSwitchFix on each file",
      properties: [],
    },
    tryBuildPurl({ type: "generic", name: "brotli" }),
  );
}

/**
 * Start collecting the decoder copies of one scan.
 *
 * @returns {{component: Object|undefined, dependencies: Object[], copies: number, unpatched: number}}
 */
export function createBrotliInventory() {
  return { component: undefined, dependencies: [], copies: 0, unpatched: 0 };
}

/**
 * Tag a file component with the decoder found in it and link it to the shared
 * brotli component, creating that component on first use. Mutates the file
 * component in place.
 *
 * @param {{component: Object|undefined, dependencies: Object[], copies: number, unpatched: number}} inventory
 *   accumulator from createBrotliInventory
 * @param {Object} fileComponent file component with a `properties` array
 * @param {{blockSwitchFix: boolean, port: string}} decoder result of readBrotliDecoder
 */
export function attachBrotliDecoder(inventory, fileComponent, decoder) {
  fileComponent.properties.push(...brotliDecoderProperties(decoder));
  if (!inventory.component) {
    inventory.component = createBrotliComponent();
  }
  inventory.copies += 1;
  if (!decoder.blockSwitchFix) {
    inventory.unpatched += 1;
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
 * @param {{component: Object|undefined, dependencies: Object[], copies: number, unpatched: number}} inventory
 * @returns {{components: Object[], dependencies: Object[]}} what to add to the BOM
 */
export function finishBrotliInventory(inventory) {
  if (!inventory?.component) {
    return { components: [], dependencies: [] };
  }
  inventory.component.properties = [
    { name: "cdx:brotli:embeddedCopies", value: String(inventory.copies) },
    { name: "cdx:brotli:unpatchedCopies", value: String(inventory.unpatched) },
  ];
  return {
    components: [inventory.component],
    dependencies: [
      { ref: inventory.component["bom-ref"], dependsOn: [] },
      ...inventory.dependencies,
    ],
  };
}
