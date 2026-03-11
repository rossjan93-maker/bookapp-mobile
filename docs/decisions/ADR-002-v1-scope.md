# ADR-002: V1 Scope

## Status

Revised.

## Decision

V1 is a mobile-first social reading app centered on one product loop:

**suggest → save → read → finish → reward**

V1 is not a broad Goodreads replacement. It is scoped to friend-to-friend book recommendations and measurable follow-through on those recommendations.

## Previous decision (superseded)

The original v1 scope was a solo-first reading tracker limited to a UI shell with placeholder screens and no backend logic.

That scope is superseded. Backend integration (Supabase auth) has begun. The product direction has shifted from solo tracker to social recommendation loop.

## Rationale

- A solo reading tracker has well-established competition (Goodreads, StoryGraph, Literal).
- The underserved opportunity is in friend-to-friend recommendations with accountability: knowing that a specific person suggested a book, and tracking whether their suggestions actually get read.
- Narrowing to the suggest→save→read→finish→reward loop avoids feature sprawl and produces a testable core value proposition in v1.

## Implications

- Supabase Auth owns the user account. The app extends it via a `profiles` table.
- Friend-to-friend recommendation is a first-class data object in v1, not a social post.
- Friendship uses a `friendships` table with `pending` / `accepted` status. One row per pair, no reciprocal row.
- Recommendation lifecycle state matters: sent, saved, started, finished, ignored, dnf.
- `recommendations.status` and `user_books.status` must be kept in sync when a recipient acts on a recommendation.
- Credibility/points are tied to completed recommendations only, tracked via `credibility_events`.
- Activity feed is driven by a dedicated `activity_events` table scoped to five event types.
- Architecture should remain simple and avoid feature sprawl.

## In scope for v1

- Auth / login
- Book search and add
- Friend connections (friendships with pending/accepted state)
- User profiles
- Reading statuses: Want to Read, Reading, Finished, DNF
- Direct user-to-user book suggestions
- Received suggestions inbox / feed
- Save a suggested book to Want to Read
- Mark a suggested book as started / finished
- Simple recommendation credibility points when a suggested book is finished
- Yearly reading goal
- Minimal activity feed (five event types)

## Out of scope for v1

- Broad public social posting
- Comments and discussion threads
- Bookstore or library integrations
- Complex gamification or reward economy
- AI recommendations
- Book clubs
- Premium features
- Advanced discovery or review architecture

## Tab structure note

Current placeholder tabs (Home, Search, Library, Notes, Profile) are temporary scaffolding. Final tabs will likely be: Home/Feed, Search, Inbox, Library, Profile. This will be updated in a future routing pass.
