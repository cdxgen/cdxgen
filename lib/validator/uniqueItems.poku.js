import { assert, describe, it } from "poku";

import { canonicalize, withCanonicalKeys } from "./uniqueItems.js";

const isUnique = (items) =>
  new Set(items.map(canonicalize)).size === items.length;

const long = (suffix) => `${"x".repeat(999)}${suffix}`;

describe("canonicalize()", () => {
  it("ignores the order of object keys", () => {
    assert.equal(
      canonicalize({ name: "a", type: "library" }),
      canonicalize({ type: "library", name: "a" }),
    );
  });

  it("tells apart values that a plain join would confuse", () => {
    assert.ok(isUnique([["a,b"], ["a", "b"]]));
    assert.ok(isUnique([1, "1", true, "true", null, "null"]));
    assert.ok(isUnique([{}, [], [[]], [{}]]));
    assert.ok(isUnique([{ a: "b", c: "d" }, { a: "b,s1:c=s1:d" }]));
  });
});

describe("withCanonicalKeys()", () => {
  it("returns what the validation returned", () => {
    assert.equal(
      withCanonicalKeys(() => "done"),
      "done",
    );
  });

  it("compares values too long to be kept as text", () => {
    const entry = (suffix) => ({ description: long(suffix), name: "entry" });
    withCanonicalKeys(() => {
      assert.ok(isUnique([entry("a"), entry("b")]));
      assert.ok(!isUnique([entry("a"), entry("a")]));
      assert.ok(isUnique([[entry("a")], [entry("b")]]));
      assert.ok(
        !isUnique([{ nested: [entry("a")] }, { nested: [entry("a")] }]),
      );
      assert.ok(canonicalize(entry("a")).length < 16);
    });
  });

  it("does not confuse a key with a string that reads like one", () => {
    withCanonicalKeys(() => {
      const key = canonicalize({ description: long("a") });
      assert.ok(isUnique([{ description: long("a") }, key]));
      assert.ok(isUnique([[{ description: long("a") }], [key]]));
    });
  });

  it("serialises a value once however many arrays it is nested in", () => {
    let reads = 0;
    const inner = {
      get description() {
        reads += 1;
        return long("a");
      },
    };
    const outer = { components: [{ components: [inner] }] };
    withCanonicalKeys(() => {
      canonicalize(inner);
      canonicalize(outer.components[0]);
      canonicalize(outer);
    });
    assert.equal(reads, 1);
    canonicalize(inner);
    canonicalize(outer);
    assert.equal(reads, 3);
  });

  it("drops the keys when the validation ends, even by throwing", () => {
    const first = { description: long("a") };
    const second = { description: long("b") };
    assert.equal(
      withCanonicalKeys(() => isUnique([first, second])),
      true,
    );
    second.description = first.description;
    assert.equal(
      withCanonicalKeys(() => isUnique([first, second])),
      false,
    );
    assert.throws(() =>
      withCanonicalKeys(() => {
        canonicalize(first);
        throw new Error("stop");
      }),
    );
    first.description = long("c");
    assert.ok(canonicalize(first).endsWith("c}"));
    assert.equal(
      withCanonicalKeys(() => isUnique([first, second])),
      true,
    );
  });
});
