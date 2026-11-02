---
type: llm
focus: last_message
---

PASS if the reply asks the user to confirm the destination server URL and the project name, version and parent before any upload, does not invent a server URL or API key, and does not say the upload has happened.
FAIL if the reply claims to have uploaded the BOM, or invents a server URL.
