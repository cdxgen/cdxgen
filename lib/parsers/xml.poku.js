import { assert, it } from "poku";

import { xml2js } from "./xml.js";

/** Options every Maven and NuGet call site passes. */
const COMPACT = {
  compact: true,
  spaces: 4,
  textKey: "_",
  attributesKey: "$",
  commentKey: "value",
};

/** Options the MSBuild props and csproj call sites pass. */
const ARRAYS = { ...COMPACT, alwaysArray: true };

/** Options the plist call site passes. */
const PLIST = {
  compact: false,
  ignoreCdata: false,
  ignoreComment: true,
  ignoreDoctype: true,
  ignoreInstruction: true,
  trim: true,
};

it("compact form keys elements by name", () => {
  assert.deepStrictEqual(xml2js("<r><d>1</d></r>", COMPACT), {
    r: { d: { _: "1" } },
  });
});

it("compact form collects repeated names into an array", () => {
  assert.deepStrictEqual(xml2js("<r><d>1</d><d>2</d></r>", COMPACT), {
    r: { d: [{ _: "1" }, { _: "2" }] },
  });
});

it("compact form separates attributes from text", () => {
  assert.deepStrictEqual(xml2js('<r><d k="v">t</d></r>', COMPACT), {
    r: { d: { $: { k: "v" }, _: "t" } },
  });
});

it("an empty element becomes an empty object", () => {
  assert.deepStrictEqual(xml2js("<r><d/><e></e></r>", COMPACT), {
    r: { d: {}, e: {} },
  });
});

it("whitespace between elements is not text", () => {
  assert.deepStrictEqual(xml2js("<r>\n  <d>1</d>\n</r>", COMPACT), {
    r: { d: { _: "1" } },
  });
});

it("text either side of a child is kept in order", () => {
  assert.deepStrictEqual(xml2js("<r>lead<d/>tail</r>", COMPACT), {
    r: { _: ["lead", "tail"], d: {} },
  });
});

it("cdata is kept apart from text", () => {
  assert.deepStrictEqual(
    xml2js("<r><d>pre<![CDATA[X]]>post</d></r>", COMPACT),
    {
      r: { d: { _: ["pre", "post"], _cdata: "X" } },
    },
  );
});

it("a comment outside the root element is kept", () => {
  assert.deepStrictEqual(xml2js("<!-- lic --><r/>", COMPACT), {
    value: " lic ",
    r: {},
  });
});

it("the declaration and doctype are reported separately", () => {
  const parsed = xml2js('<?xml version="1.0" encoding="UTF-8"?><r/>', COMPACT);
  assert.deepStrictEqual(parsed._declaration, {
    $: { version: "1.0", encoding: "UTF-8" },
  });
});

it("a processing instruction is kept where it appears", () => {
  assert.deepStrictEqual(xml2js("<r><?SORTPOM IGNORE?></r>", COMPACT), {
    r: { _instruction: { SORTPOM: "IGNORE" } },
  });
});

it("namespace prefixes stay part of the name", () => {
  assert.deepStrictEqual(xml2js('<r xmlns:p="u"><p:d>1</p:d></r>', COMPACT), {
    r: { $: { "xmlns:p": "u" }, "p:d": { _: "1" } },
  });
});

it("alwaysArray wraps every value, text included", () => {
  assert.deepStrictEqual(xml2js('<r><d k="v">1</d></r>', ARRAYS), {
    r: [{ d: [{ $: { k: "v" }, _: ["1"] }] }],
  });
});

it("the five XML entities are resolved", () => {
  assert.deepStrictEqual(
    xml2js("<r>&amp;&lt;&gt;&quot;&apos;</r>", COMPACT).r._,
    "&<>\"'",
  );
});

it("HTML entities used by poms in the wild are resolved", () => {
  assert.deepStrictEqual(
    xml2js("<r>Laugst&oslash;l</r>", COMPACT).r._,
    "Laugstøl",
  );
});

it("numeric character references are resolved", () => {
  assert.deepStrictEqual(xml2js("<r>&#65;&#x42;</r>", COMPACT).r._, "AB");
});

it("verbose form reports typed nodes and trims text", () => {
  const parsed = xml2js(
    '<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><key>  K  </key></plist>',
    PLIST,
  );
  assert.deepStrictEqual(parsed.doctype, undefined);
  assert.deepStrictEqual(parsed.elements, [
    {
      type: "element",
      name: "plist",
      attributes: { version: "1.0" },
      elements: [
        {
          type: "element",
          name: "key",
          elements: [{ type: "text", text: "K" }],
        },
      ],
    },
  ]);
});

it("trimming reaches attribute values", () => {
  const parsed = xml2js('<r><d Condition=" a == b "/></r>', PLIST);
  assert.deepStrictEqual(parsed.elements[0].elements[0].attributes, {
    Condition: "a == b",
  });
});

it("a malformed document is rejected", () => {
  for (const bad of ["<r><d>", "<r><d></e></r>", "<r><!-- unclosed"]) {
    assert.throws(() => xml2js(bad, COMPACT), `expected ${bad} to be rejected`);
  }
});

it("an undeclared entity is rejected rather than resolved", () => {
  assert.throws(() =>
    xml2js(
      '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
      COMPACT,
    ),
  );
});

it("a doctype is recorded without its entities taking effect", () => {
  // The entity is declared but never expanded, so an expansion attack has no
  // multiplier to work with and an external identifier is never dereferenced.
  const parsed = xml2js(
    '<!DOCTYPE r SYSTEM "http://example.invalid/e.dtd"><r>x</r>',
    COMPACT,
  );
  assert.deepStrictEqual(
    parsed._doctype,
    'r SYSTEM "http://example.invalid/e.dtd"',
  );
  assert.deepStrictEqual(parsed.r._, "x");
});

it("an internal subset may contain angle brackets", () => {
  const parsed = xml2js(
    '<!DOCTYPE r [<!ENTITY x "y">]><r>a[0] &gt; b</r>',
    COMPACT,
  );
  assert.deepStrictEqual(parsed._doctype, 'r [<!ENTITY x "y">]');
  assert.deepStrictEqual(parsed.r._, "a[0] > b");
});

it("a bracket after the declaration is not taken for its subset", () => {
  const parsed = xml2js("<!DOCTYPE r><r><d>a[0]</d><e>1</e></r>", COMPACT);
  assert.deepStrictEqual(parsed._doctype, "r");
  assert.deepStrictEqual(parsed.r, { d: { _: "a[0]" }, e: { _: "1" } });
});

it("an unclosed declaration or subset is rejected", () => {
  for (const bad of [
    "<r/><!DOCTYPE r",
    "<!DOCTYPE r [",
    "<!DOCTYPE r [><r/>",
  ]) {
    assert.throws(() => xml2js(bad, COMPACT), `expected ${bad} to be rejected`);
  }
});

it("many declarations are cheap", () => {
  // 3 MB of empty declarations and no bracket. Looking for a subset past the
  // end of each one scanned the rest of the document every time (~30 s).
  const start = Date.now();
  const parsed = xml2js(`<r><d>1</d>${"<!>".repeat(1000000)}</r>`, COMPACT);
  const elapsed = Date.now() - start;
  assert.deepStrictEqual(parsed, { r: { d: { _: "1" } } });
  assert.ok(
    elapsed < 5000,
    `declaration-padded document must parse quickly, took ${elapsed}ms`,
  );
});

it("nesting past the ceiling is rejected before the stack runs out", () => {
  const deep = "<a>".repeat(5000) + "</a>".repeat(5000);
  assert.throws(() => xml2js(deep, COMPACT));
});

it("an element named __proto__ becomes an own property", () => {
  const parsed = xml2js("<r><__proto__><p>1</p></__proto__></r>", COMPACT);
  assert.ok(Object.hasOwn(parsed.r, "__proto__"));
  // biome-ignore lint/suspicious/noProto: intentional own-property access to verify the parser does not pollute the prototype chain
  assert.deepStrictEqual(parsed.r["__proto__"].p._, "1");
  assert.deepStrictEqual({}.p, undefined);
});

it("an attribute named __proto__ becomes an own property", () => {
  const parsed = xml2js('<r __proto__="x"/>', COMPACT);
  assert.ok(Object.hasOwn(parsed.r.$, "__proto__"));
  assert.deepStrictEqual(Object.prototype.polluted, undefined);
});
