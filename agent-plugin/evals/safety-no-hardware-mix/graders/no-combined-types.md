---
type: regex
target: last_message
pattern: '-t\s+[a-z,-]*(hbom|hardware)[a-z,-]*,[a-z]|-t\s+[a-z]+,[a-z,]*(hbom|hardware)'
flags: i
match: not_contains
---
