# Data Model

## Current state

Supabase auth is active. No application data tables have been created yet. The model below is the planned v1 target.

## Core entities

### user
Managed by Supabase Auth. Extended with a `profiles` table.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | Supabase auth user id |
| username | text | Display name |
| yearly_reading_goal | integer | Optional |
| created_at | timestamptz | |

### book
Canonical book record. Sourced from search (Open Library or similar).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| title | text | |
| author | text | |
| cover_url | text | Optional |
| external_id | text | Source API identifier |

### user_book
Tracks a user's relationship with a specific book.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| user_id | uuid | FK → user |
| book_id | uuid | FK → book |
| status | enum | want_to_read, reading, finished, dnf |
| started_at | timestamptz | Optional |
| finished_at | timestamptz | Optional |

### friend
Bidirectional friend connection between two users.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| from_user_id | uuid | FK → user |
| to_user_id | uuid | FK → user |
| created_at | timestamptz | |

### recommendation
First-class object. A direct user-to-user book suggestion.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| from_user_id | uuid | Recommender |
| to_user_id | uuid | Recipient |
| book_id | uuid | FK → book |
| status | enum | sent, saved, started, finished, ignored, dnf |
| note | text | Optional message from recommender |
| created_at | timestamptz | |
| resolved_at | timestamptz | When status changed to finished/ignored/dnf |

Note: `recommendation.status` and `user_book.status` must be kept in sync when a recipient acts on a recommendation.

### credibility_event
Records when a recommendation results in a finished book. Used to compute recommender credibility score.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| recommendation_id | uuid | FK → recommendation |
| from_user_id | uuid | Recommender who earns the point |
| to_user_id | uuid | Reader who finished the book |
| book_id | uuid | FK → book |
| created_at | timestamptz | |

Credibility score for a user = count of their `credibility_event` rows as `from_user_id`.

## Entities explicitly out of scope for v1

- Reviews / ratings
- Comments or discussion threads
- Book clubs
- Public posts or social feed beyond activity events
- Bookstore or library data
- Complex gamification tables
