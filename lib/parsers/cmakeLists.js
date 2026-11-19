/**
 * Pure parser for CMake language files (`CMakeLists.txt`, `*.cmake`).
 *
 * `parseCmakeCommands` splits a file into command invocations the way CMake
 * reads it: command names are case-insensitive, an invocation may span several
 * lines, and arguments may be quoted, bracketed (`[[...]]`) or interleaved with
 * comments. `cmakeFetchDependencies` reads the commands that download a
 * dependency at configure time: `FetchContent_Declare`, `ExternalProject_Add`
 * and the CPM.cmake `CPMAddPackage` family.
 *
 * This module is layer 1 (text in, data out): no filesystem or subprocess
 * access. `lib/ecosystems/parsers-misc.js` turns the facts into components.
 */

/**
 * Length of the bracket opener (`[[`, `[=[`, `[==[`, ...) at `text[start]`, or 0.
 *
 * @param {string} text CMake source
 * @param {number} start Index of a `[`
 * @returns {number} Opener length including both brackets, or 0
 */
function bracketOpenLength(text, start) {
  if (text[start] !== "[") {
    return 0;
  }
  let i = start + 1;
  while (text[i] === "=") {
    i++;
  }
  return text[i] === "[" ? i - start + 1 : 0;
}

/**
 * Index just past the bracket closer matching an opener of `openLength`.
 *
 * @param {string} text CMake source
 * @param {number} contentStart First index after the opener
 * @param {number} openLength Opener length (`[==[` is 4)
 * @returns {number} Index after the closer, or the text length when unclosed
 */
function bracketCloseEnd(text, contentStart, openLength) {
  const closer = `]${"=".repeat(openLength - 2)}]`;
  const end = text.indexOf(closer, contentStart);
  return end === -1 ? text.length : end + closer.length;
}

/**
 * Index of the end of the comment starting at `text[start]` (a `#`).
 *
 * @param {string} text CMake source
 * @param {number} start Index of the `#`
 * @returns {number} Index of the first character after the comment
 */
function skipComment(text, start) {
  const openLength = bracketOpenLength(text, start + 1);
  if (openLength) {
    return bracketCloseEnd(text, start + 1 + openLength, openLength);
  }
  const eol = text.indexOf("\n", start);
  return eol === -1 ? text.length : eol;
}

function isIdentifierStart(c) {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}

function isIdentifierPart(c) {
  return isIdentifierStart(c) || (c >= "0" && c <= "9");
}

function isSpace(c) {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

/**
 * Split CMake source into command invocations.
 *
 * @param {string} text Contents of a CMake file
 * @returns {{name: string, args: string[], line: number}[]} Invocations in
 *   source order. `name` is lower-cased; `args` have their quotes and bracket
 *   delimiters removed; `line` is the 1-based line of the command name.
 */
export function parseCmakeCommands(text) {
  const commands = [];
  if (!text || typeof text !== "string") {
    return commands;
  }
  let line = 1;
  let i = 0;
  const advanceTo = (end) => {
    for (let k = i; k < end; k++) {
      if (text[k] === "\n") {
        line++;
      }
    }
    i = end;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      advanceTo(skipComment(text, i));
      continue;
    }
    if (!isIdentifierStart(c) || (i > 0 && isIdentifierPart(text[i - 1]))) {
      advanceTo(i + 1);
      continue;
    }
    let end = i;
    while (end < text.length && isIdentifierPart(text[end])) {
      end++;
    }
    const name = text.slice(i, end).toLowerCase();
    const commandLine = line;
    let open = end;
    while (text[open] === " " || text[open] === "\t") {
      open++;
    }
    if (text[open] !== "(") {
      advanceTo(end);
      continue;
    }
    advanceTo(open + 1);
    const args = [];
    let depth = 1;
    let current = "";
    let hasToken = false;
    const flush = () => {
      if (hasToken) {
        args.push(current);
      }
      current = "";
      hasToken = false;
    };
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "#") {
        flush();
        advanceTo(skipComment(text, i));
        continue;
      }
      if (ch === '"') {
        let k = i + 1;
        let value = "";
        while (k < text.length && text[k] !== '"') {
          if (text[k] === "\\" && k + 1 < text.length) {
            value += text[k + 1];
            k += 2;
            continue;
          }
          value += text[k];
          k++;
        }
        current += value;
        hasToken = true;
        advanceTo(Math.min(k + 1, text.length));
        continue;
      }
      const openLength = bracketOpenLength(text, i);
      if (openLength && !hasToken) {
        const contentStart = i + openLength;
        const closeEnd = bracketCloseEnd(text, contentStart, openLength);
        const contentEnd = Math.max(contentStart, closeEnd - openLength);
        current += text.slice(contentStart, contentEnd);
        hasToken = true;
        advanceTo(closeEnd);
        continue;
      }
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          flush();
          advanceTo(i + 1);
          break;
        }
      }
      if (isSpace(ch)) {
        flush();
      } else {
        current += ch;
        hasToken = true;
      }
      advanceTo(i + 1);
    }
    commands.push({ name, args, line: commandLine });
  }
  return commands;
}

// Upper bound on an expanded value; a set() chain that doubles a variable can
// otherwise grow it beyond the maximum string length.
const MAX_EXPANDED_LENGTH = 65536;

/**
 * Replace `${VAR}` references with the values of simple `set()` calls. A
 * reference to an unknown variable is left in place, so callers can tell a
 * resolved value from an unresolved one. Expansion stops at the previous
 * round once the text would exceed `maxLength`, 64 KiB by default.
 *
 * @param {string} value Argument text
 * @param {Map<string,string>} variables Known variable values
 * @param {number} [maxLength] Upper bound on the expanded text
 * @returns {string} The expanded text
 */
export function expandCmakeVariables(
  value,
  variables,
  maxLength = MAX_EXPANDED_LENGTH,
) {
  let result = value;
  for (let round = 0; round < 5 && result.includes("${"); round++) {
    let next = "";
    let i = 0;
    while (i < result.length) {
      if (next.length > maxLength) {
        return result;
      }
      const start = result.indexOf("${", i);
      if (start === -1) {
        next += result.slice(i);
        break;
      }
      const end = result.indexOf("}", start + 2);
      if (end === -1) {
        next += result.slice(i);
        break;
      }
      const key = result.slice(start + 2, end);
      next += result.slice(i, start);
      next += variables.has(key)
        ? variables.get(key)
        : result.slice(start, end + 1);
      i = end + 1;
    }
    if (next === result || next.length > maxLength) {
      break;
    }
    result = next;
  }
  return result;
}

/**
 * The variables a file sets to a single value: `set(FOO_VERSION 1.2.3)` and
 * `set(FOO_VERSION "1.2.3" CACHE STRING "...")`. Later definitions win.
 *
 * @param {{name: string, args: string[]}[]} commands Parsed commands
 * @returns {Map<string,string>} Variable values
 */
export function cmakeSetVariables(commands) {
  const variables = new Map();
  for (const command of commands) {
    if (command.name !== "set" || command.args.length < 2) {
      continue;
    }
    const [key, value, ...rest] = command.args;
    if (
      rest.length === 0 ||
      rest[0] === "CACHE" ||
      rest[0] === "PARENT_SCOPE"
    ) {
      // An appending set(FOO "${FOO} ...") of an undefined FOO starts from an
      // empty value in CMake; dropping the self-reference also keeps it from
      // being substituted into itself on every later expansion round.
      variables.set(
        key,
        expandCmakeVariables(value, variables).replaceAll(`\${${key}}`, ""),
      );
    }
  }
  return variables;
}

/**
 * The value following `keyword` in a keyword-style argument list, skipping the
 * leading positional arguments.
 *
 * @param {string[]} args Command arguments
 * @param {string} keyword Keyword to look up, e.g. `GIT_TAG`
 * @param {number} from First index that may hold a keyword
 * @returns {string|undefined} The value, or undefined when absent
 */
function keywordValue(args, keyword, from) {
  for (let i = from; i < args.length - 1; i++) {
    if (args[i] === keyword) {
      return args[i + 1];
    }
  }
  return undefined;
}

const HOST_SHORTHANDS = {
  gh: "https://github.com/",
  gl: "https://gitlab.com/",
  bb: "https://bitbucket.org/",
};

/**
 * Read a CPM.cmake shorthand such as `gh:fmtlib/fmt#7.1.3`,
 * `gh:nlohmann/json@3.11.2` or `https://example.com/x.git@1.0#v1.0`.
 *
 * @param {string} spec The single CPMAddPackage argument
 * @returns {{name: string, gitRepository?: string, url?: string, gitTag?: string, version?: string}|undefined}
 */
function parseCpmShorthand(spec) {
  let rest = spec;
  let gitTag;
  let version;
  const hash = rest.lastIndexOf("#");
  if (hash !== -1) {
    gitTag = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const colon = rest.indexOf(":");
  const scheme = colon === -1 ? "" : rest.slice(0, colon);
  let repository;
  if (HOST_SHORTHANDS[scheme]) {
    let path = rest.slice(colon + 1);
    const at = path.lastIndexOf("@");
    if (at !== -1) {
      version = path.slice(at + 1);
      path = path.slice(0, at);
    }
    repository = `${HOST_SHORTHANDS[scheme]}${path}`;
  } else if (scheme === "https" || scheme === "http") {
    const lastSlash = rest.lastIndexOf("/");
    const at = rest.lastIndexOf("@");
    if (at > lastSlash) {
      version = rest.slice(at + 1);
      rest = rest.slice(0, at);
    }
    repository = rest;
  } else {
    return undefined;
  }
  const name = repository
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/, "");
  if (!name) {
    return undefined;
  }
  return {
    name,
    gitRepository: repository,
    gitTag: gitTag || (version ? `v${version}` : undefined),
    version,
  };
}

/**
 * The dependencies a CMake file downloads at configure time.
 *
 * `FetchContent_Declare(<name> ...)` and `ExternalProject_Add(<name> ...)` are
 * read for `GIT_REPOSITORY`/`GIT_TAG` and `URL`/`URL_HASH`/`URL_MD5`.
 * `CPMAddPackage`, `CPMFindPackage` and `CPMDeclarePackage` are read in both
 * the shorthand form and the keyword form (`NAME`, `VERSION`,
 * `GITHUB_REPOSITORY`, `GITLAB_REPOSITORY`, `BITBUCKET_REPOSITORY`,
 * `GIT_REPOSITORY`, `GIT_TAG`, `URL`, `URL_HASH`). `${VAR}` references are
 * expanded with the file's simple `set()` values; anything still unresolved
 * stays as written.
 *
 * @param {string} text Contents of a CMake file
 * @returns {{kind: string, name: string, line: number, gitRepository?: string, gitTag?: string, url?: string, urlHash?: string, version?: string, madeAvailable: boolean}[]}
 *   `kind` is `fetch`, `external-project` or `cpm`; `madeAvailable` is true
 *   when a `FetchContent_MakeAvailable` in the same file names the dependency.
 */
export function cmakeFetchDependencies(text) {
  const commands = parseCmakeCommands(text);
  const variables = cmakeSetVariables(commands);
  const expand = (value) =>
    value === undefined ? undefined : expandCmakeVariables(value, variables);
  const madeAvailable = new Set();
  for (const command of commands) {
    if (command.name === "fetchcontent_makeavailable") {
      for (const arg of command.args) {
        madeAvailable.add(expand(arg).toLowerCase());
      }
    }
  }
  const deps = [];
  for (const command of commands) {
    const args = command.args.map(expand);
    let dep;
    if (
      (command.name === "fetchcontent_declare" ||
        command.name === "externalproject_add") &&
      args.length
    ) {
      const url = keywordValue(args, "URL", 1);
      const md5 = keywordValue(args, "URL_MD5", 1);
      dep = {
        kind:
          command.name === "fetchcontent_declare"
            ? "fetch"
            : "external-project",
        name: args[0],
        gitRepository: keywordValue(args, "GIT_REPOSITORY", 1),
        gitTag: keywordValue(args, "GIT_TAG", 1),
        url: url?.split(";")[0],
        urlHash: keywordValue(args, "URL_HASH", 1) || (md5 && `MD5=${md5}`),
      };
    } else if (
      command.name === "cpmaddpackage" ||
      command.name === "cpmfindpackage" ||
      command.name === "cpmdeclarepackage"
    ) {
      const positional = command.name === "cpmdeclarepackage" ? 1 : 0;
      if (args.length === positional + 1) {
        const shorthand = parseCpmShorthand(args[positional]);
        if (shorthand) {
          dep = {
            kind: "cpm",
            ...shorthand,
            name: positional ? args[0] : shorthand.name,
          };
        }
      } else if (args.length > positional) {
        const name = positional ? args[0] : keywordValue(args, "NAME", 0);
        const version = keywordValue(args, "VERSION", positional);
        const github = keywordValue(args, "GITHUB_REPOSITORY", positional);
        const gitlab = keywordValue(args, "GITLAB_REPOSITORY", positional);
        const bitbucket = keywordValue(
          args,
          "BITBUCKET_REPOSITORY",
          positional,
        );
        const hosted =
          (github && `${HOST_SHORTHANDS.gh}${github}`) ||
          (gitlab && `${HOST_SHORTHANDS.gl}${gitlab}`) ||
          (bitbucket && `${HOST_SHORTHANDS.bb}${bitbucket}`);
        const gitRepository =
          hosted || keywordValue(args, "GIT_REPOSITORY", positional);
        const url = keywordValue(args, "URL", positional);
        const derivedName =
          name ||
          (gitRepository || url)
            ?.split("/")
            .filter(Boolean)
            .pop()
            ?.replace(/\.git$/, "");
        if (derivedName) {
          dep = {
            kind: "cpm",
            name: derivedName,
            gitRepository,
            gitTag:
              keywordValue(args, "GIT_TAG", positional) ||
              (gitRepository && version ? `v${version}` : undefined),
            url,
            urlHash: keywordValue(args, "URL_HASH", positional),
            version,
          };
        }
      }
    }
    if (dep?.name) {
      for (const key of Object.keys(dep)) {
        if (dep[key] === undefined || dep[key] === "") {
          delete dep[key];
        }
      }
      dep.line = command.line;
      dep.madeAvailable = madeAvailable.has(dep.name.toLowerCase());
      deps.push(dep);
    }
  }
  return deps;
}
