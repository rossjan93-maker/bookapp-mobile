# Build Rules

1. Never change folder structure unless explicitly asked.
2. Never add a package unless you list:
   - why it is needed
   - what problem it solves
   - whether existing packages can solve it
3. Never change database schema except through a named migration file.
4. Never rename routes, tables, or core types without explicit approval.
5. Never refactor unrelated files while solving a task.
6. Every task must reference the exact acceptance criteria it is satisfying.
7. Prefer simple code over abstractions.
8. If a change touches more than 5 files, stop and explain why.
9. All feature work must be behind a flag if it affects user-facing behavior.
10. If uncertain, preserve the current architecture and ask for the smallest safe change.
