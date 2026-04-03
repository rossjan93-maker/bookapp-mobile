export type ToastVariant = 'success' | 'error' | 'info';

export type ToastOptions = {
  message: string;
  variant?: ToastVariant;
  action?: { label: string; onPress: () => void };
};

type ToastListener = (opts: ToastOptions) => void;

let _listener: ToastListener | null = null;

export function registerToastListener(fn: ToastListener) {
  _listener = fn;
}

export function unregisterToastListener() {
  _listener = null;
}

export function showToast(opts: ToastOptions | string) {
  const resolved: ToastOptions =
    typeof opts === 'string' ? { message: opts, variant: 'success' } : opts;
  _listener?.(resolved);
}
