import { assert, describe, it } from "poku";

import {
  extractPackageInfoFromHintPath,
  extractVersionFromHintPath,
  isValidVersion,
} from "./dotnetutils.js";

describe("csproj version extraction tests", () => {
  const testCases = [
    // Basic package structure tests
    [
      "..\\packages\\BouncyCastle.Cryptography.2.6.2\\lib\\net461\\BouncyCastle.Cryptography.dll",
      "2.6.2",
    ],
    [
      "../packages/Newtonsoft.Json.13.0.3/lib/net48/Newtonsoft.Json.dll",
      "13.0.3",
    ],
    [
      "..\\packages\\EntityFramework.6.4.4\\lib\\net45\\EntityFramework.dll",
      "6.4.4",
    ],

    // .nuget packages structure
    [
      "C:\\Users\\user\\.nuget\\packages\\microsoft.entityframeworkcore\\7.0.10\\lib\\net6.0\\Microsoft.EntityFrameworkCore.dll",
      "7.0.10",
    ],
    [
      "C:/Users/user/.nuget/packages/System.Text.Json/7.0.3/lib/net6.0/System.Text.Json.dll",
      "7.0.3",
    ],

    // UNC paths
    [
      "\\\\server\\share\\packages\\Newtonsoft.Json.13.0.3\\lib\\net48\\Newtonsoft.Json.dll",
      "13.0.3",
    ],
    [
      "\\\\network\\packages\\MyCompany.Library.2.1.5\\lib\\net472\\MyCompany.Library.dll",
      "2.1.5",
    ],

    // lib directory version extraction
    ["../lib/4.8.5/System.Data.SqlClient.dll", "4.8.5"],
    ["C:\\projects\\myapp\\lib\\1.2.3\\MyLibrary.dll", "1.2.3"],

    // Pre-release versions
    [
      "..\\packages\\MyPackage.1.2.3-beta1\\lib\\net48\\MyPackage.dll",
      "1.2.3-beta1",
    ],
    [
      "../nuget/Some.Package.Name.1.0.0-preview.1/lib/netstandard2.0/Some.Package.Name.dll",
      "1.0.0-preview.1",
    ],
    [
      "../packages/AwesomeLib.3.2.1-alpha.2/lib/net6.0/AwesomeLib.dll",
      "3.2.1-alpha.2",
    ],
    [
      "..\\packages\\Test.Package.1.0.0-rc.1.2\\lib\\net48\\Test.Package.dll",
      "1.0.0-rc.1.2",
    ],

    // Four-part versions
    ["../packages/A.B.C.1.2.3.4/lib/net48/A.B.C.dll", "1.2.3.4"],
    [
      "C:\\packages\\Windows.Library.10.0.19041.1\\lib\\net48\\Windows.Library.dll",
      "10.0.19041.1",
    ],

    // Zero versions
    ["../packages/PackageName.0.0.0.0/lib/net48/Package.dll", "0.0.0.0"],
    ["..\\packages\\TestLib.0.1.0\\lib\\net48\\TestLib.dll", "0.1.0"],

    // Unicode characters in paths
    [
      "C:\\проекты\\packages\\MyLibrary.1.2.3\\lib\\net48\\MyLibrary.dll",
      "1.2.3",
    ],
    ["../paquets/МояБиблиотека.2.1.0/lib/net48/МояБиблиотека.dll", "2.1.0"],
    ["C:\\项目\\packages\\我的库.3.2.1\\lib\\net48\\我的库.dll", "3.2.1"],
    ["..\\packages\\Tëst.Libräry.1.2.3\\lib\\net48\\Tëst.Libräry.dll", "1.2.3"],

    // Complex package names
    [
      "../packages/Microsoft.AspNet.WebApi.Client.5.2.9/lib/net45/System.Net.Http.Formatting.dll",
      "5.2.9",
    ],
    [
      "C:\\packages\\System.Collections.Immutable.7.0.0\\lib\\net6.0\\System.Collections.Immutable.dll",
      "7.0.0",
    ],
    [
      "..\\packages\\runtime.native.System.Data.SqlClient.sni.4.7.0\\runtimes\\win-x64\\native\\sni.dll",
      "4.7.0",
    ],

    // Different directory structures
    [
      "C:\\Users\\user\\.nuget\\packages\\newtonsoft.json\\13.0.3\\lib\\net6.0\\Newtonsoft.Json.dll",
      "13.0.3",
    ],
    [
      "\\\\server\\share\\.nuget\\packages\\microsoft.extensions.logging\\7.0.0\\lib\\net6.0\\Microsoft.Extensions.Logging.dll",
      "7.0.0",
    ],

    // Edge cases with dots in package names
    ["../packages/A.B.C.D.E.1.2.3/lib/net48/A.B.C.D.E.dll", "1.2.3"],
    [
      "C:\\packages\\Company.Product.Module.Core.2.5.1\\lib\\net48\\Company.Product.Module.Core.dll",
      "2.5.1",
    ],

    // Long version numbers
    [
      "../packages/TestPackage.123.456.789.999/lib/net48/TestPackage.dll",
      "123.456.789.999",
    ],

    // Null and empty cases
    [null, null],
    ["", null],
    ["invalid/path/without/version.dll", null],
    ["../packages/invalidpath", null],

    // Paths that look like they might have versions but don't
    ["../my.project/files/version.dll", null],
    ["C:\\code\\version\\1.0\\MyApp.dll", "1.0"], // This should find 1.0

    // Mixed case paths
    [
      "C:\\Packages\\NEWTONSOFT.JSON.13.0.3\\lib\\net48\\Newtonsoft.Json.dll",
      "13.0.3",
    ],
    [
      "..\\PACKAGES\\EntityFramework.6.4.4\\lib\\net45\\EntityFramework.dll",
      "6.4.4",
    ],

    // Very long paths
    [
      "C:\\very\\long\\path\\with\\many\\directories\\packages\\MyVeryLongPackageName.9.9.9\\lib\\net6.0\\MyVeryLongPackageName.dll",
      "9.9.9",
    ],

    // Special characters in package names
    [
      "../packages/My-Package_With.Symbols.1.2.3/lib/net48/My-Package_With.Symbols.dll",
      "1.2.3",
    ],
    ["C:\\packages\\Test+Package.4.5.6\\lib\\net48\\Test+Package.dll", "4.5.6"],

    // Nested package structures
    [
      "C:\\Users\\user\\.nuget\\packages\\microsoft\\aspnetcore\\mvc\\2.2.0\\lib\\netstandard2.0\\Microsoft.AspNetCore.Mvc.dll",
      "2.2.0",
    ],

    // Build metadata versions (less common but possible)
    [
      "../packages/MyLib.1.0.0+build.123/lib/net48/MyLib.dll",
      "1.0.0+build.123",
    ],
  ];

  testCases.forEach((testCase, index) => {
    it(`should extract version correctly for test case ${index}`, () => {
      const version = extractVersionFromHintPath(testCase[0]);
      assert.deepStrictEqual(version, testCase[1]);
    });
  });
});

describe("csproj package info extraction tests", () => {
  const packageInfoTestCases = [
    // Basic package structure tests
    [
      "..\\packages\\BouncyCastle.Cryptography.2.6.2\\lib\\net461\\BouncyCastle.Cryptography.dll",
      "BouncyCastle.Cryptography",
      "2.6.2",
    ],
    [
      "../packages/Newtonsoft.Json.13.0.3/lib/net48/Newtonsoft.Json.dll",
      "Newtonsoft.Json",
      "13.0.3",
    ],
    [
      "..\\packages\\EntityFramework.6.4.4\\lib\\net45\\EntityFramework.dll",
      "EntityFramework",
      "6.4.4",
    ],

    // .nuget packages structure
    [
      "C:\\Users\\user\\.nuget\\packages\\microsoft.entityframeworkcore\\7.0.10\\lib\\net6.0\\Microsoft.EntityFrameworkCore.dll",
      "microsoft.entityframeworkcore",
      "7.0.10",
    ],

    // UNC paths
    [
      "\\\\server\\share\\packages\\Newtonsoft.Json.13.0.3\\lib\\net48\\Newtonsoft.Json.dll",
      "Newtonsoft.Json",
      "13.0.3",
    ],

    // Pre-release versions
    [
      "..\\packages\\MyPackage.1.2.3-beta1\\lib\\net48\\MyPackage.dll",
      "MyPackage",
      "1.2.3-beta1",
    ],

    // Unicode characters
    [
      "C:\\проекты\\packages\\MyLibrary.1.2.3\\lib\\net48\\MyLibrary.dll",
      "MyLibrary",
      "1.2.3",
    ],

    // Complex cases
    [
      "C:\\Users\\user\\.nuget\\packages\\microsoft.aspnetcore.mvc\\2.2.0\\lib\\netstandard2.0\\Microsoft.AspNetCore.Mvc.dll",
      "microsoft.aspnetcore.mvc",
      "2.2.0",
    ],

    // Edge cases
    [null, null, null],
    ["", null, null],
    ["invalid/path/without/version.dll", null, null],
  ];

  packageInfoTestCases.forEach((testCase, index) => {
    it(`should extract package info correctly for test case ${index}`, () => {
      const result = extractPackageInfoFromHintPath(testCase[0]);
      assert.deepStrictEqual(result.name, testCase[1]);
      assert.deepStrictEqual(result.version, testCase[2]);
    });
  });
});

describe("version validation tests", () => {
  const validVersions = [
    // Standard versions
    "1.0.0",
    "2.6.2",
    "13.0.3",
    "6.4.4",
    "7.0.10",
    "4.8.5",
    "1.2.3",
    "0.0.0",
    "999.999.999",

    // Two-part versions
    "1.0",
    "2.5",
    "13.0",

    // Three-part versions
    "1.2.3",
    "10.20.30",
    "0.0.1",

    // Four-part versions
    "1.2.3.4",
    "10.0.19041.1",
    "123.456.789.999",

    // Pre-release versions
    "1.0.0-alpha",
    "1.0.0-beta1",
    "2.6.2-rc1",
    "13.0.3-preview.1",
    "1.2.3-beta.2",
    "1.0.0-rc.1.2",
    "3.2.1-alpha.2",
    "1.0.0-SNAPSHOT",

    // Versions with dots and hyphens in pre-release
    "1.0.0-feature-branch",
    "2.0.0-hotfix.1",
    "1.5.0-release-candidate.1",

    // Single digit versions
    "1.0.0",
    "2.0.0",
    "0.1.0",
    "0.0.1",
  ];

  const invalidVersions = [
    // Null and undefined
    null,
    undefined,

    // Empty and whitespace
    "",
    " ",
    "   ",

    // Invalid formats
    "version1.0.0",
    "1.0.0version",
    "v1.0.0",
    "V2.0.0",

    // Missing parts
    ".",
    "..",
    "1.",
    "1.2.",
    ".1.2",
    ".1.2.3",

    // Non-numeric parts (except pre-release)
    "a.b.c",
    "1.a.3",
    "1.2.b",
    "1.2.3.4.5", // Too many parts

    // Invalid characters
    "1.0.0@",
    "1.0.0#",
    "1.0.0$",
    "1.0.0%",
    "1.0.0^",
    "1.0.0&",
    "1.0.0*",
    "1.0.0(",
    "1.0.0)",
    "1.0.0[",
    "1.0.0]",
    "1.0.0{",
    "1.0.0}",
    "1.0.0|",
    "1.0.0\\",
    "1.0.0/",
    "1.0.0<",
    "1.0.0>",
    "1.0.0?",

    // Negative numbers
    "-1.0.0",
    "1.-2.3",
    "1.2.-3",

    // Spaces
    "1. 0.0",
    "1.0 .0",
    "1.0. 0",
    " 1.0.0",
    "1.0.0 ",

    // Multiple dots
    "1..0.0",
    "1.0..0",
    "1.0.0.",
    "..1.0.0",

    // Letters mixed with numbers
    "1a.0.0",
    "1.0b.0",
    "1.0.0c",

    // Special edge cases
    "latest",
    "stable",
    "current",
    "dev",
    "master",
    "main",
    "HEAD",

    // Malformed pre-release
    "1.0.0-",
    "1.0.0--",
    "1.0.0-alpha--beta",
    "1.0.0-.",
    "1.0.0-.alpha",
  ];

  it("should validate valid versions", () => {
    validVersions.forEach((version, index) => {
      assert.deepStrictEqual(
        isValidVersion(version),
        true,
        `Failed for valid version: ${version} at index ${index}`,
      );
    });
  });

  it("should reject invalid versions", () => {
    invalidVersions.forEach((version, index) => {
      assert.deepStrictEqual(
        isValidVersion(version),
        false,
        `Failed for invalid version: ${version} at index ${index}`,
      );
    });
  });
});

// Additional specific tests
describe("additional version validation tests", () => {
  it("should handle string representations of valid versions", () => {
    assert.deepStrictEqual(isValidVersion("1.0.0"), true);
    assert.deepStrictEqual(isValidVersion(String("2.6.2")), true);
  });

  it("should reject non-string inputs", () => {
    assert.deepStrictEqual(isValidVersion(123), false);
    assert.deepStrictEqual(isValidVersion({}), false);
    assert.deepStrictEqual(isValidVersion([]), false);
    assert.deepStrictEqual(isValidVersion(true), false);
    assert.deepStrictEqual(isValidVersion(false), false);
  });

  it("should handle boundary cases", () => {
    assert.deepStrictEqual(isValidVersion("0.0.0.0"), true); // Four zeros
    assert.deepStrictEqual(isValidVersion("999999.999999.999999"), true); // Large numbers
    assert.deepStrictEqual(isValidVersion("1.0.0-"), false); // Empty pre-release
    assert.deepStrictEqual(isValidVersion("1.0.0-a"), true); // Single char pre-release
  });
});

describe("overlong HintPath handling", () => {
  const crafted = (repeats) =>
    `..\\packages\\Lib${".1.1-".repeat(repeats)}!\\lib\\net48\\Lib.dll`;

  it("reads no package from a HintPath longer than any real path", () => {
    const start = Date.now();
    const hintPath = crafted(80000);
    assert.deepStrictEqual(extractPackageInfoFromHintPath(hintPath), {
      name: null,
      version: null,
    });
    assert.strictEqual(extractVersionFromHintPath(hintPath), null);
    assert.ok(Date.now() - start < 1000);
  });

  it("keeps a crafted HintPath of ordinary length cheap", () => {
    const start = Date.now();
    extractPackageInfoFromHintPath(crafted(700));
    assert.ok(Date.now() - start < 1000);
  });

  it("still reads a long but plausible HintPath", () => {
    const directory = "a".repeat(200);
    assert.deepStrictEqual(
      extractPackageInfoFromHintPath(
        `C:\\${directory}\\packages\\Lib.1.2.3\\lib\\net48\\Lib.dll`,
      ),
      { name: "Lib", version: "1.2.3" },
    );
  });
});

describe("dotted package ids (issue 4901)", () => {
  // The global-packages layout keeps the id and the version in a segment of
  // their own each, so an id that ends in numbers stays whole.
  it("reads the version segment of a global-packages path with a dotted id", () => {
    const hintPath =
      "C:\\Users\\user\\.nuget\\packages\\microsoft.visualstudio.shell.15.0\\17.11.40262\\lib\\net472\\Microsoft.VisualStudio.Shell.15.0.dll";
    assert.deepStrictEqual(extractPackageInfoFromHintPath(hintPath), {
      name: "microsoft.visualstudio.shell.15.0",
      version: "17.11.40262",
    });
    assert.strictEqual(extractVersionFromHintPath(hintPath), "17.11.40262");
  });

  it("reads the same layout from a POSIX cache", () => {
    const hintPath =
      "/home/user/.nuget/packages/microsoft.visualstudio.shell.15.0/17.11.40262/lib/net472/Microsoft.VisualStudio.Shell.15.0.dll";
    assert.deepStrictEqual(extractPackageInfoFromHintPath(hintPath), {
      name: "microsoft.visualstudio.shell.15.0",
      version: "17.11.40262",
    });
  });

  it("reads a dotted id at a prerelease version", () => {
    const hintPath =
      "C:\\Users\\user\\.nuget\\packages\\contoso.tools.2.0\\5.1.0-preview.3\\lib\\net6.0\\Contoso.Tools.2.0.dll";
    assert.deepStrictEqual(extractPackageInfoFromHintPath(hintPath), {
      name: "contoso.tools.2.0",
      version: "5.1.0-preview.3",
    });
  });

  it("splits an ambiguous packages.config segment on the DLL name", () => {
    const hintPath =
      "..\\packages\\Microsoft.VisualStudio.Shell.15.0.17.11.40262\\lib\\net472\\Microsoft.VisualStudio.Shell.15.0.dll";
    const referenceNames = [
      "Microsoft.VisualStudio.Shell.15.0",
      "Microsoft.VisualStudio.Shell.15.0.dll",
    ];
    assert.deepStrictEqual(
      extractPackageInfoFromHintPath(hintPath, referenceNames),
      {
        name: "Microsoft.VisualStudio.Shell.15.0",
        version: "17.11.40262",
      },
    );
    // Case differences between the reference and the folder on disk.
    assert.deepStrictEqual(
      extractPackageInfoFromHintPath(
        "..\\packages\\microsoft.visualstudio.shell.15.0.17.11.40262\\lib\\net472\\Microsoft.VisualStudio.Shell.15.0.dll",
        referenceNames,
      ),
      {
        name: "microsoft.visualstudio.shell.15.0",
        version: "17.11.40262",
      },
    );
  });

  it("falls back to the shortest versioned split without a reference name", () => {
    assert.deepStrictEqual(
      extractPackageInfoFromHintPath(
        "..\\packages\\Microsoft.VisualStudio.Shell.15.0.17.11.40262\\lib\\net472\\Microsoft.VisualStudio.Shell.15.0.dll",
      ),
      {
        name: "Microsoft.VisualStudio.Shell.15",
        version: "0.17.11.40262",
      },
    );
  });

  it("keeps ordinary packages.config paths unchanged", () => {
    assert.deepStrictEqual(
      extractPackageInfoFromHintPath(
        "..\\packages\\Newtonsoft.Json.13.0.3\\lib\\net48\\Newtonsoft.Json.dll",
        ["Newtonsoft.Json", "Newtonsoft.Json.dll"],
      ),
      { name: "Newtonsoft.Json", version: "13.0.3" },
    );
    // A reference name that only covers part of the id cannot hijack the
    // split, because the remainder it would leave is no version, and the
    // longer DLL name wins.
    assert.deepStrictEqual(
      extractPackageInfoFromHintPath(
        "..\\packages\\Company.Product.Module.Core.2.5.1\\lib\\net48\\Company.Product.Module.Core.dll",
        ["Company", "Company.Product.Module.Core.dll"],
      ),
      { name: "Company.Product.Module.Core", version: "2.5.1" },
    );
  });
});
