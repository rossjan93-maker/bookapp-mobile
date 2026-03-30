// ─── Onboarding & rec-entry instrumentation ───────────────────────────────────
//
// Two phases:
//   Phase 1 — Welcome screen (app/onboarding.tsx)
//   Phase 2 — In-app guided walkthrough (WalkthroughOverlay + _layout.tsx)
//   Phase 3 — Recommendations entry (first visit to recs tab)
//
// Wire to PostHog/Amplitude/etc. by replacing _track() body.

type OnboardingEvent =
  // ── Phase 1: welcome screen ───────────────────────────────────────────────
  | 'welcome_started'
  | 'welcome_completed'
  | 'welcome_skipped'
  | 'welcome_handoff_started'
  | 'welcome_handoff_completed'
  | 'welcome_handoff_failed'
  // ── Phase 1 legacy aliases (kept for backward compat) ─────────────────────
  | 'intro_started'
  | 'intro_slide_viewed'
  | 'intro_completed'
  | 'intro_skipped'
  | 'intro_handoff_started'
  | 'intro_handoff_completed'
  | 'intro_handoff_failed'
  // ── Phase 2: in-app walkthrough ───────────────────────────────────────────
  | 'walkthrough_started'
  | 'walkthrough_step_viewed'
  | 'walkthrough_step_completed'
  | 'walkthrough_completed'
  | 'walkthrough_skipped'
  | 'walkthrough_import_tapped'
  // ── Phase 3: recommendations entry ───────────────────────────────────────
  | 'rec_entry_shown'
  | 'rec_entry_import_tapped'
  | 'rec_entry_intake_started'
  | 'rec_entry_intake_completed'
  | 'rec_entry_intake_skipped'
  | 'rec_entry_explore_tapped'
  // ── Quick intake sub-events ───────────────────────────────────────────────
  | 'intake_taste_answered'
  | 'intake_taste_skipped'
  | 'intake_anchor_searched'
  | 'intake_anchor_selected'
  | 'intake_anchor_skipped'
  // ── Legacy (kept for compat with existing call sites) ─────────────────────
  | 'onboarding_started'
  | 'step_viewed'
  | 'step_completed'
  | 'step_skipped'
  | 'taste_question_answered'
  | 'taste_questions_skipped'
  | 'anchor_book_searched'
  | 'anchor_book_selected'
  | 'anchor_book_skipped'
  | 'finish_later_tapped'
  | 'onboarding_completed'
  | 'first_rec_saved';

type EventProps = Record<string, string | number | boolean | null>;

let _sessionStart: number | null = null;

function _track(event: OnboardingEvent, props: EventProps = {}): void {
  console.log(`[ONBOARDING] ${event}`, { ...props, ts: new Date().toISOString() });
}

// ─── Phase 1: welcome screen ──────────────────────────────────────────────────

export function welcomeEvt_started(): void {
  _sessionStart = Date.now();
  _track('welcome_started');
}

export function welcomeEvt_completed(): void {
  const durationMs = _sessionStart !== null ? Date.now() - _sessionStart : -1;
  _track('welcome_completed', { durationMs });
}

export function welcomeEvt_skipped(): void {
  const durationMs = _sessionStart !== null ? Date.now() - _sessionStart : -1;
  _track('welcome_skipped', { durationMs });
}

export function welcomeEvt_handoffStarted(): void {
  _track('welcome_handoff_started');
}

export function welcomeEvt_handoffCompleted(): void {
  _track('welcome_handoff_completed');
}

export function welcomeEvt_handoffFailed(reason: string): void {
  _track('welcome_handoff_failed', { reason });
}

// ─── Phase 1: intro prelude (legacy aliases) ──────────────────────────────────

export function introEvt_started(): void {
  _sessionStart = Date.now();
  _track('intro_started');
}

export function introEvt_slideViewed(idx: number): void {
  _track('intro_slide_viewed', { idx });
}

export function introEvt_completed(): void {
  const durationMs = _sessionStart !== null ? Date.now() - _sessionStart : -1;
  _track('intro_completed', { durationMs });
}

export function introEvt_skipped(): void {
  const durationMs = _sessionStart !== null ? Date.now() - _sessionStart : -1;
  _track('intro_skipped', { durationMs });
}

export function introEvt_handoffStarted(): void {
  _track('intro_handoff_started');
}

export function introEvt_handoffCompleted(): void {
  _track('intro_handoff_completed');
}

export function introEvt_handoffFailed(reason: string): void {
  _track('intro_handoff_failed', { reason });
}

// ─── Phase 2: in-app walkthrough ─────────────────────────────────────────────

export function wtStart(): void {
  _sessionStart = Date.now();
  _track('walkthrough_started');
}

export function wtStepView(slideIdx: number): void {
  _track('walkthrough_step_viewed', { slideIdx });
}

export function wtComplete(): void {
  const durationMs = _sessionStart !== null ? Date.now() - _sessionStart : -1;
  _track('walkthrough_completed', { durationMs });
}

export function wtSkip(slideIdx: number): void {
  _track('walkthrough_skipped', { slideIdx });
}

export function wtImportTapped(): void {
  _track('walkthrough_import_tapped');
}

// ─── Phase 3: recommendations entry ──────────────────────────────────────────

export function reEntryShown(): void {
  _track('rec_entry_shown');
}

export function reImportTapped(): void {
  _track('rec_entry_import_tapped');
}

export function reIntakeStarted(): void {
  _track('rec_entry_intake_started');
}

export function reIntakeCompleted(genreCount: number, tasteAnswers: number, hasAnchor: boolean): void {
  _track('rec_entry_intake_completed', { genreCount, tasteAnswers, hasAnchor });
}

export function reIntakeSkipped(atStep: string): void {
  _track('rec_entry_intake_skipped', { atStep });
}

export function reExploreTapped(): void {
  _track('rec_entry_explore_tapped');
}

// ─── Quick intake sub-events ──────────────────────────────────────────────────

export function riTasteAnswered(questionId: string, answerKey: string): void {
  _track('intake_taste_answered', { questionId, answerKey });
}

export function riTasteSkipped(): void {
  _track('intake_taste_skipped');
}

export function riAnchorSearched(): void {
  _track('intake_anchor_searched');
}

export function riAnchorSelected(title: string): void {
  _track('intake_anchor_selected', { title });
}

export function riAnchorSkipped(): void {
  _track('intake_anchor_skipped');
}

// ─── Legacy helpers (called by existing screens — kept for compat) ─────────────

export function obStart(): void {
  _sessionStart = Date.now();
  _track('onboarding_started');
}

export function obStepView(step: string, stepNum: number | null = null): void {
  _track('step_viewed', { step, stepNum });
}

export function obStepComplete(step: string, stepNum: number | null = null, skipped = false): void {
  _track(skipped ? 'step_skipped' : 'step_completed', { step, stepNum });
}

export function obTasteAnswer(questionId: string, answerKey: string): void {
  _track('taste_question_answered', { questionId, answerKey });
}

export function obTasteSkipped(remaining: number): void {
  _track('taste_questions_skipped', { remaining });
}

export function obAnchorBook(action: 'searched' | 'selected' | 'skipped', title?: string): void {
  _track(
    action === 'searched' ? 'anchor_book_searched'
      : action === 'selected' ? 'anchor_book_selected'
      : 'anchor_book_skipped',
    title ? { title } : {},
  );
}

export function obWalkthroughPanel(panelIdx: number): void {
  _track('walkthrough_step_viewed', { slideIdx: panelIdx });
}

export function obFinishLater(step: string): void {
  _track('finish_later_tapped', { step });
}

export function obComplete(savedRecs: number): void {
  const durationMs = _sessionStart !== null ? Date.now() - _sessionStart : -1;
  _track('onboarding_completed', { savedRecs, durationMs });
}

export function obRecSaved(bookTitle: string): void {
  _track('first_rec_saved', { bookTitle });
}
