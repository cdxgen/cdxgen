---
type: llm
focus: last_message
---

PASS if the reply says that on this platform atom runs on the JVM and needs Java 23 or newer, and that older Java versions freeze or return thin BOMs without an error message.
FAIL if the reply does not mention Java, or says Java is not needed on this platform.
