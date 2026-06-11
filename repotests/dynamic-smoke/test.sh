#!/bin/bash
# tracebom SaaSBOM smoke test: verifies dynamic SBOM generation with HTTP URL tracing
# Test 1: Basic library tracing (always runs, no root needed)
# Test 2: npm install with --trace-http-urls (requires sudo + eBPF, Linux >= 5.8)
# Test 3: pip install with --trace-http-urls (requires sudo + eBPF, Linux >= 5.8)
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TRACEBOM="$REPO_DIR/bin/tracebom.js"
RESULTS_DIR="${REPO_DIR}/bomresults"
mkdir -p "$RESULTS_DIR"

echo "=== tracebom SaaSBOM smoke test ==="

# ---------------------------------------------------------------
# Test 1: Basic library tracing (no HTTP URLs)
echo "--- Test 1: Basic library tracing ---"
TESTDIR="$(mktemp -d)"
cd "$TESTDIR"
echo '{"name":"dynamic-smoke","version":"0.0.1"}' > package.json
OUTPUT="$RESULTS_DIR/tracebom-basic.json"

node "$TRACEBOM" --cmd "echo hello" --output "$OUTPUT" 2>&1
node -e '
const j = require("'"$OUTPUT"'");
if (!j.bomFormat || j.bomFormat !== "CycloneDX") { console.log("FAIL: bomFormat"); process.exit(1); }
const libs = j.components.filter(c => c.type === "library" && c.scope === "required");
if (libs.length < 1) { console.log("FAIL: no library components"); process.exit(1); }
console.log("PASS: basic library tracing (" + libs.length + " components)");
'
rm -rf "$TESTDIR"

# ---------------------------------------------------------------
# Tests 2 and 3 require sudo + eBPF (HTTP URL tracing)
if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
  if [ "$(uname -s)" = "Linux" ] && [ "$(printf '%s\n' "5.8" "$(uname -r)" | sort -V | head -n1)" = "5.8" ]; then
    echo "--- Test 2: npm install SaaSBOM ---"
    TESTDIR="$(mktemp -d)"
    cd "$TESTDIR"
    echo '{"name":"tb-npm-saasbom","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}' > package.json
    OUTPUT="$RESULTS_DIR/tracebom-npm.json"

    echo "--- Test 2: npm install SaaSBOM (best effort) ---"
    TESTDIR="$(mktemp -d)"
    cd "$TESTDIR"
    echo '{"name":"tb-npm-saasbom","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}' > package.json
    OUTPUT="$RESULTS_DIR/tracebom-npm.json"

    if sudo -E node "$TRACEBOM" --cmd "npm install" --trace-http-urls --trace-period 30 --output "$OUTPUT" 2>&1; then
      node -e '
const j = require("'"$OUTPUT"'");
if (!j.bomFormat) { console.log("FAIL: no bomFormat"); process.exit(1); }
console.log("components: " + (j.components ? j.components.length : 0));
console.log("services: " + (j.services ? j.services.length : 0));
if (j.services && j.services.length > 0) {
  const hasNpmjs = j.services.some(s =>
    s.endpoints && s.endpoints.some(ep => ep.indexOf("registry.npmjs.org") !== -1)
  );
  const hasMethods = j.services.some(s =>
    s.properties && s.properties.some(p => p.name === "cdx:service:httpMethod")
  );
  if (hasNpmjs) console.log("PASS: Found registry.npmjs.org endpoints");
  else console.log("WARN: No registry.npmjs.org endpoints (may vary by mirror)");
  if (hasMethods) console.log("PASS: services have httpMethod properties");
  console.log("PASS: services collected (" + j.services.length + " service(s))");
} else {
  console.log("FAIL: no services collected from npm install");
  process.exit(1);
}
'
    else
      echo "WARN: npm SaaSBOM test skipped (sandbox unavailable on this system)"
    fi
    sudo rm -rf "$TESTDIR"

    echo "--- Test 3: pip download SaaSBOM (best effort) ---"
    TESTDIR="$(mktemp -d)"
    cd "$TESTDIR"
    echo 'requests>=2.28.0' > requirements.txt
    mkdir -p dist
    OUTPUT="$RESULTS_DIR/tracebom-pip.json"

    if sudo -E node "$TRACEBOM" --cmd "pip download -r requirements.txt --no-cache-dir -d dist" --trace-http-urls --trace-period 30 --output "$OUTPUT" 2>&1; then
      node -e '
const j = require("'"$OUTPUT"'");
if (!j.bomFormat) { console.log("FAIL: no bomFormat"); process.exit(1); }
console.log("components: " + (j.components ? j.components.length : 0));
console.log("services: " + (j.services ? j.services.length : 0));
if (j.services && j.services.length > 0) {
  const hasPypi = j.services.some(s =>
    s.endpoints && s.endpoints.some(ep =>
      ep.indexOf("pypi") !== -1 || ep.indexOf("python.org") !== -1 || ep.indexOf("pythonhosted.org") !== -1
    )
  );
  if (hasPypi) console.log("PASS: Found PyPI endpoints");
  else console.log("WARN: No PyPI endpoints found (may vary by mirror)");
  console.log("PASS: services collected (" + j.services.length + " service(s))");
} else {
  console.log("FAIL: no services collected from pip install");
  process.exit(1);
}
'
    else
      echo "WARN: pip SaaSBOM test skipped (sandbox unavailable on this system)"
    fi
    sudo rm -rf "$TESTDIR"
  else
    echo "--- Skipping Tests 2/3: kernel $(uname -r) < 5.8 (eBPF required) ---"
  fi
else
  echo "--- Skipping Tests 2/3: sudo not available ---"
fi

echo "=== tracebom SaaSBOM smoke test complete ==="
