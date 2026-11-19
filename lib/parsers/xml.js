/**
 * Non-validating XML parser for the manifest formats cdxgen reads: Maven poms,
 * NuGet nuspec and packages.config, MSBuild project and props files, VSIX
 * manifests and Apple plists.
 *
 * Namespace prefixes are kept verbatim in element and attribute names rather
 * than resolved, so `<PackageManifest:Metadata>` stays under that literal key.
 * Doctypes are recorded but never interpreted: no internal subset is read and
 * no external entity is fetched, so a declared entity reference is an unknown
 * entity and is rejected like any other.
 */

/**
 * Named character entities resolved without a declaration: the five XML
 * built-ins plus the HTML set, which Maven poms in the wild rely on for
 * accented author names such as `Laugst&oslash;l`.
 */
const NAMED_ENTITIES = {
  AElig: "\u00c6",
  Aacute: "\u00c1",
  Acirc: "\u00c2",
  Agrave: "\u00c0",
  Alpha: "\u0391",
  Aring: "\u00c5",
  Atilde: "\u00c3",
  Auml: "\u00c4",
  Beta: "\u0392",
  Ccedil: "\u00c7",
  Chi: "\u03a7",
  Dagger: "\u2021",
  Delta: "\u0394",
  ETH: "\u00d0",
  Eacute: "\u00c9",
  Ecirc: "\u00ca",
  Egrave: "\u00c8",
  Epsilon: "\u0395",
  Eta: "\u0397",
  Euml: "\u00cb",
  Gamma: "\u0393",
  Iacute: "\u00cd",
  Icirc: "\u00ce",
  Igrave: "\u00cc",
  Iota: "\u0399",
  Iuml: "\u00cf",
  Kappa: "\u039a",
  Lambda: "\u039b",
  Mu: "\u039c",
  Ntilde: "\u00d1",
  Nu: "\u039d",
  OElig: "\u0152",
  Oacute: "\u00d3",
  Ocirc: "\u00d4",
  Ograve: "\u00d2",
  Omega: "\u03a9",
  Omicron: "\u039f",
  Oslash: "\u00d8",
  Otilde: "\u00d5",
  Ouml: "\u00d6",
  Phi: "\u03a6",
  Pi: "\u03a0",
  Prime: "\u2033",
  Psi: "\u03a8",
  Rho: "\u03a1",
  Scaron: "\u0160",
  Sigma: "\u03a3",
  THORN: "\u00de",
  Tau: "\u03a4",
  Theta: "\u0398",
  Uacute: "\u00da",
  Ucirc: "\u00db",
  Ugrave: "\u00d9",
  Upsilon: "\u03a5",
  Uuml: "\u00dc",
  Xi: "\u039e",
  Yacute: "\u00dd",
  Yuml: "\u0178",
  Zeta: "\u0396",
  aacute: "\u00e1",
  acirc: "\u00e2",
  acute: "\u00b4",
  aelig: "\u00e6",
  agrave: "\u00e0",
  alefsym: "\u2135",
  alpha: "\u03b1",
  amp: "&",
  and: "\u2227",
  ang: "\u2220",
  apos: "'",
  aring: "\u00e5",
  asymp: "\u2248",
  atilde: "\u00e3",
  auml: "\u00e4",
  bdquo: "\u201e",
  beta: "\u03b2",
  brvbar: "\u00a6",
  bull: "\u2022",
  cap: "\u2229",
  ccedil: "\u00e7",
  cedil: "\u00b8",
  cent: "\u00a2",
  chi: "\u03c7",
  circ: "\u02c6",
  clubs: "\u2663",
  cong: "\u2245",
  copy: "\u00a9",
  crarr: "\u21b5",
  cup: "\u222a",
  curren: "\u00a4",
  dArr: "\u21d3",
  dagger: "\u2020",
  darr: "\u2193",
  deg: "\u00b0",
  delta: "\u03b4",
  diams: "\u2666",
  divide: "\u00f7",
  eacute: "\u00e9",
  ecirc: "\u00ea",
  egrave: "\u00e8",
  empty: "\u2205",
  emsp: "\u2003",
  ensp: "\u2002",
  epsilon: "\u03b5",
  equiv: "\u2261",
  eta: "\u03b7",
  eth: "\u00f0",
  euml: "\u00eb",
  euro: "\u20ac",
  exist: "\u2203",
  fnof: "\u0192",
  forall: "\u2200",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  frasl: "\u2044",
  gamma: "\u03b3",
  ge: "\u2265",
  gt: ">",
  hArr: "\u21d4",
  harr: "\u2194",
  hearts: "\u2665",
  hellip: "\u2026",
  iacute: "\u00ed",
  icirc: "\u00ee",
  iexcl: "\u00a1",
  igrave: "\u00ec",
  image: "\u2111",
  infin: "\u221e",
  int: "\u222b",
  iota: "\u03b9",
  iquest: "\u00bf",
  isin: "\u2208",
  iuml: "\u00ef",
  kappa: "\u03ba",
  lArr: "\u21d0",
  lambda: "\u03bb",
  lang: "\u2329",
  laquo: "\u00ab",
  larr: "\u2190",
  lceil: "\u2308",
  ldquo: "\u201c",
  le: "\u2264",
  lfloor: "\u230a",
  lowast: "\u2217",
  loz: "\u25ca",
  lrm: "\u200e",
  lsaquo: "\u2039",
  lsquo: "\u2018",
  lt: "<",
  macr: "\u00af",
  mdash: "\u2014",
  micro: "\u00b5",
  middot: "\u00b7",
  minus: "\u2212",
  mu: "\u03bc",
  nabla: "\u2207",
  nbsp: "\u00a0",
  ndash: "\u2013",
  ne: "\u2260",
  ni: "\u220b",
  not: "\u00ac",
  notin: "\u2209",
  nsub: "\u2284",
  ntilde: "\u00f1",
  nu: "\u03bd",
  oacute: "\u00f3",
  ocirc: "\u00f4",
  oelig: "\u0153",
  ograve: "\u00f2",
  oline: "\u203e",
  omega: "\u03c9",
  omicron: "\u03bf",
  oplus: "\u2295",
  or: "\u2228",
  ordf: "\u00aa",
  ordm: "\u00ba",
  oslash: "\u00f8",
  otilde: "\u00f5",
  otimes: "\u2297",
  ouml: "\u00f6",
  para: "\u00b6",
  part: "\u2202",
  permil: "\u2030",
  perp: "\u22a5",
  phi: "\u03c6",
  pi: "\u03c0",
  piv: "\u03d6",
  plusmn: "\u00b1",
  pound: "\u00a3",
  prime: "\u2032",
  prod: "\u220f",
  prop: "\u221d",
  psi: "\u03c8",
  quot: '"',
  rArr: "\u21d2",
  radic: "\u221a",
  rang: "\u232a",
  raquo: "\u00bb",
  rarr: "\u2192",
  rceil: "\u2309",
  rdquo: "\u201d",
  real: "\u211c",
  reg: "\u00ae",
  rfloor: "\u230b",
  rho: "\u03c1",
  rlm: "\u200f",
  rsaquo: "\u203a",
  rsquo: "\u2019",
  sbquo: "\u201a",
  scaron: "\u0161",
  sdot: "\u22c5",
  sect: "\u00a7",
  shy: "\u00ad",
  sigma: "\u03c3",
  sigmaf: "\u03c2",
  sim: "\u223c",
  spades: "\u2660",
  sub: "\u2282",
  sube: "\u2286",
  sum: "\u2211",
  sup: "\u2283",
  sup1: "\u00b9",
  sup2: "\u00b2",
  sup3: "\u00b3",
  supe: "\u2287",
  szlig: "\u00df",
  tau: "\u03c4",
  there4: "\u2234",
  theta: "\u03b8",
  thetasym: "\u03d1",
  thinsp: "\u2009",
  thorn: "\u00fe",
  tilde: "\u02dc",
  times: "\u00d7",
  trade: "\u2122",
  uArr: "\u21d1",
  uacute: "\u00fa",
  uarr: "\u2191",
  ucirc: "\u00fb",
  ugrave: "\u00f9",
  uml: "\u00a8",
  upsih: "\u03d2",
  upsilon: "\u03c5",
  uuml: "\u00fc",
  weierp: "\u2118",
  xi: "\u03be",
  yacute: "\u00fd",
  yen: "\u00a5",
  yuml: "\u00ff",
  zeta: "\u03b6",
  zwj: "\u200d",
  zwnj: "\u200c",
};

const ENTITY_REGEX = /&(#x[0-9a-fA-F]+|#[0-9]+|[^;&<\s]*);/g;

/**
 * Resolve the character entities in a text run.
 *
 * @param {string} text Raw text, which may contain entity references
 *
 * @returns {string} Text with entity references replaced
 *
 * @throws {Error} When a reference names an entity that was never declared
 */
function decodeEntities(text) {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(ENTITY_REGEX, (_match, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (Number.isNaN(code)) {
        throw new Error("Invalid character entity");
      }
      return String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (Number.isNaN(code)) {
        throw new Error("Invalid character entity");
      }
      return String.fromCodePoint(code);
    }
    if (Object.hasOwn(NAMED_ENTITIES, body)) {
      return NAMED_ENTITIES[body];
    }
    throw new Error("Invalid character entity");
  });
}

/** Characters that may not begin an element or attribute name. */
const NAME_START = /[^\s"'<>/=]/;

/**
 * Nesting depth beyond which a document is refused.
 *
 * The tree is converted to objects by recursion, so unbounded nesting would
 * exhaust the stack. The deepest manifest observed across a corpus of Maven
 * poms, nuspecs and MSBuild targets nests 26 elements, so this ceiling is far
 * above any real document while keeping a hostile one from reaching the limit.
 */
const MAX_DEPTH = 1000;

/**
 * Read the attributes of a start tag.
 *
 * @param {string} source Full document
 * @param {number} start Offset of the first character after the element name
 * @param {number} end Offset of the closing angle bracket
 *
 * @returns {Object.<string, string>|undefined} Attribute map, or undefined when the tag declares none
 */
function readAttributes(source, start, end) {
  let attributes;
  let pos = start;
  while (pos < end) {
    while (pos < end && /\s/.test(source[pos])) {
      pos++;
    }
    if (pos >= end || !NAME_START.test(source[pos])) {
      break;
    }
    const nameStart = pos;
    while (pos < end && !/[\s=]/.test(source[pos])) {
      pos++;
    }
    const name = source.slice(nameStart, pos);
    while (pos < end && /\s/.test(source[pos])) {
      pos++;
    }
    let value = "";
    if (source[pos] === "=") {
      pos++;
      while (pos < end && /\s/.test(source[pos])) {
        pos++;
      }
      const quote = source[pos];
      if (quote === '"' || quote === "'") {
        pos++;
        const valueStart = pos;
        while (pos < end && source[pos] !== quote) {
          pos++;
        }
        value = decodeEntities(source.slice(valueStart, pos));
        pos++;
      } else {
        const valueStart = pos;
        while (pos < end && !/\s/.test(source[pos])) {
          pos++;
        }
        value = decodeEntities(source.slice(valueStart, pos));
      }
    }
    attributes ??= {};
    define(attributes, name, value);
  }
  return attributes;
}

/**
 * Split a processing instruction into its target and remaining body.
 *
 * @param {string} body Instruction content between `<?` and `?>`
 *
 * @returns {{target: string, content: string}} Instruction target and the text following it
 */
function splitInstruction(body) {
  const match = body.match(/^([^\s]+)\s*([\s\S]*)$/);
  return match
    ? { target: match[1], content: match[2] }
    : { target: body, content: "" };
}

/**
 * Parse a document into a tree of nodes.
 *
 * Each node is `{type}` plus the payload for that type: elements carry `name`,
 * optional `attributes` and optional `children`; text, cdata and comment nodes
 * carry `value`.
 *
 * @param {string} source XML document
 *
 * @returns {{roots: Array<object>, declaration: Object.<string, string>|undefined, doctype: string|undefined}} Parsed tree and prolog
 *
 * @throws {Error} When the document is not well formed
 */
function parseDocument(source) {
  const roots = [];
  const stack = [];
  let declaration;
  let doctype;
  let pos = 0;

  const push = (node) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      (parent.children ??= []).push(node);
    } else {
      // A licence header sits outside the root element in most poms, so
      // top-level comments are kept rather than discarded with the prolog.
      roots.push(node);
    }
  };

  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) {
      const tail = source.slice(pos);
      if (tail.trim()) {
        push({ type: "text", value: decodeEntities(tail) });
      }
      break;
    }
    if (lt > pos) {
      const text = source.slice(pos, lt);
      if (text.trim()) {
        push({ type: "text", value: decodeEntities(text) });
      }
    }

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) {
        throw new Error("Unclosed comment");
      }
      push({ type: "comment", value: source.slice(lt + 4, end) });
      pos = end + 3;
      continue;
    }

    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) {
        throw new Error("Unclosed CDATA section");
      }
      push({ type: "cdata", value: source.slice(lt + 9, end) });
      pos = end + 3;
      continue;
    }

    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end === -1) {
        throw new Error("Unclosed processing instruction");
      }
      const body = source.slice(lt + 2, end);
      const { target, content } = splitInstruction(body);
      if (target === "xml") {
        declaration = readAttributes(content, 0, content.length);
      } else {
        push({ type: "instruction", target, content });
      }
      pos = end + 2;
      continue;
    }

    if (source.startsWith("<!", lt)) {
      // A doctype may carry an internal subset in brackets, which can itself
      // contain angle brackets, so the closing bracket is found before the
      // closing angle bracket is looked for. Only a bracket ahead of the first
      // angle bracket opens a subset: the search is confined to that range, as
      // looking through the rest of the document would cost a full scan per
      // declaration.
      let scan = lt + 2;
      const firstGt = source.indexOf(">", scan);
      if (firstGt === -1) {
        throw new Error("Unclosed declaration");
      }
      const subset = source.slice(scan, firstGt).indexOf("[");
      if (subset !== -1) {
        const subsetEnd = source.indexOf("]", scan + subset);
        if (subsetEnd === -1) {
          throw new Error("Unclosed doctype subset");
        }
        scan = subsetEnd;
      }
      const end = source.indexOf(">", scan);
      if (end === -1) {
        throw new Error("Unclosed declaration");
      }
      const body = source.slice(lt + 2, end);
      if (/^DOCTYPE/i.test(body)) {
        doctype = body.replace(/^DOCTYPE\s*/i, "");
      }
      pos = end + 1;
      continue;
    }

    if (source.startsWith("</", lt)) {
      const end = source.indexOf(">", lt + 2);
      if (end === -1) {
        throw new Error("Unclosed end tag");
      }
      const name = source.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open) {
        throw new Error(`Unexpected close tag ${name}`);
      }
      if (open.name !== name) {
        throw new Error(`Unexpected close tag ${name}`);
      }
      pos = end + 1;
      continue;
    }

    let end = lt + 1;
    let quote;
    while (end < source.length) {
      const ch = source[end];
      if (quote) {
        if (ch === quote) {
          quote = undefined;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      end++;
    }
    if (end >= source.length) {
      throw new Error("Unclosed start tag");
    }
    const selfClosing = source[end - 1] === "/";
    const inner = end - (selfClosing ? 1 : 0);
    let nameEnd = lt + 1;
    while (nameEnd < inner && !/\s/.test(source[nameEnd])) {
      nameEnd++;
    }
    const name = source.slice(lt + 1, nameEnd);
    if (!name) {
      throw new Error("Malformed start tag");
    }
    const node = { type: "element", name };
    const attributes = readAttributes(source, nameEnd, inner);
    if (attributes) {
      node.attributes = attributes;
    }
    push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) {
        throw new Error(`Element nesting deeper than ${MAX_DEPTH}`);
      }
      stack.push(node);
    }
    pos = end + 1;
  }

  if (stack.length) {
    throw new Error(`Unclosed tag ${stack[stack.length - 1].name}`);
  }
  return { roots, declaration, doctype };
}

/**
 * Write an own, enumerable property.
 *
 * Element names come from the document, so a document may name an element
 * `__proto__`. Plain assignment would reach the prototype setter and lose the
 * value instead of recording it, so the property is always defined outright.
 *
 * @param {object} target Object being built
 * @param {string} key Key to write
 * @param {*} value Value to write
 */
function define(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Attach a value to a key, promoting the slot to an array once a second value
 * arrives so that repeated element names and repeated text runs both survive.
 *
 * @param {object} target Object being built
 * @param {string} key Key to write
 * @param {*} value Value to attach
 * @param {Boolean} alwaysArray Whether every slot is an array regardless of count
 */
function attach(target, key, value, alwaysArray) {
  if (alwaysArray) {
    if (!Object.hasOwn(target, key)) {
      define(target, key, []);
    }
    target[key].push(value);
    return;
  }
  if (!Object.hasOwn(target, key)) {
    define(target, key, value);
    return;
  }
  if (Array.isArray(target[key])) {
    target[key].push(value);
    return;
  }
  define(target, key, [target[key], value]);
}

/**
 * Present a text run, trimming it when the caller asked for trimmed text.
 *
 * @param {string} value Raw text, CDATA or comment content
 * @param {object} keys Resolved option keys
 *
 * @returns {string} Text to emit
 */
function present(value, keys) {
  return keys.trim ? value.trim() : value;
}

/**
 * Present an element's attributes, trimming the values when the caller asked
 * for trimmed text. MSBuild conditions are routinely padded for readability,
 * so the padding is noise rather than data.
 *
 * @param {Object.<string, string>} attributes Attribute map
 * @param {object} keys Resolved option keys
 *
 * @returns {Object.<string, string>} Attribute map to emit
 */
function presentAttributes(attributes, keys) {
  if (!keys.trim) {
    return attributes;
  }
  const out = {};
  for (const [name, value] of Object.entries(attributes)) {
    define(out, name, value.trim());
  }
  return out;
}

/**
 * Convert an element node into its compact-form object.
 *
 * @param {object} node Element node from {@link parseDocument}
 * @param {object} keys Resolved option keys
 *
 * @returns {object} Compact representation of the element
 */
function compactElement(node, keys) {
  const out = {};
  if (node.attributes) {
    out[keys.attributes] = presentAttributes(node.attributes, keys);
  }
  compactChildren(node.children, out, keys);
  return out;
}

/**
 * Add a list of nodes to a compact-form object.
 *
 * Shared by elements and by the document itself, so that a comment outside the
 * root element lands under the same key it would inside one.
 *
 * @param {Array<object>|undefined} children Nodes to add
 * @param {object} out Compact-form object being built
 * @param {object} keys Resolved option keys
 */
function compactChildren(children, out, keys) {
  for (const child of children || []) {
    switch (child.type) {
      case "element":
        attach(out, child.name, compactElement(child, keys), keys.alwaysArray);
        break;
      case "text":
        attach(out, keys.text, present(child.value, keys), keys.alwaysArray);
        break;
      case "cdata":
        if (!keys.ignoreCdata) {
          attach(out, keys.cdata, present(child.value, keys), keys.alwaysArray);
        }
        break;
      case "comment":
        if (!keys.ignoreComment) {
          attach(
            out,
            keys.comment,
            present(child.value, keys),
            keys.alwaysArray,
          );
        }
        break;
      case "instruction":
        if (!keys.ignoreInstruction) {
          attach(
            out,
            "_instruction",
            { [child.target]: child.content },
            keys.alwaysArray,
          );
        }
        break;
    }
  }
}

/**
 * Convert an element node into its verbose-form object.
 *
 * @param {object} node Element node from {@link parseDocument}
 * @param {object} keys Resolved option keys
 *
 * @returns {object} Verbose representation of the element
 */
function verboseElement(node, keys) {
  const out = { type: "element", name: node.name };
  if (node.attributes) {
    out.attributes = presentAttributes(node.attributes, keys);
  }
  const elements = verboseChildren(node.children, keys);
  if (elements.length) {
    out.elements = elements;
  }
  return out;
}

/**
 * Convert a list of nodes into verbose-form nodes.
 *
 * @param {Array<object>|undefined} children Nodes to convert
 * @param {object} keys Resolved option keys
 *
 * @returns {Array<object>} Verbose-form nodes
 */
function verboseChildren(children, keys) {
  const elements = [];
  for (const child of children || []) {
    switch (child.type) {
      case "element":
        elements.push(verboseElement(child, keys));
        break;
      case "text":
        elements.push({ type: "text", text: present(child.value, keys) });
        break;
      case "cdata":
        if (!keys.ignoreCdata) {
          elements.push({ type: "cdata", cdata: present(child.value, keys) });
        }
        break;
      case "comment":
        if (!keys.ignoreComment) {
          elements.push({
            type: "comment",
            comment: present(child.value, keys),
          });
        }
        break;
      case "instruction":
        if (!keys.ignoreInstruction) {
          elements.push({
            type: "instruction",
            name: child.target,
            instruction: child.content,
          });
        }
        break;
    }
  }
  return elements;
}

/**
 * Parse an XML document into a plain object.
 *
 * In compact form each element becomes a key on its parent, with text under
 * `textKey`, attributes under `attributesKey` and comments under `commentKey`;
 * a name that repeats becomes an array. In verbose form the document becomes a
 * list of typed nodes under `elements`.
 *
 * @param {string} source XML document
 * @param {object} [options] Parse options
 * @param {Boolean} [options.compact] Emit the compact form
 * @param {Boolean} [options.alwaysArray] Wrap every compact-form value in an array
 * @param {string} [options.textKey] Key holding element text
 * @param {string} [options.attributesKey] Key holding element attributes
 * @param {string} [options.commentKey] Key holding comment text
 * @param {string} [options.cdataKey] Key holding CDATA text
 * @param {Boolean} [options.ignoreComment] Drop comments
 * @param {Boolean} [options.ignoreCdata] Drop CDATA sections
 * @param {Boolean} [options.trim] Trim text in the verbose form
 *
 * @returns {object} Parsed document
 *
 * @throws {Error} When the document is not well formed
 */
export function xml2js(source, options = {}) {
  const keys = {
    text: options.textKey ?? "_text",
    attributes: options.attributesKey ?? "_attributes",
    comment: options.commentKey ?? "_comment",
    cdata: options.cdataKey ?? "_cdata",
    alwaysArray: options.alwaysArray === true,
    ignoreComment: options.ignoreComment === true,
    ignoreCdata: options.ignoreCdata === true,
    ignoreDoctype: options.ignoreDoctype === true,
    ignoreInstruction: options.ignoreInstruction === true,
    ignoreDeclaration: options.ignoreDeclaration === true,
    trim: options.trim === true,
  };
  const { roots, declaration, doctype } = parseDocument(String(source));

  if (options.compact) {
    const out = {};
    if (declaration && !keys.ignoreDeclaration) {
      out._declaration = { [keys.attributes]: declaration };
    }
    if (doctype !== undefined && !keys.ignoreDoctype) {
      out._doctype = doctype;
    }
    compactChildren(roots, out, keys);
    return out;
  }

  const out = {};
  if (declaration && !keys.ignoreDeclaration) {
    out.declaration = { attributes: declaration };
  }
  if (doctype !== undefined && !keys.ignoreDoctype) {
    out.doctype = doctype;
  }
  out.elements = verboseChildren(roots, keys);
  return out;
}
