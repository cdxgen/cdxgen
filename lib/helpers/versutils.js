function parseVersion(v) {
  const m = v.match(/^([><=^~]+)?(.*)$/);
  const ver = m ? m[2] : v;
  if (ver === "*")
    return { major: 0, minor: 0, patch: 0, pre: "", op: "", isStar: true };
  const parts = ver.split("-");
  const main = parts[0].split(".");
  return {
    op: m ? m[1] || "" : "",
    major: Number.parseInt(main[0] || "0", 10),
    minor: Number.parseInt(main[1] || "0", 10),
    patch: Number.parseInt(main[2] || "0", 10),
    pre: parts.slice(1).join("-"),
  };
}

/**
 * Converts a package.json npm version specifier to a VERS format range.
 *
 * @param {string} versionString - The native npm semver string.
 * @returns {string} The formatted vers:npm range string.
 */
export function toVersRange(versionString) {
  if (!versionString || typeof versionString !== "string") {
    return "";
  }
  let str = versionString.trim();
  if (!str) {
    return "";
  }
  if (str === "latest" || str.startsWith("workspace:")) {
    return "";
  }
  if (str === "*") {
    return "vers:npm/*";
  }
  // Replace hyphen ranges: A - B -> >=A <=B
  str = str.replace(/([\w.-]+)\s+-\s+([\w.-]+)/g, ">= $1 <= $2");

  // Split logical ORs
  const ors = str.split("||").map((s) => s.trim());
  const allBounds = [];

  for (let part of ors) {
    // Normalize spaces after operators to attach them to the version
    part = part.replace(/([><=^~]+)\s+/g, "$1");
    part = part.replace(/\s+/g, " ");

    const tokens = part.split(" ").filter(Boolean);

    for (let token of tokens) {
      // Strip the 'v' prefix if present (e.g. >=v1.2.3 -> >=1.2.3)
      token = token.replace(/^([><=^~]+)?v/i, (_match, op) => op || "");

      if (token === "*") {
        allBounds.push("*");
        continue;
      }

      const match = token.match(/^([><=^~]+)?(.*)$/);
      const op = match[1] || "";
      let ver = match[2];

      if (ver === "*") {
        allBounds.push("*");
        continue;
      }

      // Pad versions (e.g., '1' -> '1.0.0', '1.1' -> '1.1.0')
      if (/^\d+$/.test(ver)) {
        ver += ".0.0";
      } else if (/^\d+\.\d+$/.test(ver)) {
        ver += ".0";
      }

      // Handle .x or .* ranges
      if (ver.endsWith(".x") || ver.endsWith(".*")) {
        const parts = ver.split(".");
        if (parts[1] === "x" || parts[1] === "*") {
          const M = Number.parseInt(parts[0], 10);
          allBounds.push(`>=${M}.0.0`, `<${M + 1}.0.0`);
        } else if (parts[2] === "x" || parts[2] === "*") {
          const M = parts[0];
          const m_minor = Number.parseInt(parts[1], 10);
          allBounds.push(`>=${M}.${m_minor}.0`, `<${M}.${m_minor + 1}.0`);
        }
        continue;
      }

      // Caret (^) expansion
      if (op === "^") {
        const m = ver.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
        if (!m) {
          allBounds.push(`${op}${ver}`);
          continue;
        }
        const M = Number.parseInt(m[1], 10);
        const m_minor = Number.parseInt(m[2], 10);
        const p = Number.parseInt(m[3], 10);
        let upper;
        if (M > 0) {
          upper = `${M + 1}.0.0`;
        } else if (m_minor > 0) {
          upper = `0.${m_minor + 1}.0`;
        } else {
          upper = `0.0.${p + 1}`;
        }
        allBounds.push(`>=${ver}`, `<${upper}`);
        continue;
      }

      // Tilde (~) expansion
      if (op === "~") {
        const m = ver.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
        if (!m) {
          allBounds.push(`${op}${ver}`);
          continue;
        }
        if (ver.includes("-pre")) {
          const sv = parseVersion(ver);
          const upper = `${sv.major}.${sv.minor}.0`;
          const upper_1 = `${sv.major}.${sv.minor}.1`;
          allBounds.push(`>=${ver}`, `<${upper}`, `>=${upper}`, `<${upper_1}`);
          continue;
        }
        const M = Number.parseInt(m[1], 10);
        const m_minor = Number.parseInt(m[2], 10);
        const upper = `${M}.${m_minor + 1}.0`;
        allBounds.push(`>=${ver}`, `<${upper}`);
        continue;
      }

      if (op === "=") {
        allBounds.push(ver);
        continue;
      }

      // Exact fallback matches
      if (op === "") {
        allBounds.push(ver);
        continue;
      }

      allBounds.push(op + ver);
    }
  }

  // Sort all bounded intervals linearly mapped by semver precedence
  allBounds.sort((aStr, bStr) => {
    if (aStr === "*" && bStr === "*") return 0;
    if (aStr === "*") return -1;
    if (bStr === "*") return 1;

    const a = parseVersion(aStr);
    const b = parseVersion(bStr);

    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;

    if (a.pre && !b.pre) return -1;
    if (!a.pre && b.pre) return 1;

    if (a.pre && b.pre) {
      if (a.pre !== b.pre) {
        const aPre = a.pre.split(".");
        const bPre = b.pre.split(".");
        for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
          const ap = aPre[i];
          const bp = bPre[i];

          if (ap === undefined) return -1;
          if (bp === undefined) return 1;

          const apNum = /^\d+$/.test(ap);
          const bpNum = /^\d+$/.test(bp);

          if (apNum && bpNum) {
            const diff = Number.parseInt(ap, 10) - Number.parseInt(bp, 10);
            if (diff !== 0) return diff;
          } else if (apNum && !bpNum) {
            return -1;
          } else if (!apNum && bpNum) {
            return 1;
          } else {
            if (ap < bp) return -1;
            if (ap > bp) return 1;
          }
        }
      }
    }

    const opOrder = { "<": 1, "<=": 2, "": 3, ">=": 4, ">": 5 };
    const aOp = opOrder[a.op] || 3;
    const bOp = opOrder[b.op] || 3;
    if (aOp !== bOp) return aOp - bOp;

    return 0;
  });

  return `vers:npm/${allBounds.join("|")}`;
}
