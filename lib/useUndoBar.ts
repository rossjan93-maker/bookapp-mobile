/**
 * useUndoBar
 *
 * Lightweight hook that manages the in-screen undo bar state.
 *
 * Usage:
 *   const undo = useUndoBar();
 *   undo.trigger('Marked finished', handleUndo);  // shows bar, starts timer
 *   undo.dismiss();                               // hides immediately
 *
 * The bar auto-dismisses after AUTO_DISMISS_MS.  Calling trigger() again
 * before the timer fires cancels the old timer and starts a fresh one, so
 * rapid sequential actions always get a full window.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const AUTO_DISMISS_MS = 6000;

export type UndoBarState = {
  visible:  boolean;
  message:  string;
  trigger:  (message: string, onUndo: () => Promise<void> | void) => void;
  dismiss:  () => void;
  onUndo:   () => void;
};

export function useUndoBar(): UndoBarState {
  const [visible,  setVisible]  = useState(false);
  const [message,  setMessage]  = useState('');
  const undoFnRef = useRef<(() => Promise<void> | void) | null>(null);
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  }, []);

  const trigger = useCallback((msg: string, onUndo: () => Promise<void> | void) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    undoFnRef.current = onUndo;
    setMessage(msg);
    setVisible(true);
    timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS);
  }, [dismiss]);

  const onUndo = useCallback(() => {
    dismiss();
    if (undoFnRef.current) {
      void undoFnRef.current();
      undoFnRef.current = null;
    }
  }, [dismiss]);

  // Clean up on unmount.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { visible, message, trigger, dismiss, onUndo };
}
