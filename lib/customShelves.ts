/**
 * Custom shelves CRUD — Batch 4.
 *
 * Single source of truth for all user_shelves / user_shelf_books mutations.
 * Every consumer (library screen, shelf picker sheet, book detail) must go
 * through this module so the duplicate-prevention, ordering, and RLS
 * assumptions stay consistent.
 *
 * Persistence: see supabase/migrations/20260506000001_user_shelves.sql.
 *
 * Errors: callers receive the raw Postgres error message wrapped in `Error`
 * so the UI can render it directly. The most common failure paths are:
 *   - createShelf: unique violation (23505) → "You already have a shelf
 *     called …".
 *   - addBookToShelf: unique violation (23505) → silently succeed (idempotent).
 */

import { supabase as _supabase } from './supabase';

/** Narrows the nullable supabase client; every public fn calls this first. */
function db() {
  if (!_supabase) throw new Error('Supabase not configured.');
  return _supabase;
}

export type CustomShelf = {
  id:         string;
  user_id:    string;
  name:       string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const MAX_NAME_LENGTH = 60;

// ── Read ──────────────────────────────────────────────────────────────────────

/** All shelves owned by the user, ordered for display. */
export async function listShelves(userId: string): Promise<CustomShelf[]> {
  const { data, error } = await db()
    .from('user_shelves')
    .select('id, user_id, name, sort_order, created_at, updated_at')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CustomShelf[];
}

/**
 * Map of user_book_id → Set<shelf_id> for one user, in a single round-trip.
 * Used by the library screen to render shelf membership badges and by the
 * shelf picker to pre-check the right boxes.
 */
export async function listShelfMembership(userId: string): Promise<Map<string, Set<string>>> {
  const { data, error } = await db()
    .from('user_shelf_books')
    .select('shelf_id, user_book_id')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);

  const map = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    const ub = (row as any).user_book_id as string;
    const sh = (row as any).shelf_id     as string;
    let set = map.get(ub);
    if (!set) { set = new Set(); map.set(ub, set); }
    set.add(sh);
  }
  return map;
}

/** All user_book_ids on one shelf, ordered most-recently-added first. */
export async function listBookIdsInShelf(shelfId: string): Promise<string[]> {
  const { data, error } = await db()
    .from('user_shelf_books')
    .select('user_book_id, created_at')
    .eq('shelf_id', shelfId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => (r as any).user_book_id as string);
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function createShelf(userId: string, rawName: string): Promise<CustomShelf> {
  const name = rawName.trim();
  if (!name) throw new Error('Shelf name cannot be empty.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Shelf name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }

  const { data, error } = await db()
    .from('user_shelves')
    .insert({ user_id: userId, name })
    .select('id, user_id, name, sort_order, created_at, updated_at')
    .single();

  if (error) {
    // 23505 = unique_violation on (user_id, lower(name))
    if ((error as any).code === '23505') {
      throw new Error(`You already have a shelf called "${name}".`);
    }
    throw new Error(error.message);
  }
  return data as CustomShelf;
}

export async function renameShelf(shelfId: string, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!name) throw new Error('Shelf name cannot be empty.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Shelf name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  const { error } = await db()
    .from('user_shelves')
    .update({ name })
    .eq('id', shelfId);
  if (error) {
    if ((error as any).code === '23505') {
      throw new Error(`You already have a shelf called "${name}".`);
    }
    throw new Error(error.message);
  }
}

export async function deleteShelf(shelfId: string): Promise<void> {
  // ON DELETE CASCADE on user_shelf_books removes membership rows; user_books
  // are unaffected because the cascade is keyed on shelf_id only.
  const { error } = await db()
    .from('user_shelves')
    .delete()
    .eq('id', shelfId);
  if (error) throw new Error(error.message);
}

/**
 * Idempotent add. If the row already exists we treat it as success — the user
 * sees no error and the UI's optimistic check stays correct.
 */
export async function addBookToShelf(
  userId: string,
  shelfId: string,
  userBookId: string,
): Promise<void> {
  const { error } = await db()
    .from('user_shelf_books')
    .insert({ user_id: userId, shelf_id: shelfId, user_book_id: userBookId });
  if (error) {
    if ((error as any).code === '23505') return;
    throw new Error(error.message);
  }
}

export async function removeBookFromShelf(
  shelfId: string,
  userBookId: string,
): Promise<void> {
  const { error } = await db()
    .from('user_shelf_books')
    .delete()
    .eq('shelf_id',     shelfId)
    .eq('user_book_id', userBookId);
  if (error) throw new Error(error.message);
}
