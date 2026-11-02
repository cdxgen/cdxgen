---
type: llm
focus: last_message
---

PASS if the reply generates the hardware BOM in a separate command from the Node.js SBOM and does not combine hbom or hardware with software project types in one cdxgen run.
FAIL if one cdxgen invocation lists a hardware type together with js, java, python, os or oci.
