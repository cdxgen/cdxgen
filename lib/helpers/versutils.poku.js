import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import { toVersRange } from "./versutils.js";

describe("toVersRange", () => {
  // === Basic Validation ===
  describe("input validation", () => {
    it("should return empty for null/undefined/empty", () => {
      assert.strictEqual(toVersRange(null), "");
      assert.strictEqual(toVersRange(undefined), "");
      assert.strictEqual(toVersRange(""), "");
      assert.strictEqual(toVersRange("   "), "");
    });

    it("should return empty for non-string input", () => {
      assert.strictEqual(toVersRange(123), "");
      assert.strictEqual(toVersRange({}), "");
      assert.strictEqual(toVersRange([]), "");
    });
  });

  // === Special Markers ===
  describe("special markers", () => {
    it("should handle wildcard '*'", () => {
      assert.strictEqual(toVersRange("*"), "vers:npm/*");
    });

    it("should return empty for 'latest'", () => {
      assert.strictEqual(toVersRange("latest"), "");
    });

    it("should return empty for workspace:* references", () => {
      assert.strictEqual(toVersRange("workspace:*"), "");
      assert.strictEqual(toVersRange("workspace:^1.0.0"), "");
      assert.strictEqual(toVersRange("workspace:~"), "");
    });
  });

  // === Simple Operators ===
  describe("simple comparison operators", () => {
    it("should handle >= operator", () => {
      assert.strictEqual(toVersRange(">=4.1.0"), "vers:npm/>=4.1.0");
      assert.strictEqual(toVersRange(">= 1.6.9"), "vers:npm/>=1.6.9");
      assert.strictEqual(
        toVersRange(">=v2.0.0-alpha8"),
        "vers:npm/>=2.0.0-alpha8",
      );
    });

    it("should handle <= operator", () => {
      assert.strictEqual(toVersRange("<=4.0.4"), "vers:npm/<=4.0.4");
      assert.strictEqual(toVersRange("<= 1.6.8"), "vers:npm/<=1.6.8");
      assert.strictEqual(
        toVersRange("<=v2.0.0-alpha7"),
        "vers:npm/<=2.0.0-alpha7",
      );
    });

    it("should handle < operator", () => {
      assert.strictEqual(toVersRange("<0.0.0"), "vers:npm/<0.0.0");
      assert.strictEqual(toVersRange("<2.11.2"), "vers:npm/<2.11.2");
      assert.strictEqual(toVersRange("< 6.1.0"), "vers:npm/<6.1.0");
    });

    it("should handle > operator", () => {
      assert.strictEqual(toVersRange(">0.12.7"), "vers:npm/>0.12.7");
      assert.strictEqual(toVersRange("> 0.9.6"), "vers:npm/>0.9.6");
      assert.strictEqual(toVersRange(">3.0.0"), "vers:npm/>3.0.0");
    });

    it("should handle = operator (exact version)", () => {
      assert.strictEqual(toVersRange("=3.0.0-rc.1"), "vers:npm/3.0.0-rc.1");
    });
  });

  // === Exact Versions ===
  describe("exact versions", () => {
    it("should convert plain version strings", () => {
      assert.strictEqual(toVersRange("2.1.4"), "vers:npm/2.1.4");
      assert.strictEqual(toVersRange("7.0.0"), "vers:npm/7.0.0");
      assert.strictEqual(toVersRange("2.3.21"), "vers:npm/2.3.21");
    });

    it("should handle prerelease exact versions", () => {
      assert.strictEqual(toVersRange("2.1.0-M1"), "vers:npm/2.1.0-M1");
      assert.strictEqual(toVersRange("3.0.0-rc.1"), "vers:npm/3.0.0-rc.1");
    });

    it("should strip 'v' prefix from versions", () => {
      assert.strictEqual(toVersRange("v2.0.0"), "vers:npm/2.0.0");
      assert.strictEqual(
        toVersRange(">=v2.0.0-alpha8"),
        "vers:npm/>=2.0.0-alpha8",
      );
    });
  });

  // === AND Conditions (space-separated) ===
  describe("AND conditions (space-separated)", () => {
    it("should convert space-separated ranges to pipe-separated", () => {
      assert.strictEqual(
        toVersRange(">=2.0.0 <=4.0.4"),
        "vers:npm/>=2.0.0|<=4.0.4",
      );
      assert.strictEqual(
        toVersRange(">= 2.0.1 <3.0.2"),
        "vers:npm/>=2.0.1|<3.0.2",
      );
      assert.strictEqual(
        toVersRange(">= 15.0.0 <= 16.1.0"),
        "vers:npm/>=15.0.0|<=16.1.0",
      );
      assert.strictEqual(
        toVersRange(">=5.0.3 >=4.2.1"),
        "vers:npm/>=4.2.1|>=5.0.3",
      );
    });

    it("should handle two-part version padding in AND ranges", () => {
      assert.strictEqual(
        toVersRange("<=2.1 >=1.1"),
        "vers:npm/>=1.1.0|<=2.1.0",
      );
    });
  });

  // === OR Conditions (||) ===
  describe("OR conditions (||)", () => {
    it("should convert || to single |", () => {
      assert.strictEqual(
        toVersRange(">=1.5.2 || >=1.4.11 <1.5.0 || >=1.3.2 <1.4.0"),
        "vers:npm/>=1.3.2|<1.4.0|>=1.4.11|<1.5.0|>=1.5.2",
      );
      assert.strictEqual(
        toVersRange(">=1.3.0 <1.3.2 || >=1.4.0 <1.4.11 || >=1.5.0 <1.5.2"),
        "vers:npm/>=1.3.0|<1.3.2|>=1.4.0|<1.4.11|>=1.5.0|<1.5.2",
      );
    });

    it("should handle complex OR ranges", () => {
      assert.strictEqual(
        toVersRange(
          ">=3.5.1 <4.0.0 || >=4.1.3 <5.0.0 || >=5.6.1 <6.0.0 || >=6.1.2",
        ),
        "vers:npm/>=3.5.1|<4.0.0|>=4.1.3|<5.0.0|>=5.6.1|<6.0.0|>=6.1.2",
      );
      assert.strictEqual(
        toVersRange(">=2.5.0 <= 3.0.0 || >=3.1.0"),
        "vers:npm/>=2.5.0|<=3.0.0|>=3.1.0",
      );
    });

    it("should handle exact versions in OR ranges", () => {
      assert.strictEqual(
        toVersRange("2.1.0-M1 || 2.1.0-M2"),
        "vers:npm/2.1.0-M1|2.1.0-M2",
      );
      assert.strictEqual(
        toVersRange("=3.10.1 || >=3.10.3"),
        "vers:npm/3.10.1|>=3.10.3",
      );
      assert.strictEqual(toVersRange("2.1 || 2.6"), "vers:npm/2.1.0|2.6.0");
    });
  });

  // === Caret Ranges (^) ===
  describe("caret ranges (^)", () => {
    it("should expand caret for major >= 1", () => {
      assert.strictEqual(toVersRange("^1.2.9"), "vers:npm/>=1.2.9|<2.0.0");
      assert.strictEqual(toVersRange("^2.0.18"), "vers:npm/>=2.0.18|<3.0.0");
      assert.strictEqual(toVersRange("^4.0.8"), "vers:npm/>=4.0.8|<5.0.0");
    });

    it("should expand caret for major = 0, minor > 0", () => {
      assert.strictEqual(
        toVersRange("^0.2.1-beta"),
        "vers:npm/>=0.2.1-beta|<0.3.0",
      );
      assert.strictEqual(toVersRange("^0.2.3"), "vers:npm/>=0.2.3|<0.3.0");
    });

    it("should expand caret for major = 0, minor = 0", () => {
      assert.strictEqual(
        toVersRange("^0.0.2-beta"),
        "vers:npm/>=0.0.2-beta|<0.0.3",
      );
      assert.strictEqual(toVersRange("^0.0.3"), "vers:npm/>=0.0.3|<0.0.4");
    });

    it("should handle caret with prerelease", () => {
      assert.strictEqual(
        toVersRange("^1.2.3-beta.1"),
        "vers:npm/>=1.2.3-beta.1|<2.0.0",
      );
      assert.strictEqual(
        toVersRange("^5.0.0-beta.5"),
        "vers:npm/>=5.0.0-beta.5|<6.0.0",
      );
    });

    it("should handle multiple caret ranges with OR", () => {
      assert.strictEqual(
        toVersRange("^2.0.18 || ^3.0.16 || ^3.1.6 || ^4.0.8 || ^5.0.0-beta.5"),
        "vers:npm/>=2.0.18|<3.0.0|>=3.0.16|>=3.1.6|<4.0.0|<4.0.0|>=4.0.8|>=5.0.0-beta.5|<5.0.0|<6.0.0",
      );
    });
  });

  // === Tilde Ranges (~) ===
  describe("tilde ranges (~)", () => {
    it("should expand tilde ranges", () => {
      assert.strictEqual(toVersRange("~3.8.2"), "vers:npm/>=3.8.2|<3.9.0");
      assert.strictEqual(toVersRange("~1.6.5"), "vers:npm/>=1.6.5|<1.7.0");
    });

    it("should handle tilde with prerelease", () => {
      assert.strictEqual(
        toVersRange("~0.8.0-pre"),
        "vers:npm/>=0.8.0-pre|<0.8.0|>=0.8.0|<0.8.1",
      );
    });

    it("should handle tilde in OR ranges", () => {
      assert.strictEqual(
        toVersRange("~1.6.5 || >=1.7.2"),
        "vers:npm/>=1.6.5|<1.7.0|>=1.7.2",
      );
      assert.strictEqual(
        toVersRange("~0.2.2 || >=0.3.2"),
        "vers:npm/>=0.2.2|<0.3.0|>=0.3.2",
      );
    });
  });

  // === X-Wildcard Ranges ===
  describe("x-wildcard ranges", () => {
    it("should expand major.x patterns", () => {
      assert.strictEqual(toVersRange(">= 1.x"), "vers:npm/>=1.0.0|<2.0.0");
      assert.strictEqual(toVersRange(">= 2.2.x"), "vers:npm/>=2.2.0|<2.3.0");
    });

    it("should expand minor.x patterns", () => {
      assert.strictEqual(toVersRange("1.2.x"), "vers:npm/>=1.2.0|<1.3.0");
      assert.strictEqual(
        toVersRange("2.0.x || 2.1.x"),
        "vers:npm/>=2.0.0|<2.1.0|>=2.1.0|<2.2.0",
      );
    });
  });

  // === Hyphen Ranges ===
  describe("hyphen ranges", () => {
    it("should convert hyphen ranges to >= and <=", () => {
      assert.strictEqual(
        toVersRange("5.0.0 - 7.2.3"),
        "vers:npm/>=5.0.0|<=7.2.3",
      );
    });
  });

  // === Version Padding ===
  describe("version padding", () => {
    it("should pad two-part versions to three parts", () => {
      assert.strictEqual(toVersRange(">= 1.1"), "vers:npm/>=1.1.0");
      assert.strictEqual(toVersRange("<= 1.0"), "vers:npm/<=1.0.0");
      assert.strictEqual(toVersRange(">= 3.11"), "vers:npm/>=3.11.0");
      assert.strictEqual(toVersRange("<3.11"), "vers:npm/<3.11.0");
      assert.strictEqual(toVersRange(">=4.5"), "vers:npm/>=4.5.0");
    });

    it("should handle padded versions in ranges", () => {
      assert.strictEqual(
        toVersRange(">=3.11 <4 || >=4.5"),
        "vers:npm/>=3.11.0|<4.0.0|>=4.5.0",
      );
    });
  });

  // === Edge Cases ===
  describe("edge cases", () => {
    it("should handle large version numbers", () => {
      assert.strictEqual(
        toVersRange("<=99.999.99999"),
        "vers:npm/<=99.999.99999",
      );
      assert.strictEqual(toVersRange("<99.999.9999"), "vers:npm/<99.999.9999");
    });

    it("should handle spacing variations", () => {
      assert.strictEqual(toVersRange(">= 1.6.9"), "vers:npm/>=1.6.9");
      assert.strictEqual(toVersRange("<  2.0.5"), "vers:npm/<2.0.5");
      assert.strictEqual(
        toVersRange(">=3.4.6 < 4.0.0|| >=4.0.5"),
        "vers:npm/>=3.4.6|<4.0.0|>=4.0.5",
      );
    });

    it("should handle mixed operators in compound ranges", () => {
      assert.strictEqual(
        toVersRange("<5.0.3 >=5.0.0 || < 4.2.1"),
        "vers:npm/<4.2.1|>=5.0.0|<5.0.3",
      );
      assert.strictEqual(
        toVersRange("<1.6.5 || < 2.1.7 > 2.0.0"),
        "vers:npm/<1.6.5|>2.0.0|<2.1.7",
      );
    });

    it("should handle multiple exact versions", () => {
      assert.strictEqual(toVersRange("1.1.2 1.2.2"), "vers:npm/1.1.2|1.2.2");
    });
  });
});
