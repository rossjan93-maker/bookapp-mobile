import { supabase } from './supabase';

export type FriendRequestErrorCode =
  | 'unauthenticated'
  | 'self'
  | 'invalid_addressee'
  | 'addressee_not_found'
  | 'duplicate'
  | 'pending_cap_exceeded'
  | 'unknown';

export type SendFriendRequestResult =
  | { ok: true }
  | { ok: false; code: FriendRequestErrorCode; message: string };

// Classification prefers SQLSTATE-equivalent matches first, then message
// tokens, so race outcomes that surface as the underlying unique-violation
// (23505) or cap-exceeded (53400) still classify deterministically even if
// PostgREST or pg-error mangles the message text.
function classifySendError(error: { message?: string | null; code?: string | null } | null | undefined): FriendRequestErrorCode {
  const m = (error?.message ?? '').toUpperCase();
  const code = (error?.code ?? '').toString();

  // Message-token matches (preferred — explicit, set by the RPC)
  if (m.includes('FRIEND_REQUEST_SELF')) return 'self';
  if (m.includes('FRIEND_REQUEST_ADDRESSEE_NOT_FOUND')) return 'addressee_not_found';
  if (m.includes('FRIEND_REQUEST_INVALID_ADDRESSEE')) return 'invalid_addressee';
  if (m.includes('FRIEND_REQUEST_DUPLICATE')) return 'duplicate';
  if (m.includes('FRIEND_REQUEST_PENDING_CAP_EXCEEDED')) return 'pending_cap_exceeded';
  if (m.includes('FRIEND_REQUEST_UNAUTHENTICATED')) return 'unauthenticated';

  // SQLSTATE fallbacks (covers race outcomes where the index fires before
  // our explicit RAISE, or unhandled DB-level errors)
  if (code === '23505') return 'duplicate';
  if (code === '53400') return 'pending_cap_exceeded';
  if (code === '23503') return 'addressee_not_found';

  return 'unknown';
}

function friendlyMessage(code: FriendRequestErrorCode): string {
  switch (code) {
    case 'self':                  return "You can't send a friend request to yourself.";
    case 'duplicate':             return 'A friendship or request already exists with this user.';
    case 'pending_cap_exceeded':  return "You've reached the maximum of 50 pending requests. Cancel some before sending more.";
    case 'addressee_not_found':   return 'That user no longer exists.';
    case 'invalid_addressee':     return 'Invalid user.';
    case 'unauthenticated':       return 'Please sign in again.';
    default:                      return 'Could not send friend request.';
  }
}

export async function sendFriendRequest(addresseeId: string): Promise<SendFriendRequestResult> {
  if (!supabase) return { ok: false, code: 'unknown', message: 'Not connected.' };

  const { error } = await supabase.rpc('send_friend_request', { p_addressee_id: addresseeId });

  if (!error) return { ok: true };

  const code = classifySendError(error);
  return { ok: false, code, message: friendlyMessage(code) };
}

/**
 * Cancel an outbound pending request, decline an inbound pending request,
 * or unfriend an accepted friendship.  All three flows DELETE the same row;
 * the RLS DELETE policy ("either party can delete") permits it.
 */
export async function deleteFriendship(friendshipId: string): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Not connected.' };
  const { error } = await supabase.from('friendships').delete().eq('id', friendshipId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
