// Bounded Go buildinfo reader for executable file components: recovers the
// toolchain version a binary was built with, so a BOM can answer "which Go
// programs predate the CVE-2026-111943 distrust list". Only the header and
// the inline version string are read; pointer-based (pre-1.18) layouts are
// reported as such and never followed.
//
// Layout: go/src/debug/buildinfo/buildinfo.go at tag go1.27.2. The 14-byte
// magic `\xff Go buildinf:` is 16-byte aligned; the next two bytes are the
// pointer size and flags. When flags&2 is set the version string follows as a
// uvarint length plus bytes. The magic can appear anywhere in the file's
// initial segment, so the search scans aligned offsets up to a cap.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const BUILD_INFO_MAGIC = Buffer.from([
  0xff, 0x20, 0x47, 0x6f, 0x20, 0x62, 0x75, 0x69, 0x6c, 0x64, 0x69, 0x6e, 0x66,
  0x3a,
]);
// The buildinfo section follows text and rodata, often late in the file
// (37 MB into a 40 MB gh binary), so the cap must cover large binaries.
const MAX_SEARCH_BYTES = 512 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_VERSION_BYTES = 128;
// The module-info string carries one line per dependency, so a binary with
// thousands of them holds tens of kilobytes; a megabyte is well past that and
// keeps a corrupted length field from pulling the file into memory.
const MAX_MODULE_INFO_BYTES = 1024 * 1024;
export const PRE_1_18_VERSION = "unknown-pre-1.18";

function readUvarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 10 && offset + i < buffer.length; i++) {
    const byte = buffer[offset + i];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) {
      return { value, next: offset + i + 1 };
    }
    shift += 7;
  }
  return undefined;
}

// parseHeaderAt returns what the inline (go1.18+) layout holds at one
// candidate offset: the version string and the buffer offset where the
// module-info string's uvarint length begins. `undefined` when the offset
// holds no header, and `pre118` for the pointer-based layout, whose pointers
// are never followed.
function parseHeaderAt(buffer, offset, limit) {
  if (offset + 32 > limit) {
    return undefined;
  }
  for (let i = 0; i < BUILD_INFO_MAGIC.length; i++) {
    if (buffer[offset + i] !== BUILD_INFO_MAGIC[i]) {
      return undefined;
    }
  }
  const pointerSize = buffer[offset + 14];
  const flags = buffer[offset + 15];
  if (pointerSize !== 4 && pointerSize !== 8) {
    return undefined;
  }
  if (!(flags & 0x02)) {
    // Version lives behind pointers (pre-1.18 layout): not followed.
    return { pre118: true };
  }
  // The inline strings start 16 bytes past the magic header (magic 14 +
  // pointerSize 1 + flags 1, then a reserved 16-byte slot), as a uvarint
  // length followed by the bytes.
  const varint = readUvarint(buffer, offset + 32);
  if (
    !varint ||
    varint.value === 0 ||
    varint.value > MAX_VERSION_BYTES ||
    varint.next + varint.value > limit
  ) {
    return undefined;
  }
  const version = buffer.toString(
    "latin1",
    varint.next,
    varint.next + varint.value,
  );
  if (!/^go[0-9]/.test(version)) {
    return undefined;
  }
  return { version, moduleInfoOffset: varint.next + varint.value };
}

/**
 * Read the Go buildinfo of an executable: the toolchain version, and when
 * asked the module-info string that follows it in the inline (go1.18+)
 * layout.
 *
 * The module-info read is bounded like the version read: the length must fit
 * MAX_MODULE_INFO_BYTES and the bytes must lie inside the file, and pointers
 * are never followed. The module-info string keeps the 16-byte sentinels Go
 * wraps it in; parseGoBuildModuleSettings strips them.
 *
 * @param {string} filePath absolute path to a possible Go binary
 * @param {boolean} withModuleInfo whether to also read the module-info string
 * @returns {{version: string, moduleInfo: string|undefined}|undefined}
 *   `version` is `go1.x.y` or `unknown-pre-1.18`; undefined when the file
 *   carries no Go buildinfo. `moduleInfo` is undefined for pre-1.18 layouts
 *   and for files whose module-info string cannot be read whole.
 */
function readBuildInfo(filePath, withModuleInfo) {
  if (typeof filePath !== "string" || !filePath) {
    return undefined;
  }
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size < 32) {
      return undefined;
    }
    const searchLimit = Math.min(size, MAX_SEARCH_BYTES);
    // Each chunk examines the aligned offsets that start inside its 64 KiB
    // window, reading a fixed overlap past it so a header near the window
    // end is parsed whole; the next chunk starts at the next window.
    const OVERLAP_BYTES = 256;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES + OVERLAP_BYTES);
    for (
      let position = 0;
      position < searchLimit;
      position += READ_CHUNK_BYTES
    ) {
      const want = Math.min(READ_CHUNK_BYTES + OVERLAP_BYTES, size - position);
      const read = readSync(fd, chunk, 0, want, position);
      if (read < 32) {
        return undefined;
      }
      // position is a multiple of 16, so chunk offsets stay on the file's
      // 16-byte grid.
      for (
        let offset = 0;
        offset < READ_CHUNK_BYTES && offset + 32 <= read;
        offset += 16
      ) {
        const header = parseHeaderAt(chunk, offset, read);
        if (!header) {
          continue;
        }
        if (header.pre118) {
          return { version: PRE_1_18_VERSION, moduleInfo: undefined };
        }
        if (!withModuleInfo) {
          return { version: header.version, moduleInfo: undefined };
        }
        return {
          version: header.version,
          moduleInfo: readModuleInfoAt(
            fd,
            size,
            position + header.moduleInfoOffset,
          ),
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

// readModuleInfoAt reads the uvarint-prefixed module-info string at one file
// position. A length that is absurd or runs past the end of the file yields
// undefined rather than a truncated string: half the build settings would
// read as their absence.
function readModuleInfoAt(fd, size, position) {
  if (position < 0 || position >= size) {
    return undefined;
  }
  const lengths = Buffer.alloc(16);
  const read = readSync(fd, lengths, 0, lengths.length, position);
  if (read < 1) {
    return undefined;
  }
  // Read the uvarint from the byte array without Buffer helpers: a varint
  // longer than the bytes read is malformed anyway.
  let length = 0;
  let shift = 0;
  let next = position;
  for (let i = 0; i < read; i++) {
    const byte = lengths[i];
    length += (byte & 0x7f) * 2 ** shift;
    next += 1;
    if (!(byte & 0x80)) {
      break;
    }
    shift += 7;
    if (i === read - 1) {
      // The varint itself was cut short.
      return undefined;
    }
  }
  if (length === 0 || length > MAX_MODULE_INFO_BYTES || next + length > size) {
    return undefined;
  }
  const data = Buffer.alloc(length);
  const dataRead = readSync(fd, data, 0, length, next);
  if (dataRead !== length) {
    return undefined;
  }
  return data.toString("latin1");
}

/**
 * Read the Go toolchain version from an executable's buildinfo header.
 *
 * @param {string} filePath absolute path to a possible Go binary
 * @returns {string|undefined} `go1.x.y`, `unknown-pre-1.18` for old layouts,
 *   or undefined when the file carries no Go buildinfo
 */
export function readGoBuildVersion(filePath) {
  return readBuildInfo(filePath, false)?.version;
}

// The CGO_*FLAGS build settings whose names parseGoBuildModuleSettings
// reports when they are set to something. The values are flags for the host C
// compiler and never leave the binary.
const CGO_FLAG_SETTING = /^CGO_(CFLAGS|CPPFLAGS|CXXFLAGS|LDFLAGS)=$/;

/**
 * Read the build settings of a Go executable: the toolchain version plus the
 * settings its module-info `build` lines record. Everything here is provenance
 * about the build; flag values stay in the binary.
 *
 * @param {string} filePath absolute path to a possible Go binary
 * @returns {{buildVersion: string, cgoEnabled: boolean|undefined, cgoEnvFlagNames: string[], trimpath: boolean, buildmode: string|undefined}|undefined}
 *   undefined when the file carries no Go buildinfo; `cgoEnabled` is
 *   undefined when the binary records no CGO_ENABLED line
 */
export function readGoBuildSettings(filePath) {
  const info = readBuildInfo(filePath, true);
  if (!info) {
    return undefined;
  }
  const settings = parseGoBuildModuleSettings(info.moduleInfo);
  return { buildVersion: info.version, ...settings };
}

/**
 * Parse the `build` settings out of a module-info string.
 *
 * The module-info text holds one tab-separated record per line: the module
 * path, the main module, each dependency, and then the build settings Go
 * records at link time (`CGO_ENABLED=1`, `-buildmode=exe`, `-trimpath`,
 * `-ldflags=...`, the `CGO_*FLAGS` values, absent when `-trimpath` was used).
 * Only settings a report may carry are returned: the CGO_*FLAGS values are
 * flags for the host C compiler, so their names alone are reported, and
 * `-ldflags` is dropped for the same reason.
 *
 * @param {string|undefined} moduleInfo raw module-info string with the
 *   16-byte sentinels Go wraps it in, or undefined
 * @returns {{cgoEnabled: boolean|undefined, cgoEnvFlagNames: string[], trimpath: boolean, buildmode: string|undefined}}
 */
export function parseGoBuildModuleSettings(moduleInfo) {
  const settings = {
    cgoEnabled: undefined,
    cgoEnvFlagNames: [],
    trimpath: false,
    buildmode: undefined,
  };
  if (typeof moduleInfo !== "string" || moduleInfo.length < 33) {
    return settings;
  }
  // debug/buildinfo strips the framing only when this exact shape holds.
  if (moduleInfo.charCodeAt(moduleInfo.length - 17) !== 10) {
    return settings;
  }
  const text = moduleInfo.slice(16, -16);
  for (const line of text.split("\n")) {
    if (!line.startsWith("build\t")) {
      continue;
    }
    const field = line.slice("build\t".length);
    if (field.startsWith("CGO_ENABLED=")) {
      const value = field.slice("CGO_ENABLED=".length);
      settings.cgoEnabled =
        value === "1" ? true : value === "0" ? false : undefined;
      continue;
    }
    if (field === "-trimpath") {
      settings.trimpath = true;
      continue;
    }
    if (field.startsWith("-buildmode=")) {
      settings.buildmode = field
        .slice("-buildmode=".length)
        .replace(/^"|"$/g, "");
      continue;
    }
    const equals = field.indexOf("=");
    if (equals > 0 && CGO_FLAG_SETTING.test(`${field.slice(0, equals + 1)}`)) {
      if (field.slice(equals + 1).length > 0) {
        settings.cgoEnvFlagNames.push(field.slice(0, equals));
      }
    }
  }
  settings.cgoEnvFlagNames.sort();
  return settings;
}
