export type ProfileLike = {
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
};

/**
 * Returns the best display name for a profile.
 * Priority: "First Last" → "First" → username → "Unknown"
 */
export function getDisplayName(
  profile: ProfileLike | null | undefined,
): string {
  if (!profile) return "Unknown";
  const first = profile.first_name?.trim() || null;
  const last = profile.last_name?.trim() || null;
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  return profile.username?.trim() || "Unknown";
}

/**
 * Returns first name if available, else username.
 * Use in conversational / social contexts: "Sarah recommended…"
 */
export function getFirstName(profile: ProfileLike | null | undefined): string {
  if (!profile) return "Unknown";
  const first = profile.first_name?.trim() || null;
  if (first) return first;
  return profile.username?.trim() || "Unknown";
}

/**
 * Returns the uppercase initial for avatar display.
 */
export function getInitial(profile: ProfileLike | null | undefined): string {
  return getDisplayName(profile).charAt(0).toUpperCase();
}
