// ─── Onboarding instrumentation ───────────────────────────────────────────────
//
// Logs structured events to console with [ONBOARDING] prefix.
// All events include a timestamp so timing analysis is possible.
// Wire to an external analytics service (PostHog, Amplitude, etc.) by replacing
// the _track() body — the public API surface stays the same.

type OnboardingEvent =
  | 'onboarding_started'
  | 'step_viewed'
  | 'step_completed'
  | 'step_skipped'
  | 'taste_question_answered'
  | 'taste_questions_skipped'
  | 'anchor_book_searched'
  | 'anchor_book_selected'
  | 'anchor_book_skipped'
  | 'walkthrough_panel_viewed'
  | 'finish_later_tapped'
  | 'onboarding_completed'
  | 'first_rec_saved';

type EventProps = Record<string, string | number | boolean | null>;

let _sessionStart: number | null = null;

function _track(event: OnboardingEvent, props: EventProps = {}): void {
  console.log(`[ONBOARDING] ${event}`, { ...props, ts: new Date().toISOString() });
}

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
  _track('walkthrough_panel_viewed', { panelIdx });
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
