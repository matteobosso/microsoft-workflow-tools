// Global logging gate. Default off. Toggle at runtime in any page context via
// `window.__MWT_DEBUG__ = true` or `localStorage.setItem('MWT_DEBUG', '1')`.
// Service worker context (background.ts) has no window/localStorage, so it
// only honors the MWT_DEBUG constant below.
export const MWT_DEBUG = false;

export function mwtDebugEnabled(): boolean {
  if (MWT_DEBUG) return true;
  try {
    if (typeof window !== 'undefined') {
      if ((window as any).__MWT_DEBUG__ === true) return true;
      if (window.localStorage?.getItem('MWT_DEBUG') === '1') return true;
    }
  } catch {
    // ignore — e.g. localStorage access blocked
  }
  return false;
}

export function mwtLog(...args: unknown[]): void {
  if (mwtDebugEnabled()) console.log(...args);
}

export function mwtWarn(...args: unknown[]): void {
  if (mwtDebugEnabled()) console.warn(...args);
}

export function mwtInfo(...args: unknown[]): void {
  if (mwtDebugEnabled()) console.info(...args);
}
