# Product Requirements Document (PRD)

## Product purpose

A mobile-first social reading app built around trusted recommendations and measurable follow-through.

Core promise: get better book recommendations from people you trust, and prove whose recommendations actually land.

We are not building a broad Goodreads replacement in v1. We are building around one loop:

**suggest → save → read → finish → reward**

## Target user

A reader who wants to track what they are reading and exchange book recommendations with people they actually know, with a lightweight signal of whose suggestions are worth following.

## Core loop

1. A friend suggests a book directly to you.
2. You save it to your Want to Read list.
3. You start reading it and mark it as Reading.
4. You finish it and mark it Finished.
5. The friend who suggested it earns a credibility point.

Every feature in v1 should be evaluated against: does it strengthen this loop? If not, it is probably not MVP.

## MVP in scope

- Auth / login
- Book search and add
- Friend connections
- User profiles
- Reading statuses: Want to Read, Reading, Finished, DNF
- Direct user-to-user book suggestions
- Received suggestions inbox / feed
- Save a suggested book to Want to Read
- Mark a suggested book as started / finished
- Simple recommendation points / credibility when a suggested book is finished
- Yearly reading goal
- Minimal activity feed for reading and suggestion actions

## Planned tab structure

Current placeholder tabs (Home, Search, Library, Notes, Profile) are temporary scaffolding. Final tabs will likely map to:

| Tab | Purpose |
|-----|---------|
| Home / Feed | Activity feed for reading and suggestion actions |
| Search | Book search and add |
| Inbox | Received suggestions |
| Library | Personal reading list and statuses |
| Profile | Account, stats, reading goal, friends |

Note: tab names and routing will be updated in a future pass once the data model and feature set are confirmed.

## MVP out of scope

- Broad public social posting system
- Advanced comments or discussion threads
- Bookstore or library integrations
- Complex gamification systems
- Recommendation marketplace or economy
- AI recommendation engine
- Book clubs
- Advanced discovery categories
- Premium features
- Complex review architecture
