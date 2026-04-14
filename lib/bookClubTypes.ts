export type BookClubMemberRole = 'admin' | 'member';
export type BookClubBookStatus = 'active' | 'completed' | 'cancelled';

export type BookClub = {
  id:          string;
  name:        string;
  description: string | null;
  created_by:  string;
  created_at:  string;
};

export type BookClubMember = {
  id:        string;
  club_id:   string;
  user_id:   string;
  role:      BookClubMemberRole;
  joined_at: string;
};

export type BookClubBook = {
  id:                 string;
  club_id:            string;
  book_id:            string;
  selected_by:        string;
  total_pages:        number;
  target_finish_date: string | null;
  status:             BookClubBookStatus;
  created_at:         string;
};

export type BookClubComment = {
  id:             string;
  club_id:        string;
  club_book_id:   string;
  user_id:        string;
  body:           string;
  page_threshold: number;
  created_at:     string;
};

export type ClubWithDetails = BookClub & {
  memberCount:   number;
  activeBook: {
    id:                 string;
    book_id:            string;
    title:              string;
    author:             string;
    cover_url:          string | null;
    external_id:        string | null;
    total_pages:        number;
    target_finish_date: string | null;
  } | null;
};

export type MemberProgress = {
  userId:          string;
  displayName:     string;
  percentComplete: number;
};

export type CommentWithAuthor = BookClubComment & {
  author: {
    username:   string;
    first_name: string | null;
    last_name:  string | null;
  } | null;
};
