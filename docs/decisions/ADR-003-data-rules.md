# ADR-003: Data Rules

## Decision
Defer all schema and backend logic to future phases; any schema changes must use named migrations.

## Status
Accepted.

## Rationale
- Keeps Phase 1 purely foundational.
- Supports controlled, auditable evolution when Supabase work begins.
