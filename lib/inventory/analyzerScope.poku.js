import { assert, describe, it } from "poku";

import {
  getScopedStaticValueByName,
  resolveStaticValue,
} from "./analyzerScope.js";

const getLiteralStringValue = (node) =>
  node?.type === "StringLiteral" ? node.value : undefined;
const getMemberExpressionPropertyName = (node) => node?.name;
const identifier = (name) => ({ name, type: "Identifier" });

// A statement in the consequent of `if (alg === "RS256") { ... }`
const createGuardedPath = () => ({
  key: "consequent",
  node: { type: "ExpressionStatement" },
  parentPath: {
    key: "body",
    node: {
      test: {
        left: identifier("alg"),
        operator: "===",
        right: { type: "StringLiteral", value: "RS256" },
        type: "BinaryExpression",
      },
      type: "IfStatement",
    },
    parentPath: { key: "program", node: { type: "Program" } },
  },
});

describe("getScopedStaticValueByName()", () => {
  it("layers the narrowings of a branch over the shared values", () => {
    const staticValueByName = new Map([
      ["alg", ["RS256", "RS384"]],
      ["digest", "sha256"],
    ]);
    const scopedStaticValueByName = getScopedStaticValueByName(
      createGuardedPath(),
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
    );
    const resolve = (name) =>
      resolveStaticValue(
        identifier(name),
        scopedStaticValueByName,
        getLiteralStringValue,
        getMemberExpressionPropertyName,
      );

    assert.strictEqual(resolve("alg"), "RS256");
    assert.strictEqual(resolve("digest"), "sha256");
    assert.strictEqual(resolve("unknown"), undefined);
    assert.deepStrictEqual(staticValueByName.get("alg"), ["RS256", "RS384"]);
  });

  it("does not copy the shared values for every scope", () => {
    class UncopyableMap extends Map {
      [Symbol.iterator]() {
        throw new Error("the shared static values must not be enumerated");
      }
    }
    const staticValueByName = new UncopyableMap([["digest", "sha256"]]);
    for (const path of [{ node: { type: "Program" } }, createGuardedPath()]) {
      const scopedStaticValueByName = getScopedStaticValueByName(
        path,
        staticValueByName,
        getLiteralStringValue,
        getMemberExpressionPropertyName,
      );

      assert.strictEqual(scopedStaticValueByName.get("digest"), "sha256");
    }
  });
});
