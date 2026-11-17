import { assert, describe, it } from "poku";

import {
  cpuHasAvx512Vbmi,
  isJava4ShellAffectedVersion,
  java4ShellWarning,
} from "./java4shell.js";
import { jdkVendorFor } from "./jdkIdentity.js";

const identity = (version) => ({
  version,
  build: "8",
  vendor: jdkVendorFor("Eclipse Adoptium"),
});
const avx512 =
  "flags\t\t: fpu avx512f avx512bw avx512vbmi bmi2 avx2\nflags\t: fpu\n";
const linuxX64 = {
  platform: "linux",
  arch: "x64",
  cpuinfo: avx512,
  options: "",
};

describe("isJava4ShellAffectedVersion()", () => {
  it("covers 17.0.6 and later and nothing older", () => {
    for (const version of ["17.0.6", "17.0.21", "21.0.5", "25", "26.0.2"]) {
      assert.strictEqual(isJava4ShellAffectedVersion(version), true, version);
    }
    for (const version of ["17.0.5", "17", "11.0.25", "1.8.0_504", undefined]) {
      assert.strictEqual(
        isJava4ShellAffectedVersion(version),
        false,
        `${version}`,
      );
    }
  });
});

describe("cpuHasAvx512Vbmi()", () => {
  it("needs all four CPU features", () => {
    assert.strictEqual(cpuHasAvx512Vbmi(avx512), true);
    assert.strictEqual(
      cpuHasAvx512Vbmi("flags : avx512f avx512bw bmi2\n"),
      false,
    );
    assert.strictEqual(cpuHasAvx512Vbmi(undefined), false);
  });
});

describe("java4ShellWarning()", () => {
  it("warns for an affected JDK on an AVX-512 VBMI x86-64 Linux host", () => {
    const message = java4ShellWarning(identity("21.0.5"), linuxX64);
    assert.match(message, /Java4Shell \(CVE-2026-114938\)/);
    assert.match(message, /Eclipse Temurin 21\.0\.5\+8/);
    assert.match(message, /-XX:-UseBASE64Intrinsics/);
  });
  it("stays quiet when the flag is set, on ARM64, without the CPU feature, or for an older JDK", () => {
    assert.strictEqual(
      java4ShellWarning(identity("21.0.5"), {
        ...linuxX64,
        options: "-Dx=1 -XX:-UseBASE64Intrinsics",
      }),
      undefined,
    );
    assert.strictEqual(
      java4ShellWarning(identity("21.0.5"), { ...linuxX64, arch: "arm64" }),
      undefined,
    );
    assert.strictEqual(
      java4ShellWarning(identity("21.0.5"), {
        ...linuxX64,
        cpuinfo: "flags : avx2\n",
      }),
      undefined,
    );
    assert.strictEqual(
      java4ShellWarning(identity("17.0.5"), linuxX64),
      undefined,
    );
    assert.strictEqual(
      java4ShellWarning(identity("21.0.5"), {
        ...linuxX64,
        platform: "darwin",
      }),
      undefined,
    );
  });
});
