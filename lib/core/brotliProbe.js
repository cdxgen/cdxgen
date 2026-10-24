// Bounded probe for a Brotli decoder compiled into a native file, and for
// whether that copy carries the CVE-2026-111497 fix.
//
// Node.js, the Python Brotli and brotlicffi wheels, the PHP and Ruby
// extensions, the .NET runtime and many static binaries carry a private copy of
// Google's C decoder. No package manager names that copy, and its version is
// not stored as a string anywhere in the file, so a BOM has to read the file
// to say whether a vulnerable decoder ships in it.
//
// Three kinds of evidence are read, each classified by the bytes around it:
//
// - The names of the decoder's error codes, which BrotliDecoderErrorString()
//   returns (EXUBERANT_NIBBLE is one). Upstream 1.1+ stores them prefixed,
//   `_ERROR_FORMAT_EXUBERANT_NIBBLE`; 1.0.x and Debian's backport store the
//   bare name between NULs. The fix, google/brotli 0ed4268, added the name
//   BLOCK_SWITCH, so a decoder whose table has it is patched.
//   https://github.com/google/brotli/blob/v1.2.0/c/include/brotli/decode.h#L72
//   https://github.com/google/brotli/commit/0ed4268a4401abcb4472096340477cf4af7d1a2b
// - Two decoder tables, kCodeLengthCodeOrder and kCodeLengthPrefixValue
//   (c/dec/decode.c). They stay when a linker drops the error-name table
//   because nothing calls BrotliDecoderErrorString (--gc-sections, LTO,
//   -dead_strip). The encoder keeps the first table but not the second. With
//   the tables alone the decoder is present but its fix state is unknown.
// - Node.js's zlib.constants table, BROTLI_DECODER_ERROR_FORMAT_*. It mirrors
//   the brotli headers Node.js was built with, and a linker that merges string
//   tails (lld -O2, lld-link /OPT:ICF) can leave only it in place of the
//   decoder's own names. Next to the decoder tables it stands for them; alone,
//   as in a Node.js linked to a shared libbrotlidec, it is no decoder.
//
// The ports are told apart. The Go port (andybalholm/brotli, fixed in v1.2.7)
// keeps the same names in Go's undelimited string table, so a Go binary can
// hold both a cgo-linked C decoder and the Go port, and each gets its own
// fix state. The Rust port (brotli-decompressor) keeps `ERROR_FORMAT_...`
// strings and the same tables but is not affected; its crate name in symbols
// or panic paths marks it, and its evidence is ignored.
//
// Nothing is executed. A file over the read cap is reported as skipped, never
// as free of a decoder.
//
// The component helpers that put the answer into a BOM are in
// lib/inventory/brotliDecoder.js; this half lives in the core layer so the HTTP
// client can ask it about its own runtime.

import { scanFileMarkers } from "./boundedFile.js";

const NAME = Buffer.from("EXUBERANT_NIBBLE");
const FIX_NAME = Buffer.from("BLOCK_SWITCH");
// The Go linker writes this magic at the start of the buildinfo section.
// https://github.com/golang/go/blob/go1.25.0/src/debug/buildinfo/buildinfo.go#L58
const GO_BUILDINFO_MAGIC = Buffer.from("\xff Go buildinf:", "latin1");
// static const uint8_t kCodeLengthCodeOrder[18] and
// kCodeLengthPrefixValue[16], c/dec/decode.c.
const CODE_LENGTH_CODE_ORDER = Buffer.from([
  1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);
const CODE_LENGTH_PREFIX_VALUE = Buffer.from([
  0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5,
]);
// Legacy and v0 Rust mangling length-prefix the crate name; panic messages
// name the crate's source path.
const RUST_CRATE_SYMBOL = Buffer.from("19brotli_decompressor");
const RUST_CRATE_PATH = Buffer.from("brotli-decompressor-");

const CONSTANT_PREFIX = Buffer.from("BROTLI_DECODER_ERROR_FORMAT_");
const C_PREFIX = Buffer.from("_ERROR_FORMAT_");
const RUST_PREFIX = Buffer.from("ERROR_FORMAT_");

/**
 * The most files of one kind (executables and libraries, or extension
 * modules) one scan opens in search of a Brotli decoder.
 *
 * @type {number}
 */
export const MAX_BROTLI_PROBES = 4096;

/**
 * The most bytes one scan reads in search of Brotli decoders.
 *
 * @type {number}
 */
export const MAX_BROTLI_PROBE_BYTES = 16 * 1024 * 1024 * 1024;

function endsWith(buffer, suffix) {
  return (
    buffer.length >= suffix.length &&
    buffer.subarray(buffer.length - suffix.length).equals(suffix)
  );
}

/**
 * Classify one hit of an error name by what it is part of.
 *
 * @param {{before: Buffer, after: Buffer}} hit marker hit
 * @returns {string} `constant`, `c`, `rust` or `other`
 */
function classify(hit) {
  if (endsWith(hit.before, CONSTANT_PREFIX)) {
    return "constant";
  }
  if (endsWith(hit.before, C_PREFIX)) {
    return "c";
  }
  if (endsWith(hit.before, RUST_PREFIX)) {
    return "rust";
  }
  const previous = hit.before.length ? hit.before[hit.before.length - 1] : 0;
  if (previous === 0 && hit.after.length && hit.after[0] === 0) {
    return "c";
  }
  return "other";
}

/**
 * Read which Brotli decoders a native file embeds and whether each carries
 * the CVE-2026-111497 fix.
 *
 * @param {string} absPath absolute path of the file
 * @param {string|undefined} rootDir extracted root the file must stay under
 * @returns {{c?: {blockSwitchFix: string, evidence: string}, go?: {blockSwitchFix: string}, skipped?: string, size: number}|undefined}
 *   undefined when the file cannot be read or holds no decoder. `c` is
 *   Google's C decoder, with blockSwitchFix `true`, `false` or `unknown` and
 *   the evidence it rests on (`error-names`, `constant-names` or `tables`);
 *   `go` is the Go port. `skipped` is `too-large` for a file over the read cap.
 */
export function readBrotliDecoder(absPath, rootDir) {
  const scan = scanFileMarkers(
    absPath,
    rootDir,
    [
      NAME,
      FIX_NAME,
      GO_BUILDINFO_MAGIC,
      CODE_LENGTH_CODE_ORDER,
      CODE_LENGTH_PREFIX_VALUE,
      RUST_CRATE_SYMBOL,
      RUST_CRATE_PATH,
    ],
    { contextBytes: 1, beforeBytes: CONSTANT_PREFIX.length, maxHits: 256 },
  );
  if (!scan) {
    return undefined;
  }
  if (scan.skipped) {
    return { skipped: scan.skipped, size: scan.size };
  }
  const [
    names,
    fixNames,
    goMagic,
    codeOrder,
    prefixValue,
    rustSymbol,
    rustPath,
  ] = scan.hits;
  const kinds = (hits) => new Set(hits.map(classify));
  const nameKinds = kinds(names);
  const fixKinds = kinds(fixNames);
  const isGo = goMagic.length > 0;
  const isRust = rustSymbol.length > 0 || rustPath.length > 0;
  const hasTables = codeOrder.length > 0 && prefixValue.length > 0;
  const result = { size: scan.size };
  // Go strings are not delimited, so a name that is neither C-shaped nor a
  // constant is the Go port's, in a Go binary.
  const hasGoPort = isGo && nameKinds.has("other");
  if (hasGoPort) {
    result.go = { blockSwitchFix: fixKinds.has("other") ? "true" : "false" };
  }
  if (nameKinds.has("c")) {
    result.c = {
      blockSwitchFix: fixKinds.has("c") ? "true" : "false",
      evidence: "error-names",
    };
  } else if (hasTables && !hasGoPort && !isRust) {
    result.c = nameKinds.has("constant")
      ? {
          blockSwitchFix: fixKinds.has("constant") ? "true" : "false",
          evidence: "constant-names",
        }
      : { blockSwitchFix: "unknown", evidence: "tables" };
  }
  return result.c || result.go ? result : undefined;
}
