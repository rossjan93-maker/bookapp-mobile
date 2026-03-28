/**
 * useUndoBar
 *
 * Lightweight hook that manages the in-screen undo bar state.
 *
 * Usage:
 *   const undo = useUndoBar();
 *   undo.trigger('Marked finished', handleUndo);  // shows bar, starts timer
 *   undo.trigger('Removed', handleUndo, () => router.back()); // navigate after dismiss
 *   undo.dismiss();                               // hides immediately
 *
 * The bar auto-dismisses after AUTO_DISMISS_MS.  Calling trigger() again
 * before the timer fires cancels the old timer and starts a fresh one, so
 * rapid sequential actions always get a full window.
 *
 * onAfterDismiss fires when the timer expires naturally (not when the user
 * taps Undo). Use it for deferred navigation so the bar stays visible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const AUTO_DISMISS_MS = 6000;

export type UndoBarState = {
  visible:  boolean;
  message:  string;
  trigger:  (message: string, onUndo: () => Promise<void> | void, onAfterDismiss?: () => void) => void;
  dismiss:  () => void;
  onUndo:   () => void;
};

export function useUndoBar(): UndoBarState {
  const [visible,  setVisible]  = useState(false);
  const [message,  setMessage]  = useState('');
  const undoFnRef        = useRef<(() => Promise<void> | void) | null>(null);
  const afterDismissRef  = useRef<(() => void) | null>(null);
  const timerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  }, []);

  const trigger = useCallback((
    msg: string,
    onUndo: () => Promise<void> | void,
    onAfterDismiss?: () => void,
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    undoFnRef.current       = onUndo;
    afterDismissRef.current = onAfterDismiss ?? null;
    setMessage(msg);
    setVisible(true);
    timerRef.current = setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
      // Fire the deferred action (e.g. navigate back) after the bar expires.
      if (afterDismissRef.current) {
        afterDismissRef.current();
        afterDismissRef.current = null;
      }
    }, AUTO_DISMISS_MS);
  }, []);

  const onUndo = useCallback(() => {
    // Cancel timer without firing afterDismiss — undo means we stay on screen.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    afterDismissRef.current = null;
    setVisible(false);
    if (undoFnRef.current) {
      void undoFnRef.current();
      undoFnRef.current = null;
    }
  }, []);

  // Clean up on unmount.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { visible, message, trigger, dismiss, onUndo };
}
