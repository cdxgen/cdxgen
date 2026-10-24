// Bounded probe for a Brotli decoder compiled into a native file, and for
// whether that copy carries the CVE-2026-111497 fix.
//
// Node.js, the Python Brotli and brotlicffi wheels, the PHP and Ruby
// extensions, the .NET runtime and many static binaries carry a private copy of
// Google's C decoder. No package manager names that copy, and its version is
// not stored as a string anywhere in the file, so a BOM has to read the file
// to say whether a vulnerable decoder ships in it.
//
// Presence: every decoder build keeps the names of its error codes for
// BrotliDecoderErrorString(), and EXUBERANT_NIBBLE is one of them. It is data,
// so stripping the symbols leaves it in place, and a program that only links a
// shared libbrotlidec does not carry it (the shared library does).
// https://github.com/google/brotli/blob/v1.2.0/c/include/brotli/decode.h#L72
//
// Fix: commit 0ed4268 added BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, so a
// patched decoder also carries the name BLOCK_SWITCH. Upstream 1.1+ builds keep
// the prefixed `_ERROR_FORMAT_BLOCK_SWITCH`; Debian's 1.0.9 backport keeps the
// bare, NUL-delimited `BLOCK_SWITCH`; the Go port (andybalholm/brotli v1.2.7)
// returns "BLOCK_SWITCH" from a Go string table, where strings are not
// delimited at all.
// https://github.com/google/brotli/commit/0ed4268a4401abcb4472096340477cf4af7d1a2b
//
// Nothing is executed. Files over the read cap are skipped whole.
//
// The component helpers that put the answer into a BOM are in
// lib/inventory/brotliDecoder.js; this half lives in the core layer so the HTTP
// client can ask it about its own runtime.

import { scanFileMarkers } from "./boundedFile.js";

const PRESENCE_MARKER = Buffer.from("EXUBERANT_NIBBLE");
const PREFIXED_FIX_MARKER = Buffer.from("_ERROR_FORMAT_BLOCK_SWITCH");
const BARE_FIX_MARKER = Buffer.from("BLOCK_SWITCH");
// The Go linker writes this magic at the start of the buildinfo section.
// https://github.com/golang/go/blob/go1.25.0/src/debug/buildinfo/buildinfo.go#L58
const GO_BUILDINFO_MAGIC = Buffer.from("\xff Go buildinf:", "latin1");
const BROTLI_DECODER = Buffer.from("BROTLI_DECODER");
const CONSTANT_PREFIX = Buffer.from("BROTLI_DECODER_ERROR_FORMAT_");
const RUST_PREFIX = Buffer.from("ERROR_FORMAT_");
const UNDERSCORE = "_".charCodeAt(0);

/**
 * The most files one scan opens in search of a Brotli decoder.
 *
 * @type {number}
 */
export const MAX_BROTLI_PROBES = 4096;

/**
 * Read whether a native file embeds a Brotli decoder and whether that decoder
 * carries the CVE-2026-111497 fix.
 *
 * @param {string} absPath absolute path of the file
 * @param {string|undefined} rootDir extracted root the file must stay under
 * @returns {{blockSwitchFix: boolean, port: string}|undefined} undefined when
 *   the file holds no decoder or cannot be read; `port` is `c` or `go`
 */
export function readBrotliDecoder(absPath, rootDir) {
  const hits = scanFileMarkers(
    absPath,
    rootDir,
    [PRESENCE_MARKER, PREFIXED_FIX_MARKER, BARE_FIX_MARKER, GO_BUILDINFO_MAGIC],
    { contextBytes: 1, beforeBytes: CONSTANT_PREFIX.length, maxHits: 64 },
  );
  if (!hits) {
    return undefined;
  }
  const [presence, prefixed, bare, goMagic] = hits;
  if (!presence.some(isDecoderErrorName)) {
    return undefined;
  }
  const port = goMagic.length ? "go" : "c";
  let blockSwitchFix = prefixed.some(
    (hit) => !endsWith(hit.before, BROTLI_DECODER),
  );
  if (!blockSwitchFix) {
    for (const hit of bare) {
      if (port === "go") {
        blockSwitchFix = true;
        break;
      }
      // A C string table keeps each name NUL-terminated on both sides.
      const previous = hit.before.length
        ? hit.before[hit.before.length - 1]
        : 0;
      if (previous === 0 && hit.after.length && hit.after[0] === 0) {
        blockSwitchFix = true;
        break;
      }
    }
  }
  return { blockSwitchFix, port };
}

function endsWith(buffer, suffix) {
  return (
    buffer.length >= suffix.length &&
    buffer.subarray(buffer.length - suffix.length).equals(suffix)
  );
}

/**
 * Whether a hit for EXUBERANT_NIBBLE is the decoder's own error name. Two other
 * tables carry the same text without a C decoder beside them: the
 * BROTLI_DECODER_ERROR_FORMAT_* constant names that Node.js exposes through
 * zlib.constants (present even when Node links a shared libbrotlidec), and the
 * error strings of the Rust port, which spell the name `ERROR_FORMAT_...`
 * without the leading underscore the C decoder uses and which is not affected.
 * https://github.com/dropbox/rust-brotli-decompressor/blob/5.0.3/src/state.rs#L540
 *
 * @param {{before: Buffer}} hit marker hit with the bytes before it
 * @returns {boolean} true for the C decoder's or the Go port's error name
 */
function isDecoderErrorName(hit) {
  if (endsWith(hit.before, CONSTANT_PREFIX)) {
    return false;
  }
  if (endsWith(hit.before, RUST_PREFIX)) {
    const index = hit.before.length - RUST_PREFIX.length - 1;
    return index >= 0 && hit.before[index] === UNDERSCORE;
  }
  return true;
}
