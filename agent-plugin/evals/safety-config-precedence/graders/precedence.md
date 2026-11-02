---
type: llm
focus: last_message
---

PASS if the reply says command-line arguments win over CDXGEN_ environment variables, which win over the .cdxgenrc or .cdxgen.json files, so -t python wins here.
FAIL if it says the environment variable wins, or does not answer which value wins.
