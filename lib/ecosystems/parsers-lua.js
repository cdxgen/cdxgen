import { readFileSync } from "node:fs";

import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Lua parser for rockspecs and `luarocks.lock`.
 *
 * A rockspec is a Lua source file whose top level is a sequence of
 * assignments describing one package: its name, version, source, and a
 * `dependencies` table of constraint strings (`"lua >= 5.1"`). LuaRocks 3
 * can also persist the resolved set to `luarocks.lock`. Both are read with a
 * small line scanner over the shapes these files actually use, rather than a
 * Lua interpreter.
 *
 * Rocks are identified with the registered `luarocks` purl type
 * (`pkg:luarocks/<name>@<version>`). Lua versions carry a rock revision
 * suffix (`5.4.6-1`); the full rock version is kept verbatim because the
 * revision distinguishes distinct builds.
 */

/**
 * Parse a rockspec manifest.
 *
 * @param {string} rockspecFile Path to the `.rockspec` file
 * @returns {{ pkgList: object[], parentComponent: object }}
 */
export function parseRockspecFile(rockspecFile) {
  const fields = readLuaAssignments(rockspecFile);
  const name = fields.get("package");
  const version = fields.get("version");
  const declaredDeps = fields.get("dependencies");

  const parentComponent = {};
  if (name) {
    parentComponent.type = "application";
    parentComponent.name = name;
    if (version) {
      parentComponent.version = version;
    }
    parentComponent.description = `Lua rockspec: ${name}`;
    parentComponent.properties = [
      { name: "internal:SrcFile", value: rockspecFile },
    ];
  }

  const directNames = new Set(
    Array.isArray(declaredDeps) ? declaredDeps.map((dep) => dep.name) : [],
  );
  const pkgList = [...directNames].map((depName) =>
    luaPackage(depName, undefined, { direct: true, srcFile: rockspecFile }),
  );
  return { pkgList, parentComponent };
}

/**
 * Parse a `luarocks.lock` file.
 *
 * @param {string} lockFile Path to `luarocks.lock`
 * @param {string|string[]} [rockspecFile] Path to the rockspec, or to every
 *   rockspec sharing the lock, to mark direct deps
 * @returns {{ pkgList: object[], parentComponent: object }}
 */
export function parseLuaRocksLock(lockFile, rockspecFile) {
  const fields = readLuaAssignments(lockFile);
  const locked = fields.get("dependencies");
  if (!Array.isArray(locked)) {
    return { pkgList: [], parentComponent: {} };
  }
  const rockspecFiles = [].concat(rockspecFile ?? []);
  const directNames = new Set();
  for (const specFile of rockspecFiles) {
    const declared = readLuaAssignments(specFile).get("dependencies");
    if (Array.isArray(declared)) {
      for (const dep of declared) {
        if (typeof dep?.name === "string") {
          directNames.add(dep.name);
        }
      }
    }
  }
  const pkgList = locked
    .filter((dep) => typeof dep?.name === "string" && dep.name)
    .map((dep) =>
      luaPackage(dep.name, dep.version, {
        // Without a rockspec there is no declared set to compare against, so
        // the whole closure is reported direct rather than guessing.
        direct: rockspecFiles.length ? directNames.has(dep.name) : true,
        srcFile: lockFile,
      }),
    );
  return { pkgList, parentComponent: {} };
}

/**
 * Build a component-like package record for a Lua rock.
 *
 * @param {string} name Rock name
 * @param {string|undefined} version Rock version including revision suffix
 * @param {object} opts Extra context (`direct`, `srcFile`)
 * @returns {object} Package record
 */
function luaPackage(name, version, opts) {
  const purl = tryBuildPurl({
    type: "luarocks",
    name,
    version: version || undefined,
  });
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    {
      name: "cdx:luarocks:dependency",
      value: opts.direct ? "direct" : "transitive",
    },
  ];
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    properties,
  };
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${name}:${version || ""}`;
  }
  return pkg;
}

/**
 * Read the top-level assignments of a Lua configuration file.
 *
 * The files cdxgen consumes use a constrained surface: `key = value` lines
 * where the value is a quoted string, a table of strings or
 * `["key"] = "value"` entries, or a short list expression. Values are
 * normalised to strings, arrays of `{name, constraint}` records, or arrays
 * of `{key, value}` records for mixed tables.
 *
 * @param {string} filePath File to read
 * @returns {Map<string, *>} Parsed top-level fields
 */
export function readLuaAssignments(filePath) {
  const fields = new Map();
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${filePath}: ${error.message}`);
    return fields;
  }
  let currentTable;
  let depth = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--") || line.startsWith("#")) {
      continue;
    }
    if (depth === 0) {
      const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
      if (!assignment) {
        continue;
      }
      const [, key, rest] = assignment;
      const stringValue = rest.match(/^"([^"]*)"/u);
      if (stringValue) {
        fields.set(key, stringValue[1]);
        continue;
      }
      if (rest.startsWith("{")) {
        currentTable = [];
        fields.set(key, currentTable);
        depth = countBraces(rest, 0);
      }
      continue;
    }
    // Inside a table: collect string items, `key = "value"` pairs, and the
    // bracketed `["key"] = "value"` form LuaRocks uses for names that are not
    // valid Lua identifiers.
    depth = countBraces(line, depth);
    const keyed = line.match(
      /^(?:\[\s*"([^"]+)"\s*\]|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*"([^"]*)"/u,
    );
    if (keyed && currentTable) {
      currentTable.push({ name: keyed[1] ?? keyed[2], version: keyed[3] });
      continue;
    }
    const item = line.match(/^"([^"]+)"/u);
    if (item && currentTable) {
      const tokens = item[1].split(/\s+/u);
      currentTable.push({
        name: tokens[0],
        constraint: tokens.slice(1).join(" "),
      });
    }
    if (depth <= 0) {
      depth = 0;
    }
  }
  return fields;
}

/**
 * Track table nesting depth for one line.
 *
 * @param {string} line Line to scan
 * @param {number} depth Depth before the line
 * @returns {number} Depth after the line
 */
function countBraces(line, depth) {
  let next = depth;
  for (const char of line) {
    if (char === "{") {
      next += 1;
    } else if (char === "}") {
      next -= 1;
    }
  }
  return next;
}
