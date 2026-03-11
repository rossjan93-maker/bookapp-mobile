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
| Book data | Not yet implemented |
| Friend graph | Not yet implemented |
| Suggestion objects | Not yet implemented |
| Reading statuses | Not yet implemented |
| Recommendation credibility | Not yet implemented |
| Activity feed | Not yet implemented |

## Product loop

The architecture is being built to support:

**suggest → save → read → finish → reward**

All data model decisions should serve this loop.

## Key architectural notes

- Friend-to-friend recommendation is a first-class object, not a social post.
- Recommendation lifecycle state (sent, saved, started, finished, ignored, dnf) must be tracked explicitly.
- Reading state and recommendation state will be linked at the data model level.
- Credibility/points are derived from completed recommendations only.
- Architecture should stay simple. Avoid premature abstraction.

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
