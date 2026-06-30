const STYLE_ID = 'mwt-canvas-native-skeleton-style';
const ROOT_CLASS = 'mwt-native-skeleton-root';
const REVEAL_CLASS = 'mwt-native-skeleton-reveal';
const NODE_OVERLAY_CLASS = 'mwt-node-native-skeleton';
const ATTR_SKELETONIZED = 'data-mwt-skeletonized';
const ATTR_PREV_POS = 'data-mwt-prev-pos';

let activeRoot: Element | null = null;
let activeSince = 0;
let storedMinVisibleMs = 1000;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes mwtNativeSkeletonShimmer {
      0%   { transform: translateX(-120%); opacity: 0; }
      20%  { opacity: .55; }
      60%  { opacity: .55; }
      100% { transform: translateX(120%); opacity: 0; }
    }

    @keyframes mwtNativeCanvasReveal {
      from { opacity: .42; filter: blur(.6px); }
      to   { opacity: 1; filter: blur(0); }
    }

    .${ROOT_CLASS} .react-flow__node,
    .${ROOT_CLASS} .xyflow__node {
      pointer-events: none !important;
    }

    .${ROOT_CLASS} .react-flow__node > :not(.${NODE_OVERLAY_CLASS}),
    .${ROOT_CLASS} .xyflow__node > :not(.${NODE_OVERLAY_CLASS}) {
      opacity: 0 !important;
      visibility: hidden !important;
    }

    .${NODE_OVERLAY_CLASS} {
      position: absolute !important;
      inset: 0 !important;
      z-index: 999 !important;
      display: flex !important;
      align-items: center !important;
      box-sizing: border-box !important;
      padding: 14px 18px !important;
      border: 1px solid #e6e6e6 !important;
      border-radius: 16px !important;
      background: rgba(255,255,255,.92) !important;
      box-shadow: 0 1px 2px rgba(0,0,0,.035) !important;
      overflow: hidden !important;
    }

    .${NODE_OVERLAY_CLASS}::after {
      content: "" !important;
      position: absolute !important;
      top: 0 !important;
      bottom: 0 !important;
      left: 0 !important;
      width: 65% !important;
      background: linear-gradient(
        90deg,
        transparent 0%,
        rgba(255,255,255,.25) 22%,
        rgba(255,255,255,.72) 50%,
        rgba(255,255,255,.25) 78%,
        transparent 100%
      ) !important;
      animation: mwtNativeSkeletonShimmer 1.15s ease-in-out infinite !important;
      pointer-events: none !important;
    }

    .mwt-sk-icon {
      flex: 0 0 auto !important;
      width: 30px !important;
      height: 30px !important;
      border-radius: 999px !important;
      background: #eeeeee !important;
      margin-right: 18px !important;
    }

    .mwt-sk-lines {
      flex: 1 1 auto !important;
      min-width: 0 !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 8px !important;
    }

    .mwt-sk-line {
      height: 9px !important;
      border-radius: 999px !important;
      background: #eeeeee !important;
    }

    .mwt-sk-line.primary   { width: min(54%, 130px) !important; }
    .mwt-sk-line.secondary { width: min(34%, 86px) !important; height: 8px !important; }
    .mwt-sk-line.tertiary  { width: min(46%, 112px) !important; height: 8px !important; opacity: .72 !important; }

    .${ROOT_CLASS} .react-flow__edge-path,
    .${ROOT_CLASS} .xyflow__edge-path,
    .${ROOT_CLASS} .react-flow__connection-path,
    .${ROOT_CLASS} .xyflow__connection-path {
      stroke: #d8d8d8 !important;
      stroke-width: 1.4px !important;
      opacity: .50 !important;
    }

    .${ROOT_CLASS} .react-flow__edge-text,
    .${ROOT_CLASS} .xyflow__edge-text,
    .${ROOT_CLASS} .react-flow__edgelabel-renderer,
    .${ROOT_CLASS} .xyflow__edgelabel-renderer {
      opacity: 0 !important;
      visibility: hidden !important;
    }

    .${ROOT_CLASS} .react-flow__handle,
    .${ROOT_CLASS} .xyflow__handle {
      background: #d8d8d8 !important;
      border-color: #d8d8d8 !important;
      opacity: .72 !important;
    }

    .${REVEAL_CLASS} .react-flow__node,
    .${REVEAL_CLASS} .xyflow__node,
    .${REVEAL_CLASS} .react-flow__edge,
    .${REVEAL_CLASS} .xyflow__edge {
      animation: mwtNativeCanvasReveal 190ms ease-out both !important;
    }
  `;

  document.head.appendChild(style);
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 200 && r.height > 200;
}

function findCanvasRoot(): Element | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('.react-flow, .xyflow'))
    .filter(isVisible);
  if (!candidates.length) return null;

  return candidates
    .map(el => ({ el, area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
    .sort((a, b) => b.area - a.area)[0].el;
}

function getNodes(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.react-flow__node, .xyflow__node'))
    .filter(node => {
      const r = node.getBoundingClientRect();
      return r.width > 40 && r.height > 28;
    });
}

function ensureNodeOverlay(node: HTMLElement): void {
  if (node.getAttribute(ATTR_SKELETONIZED) === '1') return;

  const computed = getComputedStyle(node);
  if (computed.position === 'static') {
    node.setAttribute(ATTR_PREV_POS, node.style.position ?? '');
    node.style.position = 'absolute';
  }

  const rect = node.getBoundingClientRect();
  const lineCount = rect.height >= 86 ? 3 : 2;

  const overlay = document.createElement('div');
  overlay.className = NODE_OVERLAY_CLASS;
  overlay.setAttribute('aria-hidden', 'true');

  const icon = document.createElement('div');
  icon.className = 'mwt-sk-icon';

  const lines = document.createElement('div');
  lines.className = 'mwt-sk-lines';

  const primary = document.createElement('div');
  primary.className = 'mwt-sk-line primary';
  lines.appendChild(primary);

  const secondary = document.createElement('div');
  secondary.className = 'mwt-sk-line secondary';
  lines.appendChild(secondary);

  if (lineCount >= 3) {
    const tertiary = document.createElement('div');
    tertiary.className = 'mwt-sk-line tertiary';
    lines.appendChild(tertiary);
  }

  overlay.appendChild(icon);
  overlay.appendChild(lines);
  node.appendChild(overlay);

  node.setAttribute(ATTR_SKELETONIZED, '1');
}

function removeNodeOverlay(node: HTMLElement): void {
  node.querySelectorAll<HTMLElement>(`.${NODE_OVERLAY_CLASS}`).forEach(el => el.remove());

  const prevPos = node.getAttribute(ATTR_PREV_POS);
  if (prevPos !== null) {
    node.style.position = prevPos;
    node.removeAttribute(ATTR_PREV_POS);
  }

  node.removeAttribute(ATTR_SKELETONIZED);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function startCanvasSkeleton(options: { minVisibleMs?: number } = {}): boolean {
  ensureStyle();

  const root = findCanvasRoot();
  if (!root) return false;

  storedMinVisibleMs = options.minVisibleMs ?? 1000;
  activeRoot = root;
  activeSince = performance.now();

  root.classList.remove(REVEAL_CLASS);
  root.classList.add(ROOT_CLASS);

  getNodes(root).forEach(ensureNodeOverlay);
  return true;
}

export async function stopCanvasSkeleton(options: { minVisibleMs?: number } = {}): Promise<boolean> {
  const root = activeRoot ?? findCanvasRoot();
  if (!root) return false;

  const minMs = options.minVisibleMs ?? storedMinVisibleMs ?? 1000;
  const elapsed = performance.now() - activeSince;
  const remaining = Math.max(0, minMs - elapsed);

  if (remaining > 0) await sleep(remaining);

  root.classList.remove(ROOT_CLASS);
  root.classList.add(REVEAL_CLASS);

  getNodes(root).forEach(removeNodeOverlay);

  await sleep(220);

  root.classList.remove(REVEAL_CLASS);
  activeRoot = null;
  activeSince = 0;
  return true;
}

export async function runCanvasSkeleton(durationMs = 1000): Promise<boolean> {
  const ok = startCanvasSkeleton({ minVisibleMs: durationMs });
  if (!ok) return false;
  return stopCanvasSkeleton({ minVisibleMs: durationMs });
}

export function cleanupCanvasSkeleton(): void {
  document.querySelectorAll<HTMLElement>(`.${NODE_OVERLAY_CLASS}`).forEach(el => el.remove());

  document.querySelectorAll<Element>(`.${ROOT_CLASS}, .${REVEAL_CLASS}`).forEach(root => {
    root.classList.remove(ROOT_CLASS, REVEAL_CLASS);
  });

  document.querySelectorAll<HTMLElement>('.react-flow__node, .xyflow__node').forEach(removeNodeOverlay);

  document.getElementById(STYLE_ID)?.remove();

  activeRoot = null;
  activeSince = 0;
}
