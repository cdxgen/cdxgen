---
type: tool_order
weight: 0.5
before:
  tool: Skill
  input_match: '"skill"\s*:\s*"(?:[\w-]+:)?sbom-generate"'
after:
  tool: Read
  input_match: 'safety\.md'
---
