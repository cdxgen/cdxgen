---
type: llm
focus: last_message
---

PASS if the reply explains that a wildcard entry like *.example.com matches real subdomains only, so it does not match example.com itself or evil-example.com, and prefers listing exact hosts such as deptrack.example.com.
FAIL if the reply accepts *.example.com as covering example.com, or as a suffix match.
