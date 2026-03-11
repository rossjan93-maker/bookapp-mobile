# System Overview

## Stack

- **Client**: Expo + React Native + TypeScript
- **Routing**: Expo Router (file-based routes)
- **Backend**: Supabase (auth active; data layer not yet implemented)
- **Web runtime**: React Native Web via Metro bundler, port 5000

## Current build state

| Layer | Status |
|-------|--------|
| App shell and routing | Done |
| Supabase client init | Done (`lib/supabase.ts`) |
| Email/password auth | Done (`app/(auth)/login.tsx`) |
| profiles table | Not yet implemented |
| books table | Not yet implemented |
| user_books table | Not yet implemented |
| friendships table | Not yet implemented |
| recommendations table | Not yet implemented |
| credibility_events table | Not yet implemented |
| activity_events table | Not yet implemented |

## Product loop

The architecture is being built to support:

**suggest → save → read → finish → reward**

All data model decisions should serve this loop.

## Key architectural notes

- **Auth boundary**: Supabase Auth owns the user account. The app extends it via a `profiles` table keyed on `auth.users.id`.
- **Recommendations are first-class**: a recommendation is not a social post. It is a direct object between two users with its own lifecycle state.
- **Recommendation lifecycle**: `sent` → `saved` → `started` → `finished` (or `ignored` / `dnf`).
- **Linked states**: `recommendations.status` and `user_books.status` must be kept in sync as the recipient acts on a recommendation.
- **Friendships**: one row per pair (requester → addressee), no reciprocal row. Status: `pending` or `accepted`.
- **Credibility**: derived from `credibility_events` rows only. Not from generic social activity.
- **Activity feed**: driven by `activity_events` table. Five event types in scope for v1. Filtered by friendship graph.
- **Simplicity**: avoid premature abstraction. Build the minimum that makes the loop work.

## Planned tab structure

Current tabs (Home, Search, Library, Notes, Profile) are placeholder scaffolding. The final tab structure will likely be:

- **Home / Feed** — activity feed for reading and suggestion actions
- **Search** — book search and add
- **Inbox** — received suggestions
- **Library** — personal reading list and statuses
- **Profile** — account, stats, reading goal, friends

Tab routing will be updated once the data model and feature set are confirmed.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/public key |
