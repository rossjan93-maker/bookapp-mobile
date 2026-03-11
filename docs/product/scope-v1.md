# V1 Scope Boundaries

## MVP direction

V1 is a mobile-first social reading app centered on the loop:

**suggest → save → read → finish → reward**

It is not a broad Goodreads replacement. It is a focused tool for exchanging trusted book recommendations between friends and tracking whether those recommendations are acted on.

## What v1 must support

- Auth / login (Supabase email auth — implemented)
- Book search and add
- Friend connections
- User profiles
- Reading statuses: Want to Read, Reading, Finished, DNF
- Direct user-to-user book suggestions
- Received suggestions inbox / feed
- Save a suggested book to Want to Read
- Mark a suggested book as started / finished
- Simple recommendation credibility points when a suggested book is finished
- Yearly reading goal
- Minimal activity feed (reading actions + suggestion actions)

## What v1 must not include

- Broad public social posting system
- Advanced comments or discussion threads
- Bookstore or library integrations
- Complex gamification systems
- Recommendation marketplace or economy
- AI recommendation engine
- Book clubs
- Advanced discovery categories
- Premium / subscription features
- Complex review architecture
- Analytics instrumentation
- Non-essential abstractions or architecture expansions

## Current build state

- App shell: Expo + Expo Router, TypeScript, React Native Web
- Auth: Supabase email/password (implemented)
- Supabase client: initialized in lib/supabase.ts
- Placeholder tab screens: Home, Search, Library, Notes, Profile
  - These tabs are temporary scaffolding. Final tabs will map to: Home/Feed, Search, Inbox, Library, Profile.
- Book data, friend graph, suggestion objects, reading statuses: not yet implemented

## Product rule

Before adding any feature, ask: does it strengthen the loop "suggest → save → read → finish → reward"? If not, it does not belong in v1.
