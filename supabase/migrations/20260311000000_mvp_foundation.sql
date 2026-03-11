-- =============================================================================
-- Migration: MVP Foundation Schema
-- Created:   2026-03-11
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type user_book_status as enum (
  'want_to_read',
  'reading',
  'finished',
  'dnf'
);

create type friendship_status as enum (
  'pending',
  'accepted'
);

create type recommendation_status as enum (
  'sent',
  'saved',
  'started',
  'finished',
  'ignored',
  'dnf'
);

create type activity_event_type as enum (
  'recommendation_sent',
  'recommendation_saved',
  'recommendation_started',
  'recommendation_finished',
  'book_finished'
);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table profiles (
  id                  uuid        primary key references auth.users (id),
  username            text        not null unique,
  yearly_reading_goal integer,
  created_at          timestamptz not null default now()
);

alter table profiles enable row level security;

create index idx_profiles_username on profiles (username);

-- ---------------------------------------------------------------------------
-- books
-- ---------------------------------------------------------------------------

create table books (
  id          uuid        primary key default gen_random_uuid(),
  title       text        not null,
  author      text        not null,
  cover_url   text,
  external_id text        not null unique,
  created_at  timestamptz not null default now()
);

alter table books enable row level security;

create index idx_books_external_id on books (external_id);

-- ---------------------------------------------------------------------------
-- user_books
-- ---------------------------------------------------------------------------

create table user_books (
  id          uuid             primary key default gen_random_uuid(),
  user_id     uuid             not null references profiles (id),
  book_id     uuid             not null references books (id),
  status      user_book_status not null,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz      not null default now(),
  unique (user_id, book_id)
);

alter table user_books enable row level security;

create index idx_user_books_user_id on user_books (user_id);
create index idx_user_books_book_id on user_books (book_id);

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------

create table friendships (
  id           uuid              primary key default gen_random_uuid(),
  requester_id uuid              not null references profiles (id),
  addressee_id uuid              not null references profiles (id),
  status       friendship_status not null default 'pending',
  created_at   timestamptz       not null default now(),
  updated_at   timestamptz       not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

alter table friendships enable row level security;

create index idx_friendships_requester_id on friendships (requester_id);
create index idx_friendships_addressee_id on friendships (addressee_id);
create index idx_friendships_status on friendships (status);

-- ---------------------------------------------------------------------------
-- recommendations
-- ---------------------------------------------------------------------------

create table recommendations (
  id             uuid                  primary key default gen_random_uuid(),
  from_user_id   uuid                  not null references profiles (id),
  to_user_id     uuid                  not null references profiles (id),
  book_id        uuid                  not null references books (id),
  user_book_id   uuid                  references user_books (id),
  status         recommendation_status not null default 'sent',
  note           text,
  created_at     timestamptz           not null default now(),
  resolved_at    timestamptz,
  check (from_user_id <> to_user_id)
);

alter table recommendations enable row level security;

create index idx_recommendations_from_user_id on recommendations (from_user_id);
create index idx_recommendations_to_user_id   on recommendations (to_user_id);
create index idx_recommendations_book_id      on recommendations (book_id);
create index idx_recommendations_status       on recommendations (status);

-- ---------------------------------------------------------------------------
-- credibility_events
-- ---------------------------------------------------------------------------

create table credibility_events (
  id                uuid        primary key default gen_random_uuid(),
  recommendation_id uuid        not null unique references recommendations (id),
  from_user_id      uuid        not null references profiles (id),
  to_user_id        uuid        not null references profiles (id),
  book_id           uuid        not null references books (id),
  created_at        timestamptz not null default now()
);

alter table credibility_events enable row level security;

create index idx_credibility_events_from_user_id on credibility_events (from_user_id);

-- ---------------------------------------------------------------------------
-- activity_events
-- ---------------------------------------------------------------------------

create table activity_events (
  id                uuid               primary key default gen_random_uuid(),
  actor_id          uuid               not null references profiles (id),
  event_type        activity_event_type not null,
  book_id           uuid               references books (id),
  recommendation_id uuid               references recommendations (id),
  created_at        timestamptz        not null default now()
);

alter table activity_events enable row level security;

create index idx_activity_events_actor_id   on activity_events (actor_id);
create index idx_activity_events_event_type on activity_events (event_type);
create index idx_activity_events_created_at on activity_events (created_at desc);
