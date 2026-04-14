/**
 * Book club data layer.
 *
 * All mutations reference existing tables (user_books, books, profiles,
 * friendships) but never alter their structure.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BookClub,
  BookClubBook,
  BookClubComment,
  ClubWithDetails,
  CommentWithAuthor,
  MemberProgress,
} from './bookClubTypes';
import { getDisplayName } from './displayName';

// ── Spoiler gating ─────────────────────────────────────────────────────────────

/**
 * Returns true iff the reader has reached or passed the comment's page threshold.
 * A reader who has finished (readerPage >= total_pages) sees all comments.
 */
export function isCommentVisible(readerPage: number, pageThreshold: number): boolean {
  return readerPage >= pageThreshold;
}

/**
 * Returns the page number at which a locked comment unlocks.
 * Used by the UI to render the "Unlocks at page X" placeholder.
 */
export function unlocksAtPage(pageThreshold: number): number {
  return pageThreshold;
}

// ── Club CRUD ──────────────────────────────────────────────────────────────────

/**
 * Create a new book club.
 * The creator is automatically added as an admin member.
 */
export async function createClub(
  supabase: SupabaseClient,
  params: { name: string; description?: string; userId: string },
): Promise<{ club: BookClub | null; error: string | null }> {
  const { name, description, userId } = params;

  const { data: club, error: clubErr } = await supabase
    .from('book_clubs')
    .insert({ name: name.trim(), description: description?.trim() ?? null, created_by: userId })
    .select()
    .single();

  if (clubErr || !club) {
    return { club: null, error: 'Could not create club. Please try again.' };
  }

  const { error: memberErr } = await supabase
    .from('book_club_members')
    .insert({ club_id: club.id, user_id: userId, role: 'admin' });

  if (memberErr) {
    return { club: null, error: 'Club created but could not add you as a member.' };
  }

  return { club: club as BookClub, error: null };
}

/**
 * Invite a friend to a club. Only accepted friends (via the friendships table)
 * may be invited.
 */
export async function inviteMember(
  supabase: SupabaseClient,
  params: { clubId: string; inviterId: string; inviteeId: string },
): Promise<{ error: string | null }> {
  const { clubId, inviterId, inviteeId } = params;

  // Verify accepted friendship (canonical pair ordering)
  const { data: friendship } = await supabase
    .from('friendships')
    .select('id')
    .eq('status', 'accepted')
    .or(
      `and(requester_id.eq.${inviterId},addressee_id.eq.${inviteeId}),and(requester_id.eq.${inviteeId},addressee_id.eq.${inviterId})`,
    )
    .maybeSingle();

  if (!friendship) {
    return { error: 'You can only invite accepted friends.' };
  }

  const { error } = await supabase
    .from('book_club_members')
    .insert({ club_id: clubId, user_id: inviteeId, role: 'member' });

  if (error) {
    if (error.code === '23505') return { error: 'This person is already a member.' };
    return { error: 'Could not invite member. Please try again.' };
  }

  return { error: null };
}

// ── Club book management ───────────────────────────────────────────────────────

/**
 * Set the active book for a club (admin only at the DB/RLS level).
 * Marks any existing active book as 'completed' before inserting the new one.
 */
export async function setClubBook(
  supabase: SupabaseClient,
  params: {
    clubId:           string;
    bookId:           string;
    selectedBy:       string;
    totalPages:       number;
    targetFinishDate?: string | null;
  },
): Promise<{ clubBook: BookClubBook | null; error: string | null }> {
  const { clubId, bookId, selectedBy, totalPages, targetFinishDate } = params;

  // Mark the current active book as completed.
  await supabase
    .from('book_club_books')
    .update({ status: 'completed' })
    .eq('club_id', clubId)
    .eq('status', 'active');

  const { data, error } = await supabase
    .from('book_club_books')
    .insert({
      club_id:            clubId,
      book_id:            bookId,
      selected_by:        selectedBy,
      total_pages:        totalPages,
      target_finish_date: targetFinishDate ?? null,
      status:             'active',
    })
    .select()
    .single();

  if (error || !data) {
    return { clubBook: null, error: 'Could not set club book. Please try again.' };
  }

  return { clubBook: data as BookClubBook, error: null };
}

// ── Comments ───────────────────────────────────────────────────────────────────

/**
 * Post a comment to the club's active book.
 * Reads the poster's current_page for this book from user_books and
 * writes it as page_threshold — permanently stamped at write time.
 */
export async function postComment(
  supabase: SupabaseClient,
  params: {
    clubId:      string;
    clubBookId:  string;
    bookId:      string;
    userId:      string;
    body:        string;
  },
): Promise<{ comment: BookClubComment | null; error: string | null }> {
  const { clubId, clubBookId, bookId, userId, body } = params;

  if (!body.trim()) return { comment: null, error: 'Comment cannot be empty.' };

  // Read the poster's current page for this book.
  const { data: ub } = await supabase
    .from('user_books')
    .select('current_page')
    .eq('user_id', userId)
    .eq('book_id', bookId)
    .maybeSingle();

  const pageThreshold = ub?.current_page ?? 0;

  const { data, error } = await supabase
    .from('book_club_comments')
    .insert({
      club_id:        clubId,
      club_book_id:   clubBookId,
      user_id:        userId,
      body:           body.trim(),
      page_threshold: pageThreshold,
    })
    .select()
    .single();

  if (error || !data) {
    return { comment: null, error: 'Could not post comment. Please try again.' };
  }

  return { comment: data as BookClubComment, error: null };
}

/**
 * Fetch all comments for the active club book, with author info.
 * The caller is responsible for client-side spoiler gating via isCommentVisible().
 */
export async function fetchClubComments(
  supabase: SupabaseClient,
  params: { clubBookId: string },
): Promise<{ comments: CommentWithAuthor[]; error: string | null }> {
  const { clubBookId } = params;

  const { data, error } = await supabase
    .from('book_club_comments')
    .select(`
      id,
      club_id,
      club_book_id,
      user_id,
      body,
      page_threshold,
      created_at,
      author:profiles!book_club_comments_user_id_fkey (
        username,
        first_name,
        last_name
      )
    `)
    .eq('club_book_id', clubBookId)
    .order('created_at', { ascending: true });

  if (error) {
    return { comments: [], error: 'Could not load comments.' };
  }

  return { comments: (data ?? []) as CommentWithAuthor[], error: null };
}

// ── Member progress ────────────────────────────────────────────────────────────

/**
 * Returns each member's reading progress as a percentage (0–100).
 * Never exposes raw page numbers to the caller.
 * percentComplete = current_page / total_pages * 100, clamped 0–100.
 *
 * Uses a SECURITY DEFINER Postgres function (club_member_progress) to read
 * user_books.current_page for all club members — direct client-side reads
 * are blocked by the existing user_books RLS policy (owner-only).
 */
export async function fetchMemberProgress(
  supabase: SupabaseClient,
  params: { clubId: string; clubBookId: string; bookId: string; totalPages: number },
): Promise<{ progress: MemberProgress[]; error: string | null }> {
  const { clubId, bookId, totalPages } = params;

  const { data, error } = await supabase.rpc('club_member_progress', {
    p_club_id:     clubId,
    p_book_id:     bookId,
    p_total_pages: totalPages,
  });

  if (error) {
    return { progress: [], error: 'Could not load member progress.' };
  }

  const progress: MemberProgress[] = (data ?? []).map((row: {
    user_id:          string;
    username:         string;
    first_name:       string | null;
    last_name:        string | null;
    percent_complete: number;
  }) => ({
    userId: row.user_id,
    displayName: getDisplayName({
      username:   row.username,
      first_name: row.first_name,
      last_name:  row.last_name,
    }),
    percentComplete: row.percent_complete,
  }));

  return { progress, error: null };
}

// ── Club list ─────────────────────────────────────────────────────────────────

/**
 * Fetch all clubs the current user belongs to, with active book info and member count.
 */
export async function fetchMyClubs(
  supabase: SupabaseClient,
  params: { userId: string },
): Promise<{ clubs: ClubWithDetails[]; error: string | null }> {
  const { userId } = params;

  // Get clubs the user is a member of
  const { data: memberships, error: memErr } = await supabase
    .from('book_club_members')
    .select('club_id')
    .eq('user_id', userId);

  if (memErr || !memberships) {
    return { clubs: [], error: 'Could not load clubs.' };
  }

  if (memberships.length === 0) {
    return { clubs: [], error: null };
  }

  const clubIds = memberships.map(m => m.club_id);

  const { data: clubs, error: clubsErr } = await supabase
    .from('book_clubs')
    .select('id, name, description, created_by, created_at')
    .in('id', clubIds)
    .order('created_at', { ascending: false });

  if (clubsErr || !clubs) {
    return { clubs: [], error: 'Could not load clubs.' };
  }

  // Fetch member counts and active books for all clubs in parallel
  const [memberCountsResult, activeBooksResult] = await Promise.all([
    supabase
      .from('book_club_members')
      .select('club_id')
      .in('club_id', clubIds),
    supabase
      .from('book_club_books')
      .select(`
        id,
        club_id,
        book_id,
        total_pages,
        target_finish_date,
        book:books!book_club_books_book_id_fkey (
          title,
          author,
          cover_url,
          external_id
        )
      `)
      .in('club_id', clubIds)
      .eq('status', 'active'),
  ]);

  // Build member count map
  const memberCountMap = new Map<string, number>();
  for (const row of memberCountsResult.data ?? []) {
    memberCountMap.set(row.club_id, (memberCountMap.get(row.club_id) ?? 0) + 1);
  }

  // Build active book map
  const activeBookMap = new Map<string, ClubWithDetails['activeBook']>();
  for (const row of activeBooksResult.data ?? []) {
    const book = row.book as { title: string; author: string; cover_url: string | null; external_id: string | null } | null;
    activeBookMap.set(row.club_id, {
      id:                 row.id,
      book_id:            row.book_id,
      title:              book?.title ?? '',
      author:             book?.author ?? '',
      cover_url:          book?.cover_url ?? null,
      external_id:        book?.external_id ?? null,
      total_pages:        row.total_pages,
      target_finish_date: row.target_finish_date ?? null,
    });
  }

  const result: ClubWithDetails[] = clubs.map(club => ({
    ...club,
    memberCount: memberCountMap.get(club.id) ?? 0,
    activeBook:  activeBookMap.get(club.id) ?? null,
  }));

  return { clubs: result, error: null };
}
