import { Actions } from "./shared/messages/backgroundActions";
import { startCanvasSkeleton, stopCanvasSkeleton } from "./utils/canvasNativeSkeleton";
import { WORKFLOW_SELECTORS } from "./utils/selectors";
import { mwtLog, mwtWarn } from "./shared/debug";

// ── Icons ─────────────────────────────────────────────────────────────────

const CODE_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M6.4 5.9L3.2 10L6.4 14.1" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.6 5.9L16.8 10L13.6 14.1" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.55 3.8L8.45 16.2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;

// ── State ─────────────────────────────────────────────────────────────────

let toolbarButton: HTMLButtonElement | null = null;
let embeddedPanel: HTMLElement | null = null;
let isOpen = false;
let dockObserver: MutationObserver | null = null;
let dockTimer = 0;
let isApplyingDockReservation = false;
let lastAppliedCanvasReserve = -1;
let lastAppliedMessageBarReserve = -1;
const DOCK_JITTER_THRESHOLD = 4;

// ── Code View lifecycle state ──────────────────────────────────────────────

type CodeViewSource = 'workflow-clientdata' | 'current-draft' | 'latest-server-side' | 'published-live' | 'live-store' | 'unknown';

interface CodeViewState {
  isOpen: boolean;
  isOpening: boolean;
  isDirty: boolean;
  source: CodeViewSource;
  versionNumber?: number;
  definitionHash?: string;
}

let codeViewState: CodeViewState = {
  isOpen: false,
  isOpening: false,
  isDirty: false,
  source: 'unknown',
};

// ── Lifecycle logging ──────────────────────────────────────────────────────

function logCodeViewLifecycle(event: string, extra: Record<string, unknown> = {}): void {
  mwtLog('[CodeViewLifecycle]', {
    event,
    codeViewOpen: codeViewState.isOpen,
    codeViewOpening: codeViewState.isOpening,
    codeViewDirty: codeViewState.isDirty,
    source: codeViewState.source,
    definitionHash: codeViewState.definitionHash,
    hasVersionHistoryPanel: !!document.querySelector(WORKFLOW_SELECTORS.versionHistoryPanel),
    hasActivityPanel: !!document.querySelector(WORKFLOW_SELECTORS.activityPanel),
    ...extra,
  });
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function qs<T extends Element = Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}


function isElementVisible(el: Element | null): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  );
}

function clickElement(el: HTMLElement | null): boolean {
  if (!el || !isElementVisible(el)) return false;
  el.click();
  return true;
}

// ── Style injection ───────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById("mwt-styles")) return;
  const style = document.createElement("style");
  style.id = "mwt-styles";
  style.textContent = `
    [data-mwt-btn] {
      transition: background 0.12s ease, color 0.12s ease !important;
    }
    [data-mwt-btn][data-active="true"] {
      background: rgba(0, 120, 212, 0.10) !important;
      color: #0078d4 !important;
    }
    #mwt-panel {
      border-radius: 14px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 100;
      contain: layout style;
      isolation: isolate;
      box-sizing: border-box;
    }

    #mwt-panel-resize {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 5px;
      cursor: col-resize;
      z-index: 10;
    }
    #mwt-panel-resize:hover,
    #mwt-panel-resize:active {
      background: var(--colorBrandBackground, rgba(72, 88, 235, 0.20));
      opacity: 0.25;
    }
    #mwt-panel iframe {
      flex: 1 1 auto;
      min-height: 0;
      border: none;
      width: 100%;
      display: block;
      background: transparent;
      border-radius: inherit;
      overflow: hidden;
    }
    #mwt-toast {
      position: fixed;
      bottom: 72px;
      left: 20px;
      background: #323130;
      color: #fff;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0,0,0,.2);
      transition: opacity 0.3s;
    }
    /* Applied during Node Panel → Code View handoff to eliminate layout glitches */
    body.mwt-handoff-no-transition,
    body.mwt-handoff-no-transition * {
      transition: none !important;
      animation-duration: 0.001ms !important;
    }
  `;
  document.head.appendChild(style);
}

// ── Canvas-relative layout ────────────────────────────────────────────────

function getCodeViewPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-mwt-code-view-panel="true"]');
}

function getWorkflowCanvasEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="workflow-canvas"]');
}

// ── Warning bar inline reservation ────────────────────────────────────────

function applyMessageBarReservation(): void {
  const canvas = getWorkflowCanvasEl();
  if (!canvas || !canvas.classList.contains('mwt-code-view-open')) return;
  const panel = getCodeViewPanel();
  if (!panel) return;
  const panelRect = panel.getBoundingClientRect();
  document.querySelectorAll<HTMLElement>('[data-testid="designer-message-bar-group"]').forEach(group => {
    if (panelRect.width <= 0 || panelRect.left <= 0) return;

    const groupRect = group.getBoundingClientRect();

    if (groupRect.width <= 0 || groupRect.left <= 0) return;

    const targetWidth = Math.floor(panelRect.left - groupRect.left - 16);

    if (targetWidth < 240) return;
    group.style.setProperty('width', `${targetWidth}px`, 'important');
    group.style.setProperty('max-width', `${targetWidth}px`, 'important');
    group.style.setProperty('max-inline-size', `${targetWidth}px`, 'important');
    group.style.setProperty('right', 'auto', 'important');
    group.style.setProperty('box-sizing', 'border-box', 'important');
    group.querySelectorAll<HTMLElement>('.fui-MessageBar').forEach(bar => {
      bar.style.setProperty('width', '100%', 'important');
      bar.style.setProperty('max-width', '100%', 'important');
      bar.style.setProperty('max-inline-size', '100%', 'important');
      bar.style.setProperty('box-sizing', 'border-box', 'important');
    });
  });
}

function removeMessageBarReservation(): void {
  const canvas = getWorkflowCanvasEl();
  if (!canvas) return;
  document.querySelectorAll<HTMLElement>('[data-testid="designer-message-bar-group"]').forEach(group => {
    group.style.removeProperty('width');
    group.style.removeProperty('max-width');
    group.style.removeProperty('max-inline-size');
    group.style.removeProperty('right');
    group.style.removeProperty('box-sizing');
    group.querySelectorAll<HTMLElement>('.fui-MessageBar').forEach(bar => {
      bar.style.removeProperty('width');
      bar.style.removeProperty('max-width');
      bar.style.removeProperty('max-inline-size');
      bar.style.removeProperty('box-sizing');
    });
  });
}

function scheduleMessageBarReservationBurst(): void {
  applyMessageBarReservation();
  requestAnimationFrame(applyMessageBarReservation);
  setTimeout(applyMessageBarReservation, 50);
  setTimeout(applyMessageBarReservation, 150);
  setTimeout(applyMessageBarReservation, 300);
  setTimeout(applyMessageBarReservation, 600);
}

let _mbObserver: MutationObserver | null = null;

function startMessageBarObserver(): void {
  if (_mbObserver) return;
  const canvas = getWorkflowCanvasEl();
  if (!canvas) return;
  _mbObserver = new MutationObserver(() => scheduleMessageBarReservationBurst());
  _mbObserver.observe(canvas, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
}

function stopMessageBarObserver(): void {
  if (_mbObserver) {
    _mbObserver.disconnect();
    _mbObserver = null;
  }
}

function applyCodeViewNativePanelLayout(): void {
  const panel = getCodeViewPanel();
  if (!panel) return;

  panel.style.position = 'absolute';
  panel.style.top = '27px';
  panel.style.right = '20px';
  panel.style.bottom = '20px';
  panel.style.left = 'auto';
  panel.style.width = '400px';
  panel.style.height = 'auto';
  panel.style.maxHeight = 'none';
  panel.style.padding = '0';
  panel.style.boxSizing = 'border-box';
  panel.style.zIndex = '100';

  mwtLog('[MWT_CODEVIEW_LAYOUT]', { event: 'applied', position: 'absolute', top: 27, right: 20, bottom: 20, width: 400 });
}

// ── Embedded panel ────────────────────────────────────────────────────────

function createEmbeddedPanel(envId: string, flowId: string): HTMLElement {
  const panel = document.createElement("div");
  panel.id = "mwt-panel";
  panel.setAttribute("data-glass", "proxy");
  panel.setAttribute("data-node-panel", "true");
  panel.setAttribute("data-mwt-code-view-panel", "true");
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Node configuration panel");
  panel.tabIndex = -1;

  const resizeHandle = document.createElement("div");
  resizeHandle.id = "mwt-panel-resize";

  const iframe = document.createElement("iframe");
  const params = new URLSearchParams({ envId, flowId, embedded: "true" });
  iframe.src = chrome.runtime.getURL(`app.html?${params}`);
  iframe.setAttribute("allow", "clipboard-read; clipboard-write");

  panel.appendChild(resizeHandle);
  panel.appendChild(iframe);

  makeResizable(panel, resizeHandle);

  return panel;
}

function makeResizable(panel: HTMLElement, grip: HTMLElement): void {
  grip.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    panel.style.transition = "none";

    const onMove = (e: MouseEvent) => {
      const rect = panel.getBoundingClientRect();
      const newW = Math.max(320, Math.min(window.innerWidth * 0.7, rect.right - e.clientX));
      panel.style.width = `${newW}px`;
    };
    const onUp = () => {
      panel.style.transition = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ── Canvas dock reservation ───────────────────────────────────────────────

let dockState: {
  canvasContainer: HTMLElement | null;
  canvasStyle: string | null;
  bodyStyle: string | null;
} | null = null;

const barOriginalStyles = new WeakMap<HTMLElement, {
  right: string; width: string; maxWidth: string; boxSizing: string;
}>();

function saveBarOriginals(bar: HTMLElement): void {
  if (barOriginalStyles.has(bar)) return;
  barOriginalStyles.set(bar, {
    right: bar.style.right,
    width: bar.style.width,
    maxWidth: bar.style.maxWidth,
    boxSizing: bar.style.boxSizing,
  });
}

function restoreBarOriginals(bar: HTMLElement): void {
  const orig = barOriginalStyles.get(bar);
  if (!orig) return;
  bar.style.right = orig.right;
  bar.style.width = orig.width;
  bar.style.maxWidth = orig.maxWidth;
  bar.style.boxSizing = orig.boxSizing;
  barOriginalStyles.delete(bar);
}

function getCanvasContainer(): HTMLElement | null {
  try {
    const section = document.querySelector("section:has(.react-flow)") as HTMLElement | null;
    if (section?.parentElement) {
      return section.parentElement as HTMLElement;
    }
  } catch {}

  const reactFlow = document.querySelector(".react-flow") as HTMLElement | null;
  if (!reactFlow) return null;

  return reactFlow.parentElement ?? null;
}

function getDesignerMessageBars(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="designer-message-bar-group"]')
  );
}

function isCodePanelVisible(): boolean {
  const panel = document.getElementById("mwt-panel") as HTMLElement | null;
  if (!panel) return false;
  const rect = panel.getBoundingClientRect();
  const style = window.getComputedStyle(panel);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function getCodePanelLeft(): number {
  const panel = document.getElementById("mwt-panel") as HTMLElement | null;
  if (!panel) return window.innerWidth;
  const rect = panel.getBoundingClientRect();
  const style = window.getComputedStyle(panel);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    rect.width <= 0 ||
    rect.height <= 0
  ) return window.innerWidth;
  return rect.left;
}

function getCodePanelReserve(): number {
  const codeLeft = getCodePanelLeft();
  if (codeLeft >= window.innerWidth) return 0;
  return Math.ceil(window.innerWidth - codeLeft + 14);
}

function applyDockReservation(): void {
  if (isApplyingDockReservation) return;
  if (!isCodePanelVisible()) return;

  isApplyingDockReservation = true;

  try {
    const reserve = getCodePanelReserve();

    const canvasChanged = Math.abs(reserve - lastAppliedCanvasReserve) > DOCK_JITTER_THRESHOLD;
    const messageBarChanged = Math.abs(reserve - lastAppliedMessageBarReserve) > DOCK_JITTER_THRESHOLD;

    if (!canvasChanged && !messageBarChanged) return;

    lastAppliedCanvasReserve = reserve;
    lastAppliedMessageBarReserve = reserve;

    const canvasContainer = getCanvasContainer();

    if (!dockState) {
      dockState = {
        canvasContainer,
        canvasStyle: canvasContainer?.getAttribute("style") ?? null,
        bodyStyle: document.body.getAttribute("style"),
      };
    }

    if (canvasContainer) {
      const left = Math.round(canvasContainer.getBoundingClientRect().left || 0);
      canvasContainer.style.transition = "max-width 0.15s ease, padding-right 0.15s ease";
      canvasContainer.style.maxWidth = `calc(100vw - ${reserve + left}px)`;
      canvasContainer.style.overflowX = "hidden";
    } else {
      document.body.style.transition = "width 0.15s ease";
      document.body.style.width = `calc(100vw - ${reserve}px)`;
      document.body.style.overflowX = "hidden";
    }

    getDesignerMessageBars().forEach((bar) => {
      saveBarOriginals(bar);
      bar.style.setProperty("right", `${reserve}px`);
      bar.style.setProperty("box-sizing", "border-box");
      bar.style.removeProperty("width");
      bar.style.removeProperty("max-width");
    });
  } finally {
    isApplyingDockReservation = false;
  }
}

function removeDockReservation(): void {
  lastAppliedCanvasReserve = -1;
  lastAppliedMessageBarReserve = -1;

  getDesignerMessageBars().forEach(restoreBarOriginals);

  if (!dockState) return;
  const { canvasContainer, canvasStyle, bodyStyle } = dockState;

  if (canvasContainer) {
    if (canvasStyle === null) {
      canvasContainer.removeAttribute("style");
    } else {
      canvasContainer.setAttribute("style", canvasStyle);
    }
  }

  if (bodyStyle === null) {
    document.body.removeAttribute("style");
  } else {
    document.body.setAttribute("style", bodyStyle);
  }

  dockState = null;
}

function scheduleApplyDockReservation(): void {
  if (!isCodePanelVisible()) return;
  if (dockTimer) window.clearTimeout(dockTimer);
  dockTimer = window.setTimeout(() => {
    dockTimer = 0;
    window.requestAnimationFrame(() => applyDockReservation());
  }, 140);
}

function startDockObserver(): void {
  if (dockObserver) return;

  dockObserver = new MutationObserver((mutations) => {
    if (isApplyingDockReservation) return;

    let shouldSchedule = false;
    for (const mutation of mutations) {
      const target = mutation.target;
      if (!(target instanceof HTMLElement)) continue;

      const isMessageBar =
        target.matches?.('[data-testid="designer-message-bar-group"]') ||
        !!target.closest?.('[data-testid="designer-message-bar-group"]');

      if (isMessageBar || target.id === "mwt-panel") {
        shouldSchedule = true;
        break;
      }
    }

    if (shouldSchedule) scheduleApplyDockReservation();
  });

  dockObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "class", "data-testid", "aria-label", "role"],
  });

  scheduleApplyDockReservation();
}

function stopDockObserver(): void {
  if (dockObserver) {
    dockObserver.disconnect();
    dockObserver = null;
  }
  if (dockTimer) {
    window.clearTimeout(dockTimer);
    dockTimer = 0;
  }
}

function embedInCanvas(envId: string, flowId: string): void {
  if (document.getElementById("mwt-panel")) return;

  const panel = createEmbeddedPanel(envId, flowId);
  const workflowCanvas = getWorkflowCanvasEl();
  (workflowCanvas ?? document.body).appendChild(panel);
  applyCodeViewNativePanelLayout();
  workflowCanvas?.classList.add('mwt-code-view-open');
  applyMessageBarReservation();
  startMessageBarObserver();

  embeddedPanel = panel;
  isOpen = true;
  codeViewState = { ...codeViewState, isOpen: true, isOpening: true };
  updateButtonActive(true);
}

function setPanelVisible(visible: boolean): void {
  isOpen = visible;
  if (visible) {
    codeViewState = { ...codeViewState, isOpen: true, isOpening: true };
  } else {
    codeViewState = { ...codeViewState, isOpen: false, isOpening: false, isDirty: false };
  }
  updateButtonActive(visible);
  if (!embeddedPanel) return;
  embeddedPanel.style.display = visible ? "flex" : "none";
  if (visible) {
    applyCodeViewNativePanelLayout();
    getWorkflowCanvasEl()?.classList.add('mwt-code-view-open');
    applyMessageBarReservation();
    startMessageBarObserver();
  } else {
    stopMessageBarObserver();
    getWorkflowCanvasEl()?.classList.remove('mwt-code-view-open');
    removeMessageBarReservation();
  }
}

function showOrCreatePanel(envId: string, flowId: string): void {
  if (!embeddedPanel) {
    embedInCanvas(envId, flowId);
  } else {
    setPanelVisible(true);
  }
}

// ── Extension tooltip ─────────────────────────────────────────────────────

let extensionTooltipEl: HTMLDivElement | null = null;

function ensureExtensionTooltip(): HTMLDivElement {
  if (extensionTooltipEl) return extensionTooltipEl;

  const el = document.createElement('div');
  el.setAttribute('role', 'tooltip');
  el.setAttribute('data-mwt-tooltip', 'true');

  Object.assign(el.style, {
    position: 'fixed',
    padding: '4px 11px 6px',
    color: 'rgb(36, 36, 36)',
    backgroundColor: 'rgb(255, 255, 255)',
    border: '1.11111px solid rgba(0, 0, 0, 0)',
    borderRadius: '12px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.14)',
    fontFamily: '"Segoe UI Variable", "Segoe UI Variable Text", "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif',
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: '400',
    whiteSpace: 'nowrap',
    overflow: 'visible',
    pointerEvents: 'none',
    zIndex: '2147483647',
    display: 'none',
  });

  document.body.appendChild(el);
  extensionTooltipEl = el;
  return el;
}

function showExtensionTooltip(target: HTMLElement, text: string): void {
  const tooltip = ensureExtensionTooltip();
  const rect = target.getBoundingClientRect();
  const hasSpaceAbove = rect.top >= 32;

  tooltip.textContent = text;
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top = `${hasSpaceAbove ? rect.top - 4 : rect.bottom + 4}px`;
  tooltip.style.transform = hasSpaceAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
  tooltip.style.display = 'block';
}

function hideExtensionTooltip(): void {
  if (extensionTooltipEl) {
    extensionTooltipEl.style.display = 'none';
  }
}

function attachExtensionTooltip(target: HTMLElement, text: string): void {
  target.removeAttribute('title');
  if (!target.getAttribute('aria-label')) target.setAttribute('aria-label', text);

  target.addEventListener('mouseenter', () => showExtensionTooltip(target, text));
  target.addEventListener('mouseleave', hideExtensionTooltip);
  target.addEventListener('focus', () => showExtensionTooltip(target, text));
  target.addEventListener('blur', hideExtensionTooltip);
}

// ── Toolbar button ────────────────────────────────────────────────────────

function findCanvasToolbar(): HTMLElement | null {
  return document.querySelector(
    ".react-flow__panel.bottom.left .fui-Toolbar"
  ) as HTMLElement | null;
}

function injectToolbarButton(toolbar: HTMLElement): void {
  if (toolbar.querySelector("[data-mwt-btn]")) return;

  const sibling = toolbar.querySelector("button");
  const btn = document.createElement("button");
  if (sibling) btn.className = sibling.className;

  btn.setAttribute("data-mwt-btn", "");
  btn.setAttribute("aria-label", "Code view");
  btn.setAttribute("type", "button");

  const iconSpan = document.createElement("span");
  const siblingIcon = sibling?.querySelector("span");
  if (siblingIcon) iconSpan.className = siblingIcon.className;
  iconSpan.innerHTML = CODE_ICON_SVG;

  btn.appendChild(iconSpan);
  btn.addEventListener("click", (e) => onToolbarButtonClick(e));
  attachExtensionTooltip(btn, "Code view");
  toolbar.appendChild(btn);

  toolbarButton = btn;
}

function updateButtonActive(active: boolean): void {
  if (!toolbarButton) return;
  toolbarButton.setAttribute("data-active", active ? "true" : "false");
}

function observeToolbar(): void {
  const tryInject = () => {
    const toolbar = findCanvasToolbar();
    if (toolbar) injectToolbarButton(toolbar);
  };
  tryInject();
  const observer = new MutationObserver(tryInject);
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Toast ─────────────────────────────────────────────────────────────────

function showToast(message: string): void {
  const existing = document.getElementById("mwt-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "mwt-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Panel message bridge ──────────────────────────────────────────────────

function sendMessageToPanel(msg: object): void {
  const panel = document.getElementById('mwt-panel');
  const iframe = panel?.querySelector('iframe') as HTMLIFrameElement | null;
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage(msg, '*');
  }
}

// ── MAIN world bridge — forwards apply requests to interceptor.ts ─────────────
// Fiber discovery runs only in MAIN world (interceptor.ts) where __reactFiber$
// expando properties are visible. Content script (isolated world) just bridges.

function sendApplyToCanvasMainWorld(graph: unknown): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2) + Date.now();
    const timeoutHandle = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Apply to canvas timed out (no response from page bridge)'));
    }, 10000);

    function onMessage(event: MessageEvent): void {
      if (event.source !== window) return;
      if (event.data?.type !== 'MWT_APPLY_TO_CANVAS_RESPONSE') return;
      if (event.data?.requestId !== requestId) return;
      window.clearTimeout(timeoutHandle);
      window.removeEventListener('message', onMessage);
      if (event.data.success) {
        resolve(event.data.result);
      } else {
        reject(new Error(event.data.error ?? 'Apply to canvas failed'));
      }
    }

    mwtLog('[MWT_APPLY_TO_CANVAS_BRIDGE]', {
      event: 'request-sent',
      requestId,
      nodeCount: (graph as any)?.nodes?.length,
      edgeCount: (graph as any)?.edges?.length,
    });

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'MWT_APPLY_TO_CANVAS_REQUEST', requestId, graph }, '*');
  });
}

// ── Copilot Studio live store bridge (isolated → MAIN world) ─────────────────
// Store-based Code View path: load/apply go through the live in-page clientdata
// resolved by interceptor.ts. Host branch is absolute — the store path only runs
// on copilotstudio.microsoft.com; it never falls back to the API/token path.

function isCopilotStudioHost(): boolean {
  return window.location.hostname.toLowerCase().includes('copilotstudio.microsoft.com');
}

function sendCsStoreMainWorld(
  requestType: 'MWT_CS_STORE_GET_REQUEST' | 'MWT_CS_STORE_APPLY_REQUEST',
  responseType: 'MWT_CS_STORE_GET_RESPONSE' | 'MWT_CS_STORE_APPLY_RESPONSE',
  extra: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (!isCopilotStudioHost()) {
      reject(new Error(
        'The Copilot Studio live store path is only available on copilotstudio.microsoft.com.'
      ));
      return;
    }

    const requestId = Math.random().toString(36).slice(2) + Date.now();
    const timeoutHandle = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(
        'Unable to access Copilot Studio live workflow state. Make sure the workflow designer is open and fully loaded.'
      ));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (event.source !== window) return;
      if (event.data?.type !== responseType) return;
      if (event.data?.requestId !== requestId) return;
      window.clearTimeout(timeoutHandle);
      window.removeEventListener('message', onMessage);
      if (event.data.success) {
        resolve(event.data.payload ?? event.data.result);
      } else {
        reject(new Error(event.data.error ?? 'Copilot Studio live store request failed'));
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ type: requestType, requestId, ...extra }, '*');
  });
}

// ── Version History helpers ───────────────────────────────────────────────

function closeVersionHistoryIfOpen(): boolean {
  const panel = qs<HTMLElement>(WORKFLOW_SELECTORS.versionHistoryPanel);
  if (!isElementVisible(panel)) return false;
  const closeBtn = qs<HTMLElement>(WORKFLOW_SELECTORS.versionHistoryClose);
  const closed = clickElement(closeBtn);
  logCodeViewLifecycle('version-history-close-requested', { closed });
  return closed;
}

// ── Native node panel detection & close ──────────────────────────────────

function getNativeNodePanelElement(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="node-panel"], [data-testid*="node-panel"], [data-testid*="nodePanel"]'
    )
  );

  // Also check for complementary/aside panels that look like node config panels
  const genericCandidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="complementary"], aside'
    )
  ).filter(el => {
    const text = (el.textContent ?? '').toLowerCase();
    return (
      text.includes('node name') ||
      text.includes('inputs') ||
      text.includes('outputs') ||
      text.includes('compose')
    );
  });

  const all = [...candidates, ...genericCandidates];
  return all.find(el => isElementVisible(el) && !el.id.startsWith('mwt-')) ?? null;
}

function hasNativeNodePanelOpen(): boolean {
  return getNativeNodePanelElement() !== null;
}

function closeNativeNodePanelIfOpen(): boolean {
  const panel = getNativeNodePanelElement();
  if (!panel) return false;

  const closeButton: HTMLElement | null =
    panel.querySelector<HTMLElement>('button[aria-label="Close"]') ||
    panel.querySelector<HTMLElement>('button[title="Close"]') ||
    (Array.from(panel.querySelectorAll<HTMLElement>('button')).find(btn => {
      const label = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('title') ||
        btn.textContent ||
        ''
      ).trim().toLowerCase();
      return label === 'close' || label === 'chiudi' || label.includes('close');
    }) ?? null);

  if (closeButton && isElementVisible(closeButton)) {
    closeButton.click();
    logCodeViewLifecycle('native-node-panel-close-clicked');
    return true;
  }

  // fallback: Escape if no close button found
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }));
  logCodeViewLifecycle('native-node-panel-close-fallback-escape');
  return true;
}

// ── Handoff timing helpers ────────────────────────────────────────────────

function waitAnimationFrames(count: number): Promise<void> {
  return new Promise<void>(resolve => {
    const step = () => {
      count--;
      if (count <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function waitUntilNativeNodePanelClosed(timeoutMs = 800): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const panel = getNativeNodePanelElement();
    if (!panel || !isElementVisible(panel) || panel.getBoundingClientRect().width < 20) {
      return true;
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  mwtWarn('[CodeViewLifecycle] node-panel-close-timeout — proceeding anyway');
  return false;
}

// Prevent canvas-node pointerdown events from re-selecting a node and reopening its panel
// during the handoff window (set for ~600 ms after Code View opens).
let suppressNativePanelReopen = false;

document.addEventListener('pointerdown', (e: PointerEvent) => {
  if (!suppressNativePanelReopen) return;
  const target = e.target as HTMLElement | null;
  if (
    target?.closest?.('.react-flow__node') ||
    target?.closest?.('.react-flow__edge')
  ) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);

async function closeNativePanelsBeforeOpeningCodeView(): Promise<void> {
  document.body.classList.add('mwt-handoff-no-transition');

  closeVersionHistoryIfOpen();
  const hadNodePanel = closeNativeNodePanelIfOpen();

  if (hadNodePanel) {
    // Wait for the panel to actually disappear from the viewport.
    await waitUntilNativeNodePanelClosed(800);
  }

  // Let the layout fully settle before we measure for Code View.
  await waitAnimationFrames(2);

  logCodeViewLifecycle('native-panels-closed-before-codeview-open', {
    hasNativeNodePanel: hasNativeNodePanelOpen(),
  });
}

// ── Apply-completed / restore-refetch coordination ───────────────────────

let applyCompletedResolve: ((success: boolean) => void) | null = null;
let restoreRefetchResolve: ((data: unknown) => void) | null = null;

function waitForApplyCompleted(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    applyCompletedResolve = resolve;
    window.setTimeout(() => {
      if (applyCompletedResolve === resolve) {
        applyCompletedResolve = null;
        resolve(false);
      }
    }, 15000);
  });
}

function waitForRestoreRefetch(): Promise<any> {
  return new Promise<any>(resolve => {
    restoreRefetchResolve = resolve;
    window.setTimeout(() => {
      if (restoreRefetchResolve === resolve) {
        restoreRefetchResolve = null;
        resolve(null);
      }
    }, 15000);
  });
}

// ── Dirty guard dialog ────────────────────────────────────────────────────

type DirtyDecision = 'save' | 'discard' | 'cancel';

function promptSaveDiscardCancel(): Promise<DirtyDecision> {
  return new Promise<DirtyDecision>(resolve => {
    const existing = document.getElementById('mwt-dirty-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mwt-dirty-dialog';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.32)',
      zIndex: '2147483640',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    });

    const dialog = document.createElement('div');
    Object.assign(dialog.style, {
      background: '#fff',
      borderRadius: '16px',
      padding: '28px 28px 24px',
      maxWidth: '360px',
      width: 'calc(100vw - 48px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    });

    const title = document.createElement('div');
    Object.assign(title.style, {
      fontSize: '16px',
      fontWeight: '600',
      color: '#242424',
      lineHeight: '22px',
    });
    title.textContent = 'Unapplied changes';

    const body = document.createElement('div');
    Object.assign(body.style, {
      fontSize: '14px',
      color: '#484848',
      lineHeight: '20px',
    });
    body.textContent = 'You have unapplied changes in the Code View. What would you like to do?';

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
    });

    function makeBtn(label: string, primary: boolean): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      Object.assign(btn.style, {
        padding: '7px 16px',
        borderRadius: '8px',
        border: primary ? 'none' : '1px solid #d1d1d1',
        background: primary ? '#0078d4' : 'transparent',
        color: primary ? '#fff' : '#242424',
        fontSize: '14px',
        fontWeight: '600',
        cursor: 'pointer',
        fontFamily: 'inherit',
      });
      return btn;
    }

    const cleanup = (decision: DirtyDecision) => {
      overlay.remove();
      resolve(decision);
    };

    const cancelBtn = makeBtn('Cancel', false);
    const discardBtn = makeBtn('Discard', false);
    const saveBtn = makeBtn('Apply to canvas', true);

    cancelBtn.addEventListener('click', () => cleanup('cancel'));
    discardBtn.addEventListener('click', () => cleanup('discard'));
    saveBtn.addEventListener('click', () => cleanup('save'));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup('cancel'); });

    actions.appendChild(cancelBtn);
    actions.appendChild(discardBtn);
    actions.appendChild(saveBtn);
    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

// ── After-restore refetch ─────────────────────────────────────────────────

async function performAfterRestoreRefetch(): Promise<void> {
  logCodeViewLifecycle('after-restore-refetch-started');
  startCanvasSkeleton({ minVisibleMs: 1500 });
  try {
    sendMessageToPanel({ type: 'panel-action', action: 'background-refetch' });
    const result = await waitForRestoreRefetch();
    logCodeViewLifecycle('after-restore-refetch-completed', {
      source: (result as any)?.resolved?.source,
      definitionHash: (result as any)?.resolved?.definitionHash,
    });
  } catch (e) {
    console.error('[CodeViewLifecycle]', 'after-restore-refetch-error', e);
  } finally {
    await stopCanvasSkeleton({ minVisibleMs: 1500 });
  }
}

function scheduleAfterRestoreRefetch(): void {
  window.setTimeout(() => {
    performAfterRestoreRefetch().catch(e => {
      console.error('[CodeViewLifecycle]', 'after-restore-refetch-error', e);
    });
  }, 800);
}

// ── Toolbar button click handler ──────────────────────────────────────────

function onToolbarButtonClick(e: MouseEvent): void {
  // Prevent the click from propagating to canvas node-selection handlers.
  e.stopPropagation();
  e.stopImmediatePropagation();
  void handleToolbarButtonClick();
}

async function handleToolbarButtonClick(): Promise<void> {
  if (isOpen) {
    logCodeViewLifecycle('close-requested-by-toolbar');
    if (codeViewState.isDirty) {
      const decision = await promptSaveDiscardCancel();
      if (decision === 'cancel') return;
      if (decision === 'save') {
        sendMessageToPanel({ type: 'panel-action', action: 'apply' });
        const ok = await waitForApplyCompleted();
        if (!ok) return;
      }
      setPanelVisible(false);
      logCodeViewLifecycle('closed', { reason: 'toolbar-toggle' });
    } else {
      setPanelVisible(false);
      logCodeViewLifecycle('closed', { reason: 'toolbar-toggle' });
    }
    return;
  }

  const url = window.location.href;
  const envMatch = /environments\/([a-zA-Z0-9\-]+)/i.exec(url);
  const flowMatch = /flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url);

  if (!envMatch || !flowMatch) {
    showToast("Save the workflow first to enable Code View.");
    return;
  }

  logCodeViewLifecycle('open-requested', {
    hasNativeNodePanel: hasNativeNodePanelOpen(),
    hasVersionHistoryPanel: !!document.querySelector(WORKFLOW_SELECTORS.versionHistoryPanel),
  });

  // Step 1: close native panels and wait until they're actually gone.
  await closeNativePanelsBeforeOpeningCodeView();

  // Step 2: show Code View while transitions are still suppressed.
  chrome.runtime.sendMessage({
    type: "toggle-panel",
    envId: envMatch[1],
    flowId: flowMatch[1],
  } as Actions);

  showOrCreatePanel(envMatch[1], flowMatch[1]);

  // Step 3: wait 2 more frames for Code View layout to settle before re-enabling transitions.
  await waitAnimationFrames(2);
  document.body.classList.remove('mwt-handoff-no-transition');

  // Step 4: suppress canvas-node pointerdown for ~600 ms so native focus-restore
  // cannot reopen the node panel while the Code View guard is still initialising.
  suppressNativePanelReopen = true;
  window.setTimeout(() => { suppressNativePanelReopen = false; }, 600);

  logCodeViewLifecycle('codeview-refetch-started', { reason: 'code-view-open' });
  sendMessageToPanel({ type: 'panel-action', action: 'refetch' });
}

// ── Message listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (_action: Actions, _sender, sendResponse) => {
    sendResponse();
  }
);

// ── Panel iframe messages ─────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent) => {
  if (e.data?.type === 'MWT_CODEVIEW_REFETCH_COMPLETED') {
    const resolved = (e.data.resolved ?? {}) as { source?: CodeViewSource; definitionHash?: string };

    if (codeViewState.isOpening) {
      codeViewState = {
        ...codeViewState,
        isOpen: true,
        isOpening: false,
        source: resolved.source ?? 'unknown',
        definitionHash: resolved.definitionHash,
      };
      logCodeViewLifecycle('codeview-opened', { source: resolved.source, definitionHash: resolved.definitionHash });
    }

    if (restoreRefetchResolve) {
      restoreRefetchResolve(e.data);
      restoreRefetchResolve = null;
    }

    return;
  }

  if (e.data?.type !== "mwt-panel-action") return;

  switch (e.data.action) {
    case 'close':
      if (codeViewState.isDirty) {
        (async () => {
          const decision = await promptSaveDiscardCancel();
          if (decision === 'cancel') return;
          if (decision === 'save') {
            sendMessageToPanel({ type: 'panel-action', action: 'apply' });
            const ok = await waitForApplyCompleted();
            if (!ok) return;
          }
          setPanelVisible(false);
          logCodeViewLifecycle('closed', { reason: 'close-button' });
        })();
      } else {
        setPanelVisible(false);
        logCodeViewLifecycle('closed', { reason: 'close-button' });
      }
      break;

    case 'dirty-changed':
      codeViewState = { ...codeViewState, isDirty: !!e.data.isDirty };
      logCodeViewLifecycle(e.data.isDirty ? 'dirty-true' : 'dirty-false');
      break;

    case 'apply-completed':
      if (applyCompletedResolve) {
        applyCompletedResolve(!!e.data.success);
        applyCompletedResolve = null;
      }
      if (codeViewState.isOpen) scheduleMessageBarReservationBurst();
      break;

    case 'get-current-graph': {
      // Debug helper — forwards to MAIN world bridge where Fiber is accessible.
      const requestId = e.data.requestId;
      const debugId = Math.random().toString(36).slice(2);
      function onDebugMsg(ev: MessageEvent): void {
        if (ev.source !== window) return;
        if (ev.data?.type !== 'MWT_APPLY_TO_CANVAS_RESPONSE' || ev.data?.requestId !== debugId) return;
        window.removeEventListener('message', onDebugMsg);
      }
      window.addEventListener('message', onDebugMsg);
      window.postMessage({ type: 'MWT_PAGE_BRIDGE_PING' }, '*');
      sendMessageToPanel({ type: 'panel-action', action: 'current-graph', requestId, graph: null });
      break;
    }

    case 'cs-store-get': {
      const requestId = e.data.requestId;
      void sendCsStoreMainWorld('MWT_CS_STORE_GET_REQUEST', 'MWT_CS_STORE_GET_RESPONSE', {}, 12000).then(
        (payload) => {
          sendMessageToPanel({ type: 'panel-action', action: 'cs-store-get-result', requestId, success: true, payload });
        },
        (err: Error) => {
          console.error('[MWT_CS_STORE_BRIDGE]', { event: 'get-failed', requestId, error: err.message });
          sendMessageToPanel({ type: 'panel-action', action: 'cs-store-get-result', requestId, success: false, error: err.message });
        }
      );
      break;
    }

    case 'cs-store-apply': {
      const requestId = e.data.requestId;
      void sendCsStoreMainWorld('MWT_CS_STORE_APPLY_REQUEST', 'MWT_CS_STORE_APPLY_RESPONSE', { payload: e.data.payload }, 20000).then(
        (result) => {
          sendMessageToPanel({ type: 'panel-action', action: 'cs-store-apply-result', requestId, success: true, result });
        },
        (err: Error) => {
          console.error('[MWT_CS_STORE_BRIDGE]', { event: 'apply-failed', requestId, error: err.message });
          sendMessageToPanel({ type: 'panel-action', action: 'cs-store-apply-result', requestId, success: false, error: err.message });
        }
      );
      break;
    }

    case 'apply-to-canvas': {
      const requestId = e.data.requestId;
      const graph = e.data.graph;
      void sendApplyToCanvasMainWorld(graph).then(
        (_result) => {
          mwtLog('[MWT_APPLY_TO_CANVAS_BRIDGE]', { event: 'response-received', requestId, success: true });
          sendMessageToPanel({ type: 'panel-action', action: 'canvas-apply-result', requestId, success: true });
        },
        (err: Error) => {
          console.error('[MWT_APPLY_TO_CANVAS_BRIDGE]', { event: 'response-received', requestId, success: false, error: err.message });
          sendMessageToPanel({ type: 'panel-action', action: 'canvas-apply-result', requestId, success: false, error: err.message });
        }
      );
      break;
    }
  }
});

// ── DOM capture listeners ─────────────────────────────────────────────────

// Restore button: schedule after-restore refetch. Dirty guard is handled by the outside guard.
document.addEventListener('click', (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;
  const restoreItem = target?.closest?.(WORKFLOW_SELECTORS.versionRestore) as HTMLElement | null;
  if (!restoreItem) return;

  logCodeViewLifecycle('version-restore-clicked', {
    restoreTestId: restoreItem.getAttribute('data-testid'),
    codeViewOpen: codeViewState.isOpen,
  });

  // If Code View is still open, the outside guard is handling it — skip here.
  if (codeViewState.isOpen) return;

  scheduleAfterRestoreRefetch();
}, true);

// ── Outside Code View interaction guard ──────────────────────────────────

let bypassOutsideCodeViewGuard = false;
// Blocks the click event that fires after a pointerdown interception during the dirty dialog.
let blockNextClickDuringDialog = false;

document.addEventListener('click', (e: MouseEvent) => {
  if (blockNextClickDuringDialog) {
    e.stopImmediatePropagation();
    e.preventDefault();
    blockNextClickDuringDialog = false;
  }
}, true);

function isInsideCodeViewPanel(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return Boolean(
    el.closest('#mwt-panel') ||
    el.closest('.monaco-editor') ||
    el.closest('.monaco-menu') ||
    el.closest('.suggest-widget') ||
    el.closest('.editor-widget') ||
    el.closest('.context-view') ||
    el.closest('.monaco-hover') ||
    el.closest('#mwt-panel-resize') ||
    // Toolbar toggle button has its own handler — let it manage open/close.
    el.closest('[data-mwt-btn]')
  );
}

function isInsideNativeModalOrDialogEl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return Boolean(
    el.closest('#mwt-dirty-dialog') ||
    el.closest('[data-testid="designer-message-bar-group"]') ||
    el.closest('[role="dialog"]') ||
    el.closest('[data-testid*="dialog"]') ||
    el.closest('.fui-Dialog__surface') ||
    el.closest('.fui-Popover__surface') ||
    el.closest('.fui-Menu__popover')
  );
}


async function handleOutsideCodeViewInteraction(event: PointerEvent): Promise<void> {
  if (bypassOutsideCodeViewGuard) return;
  if (!codeViewState.isOpen) return;

  const target = event.target as HTMLElement | null;

  if (isInsideCodeViewPanel(target)) return;
  if (isInsideNativeModalOrDialogEl(target)) return;

  logCodeViewLifecycle('outside-interaction-detected', {
    codeViewDirty: codeViewState.isDirty,
    targetTag: target?.tagName,
    targetText: target?.textContent?.trim().slice(0, 80),
  });

  if (!codeViewState.isDirty) {
    setPanelVisible(false);
    logCodeViewLifecycle('closed', { reason: 'outside-interaction-clean' });
    return;
  }

  // Block the click that will follow this pointerdown, then show the dialog.
  blockNextClickDuringDialog = true;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const originalTarget = target;
  const decision = await promptSaveDiscardCancel();

  if (decision === 'cancel') {
    blockNextClickDuringDialog = false;
    logCodeViewLifecycle('outside-interaction-cancelled-dirty');
    return;
  }

  if (decision === 'save') {
    logCodeViewLifecycle('dirty-apply-started', { reason: 'outside-interaction' });
    sendMessageToPanel({ type: 'panel-action', action: 'apply' });
    const success = await waitForApplyCompleted();
    if (!success) {
      logCodeViewLifecycle('dirty-apply-failed', { reason: 'outside-interaction' });
      return;
    }
    logCodeViewLifecycle('dirty-apply-completed', { reason: 'outside-interaction' });
  } else {
    sendMessageToPanel({ type: 'panel-action', action: 'discard' });
  }

  setPanelVisible(false);
  logCodeViewLifecycle('closed', { reason: 'outside-interaction-after-decision', decision });

  if (originalTarget) {
    bypassOutsideCodeViewGuard = true;
    window.setTimeout(() => {
      try {
        originalTarget.click();
      } finally {
        window.setTimeout(() => { bypassOutsideCodeViewGuard = false; }, 0);
      }
    }, 0);
  }
}

document.addEventListener(
  'pointerdown',
  (event: PointerEvent) => { void handleOutsideCodeViewInteraction(event); },
  true
);

// ── Init ──────────────────────────────────────────────────────────────────

injectStyles();
observeToolbar();
