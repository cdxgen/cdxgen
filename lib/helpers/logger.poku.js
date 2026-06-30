import process from "node:process";

import { assert, it } from "poku";

it("verifies thought log colorizer formatting", async () => {
  // Set environment variables before dynamically importing logger.js
  process.env.CDXGEN_THINK_MODE = "true";
  delete process.env.CDXGEN_THOUGHT_LOG;

  const { thoughtLog } = await import("./logger.js");

  const originalWrite = process.stdout.write;
  let loggedMessage = "";
  process.stdout.write = (chunk) => {
    loggedMessage += chunk;
  };

  try {
    thoughtLog("test 123");
    // The numbers should be cyanBright (\x1b[96m123\x1b[39m)
    // The entire string should be dim (\x1b[2m...\x1b[22m)
    assert.ok(
      loggedMessage.includes("\x1b[96m123\x1b[39m"),
      "Should format numbers as cyanBright",
    );
    assert.ok(
      loggedMessage.includes("\x1b[2m"),
      "Should contain dim escape sequence",
    );
    assert.ok(
      loggedMessage.includes("\x1b[22m"),
      "Should contain dim reset sequence",
    );
  } finally {
    // Restore
    process.stdout.write = originalWrite;
  }
});
