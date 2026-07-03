// Runs in ISOLATED world at document_idle, on make.powerautomate.com / make.powerapps.com
// only (see manifest.json). Fully parallel to content.ts: separate file, separate bundle,
// own DOM ids/classes (mwt-pa-v3-*), own message namespace (MWT_PA_V3_*). Does not import
// from, call into, or share module state with content.ts / interceptor.ts.
//
// Never initializes unless a Flow Designer v3 route is detected AND the native
// designerHostContextStore can be found through React Fiber (see interceptorPaV3.ts).
// There is no silent PATCH/reload fallback for Apply to canvas — if the store can't be
// found, the user gets a hard error message and nothing is written.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// editor.api is core-only: without the JSON language contribution the 'json' model silently
// falls back to plaintext tokenization and every token renders black. Importing the
// contribution directly guarantees registration in this content-script bundle instead of
// relying on MonacoWebpackPlugin rewiring the editor.api import.
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import {
  PA_V3_ACTIVE_CLASS,
  PA_V3_CONTROL_BUTTON_ID,
  PA_V3_DIRTY_DIALOG_ID,
  PA_V3_MONACO_HOST_ID,
  PA_V3_PANEL_ID,
  PA_V3_PANEL_MESSAGE_HOST_ID,
  PA_V3_STYLE_TAG_ID,
  PaV3EditorPayload,
} from './pa-v3/types';
import { mwtLog } from './shared/debug';

// Worker resolution must be set before any Monaco worker is requested. Workers are emitted
// by MonacoWebpackPlugin into dist/ alongside contentPaV3.js and are web-accessible
// resources (see manifest.json), so they can be loaded from the host page's origin.
(self as any).MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string): string {
    if (label === 'json') return chrome.runtime.getURL('json.worker.js');
    return chrome.runtime.getURL('editor.worker.js');
  },
};

// ── Host / route detection ─────────────────────────────────────────────────

function isPowerPlatformMakerHost(): boolean {
  const host = window.location.hostname;
  return host.includes('make.powerautomate.com') || host.includes('make.powerapps.com');
}

function looksLikeFlowDesignerRoute(): boolean {
  return window.location.pathname.includes('/flows/');
}

// A run-review URL (.../flows/{id}/runs/{runId}) also contains "/flows/", so
// looksLikeFlowDesignerRoute() alone can't distinguish it from the editable designer route —
// Code View must never be injected there since there is no live editable canvas/store on a
// run page.
function isPowerAutomateRunView(): boolean {
  return window.location.pathname.includes('/runs/') || window.location.href.includes('/runs/');
}

// react-flow was renamed to @xyflow/react; depending on the designer's bundled version the
// controls container carries either the legacy `react-flow__controls` class or the newer
// `xyflow__controls` one. Support both (canvasNativeSkeleton.ts does the same for CS).
function findControlsContainer(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.react-flow__controls') ||
    document.querySelector<HTMLElement>('.xyflow__controls')
  );
}

// ── MAIN-world bridge ──────────────────────────────────────────────────────

function requestFromMainWorld<TResponse extends { type: string; requestId: string }>(
  request: { type: string; requestId: string; [key: string]: unknown },
  responseType: string,
  timeoutMs = 5000
): Promise<TResponse> {
  return new Promise<TResponse>((resolve, reject) => {
    const timeoutHandle = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for Power Automate v3 bridge response'));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (event.source !== window) return;
      if (event.data?.type !== responseType) return;
      if (event.data?.requestId !== request.requestId) return;
      window.clearTimeout(timeoutHandle);
      window.removeEventListener('message', onMessage);
      resolve(event.data as TResponse);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(request, '*');
  });
}

function newRequestId(): string {
  return Math.random().toString(36).slice(2) + Date.now();
}

let storeProbeCache: { at: number; found: boolean } | null = null;
const STORE_PROBE_TTL_MS = 2000;

async function probeDesignerStore(): Promise<boolean> {
  if (storeProbeCache && Date.now() - storeProbeCache.at < STORE_PROBE_TTL_MS) {
    return storeProbeCache.found;
  }
  try {
    const result = await requestFromMainWorld<{ type: string; requestId: string; found: boolean }>(
      { type: 'MWT_PA_V3_STORE_PROBE', requestId: newRequestId() },
      'MWT_PA_V3_STORE_PROBE_RESULT',
      3000
    );
    storeProbeCache = { at: Date.now(), found: result.found };
    return result.found;
  } catch {
    storeProbeCache = { at: Date.now(), found: false };
    return false;
  }
}

async function fetchPayloadFromMainWorld(): Promise<
  { success: true; payload: PaV3EditorPayload; isGraphBacked: boolean } | { success: false; error: string }
> {
  const result = await requestFromMainWorld<any>(
    { type: 'MWT_PA_V3_GET_PAYLOAD_REQUEST', requestId: newRequestId() },
    'MWT_PA_V3_GET_PAYLOAD_RESPONSE',
    5000
  );
  if (!result.success) return { success: false, error: result.error ?? 'Unknown error' };
  return { success: true, payload: result.payload, isGraphBacked: Boolean(result.isGraphBacked) };
}

async function applyPayloadToMainWorld(
  payload: PaV3EditorPayload
): Promise<{ success: boolean; error?: string; readbackVerified?: boolean; canvasVerified?: boolean }> {
  const result = await requestFromMainWorld<any>(
    { type: 'MWT_PA_V3_APPLY_REQUEST', requestId: newRequestId(), payload },
    'MWT_PA_V3_APPLY_RESPONSE',
    10000
  );
  return {
    success: Boolean(result.success),
    error: result.error,
    readbackVerified: result.readbackVerified,
    canvasVerified: result.canvasVerified,
  };
}

// ── Graph metadata policy (PA v3) ───────────────────────────────────────────
// definition.actions (plus nesting and runAfter) is the sole source of truth for Apply.
// Copilot-Studio-derived graph metadata (triggers[..].metadata.associatedData.graph /
// nodeActionMapping) is non-authoritative in PA v3: it stays exactly where — and as — the
// user leaves it inside definition.triggers, is never normalized, synchronized, or validated
// on Apply, and is never invented for native flows. PA v3 regenerates the canonical canvas
// layout from definition.actions alone.

// ── Clean display projection (spec: don't expose environment/solution parameter data,
// endpoint signatures, or unrelated metadata by default) ────────────────────────────────

// Tool-schema marker for the editor payload root — identifies this as an MWT PA v3 clean
// projection, distinct from (and unrelated to) the Logic Apps `definition.$schema` nested
// inside it.
const PA_V3_TOOL_SCHEMA = 'https://power-automate-tools.local/flow-editor.json#';

interface PaV3CleanProjection {
  $schema: string;
  connectionReferences: Record<string, unknown>;
  definition: {
    $schema?: unknown;
    contentVersion?: unknown;
    triggers: unknown;
    actions: unknown;
  };
}

// No root graph / nodeActionMapping aliases: those fields are non-authoritative in PA v3
// (see graph metadata policy above), so the edit payload omits them rather than presenting
// them as editable. Any graph metadata a flow carries is still visible — untouched — nested
// inside definition.triggers.
function buildCleanProjection(payload: PaV3EditorPayload): PaV3CleanProjection {
  const definition = payload.definition as any;
  return {
    $schema: PA_V3_TOOL_SCHEMA,
    connectionReferences: payload.connectionReferences ?? {},
    definition: {
      $schema: definition?.$schema,
      contentVersion: definition?.contentVersion,
      triggers: definition?.triggers,
      actions: definition?.actions,
    },
  };
}

interface ValidationResult {
  ok: boolean;
  blockingError?: string;
  warnings: string[];
}

function validatePaV3Payload(parsed: any): ValidationResult {
  const warnings: string[] = [];

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, blockingError: 'No definition object could be resolved from the JSON.', warnings };
  }

  const definition = parsed.definition;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { ok: false, blockingError: 'No definition object could be resolved from the JSON.', warnings };
  }

  if (!definition.triggers || typeof definition.triggers !== 'object' || Array.isArray(definition.triggers)) {
    return { ok: false, blockingError: 'definition.triggers is missing or is not an object.', warnings };
  }

  if (!definition.actions || typeof definition.actions !== 'object' || Array.isArray(definition.actions)) {
    return { ok: false, blockingError: 'definition.actions is missing or is not an object.', warnings };
  }

  const actionNames = Object.keys(definition.actions);
  for (const name of actionNames) {
    const runAfter = (definition.actions as Record<string, any>)[name]?.runAfter;
    if (!runAfter || typeof runAfter !== 'object') continue;
    for (const dep of Object.keys(runAfter)) {
      if (!actionNames.includes(dep)) {
        warnings.push(`Action "${name}" has runAfter referencing unknown action "${dep}".`);
      }
    }
  }

  // No graph validation of any kind: graph metadata is non-authoritative in PA v3 (see graph
  // metadata policy above) and definition.actions is the sole source of truth for Apply.

  return { ok: true, warnings };
}

// ── Styles (namespaced mwt-pa-v3-, spec sections 6 + 13) ──────────────────
// Single idempotent <style id="mwt-pa-v3-style"> tag — ensurePaV3Styles() creates it once and
// overwrites its textContent on every call, so re-running bootstrap (e.g. after an SPA
// navigation) never produces a second tag and never leaves stale CSS behind.

const PA_V3_CSS = `
    #${PA_V3_CONTROL_BUTTON_ID}.${PA_V3_ACTIVE_CLASS} {
      background: var(--colorNeutralBackground1Selected, #e5f1fb);
      color: var(--colorBrandForeground1, #0078d4);
    }

    /* Backstop for the inline fill:none on the icon paths — the native controls CSS fills
       svg/path inside control buttons, which turns the open chevron paths into solid
       triangle "shadows" behind the strokes. */
    #${PA_V3_CONTROL_BUTTON_ID} svg,
    #${PA_V3_CONTROL_BUTTON_ID} svg path {
      fill: none !important;
    }

    /* Native Fluent/Fabric panel shell — metrics measured on a live PA v3 native panel
       (644px main below the 48px top bar, white overlay, sticky 50px header container).
       Stable native class names (.ms-Panel, .ms-Overlay, ...) are used for structure only;
       all styling is pinned via these mwt-pa-v3-* companions since the hashed native
       classes (main-863, contentInner-866, ...) are not stable across MS deploys. */
    #${PA_V3_PANEL_ID}.mwt-pa-v3-panel {
      position: absolute !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      padding: 0 !important;
      margin: 0 !important;
      background: transparent !important;
      box-sizing: border-box !important;
      z-index: 100000 !important;
      color: #242424;
      font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-overlay {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      background-color: rgba(255, 255, 255, 0.4) !important;
      pointer-events: auto !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-main {
      position: absolute !important;
      top: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      left: auto !important;
      width: 644px !important;
      height: calc(100vh - 48px) !important;
      margin: 48px 0 0 0 !important;
      display: flex !important;
      flex-direction: column !important;
      background: rgb(255, 255, 255) !important;
      box-shadow: rgba(0, 0, 0, 0.22) 0px 25.6px 57.6px 0px,
                  rgba(0, 0, 0, 0.18) 0px 4.8px 14.4px 0px !important;
      box-sizing: border-box !important;
      overflow: visible !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-content-inner,
    #${PA_V3_PANEL_ID} .mwt-pa-v3-scrollable-content {
      display: flex !important;
      flex-direction: column !important;
      width: 644px !important;
      height: 100% !important;
      padding: 0 !important;
      margin: 0 !important;
      box-sizing: border-box !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-content-inner {
      overflow: auto hidden !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-scrollable-content {
      overflow: auto !important;
    }

    /* Native measures these at calc(100% - 15px) because its scrollableContent shows a
       real 15px scrollbar. Ours never scrolls (Monaco scrolls internally), so the carve-out
       would just leave a dead white strip on the right — use the full width instead. */
    #${PA_V3_PANEL_ID} .mwt-pa-v3-commands {
      display: block !important;
      position: sticky !important;
      top: 0 !important;
      width: 100% !important;
      height: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      background: rgb(255, 255, 255) !important;
      z-index: 1 !important;
      overflow: visible !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-header-container {
      display: block !important;
      position: sticky !important;
      top: 0 !important;
      width: 100% !important;
      height: 50px !important;
      padding: 14px 16px 4px 16px !important;
      margin: 0 !important;
      background: rgb(255, 255, 255) !important;
      box-sizing: border-box !important;
      z-index: 1 !important;
      overflow: visible !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-header {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      flex-direction: row !important;
      width: 100% !important;
      height: 32px !important;
      min-height: 32px !important;
      padding: 0 !important;
      margin: 0 !important;
      border: 0 !important;
      background: transparent !important;
      box-sizing: border-box !important;
      overflow: visible !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-header-left {
      display: flex !important;
      align-items: center !important;
      padding: 3px !important;
      margin: 0 0 0 -3px !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-title {
      font-size: 20px !important;
      font-weight: 600 !important;
      line-height: 20px !important;
      padding: 0 0 4px 0 !important;
      margin: 0 !important;
      color: rgb(0, 0, 0) !important;
      overflow: hidden !important;
      white-space: nowrap !important;
      text-overflow: ellipsis !important;
      font-family: "Segoe UI", "Segoe UI Web (West European)", -apple-system,
        BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-header-actions {
      display: flex !important;
      align-items: center !important;
      justify-content: flex-end !important;
      height: 32px !important;
      gap: 0 !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-icon-button {
      display: block !important;
      position: relative !important;
      width: 32px !important;
      height: 32px !important;
      min-width: 32px !important;
      min-height: 32px !important;
      padding: 0 4px !important;
      margin: 0 !important;
      border: 0 !important;
      border-radius: 2px !important;
      background: transparent !important;
      color: rgb(0, 102, 255) !important;
      box-shadow: none !important;
      box-sizing: border-box !important;
      cursor: pointer !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-icon-button:hover {
      background: rgb(243, 242, 241) !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-icon-button .ms-Button-flexContainer {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: 100% !important;
    }

    /* 20px (not the measured 16px): at 16px the check/X glyphs read visibly smaller than
       the native panel's header icons. 20px + 2px margins exactly fills the button's 24px
       content box (32px minus the 4px side paddings). */
    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-icon-button svg,
    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-icon-button i {
      width: 20px !important;
      height: 20px !important;
      font-size: 20px !important;
      line-height: 20px !important;
      color: rgb(0, 102, 255) !important;
      margin: 0 2px !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-panel-content {
      display: block !important;
      width: 100% !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      padding: 0 0 20px 0 !important;
      margin: 0 !important;
      box-sizing: border-box !important;
      overflow: visible !important;
    }

    #${PA_V3_PANEL_ID} .mwt-pa-v3-ba-panel-content {
      display: flex !important;
      flex-direction: column !important;
      width: 100% !important;
      height: 100% !important;
      min-height: 0 !important;
      padding: 0 16px !important;
      margin: 0 !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }

    #${PA_V3_PANEL_MESSAGE_HOST_ID} {
      flex: 0 0 auto;
    }

    #${PA_V3_MONACO_HOST_ID} {
      width: 100% !important;
      height: 100% !important;
      /* height: 100% doubles as the flex-basis; shrink (min-height: 0) keeps the editor
         inside the column when a message bar is shown above it. */
      flex: 1 1 auto;
      min-height: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
      position: relative;
      background: rgb(255, 255, 254) !important;
    }

    #${PA_V3_MONACO_HOST_ID} .monaco-editor,
    #${PA_V3_MONACO_HOST_ID} .monaco-editor .view-lines,
    #${PA_V3_MONACO_HOST_ID} .monaco-editor .margin-view-overlays {
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 18px;
    }

    /* Structural DOM matches native Fluent v9 (fui-MessageBar*) exactly, but v9 styling is
       applied via runtime-generated hashed Griffel classes that a synthetically-created DOM
       node never receives. These mwt-pa-v3-messagebar* rules reproduce the native computed
       styles (grid layout, colors, metrics) directly instead of relying on those hashed
       classes existing. Rendered inside #${PA_V3_PANEL_MESSAGE_HOST_ID} (panel-local, not a
       page-level bar) so it can never shift the canvas or .react-flow__controls. */
    .mwt-pa-v3-messagebar {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      align-items: center;
      min-height: 36px;
      padding: 0 0 0 12px;
      margin: 0;
      border-radius: 0;
      font-family: "Segoe UI Web (West European)", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif;
      font-size: 14px;
      line-height: 20px;
      color: #333333;
      box-shadow: none;
    }

    .mwt-pa-v3-messagebar-success {
      background: rgb(241, 250, 241);
      border-bottom: 1px solid rgb(159, 216, 159);
    }

    .mwt-pa-v3-messagebar-warning {
      background: rgb(255, 248, 240);
      border-bottom: 1px solid rgb(252, 225, 0);
    }

    .mwt-pa-v3-messagebar-error {
      background: rgb(253, 243, 244);
      border-bottom: 1px solid rgb(238, 172, 178);
    }

    .mwt-pa-v3-messagebar-icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      margin: 0 8px 0 0;
      font-size: 20px;
      line-height: 20px;
    }

    .mwt-pa-v3-messagebar-success .mwt-pa-v3-messagebar-icon {
      color: rgb(14, 112, 14);
    }

    .mwt-pa-v3-messagebar-warning .mwt-pa-v3-messagebar-icon {
      color: rgb(138, 97, 0);
    }

    .mwt-pa-v3-messagebar-error .mwt-pa-v3-messagebar-icon {
      color: rgb(188, 47, 50);
    }

    .mwt-pa-v3-messagebar-body {
      padding: 0 12px 0 0;
      line-height: 20px;
      color: rgb(51, 51, 51);
    }

    /* Empty by design (matches the native fui-MessageBarActions slot) — kept as a real grid
       cell, just collapsed to zero size, so the dismiss button still lands in the intended
       4th grid-template-columns track. */
    .mwt-pa-v3-messagebar-actions {
      width: 0;
      overflow: hidden;
    }

    .mwt-pa-v3-messagebar-dismiss {
      border: 0;
      background: transparent;
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: inherit;
      padding: 0;
    }
    .mwt-pa-v3-messagebar-dismiss:hover {
      background: rgba(0, 0, 0, 0.06);
    }

    /* Fluent's filled/regular icon swap-on-hover pattern: show the regular glyph at rest,
       swap to filled on hover — reproduced here since the real swap relies on Griffel state
       classes this synthetic DOM doesn't receive. */
    .mwt-pa-v3-messagebar-dismiss .fui-Button__icon .fui-Icon-filled {
      display: none;
    }
    .mwt-pa-v3-messagebar-dismiss:hover .fui-Button__icon .fui-Icon-filled {
      display: inline-flex;
    }
    .mwt-pa-v3-messagebar-dismiss:hover .fui-Button__icon .fui-Icon-regular {
      display: none;
    }

    /* ── Unsaved-changes guard: native Fabric ms-Dialog grammar (mwt-pa-v3-guard-*).
       Same principle as the panel shell — stable native class names for structure,
       styling pinned via these companions since hashed classes aren't stable. ── */
    #${PA_V3_DIRTY_DIALOG_ID}.mwt-pa-v3-guard-modal {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483640 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-family: "Segoe UI", "Segoe UI Web (West European)", -apple-system,
        BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-overlay {
      position: absolute !important;
      inset: 0 !important;
      background-color: rgba(0, 0, 0, 0.4) !important;
      pointer-events: auto !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-main {
      position: relative !important;
      display: flex !important;
      flex-direction: column !important;
      background: rgb(255, 255, 255) !important;
      box-shadow: rgba(0, 0, 0, 0.22) 0px 25.6px 57.6px 0px,
                  rgba(0, 0, 0, 0.18) 0px 4.8px 14.4px 0px !important;
      border-radius: 2px !important;
      min-width: 288px !important;
      max-width: 480px !important;
      max-height: calc(100% - 32px) !important;
      box-sizing: border-box !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-scrollable {
      flex-grow: 1 !important;
      overflow-y: auto !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-header {
      position: relative !important;
      width: 100% !important;
      box-sizing: border-box !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-title {
      font-size: 20px !important;
      font-weight: 600 !important;
      line-height: normal !important;
      color: rgb(50, 49, 48) !important;
      margin: 0 !important;
      padding: 16px 46px 20px 24px !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-top-button {
      position: absolute !important;
      top: 4px !important;
      right: 4px !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-close {
      width: 32px !important;
      height: 32px !important;
      padding: 0 4px !important;
      margin: 0 !important;
      border: 0 !important;
      border-radius: 2px !important;
      background: transparent !important;
      color: rgb(96, 94, 92) !important;
      cursor: pointer !important;
      box-sizing: border-box !important;
    }
    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-close:hover {
      background: rgb(243, 242, 241) !important;
      color: rgb(50, 49, 48) !important;
    }
    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-close .ms-Button-flexContainer {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: 100% !important;
    }
    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-close i {
      font-size: 16px !important;
      line-height: 16px !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-inner {
      padding: 0 24px 24px !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-subtext {
      margin: 0 0 24px !important;
      padding: 0 !important;
      font-size: 14px !important;
      font-weight: 400 !important;
      line-height: 20px !important;
      color: rgb(96, 94, 92) !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-actions {
      position: relative !important;
      width: 100% !important;
      min-height: 24px !important;
      margin: 0 !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-actions-right {
      display: flex !important;
      justify-content: flex-end !important;
      flex-wrap: wrap !important;
      gap: 8px !important;
      margin: 0 !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .ms-Dialog-action {
      margin: 0 !important;
      display: inline-block !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-primary,
    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-secondary {
      display: inline-block !important;
      min-width: 80px !important;
      height: 32px !important;
      padding: 0 16px !important;
      border-radius: 2px !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      font-family: inherit !important;
      text-align: center !important;
      cursor: pointer !important;
      box-sizing: border-box !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-primary {
      background: rgb(0, 102, 255) !important;
      border: 1px solid rgb(0, 102, 255) !important;
      color: rgb(255, 255, 255) !important;
    }
    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-primary:hover {
      background: rgb(0, 90, 224) !important;
      border-color: rgb(0, 90, 224) !important;
    }

    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-secondary {
      background: rgb(255, 255, 255) !important;
      border: 1px solid rgb(138, 136, 134) !important;
      color: rgb(50, 49, 48) !important;
    }
    #${PA_V3_DIRTY_DIALOG_ID} .mwt-pa-v3-guard-secondary:hover {
      background: rgb(243, 242, 241) !important;
    }
  `;

function ensurePaV3Styles(): void {
  let style = document.getElementById(PA_V3_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = PA_V3_STYLE_TAG_ID;
    document.head.appendChild(style);
  }
  style.textContent = PA_V3_CSS;
}

// ── Message bars — panel-local only ─────────────────────────────────────────
// Rendered into #${PA_V3_PANEL_MESSAGE_HOST_ID}, a real flex child inside the Code View panel
// (flex: 0 0 auto — see PA_V3_CSS). Earlier versions inserted a page-level
// .ba-Page-MessageBar container as a sibling of the canvas, which could push
// .react-flow__controls down whenever a message appeared. A panel-local host can never do
// that: it only ever affects layout inside the panel's own fixed-position box.

type MessageKind = 'success' | 'warning' | 'error';

const MESSAGE_DISMISS_IDS: Record<MessageKind, string> = {
  success: 'mwt_pa_v3_codeview_apply_success',
  warning: 'mwt_pa_v3_codeview_warning',
  error: 'mwt_pa_v3_codeview_error',
};

const MESSAGE_KIND_CLASS: Record<MessageKind, string> = {
  success: 'mwt-pa-v3-messagebar-success',
  warning: 'mwt-pa-v3-messagebar-warning',
  error: 'mwt-pa-v3-messagebar-error',
};

// Fluent UI System Icons paths (circle-check / warning-triangle / circle-dismiss, 20px grid) —
// used as the closest available equivalent since the live host's exact proprietary SVG
// markup isn't accessible from here; visually and structurally these match Fluent's message
// bar icon conventions.
const MESSAGE_ICON_PATHS: Record<MessageKind, string> = {
  success: '<path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm3.36 5.65a.5.5 0 0 0-.64-.06l-.07.06L9 11.3 7.35 9.65l-.07-.06a.5.5 0 0 0-.7.7l.07.07 2 2 .07.06c.17.11.4.11.56 0l.07-.06 4-4 .07-.08a.5.5 0 0 0-.06-.63Z" fill="currentColor"/>',
  warning: '<path d="M8.68 2.79a1.5 1.5 0 0 1 2.64 0l6.5 12A1.5 1.5 0 0 1 16.5 17h-13a1.5 1.5 0 0 1-1.32-2.21l6.5-12ZM10.5 7.5a.5.5 0 0 0-1 0v4a.5.5 0 0 0 1 0v-4Zm.25 6.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" fill="currentColor"/>',
  error: '<path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm2.85 10.15a.5.5 0 0 1-.7.7L10 10.71l-2.15 2.14a.5.5 0 0 1-.7-.7L9.29 10 7.15 7.85a.5.5 0 1 1 .7-.7L10 9.29l2.15-2.14a.5.5 0 0 1 .7.7L10.71 10l2.14 2.15Z" fill="currentColor"/>',
};

const DISMISS_ICON_REGULAR = '<path d="M4.09 4.22a.63.63 0 0 1 .88 0L10 9.25l5.03-5.03a.63.63 0 0 1 .88.88L10.88 10l5.03 5.03a.63.63 0 1 1-.88.88L10 10.88l-5.03 5.03a.63.63 0 0 1-.88-.88L9.12 10 4.09 4.97a.63.63 0 0 1 0-.75Z" fill="currentColor"/>';
const DISMISS_ICON_FILLED = '<path d="M4.16 4.16a.75.75 0 0 1 .98-.07l.08.07L10 8.94l4.78-4.78a.75.75 0 1 1 1.06 1.06L11.06 10l4.78 4.78a.75.75 0 0 1-.98 1.14l-.08-.07L10 11.06l-4.78 4.78a.75.75 0 0 1-1.14-.98l.07-.08L8.94 10 4.16 5.22a.75.75 0 0 1-.07-.98l.07-.08Z" fill="currentColor"/>';

function showPowerAutomateV3MessageBar(kind: MessageKind, text: string): void {
  ensurePaV3Styles();

  const host = panelRefs?.messageHost;
  if (!host) return;

  // Replace, never append — only one PA v3 Code View message is ever shown at a time.
  document.querySelectorAll('.mwt-pa-v3-messagebar').forEach(el => el.remove());

  const bar = document.createElement('div');
  bar.setAttribute('role', 'group');
  bar.className = `fui-MessageBar mwt-pa-v3-messagebar ${MESSAGE_KIND_CLASS[kind]}`;

  const icon = document.createElement('div');
  icon.className = 'fui-MessageBar__icon mwt-pa-v3-messagebar-icon';
  icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">${MESSAGE_ICON_PATHS[kind]}</svg>`;

  const body = document.createElement('div');
  body.className = 'fui-MessageBarBody mwt-pa-v3-messagebar-body';
  body.textContent = text;

  const actions = document.createElement('div');
  actions.className = 'fui-MessageBarActions mwt-pa-v3-messagebar-actions';

  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'fui-MessageBarActions__containerAction mwt-pa-v3-messagebar-containerAction';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'fui-Button mwt-pa-v3-messagebar-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.setAttribute('data-automation-id', MESSAGE_DISMISS_IDS[kind]);
  dismiss.addEventListener('click', () => bar.remove());

  const dismissIconSpan = document.createElement('span');
  dismissIconSpan.className = 'fui-Button__icon';
  dismissIconSpan.innerHTML =
    `<svg class="fui-Icon-filled" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">${DISMISS_ICON_FILLED}</svg>` +
    `<svg class="fui-Icon-regular" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">${DISMISS_ICON_REGULAR}</svg>`;
  dismiss.appendChild(dismissIconSpan);

  actionsContainer.appendChild(dismiss);

  bar.appendChild(icon);
  bar.appendChild(body);
  bar.appendChild(actions);
  bar.appendChild(actionsContainer);
  host.appendChild(bar);
}

// ── Panel skeleton (spec section 4) ────────────────────────────────────────

interface PaV3PanelRefs {
  panel: HTMLElement;
  monacoHost: HTMLElement;
  messageHost: HTMLElement;
}

let panelRefs: PaV3PanelRefs | null = null;
let monacoEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let monacoModel: monaco.editor.ITextModel | null = null;
let isDirty = false;
let isSettingValueProgrammatically = false;

// JSON syntax coloring needs an explicit model (monaco.editor.create's shorthand
// value/language options don't reliably tokenize in this content-script host) plus an
// explicitly defined theme — 'vs' alone was rendering every token as plain black text.
const MONACO_THEME_NAME = 'mwt-pa-v3-json-vs';
let monacoThemeDefined = false;

function ensureMonacoTheme(): void {
  if (monacoThemeDefined) return;
  monaco.editor.defineTheme(MONACO_THEME_NAME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '0451A5' },
      { token: 'string.value.json', foreground: 'A31515' },
      { token: 'string.json', foreground: 'A31515' },
      { token: 'number', foreground: '098658' },
      { token: 'keyword.json', foreground: '0000FF' },
      { token: 'delimiter', foreground: '000000' },
    ],
    colors: {
      'editor.background': '#FFFFFE',
      'editor.foreground': '#000000',
    },
  });
  monacoThemeDefined = true;
}

// The full payload as last loaded from / applied to the canvas — kept outside the editor so
// fields the clean projection hides (parameters, unrelated definition/metadata keys) survive
// an edit + apply round trip instead of being silently dropped.
let originalPayload: PaV3EditorPayload | null = null;

// CheckMark comes from the same FabricMDL2 icon font as the Cancel glyph below, so both
// header icons share identical stroke weight and optical size — a hand-drawn SVG checkmark
// read bolder and smaller next to the font-rendered X.
const CHECKMARK_ICON_HTML = '<i data-icon-name="CheckMark" aria-hidden="true" class="ms-Icon ms-Button-icon mwt-pa-v3-apply-icon" style="font-family: FabricMDL2Icons;">&#xE73E;</i>';
// FabricMDL2Icons is loaded by the host page itself, but the runtime-generated
// .ms-Icon--Cancel:before rule that normally supplies the glyph is not guaranteed to exist
// for synthetic DOM — the \\uE711 (Cancel) codepoint is embedded directly instead.
const CLOSE_ICON_HTML = '<i data-icon-name="Cancel" aria-hidden="true" class="ms-Icon ms-Button-icon mwt-pa-v3-close-icon" style="font-family: FabricMDL2Icons;">&#xE711;</i>';

function buildHeaderIconButton(options: {
  title: string;
  ariaLabel: string;
  automationId: string;
  iconHtml: string;
  onClick: () => void;
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = options.title;
  btn.setAttribute('aria-label', options.ariaLabel);
  btn.setAttribute('data-automation-id', options.automationId);
  btn.setAttribute('data-is-focusable', 'true');
  btn.className = 'ms-Button ms-Button--icon mwt-pa-v3-panel-icon-button';

  // Native Fabric icon-button anatomy: the icon sits inside an ms-Button-flexContainer span.
  // The title is repeated on the span so hover over the icon area is always attributed to an
  // element carrying the tooltip text.
  const flexContainer = document.createElement('span');
  flexContainer.className = 'ms-Button-flexContainer';
  flexContainer.setAttribute('data-automationid', 'splitbuttonprimary');
  flexContainer.title = options.title;
  flexContainer.innerHTML = options.iconHtml;
  btn.appendChild(flexContainer);

  btn.addEventListener('click', options.onClick);
  return btn;
}

// Focus-trap bumper divs bracket the panel content exactly like the native Fabric
// FocusTrapZone renders them — structural fidelity only; no trap behavior is wired up.
function buildFocusTrapBumper(): HTMLDivElement {
  const bumper = document.createElement('div');
  bumper.setAttribute('aria-hidden', 'true');
  bumper.tabIndex = 0;
  bumper.setAttribute('data-is-visible', 'true');
  bumper.setAttribute('data-is-focus-trap-zone-bumper', 'true');
  bumper.style.pointerEvents = 'none';
  bumper.style.position = 'fixed';
  return bumper;
}

function buildPanel(): PaV3PanelRefs {
  ensurePaV3Styles();

  // Full native Fluent/Fabric panel shell: root > overlay + panel-main > bumper +
  // contentInner > scrollableContent > commands + headerContainer + content. Stable native
  // class names carry the structure; mwt-pa-v3-* companions carry all the styling.
  const panel = document.createElement('div');
  panel.id = PA_V3_PANEL_ID;
  panel.className = 'ms-Panel is-open ba-Panel fl-Panel mwt-pa-v3-panel';
  panel.setAttribute('aria-hidden', 'false');
  panel.setAttribute('role', 'presentation');

  const overlay = document.createElement('div');
  overlay.className = 'ms-Overlay mwt-pa-v3-overlay';

  const panelMain = document.createElement('div');
  panelMain.className = 'ms-Panel-main mwt-pa-v3-panel-main';

  const contentInner = document.createElement('div');
  contentInner.className = 'ms-Panel-contentInner mwt-pa-v3-content-inner';

  const scrollableContent = document.createElement('div');
  scrollableContent.className = 'ms-Panel-scrollableContent mwt-pa-v3-scrollable-content';
  scrollableContent.setAttribute('data-is-scrollable', 'true');

  const commands = document.createElement('div');
  commands.className = 'ms-Panel-commands mwt-pa-v3-commands';
  commands.setAttribute('data-is-visible', 'true');

  const headerContainer = document.createElement('div');
  headerContainer.className = 'ba-Panel-headerContainer mwt-pa-v3-header-container';

  const header = document.createElement('div');
  header.className = 'ba-Panel-header mwt-pa-v3-panel-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'ba-Panel-headerLeft mwt-pa-v3-header-left';

  const title = document.createElement('h1');
  title.className = 'ba-Panel-headerText mwt-pa-v3-panel-title';
  title.style.color = 'rgb(0, 0, 0)';
  title.textContent = 'Edit code';
  headerLeft.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'mwt-pa-v3-panel-header-actions';

  const applyButton = buildHeaderIconButton({
    title: 'Apply to canvas',
    ariaLabel: 'Apply to canvas',
    automationId: 'mwt_pa_v3_apply_to_canvas',
    iconHtml: CHECKMARK_ICON_HTML,
    onClick: () => void handleApply(),
  });

  const closeButton = buildHeaderIconButton({
    title: 'Close',
    ariaLabel: 'Close',
    automationId: 'sidePanelCloseButton',
    iconHtml: CLOSE_ICON_HTML,
    onClick: () => togglePowerAutomateV3CodeViewPanel(false),
  });

  headerActions.appendChild(applyButton);
  headerActions.appendChild(closeButton);

  header.appendChild(headerLeft);
  header.appendChild(headerActions);
  headerContainer.appendChild(header);

  const content = document.createElement('div');
  content.className = 'ms-Panel-content mwt-pa-v3-panel-content';

  const body = document.createElement('div');
  body.className = 'ba-Panel-content mwt-pa-v3-ba-panel-content';

  const messageHost = document.createElement('div');
  messageHost.id = PA_V3_PANEL_MESSAGE_HOST_ID;

  const monacoHost = document.createElement('div');
  monacoHost.id = PA_V3_MONACO_HOST_ID;
  monacoHost.setAttribute('data-mode-id', 'json');

  body.appendChild(messageHost);
  body.appendChild(monacoHost);
  content.appendChild(body);

  scrollableContent.appendChild(commands);
  scrollableContent.appendChild(headerContainer);
  scrollableContent.appendChild(content);
  contentInner.appendChild(scrollableContent);

  panelMain.appendChild(buildFocusTrapBumper());
  panelMain.appendChild(contentInner);
  panelMain.appendChild(buildFocusTrapBumper());

  panel.appendChild(overlay);
  panel.appendChild(panelMain);

  document.body.appendChild(panel);

  return { panel, monacoHost, messageHost };
}

function reportDirty(next: boolean): void {
  isDirty = next;
}

function loadPayloadIntoEditor(payload: PaV3EditorPayload): void {
  if (!monacoModel) return;
  originalPayload = payload;

  const projection = buildCleanProjection(payload);
  const text = JSON.stringify(projection, null, 2);
  isSettingValueProgrammatically = true;
  monacoModel.setValue(text);
  isSettingValueProgrammatically = false;
  reportDirty(false);
}

async function openPanel(): Promise<void> {
  if (!panelRefs) {
    panelRefs = buildPanel();
    ensureMonacoTheme();

    monacoModel = monaco.editor.createModel('', 'json');
    monaco.editor.setModelLanguage(monacoModel, 'json');

    monacoEditor = monaco.editor.create(panelRefs.monacoHost, {
      model: monacoModel,
      theme: MONACO_THEME_NAME,
      readOnly: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 18,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
    });
    monacoEditor.onDidChangeModelContent(() => {
      if (!isSettingValueProgrammatically) reportDirty(true);
    });

    // Debug-only aid (mirrors window.__mwtPaV3Debug in interceptorPaV3.ts) — lets the JSON
    // model be inspected/read from DevTools without falling back to scraping the textarea.
    (window as any).__MWT_PA_V3_EDITOR__ = monacoEditor;
    (window as any).__MWT_PA_V3_MODEL__ = monacoModel;
  } else {
    // Overlay + panel-main are absolutely positioned inside the shell root, so the root
    // itself is a plain block — not the flex column it was before the native-shell rewrite.
    panelRefs.panel.style.display = 'block';
  }

  // automaticLayout polls on an interval and can lag one tick behind a display:none -> block
  // transition, leaving the editor sized to its old (often zero) dimensions until then. The
  // staggered follow-ups cover the sticky-header/scrollbar reflow that settles a frame or
  // two after the shell first becomes visible.
  requestAnimationFrame(() => monacoEditor?.layout());
  window.setTimeout(() => monacoEditor?.layout(), 50);
  window.setTimeout(() => monacoEditor?.layout(), 250);

  if (!isDirty) {
    const result = await fetchPayloadFromMainWorld();
    if (!result.success) {
      showPowerAutomateV3MessageBar('error', 'Power Automate designer store was not found.');
    } else {
      // Graph-backed status is an internal technical detail — no informational message for
      // it; the metadata simply rides along untouched (see graph metadata policy above).
      loadPayloadIntoEditor(result.payload);
    }
  }
}

function closePanel(): void {
  if (panelRefs) panelRefs.panel.style.display = 'none';
}

function togglePowerAutomateV3CodeViewPanel(forceOpen?: boolean): void {
  const shouldOpen = forceOpen ?? !isPanelOpen();
  if (shouldOpen) {
    void openPanel();
  } else {
    closePanel();
  }
  updateButtonActiveState(shouldOpen);
}

function isPanelOpen(): boolean {
  return !!panelRefs && panelRefs.panel.style.display !== 'none';
}

function updateButtonActiveState(active: boolean): void {
  const button = document.getElementById(PA_V3_CONTROL_BUTTON_ID);
  if (!button) return;
  button.classList.toggle(PA_V3_ACTIVE_CLASS, active);
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function handleApply(): Promise<void> {
  if (!monacoModel) return;

  if (!originalPayload) {
    showPowerAutomateV3MessageBar('error', 'Apply to canvas failed. No payload has been loaded yet.');
    return;
  }

  let parsedClean: any;
  try {
    parsedClean = JSON.parse(monacoModel.getValue());
  } catch (e: any) {
    showPowerAutomateV3MessageBar('error', `Invalid JSON: ${e?.message ?? 'parse error'}.`);
    return;
  }

  // Merge the edited clean projection back into a clone of the last-known full definition —
  // this is what keeps parameters, unrelated definition/metadata keys, and (for non-graph
  // flows) the absence of graph data intact, instead of the editor's trimmed view
  // clobbering them on Apply.
  const mergedDefinition = structuredClone(originalPayload.definition) as any;
  const cleanDefinition = parsedClean?.definition ?? {};
  if (cleanDefinition.$schema !== undefined) mergedDefinition.$schema = cleanDefinition.$schema;
  if (cleanDefinition.contentVersion !== undefined) mergedDefinition.contentVersion = cleanDefinition.contentVersion;
  mergedDefinition.triggers = cleanDefinition.triggers;
  mergedDefinition.actions = cleanDefinition.actions;

  const mergedConnectionReferences =
    parsedClean?.connectionReferences !== undefined ? parsedClean.connectionReferences : originalPayload.connectionReferences;

  // Graph metadata is deliberately not touched here (see graph metadata policy above):
  // whatever the user left nested under definition.triggers rides along as-is. It is never
  // normalized, synchronized, or validated — Apply is driven by definition.actions alone,
  // and PA v3 regenerates the canvas layout from it.

  const validation = validatePaV3Payload({ definition: mergedDefinition });
  if (!validation.ok) {
    showPowerAutomateV3MessageBar('error', `Apply to canvas failed. ${validation.blockingError ?? ''}`.trim());
    return;
  }

  // Root-level graph/nodeActionMapping in the edited JSON (e.g. pasted from an older export)
  // is non-authoritative in PA v3 and deliberately not applied — say so instead of silently
  // dropping it.
  if (parsedClean?.graph !== undefined || parsedClean?.nodeActionMapping !== undefined) {
    validation.warnings.push('Root graph/nodeActionMapping fields are non-authoritative in Power Automate and were ignored.');
  }

  const payload: PaV3EditorPayload = {
    definition: mergedDefinition,
    connectionReferences: mergedConnectionReferences ?? {},
    ...(originalPayload.parameters !== undefined ? { parameters: originalPayload.parameters } : {}),
  };

  const result = await applyPayloadToMainWorld(payload);

  if (!result.success) {
    const msg = result.error?.includes('designer store was not found')
      ? 'Power Automate designer store was not found. Apply to canvas cannot continue.'
      : `Apply to canvas failed. ${result.error ?? ''}`.trim();
    showPowerAutomateV3MessageBar('error', msg);
    return;
  }

  // The store readback (see interceptorPaV3.ts) is the only signal this bridge has that the
  // write actually landed on the live designer model — never report success (or clear the
  // editor's dirty flag) on the strength of the internal setFlowData/setIsFlowDirty calls
  // alone. On a failed readback the editor content and dirty state are left untouched so
  // no edit is ever silently lost.
  if (result.readbackVerified === false) {
    showPowerAutomateV3MessageBar(
      'error',
      'Apply to canvas failed. The designer model readback does not match the edited definition — your edits are still in the editor.'
    );
    return;
  }

  originalPayload = payload;
  reportDirty(false);

  if (result.canvasVerified === false) {
    showPowerAutomateV3MessageBar(
      'warning',
      'Definition updated and draft marked dirty, but canvas refresh did not complete. Use native Save draft to persist the flow, or reload if the canvas still looks stale.'
    );
    return;
  }

  if (validation.warnings.length > 0) {
    showPowerAutomateV3MessageBar(
      'warning',
      `Applied to canvas with warnings: ${validation.warnings.join(' ')} Use native Save draft to persist the flow.`
    );
  } else {
    showPowerAutomateV3MessageBar('success', 'Applied to canvas. Use native Save draft to persist the flow.');
  }
}

// ── Unapplied-changes guard ─────────────────────────────────────────────────
// Same class of guard as the Copilot Studio outside-interaction guard in content.ts
// (capture-phase pointerdown, follow-up click suppression, decision dialog, then replay of
// the original click), rebuilt here with PA v3-namespaced DOM ids and the native PA/Fabric
// ms-Dialog visual grammar (mwt-pa-v3-guard-* in PA_V3_CSS). No code or state is shared
// with the Copilot Studio implementation.

type PaV3DirtyDecision = 'apply' | 'discard' | 'keep-editing';

function buildGuardActionButton(options: {
  label: string;
  primary: boolean;
  automationId: string;
  onClick: () => void;
}): HTMLSpanElement {
  const action = document.createElement('span');
  action.className = 'ms-Dialog-action';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = options.primary
    ? 'ms-Button ms-Button--primary fl-DefaultButton mwt-pa-v3-guard-primary'
    : 'ms-Button ms-Button--default fl-DefaultButton mwt-pa-v3-guard-secondary';
  btn.setAttribute('data-automation-id', options.automationId);
  btn.setAttribute('aria-label', options.label);
  btn.setAttribute('data-is-focusable', 'true');

  const flexContainer = document.createElement('span');
  flexContainer.className = 'ms-Button-flexContainer';
  flexContainer.setAttribute('data-automationid', 'splitbuttonprimary');
  const textContainer = document.createElement('span');
  textContainer.className = 'ms-Button-textContainer';
  const label = document.createElement('span');
  label.className = 'ms-Button-label';
  label.textContent = options.label;
  textContainer.appendChild(label);
  flexContainer.appendChild(textContainer);
  btn.appendChild(flexContainer);

  btn.addEventListener('click', options.onClick);
  action.appendChild(btn);
  return action;
}

function promptPaV3ApplyDiscardKeep(): Promise<PaV3DirtyDecision> {
  return new Promise<PaV3DirtyDecision>(resolve => {
    document.getElementById(PA_V3_DIRTY_DIALOG_ID)?.remove();
    ensurePaV3Styles();

    // Native PA v3 dialog shell: ms-Modal root > dark ms-Overlay + ms-Dialog-main
    // (bracketed by focus-trap bumpers) > scrollableContent > header + inner.
    const modal = document.createElement('div');
    modal.id = PA_V3_DIRTY_DIALOG_ID;
    modal.className = 'ms-Modal is-open ms-Dialog fl-Dialog mwt-pa-v3-guard-modal';
    modal.setAttribute('role', 'document');

    const overlay = document.createElement('div');
    overlay.className = 'ms-Overlay ms-Overlay--dark mwt-pa-v3-guard-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'ms-Dialog-main fl-Dialog mwt-pa-v3-guard-main';
    main.setAttribute('role', 'alertdialog');
    main.setAttribute('aria-modal', 'true');
    main.setAttribute('aria-label', 'Unsaved code changes');

    const scrollable = document.createElement('div');
    scrollable.className = 'ms-Modal-scrollableContent mwt-pa-v3-guard-scrollable';
    scrollable.setAttribute('data-is-scrollable', 'true');

    const content = document.createElement('div');
    content.className = 'ms-Dialog--close mwt-pa-v3-guard-content';

    const header = document.createElement('div');
    header.className = 'ms-Dialog-header ms-Dialog--close mwt-pa-v3-guard-header';

    const title = document.createElement('div');
    title.className = 'ms-Dialog-title mwt-pa-v3-guard-title';
    title.setAttribute('role', 'heading');
    title.setAttribute('aria-level', '1');
    title.textContent = 'Unsaved code changes';

    const cleanup = (decision: PaV3DirtyDecision) => {
      modal.remove();
      resolve(decision);
    };

    const topButton = document.createElement('div');
    topButton.className = 'mwt-pa-v3-guard-top-button';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ms-Button ms-Button--icon ms-Dialog-button ms-Dialog-button--close mwt-pa-v3-guard-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.setAttribute('data-is-focusable', 'true');
    closeBtn.innerHTML = `<span class="ms-Button-flexContainer" data-automationid="splitbuttonprimary">${CLOSE_ICON_HTML}</span>`;
    closeBtn.addEventListener('click', () => cleanup('keep-editing'));
    topButton.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(topButton);

    const inner = document.createElement('div');
    inner.className = 'ms-Dialog-inner mwt-pa-v3-guard-inner';

    const dialogContent = document.createElement('div');
    dialogContent.className = 'ms-Dialog-content mwt-pa-v3-guard-dialog-content';

    const subText = document.createElement('p');
    subText.className = 'ms-Dialog-subText mwt-pa-v3-guard-subtext';
    subText.textContent = 'You have unapplied changes in Code View. Apply them to the canvas, discard them, or keep editing.';

    const actions = document.createElement('div');
    actions.className = 'ms-Dialog-actions mwt-pa-v3-guard-actions';

    const actionsRight = document.createElement('div');
    actionsRight.className = 'ms-Dialog-actionsRight mwt-pa-v3-guard-actions-right';

    actionsRight.appendChild(buildGuardActionButton({
      label: 'Apply to canvas',
      primary: true,
      automationId: 'mwt_pa_v3_guard_apply',
      onClick: () => cleanup('apply'),
    }));
    actionsRight.appendChild(buildGuardActionButton({
      label: 'Keep editing',
      primary: false,
      automationId: 'mwt_pa_v3_guard_keep_editing',
      onClick: () => cleanup('keep-editing'),
    }));
    actionsRight.appendChild(buildGuardActionButton({
      label: 'Discard changes',
      primary: false,
      automationId: 'mwt_pa_v3_guard_discard',
      onClick: () => cleanup('discard'),
    }));

    actions.appendChild(actionsRight);
    dialogContent.appendChild(subText);
    dialogContent.appendChild(actions);
    inner.appendChild(dialogContent);
    content.appendChild(header);
    content.appendChild(inner);
    scrollable.appendChild(content);

    main.appendChild(buildFocusTrapBumper());
    main.appendChild(scrollable);
    main.appendChild(buildFocusTrapBumper());

    // Clicking the dimmed backdrop is never destructive — it means "keep editing".
    overlay.addEventListener('click', () => cleanup('keep-editing'));

    modal.appendChild(overlay);
    modal.appendChild(main);
    document.body.appendChild(modal);

    modal.querySelector<HTMLButtonElement>('.mwt-pa-v3-guard-primary')?.focus();
  });
}

let bypassPaV3OutsideGuard = false;
// Blocks the click event that fires after a pointerdown interception during the dirty dialog.
let blockNextClickDuringPaV3Dialog = false;

function isInsidePaV3CodeViewUi(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  // The full-viewport .ms-Overlay is a child of the panel shell, but clicking it is the
  // native light-dismiss gesture — it must count as *outside* so the existing guard closes
  // the panel (or shows the dirty dialog) instead of swallowing the click.
  if (el.closest('.mwt-pa-v3-overlay')) return false;
  return Boolean(
    el.closest(`#${PA_V3_PANEL_ID}`) ||
    el.closest(`#${PA_V3_DIRTY_DIALOG_ID}`) ||
    // Toolbar toggle button has its own handler — let it manage open/close.
    el.closest(`#${PA_V3_CONTROL_BUTTON_ID}`) ||
    // Monaco widgets (context menu, hovers, suggest) can portal outside the panel element.
    el.closest('.monaco-editor') ||
    el.closest('.monaco-menu') ||
    el.closest('.suggest-widget') ||
    el.closest('.editor-widget') ||
    el.closest('.context-view') ||
    el.closest('.monaco-hover')
  );
}

// Interactions inside native PA v3 dialogs/popovers/menus (e.g. a native discard-confirmation
// or connection picker) must not be treated as "clicked outside the Code view".
function isInsideNativePaV3ModalOrPopover(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest('[role="dialog"]') ||
    el.closest('[role="alertdialog"]') ||
    el.closest('.fui-Dialog__surface') ||
    el.closest('.fui-Popover__surface') ||
    el.closest('.fui-Menu__popover')
  );
}

async function handleOutsidePaV3CodeViewInteraction(event: PointerEvent): Promise<void> {
  if (bypassPaV3OutsideGuard) return;
  if (!isPanelOpen()) return;

  const target = event.target as HTMLElement | null;
  if (isInsidePaV3CodeViewUi(target)) return;
  if (isInsideNativePaV3ModalOrPopover(target)) return;

  if (!isDirty) {
    togglePowerAutomateV3CodeViewPanel(false);
    mwtLog('[MWT_PA_V3_CONTENT]', { event: 'panel-closed', reason: 'outside-interaction-clean' });
    return;
  }

  // Block the click that will follow this pointerdown, then show the dialog.
  blockNextClickDuringPaV3Dialog = true;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const originalTarget = target;
  const decision = await promptPaV3ApplyDiscardKeep();

  if (decision === 'keep-editing') {
    blockNextClickDuringPaV3Dialog = false;
    mwtLog('[MWT_PA_V3_CONTENT]', { event: 'outside-interaction-kept-editing' });
    return;
  }

  if (decision === 'apply') {
    await handleApply();
    // handleApply only clears the dirty flag once the store readback confirmed the write —
    // if it's still dirty the apply failed (error already shown); keep the panel open.
    if (isDirty) {
      mwtLog('[MWT_PA_V3_CONTENT]', { event: 'outside-interaction-apply-failed' });
      return;
    }
  } else if (originalPayload) {
    // Discard: revert the editor to the last loaded/applied payload.
    loadPayloadIntoEditor(originalPayload);
  } else {
    reportDirty(false);
  }

  togglePowerAutomateV3CodeViewPanel(false);
  mwtLog('[MWT_PA_V3_CONTENT]', { event: 'panel-closed', reason: 'outside-interaction-after-decision', decision });

  // Replay the originally-intended interaction so the user's click isn't swallowed.
  if (originalTarget) {
    bypassPaV3OutsideGuard = true;
    window.setTimeout(() => {
      try {
        originalTarget.click();
      } finally {
        window.setTimeout(() => { bypassPaV3OutsideGuard = false; }, 0);
      }
    }, 0);
  }
}

function installPaV3OutsideInteractionGuard(): void {
  document.addEventListener('click', (e: MouseEvent) => {
    if (blockNextClickDuringPaV3Dialog) {
      e.stopImmediatePropagation();
      e.preventDefault();
      blockNextClickDuringPaV3Dialog = false;
    }
  }, true);

  document.addEventListener(
    'pointerdown',
    (event: PointerEvent) => { void handleOutsidePaV3CodeViewInteraction(event); },
    true
  );
}

// ── Toolbar button injection (spec section 2) ──────────────────────────────

// The stroke-only paths carry inline style="fill:none": the native controls CSS applies a
// fill to svg/path inside control buttons, and a filled open chevron path renders as a solid
// triangle "shadow" behind the strokes. Inline style wins over any host stylesheet.
const CODE_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="fill:none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M6.4 5.9L3.2 10L6.4 14.1" fill="none" style="fill:none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.6 5.9L16.8 10L13.6 14.1" fill="none" style="fill:none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.55 3.8L8.45 16.2" fill="none" style="fill:none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;

function injectPowerAutomateV3CodeViewButton(): boolean {
  const controls = findControlsContainer();
  if (!controls) return false;
  if (document.getElementById(PA_V3_CONTROL_BUTTON_ID)) return true;

  // Copy the native sibling button's class instead of hardcoding react-flow__controls-button
  // — resilient to the react-flow/xyflow rename and any future hash/prefix changes.
  const sibling = controls.querySelector<HTMLElement>('button');

  const button = document.createElement('button');
  button.type = 'button';
  button.id = PA_V3_CONTROL_BUTTON_ID;
  button.className = sibling?.className || 'react-flow__controls-button';
  button.setAttribute('aria-label', 'Code view');
  button.title = 'Code view';
  button.innerHTML = CODE_ICON_SVG;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePowerAutomateV3CodeViewPanel();
  });

  controls.appendChild(button);
  mwtLog('[MWT_PA_V3_CONTENT]', { event: 'button-injected', controlsClass: controls.className });
  return true;
}

// ── Detection / lifecycle loop ─────────────────────────────────────────────

function teardown(): void {
  if (panelRefs) {
    monacoEditor?.dispose();
    monacoEditor = null;
    monacoModel?.dispose();
    monacoModel = null;
    panelRefs.panel.remove();
    panelRefs = null;
    isDirty = false;
    originalPayload = null;
  }
  document.getElementById(PA_V3_CONTROL_BUTTON_ID)?.remove();
}

type DetectionState = 'off-host' | 'off-route' | 'run-view' | 'waiting-controls' | 'waiting-store' | 'ready';
let lastLoggedState: DetectionState | null = null;

function logDetectionState(state: DetectionState, extra?: Record<string, unknown>): void {
  if (state === lastLoggedState) return;
  lastLoggedState = state;
  mwtLog('[MWT_PA_V3_CONTENT]', { event: 'detection-state', state, href: window.location.href, ...extra });
}

async function tick(): Promise<void> {
  if (!isPowerPlatformMakerHost()) {
    logDetectionState('off-host');
    teardown();
    return;
  }

  if (!looksLikeFlowDesignerRoute()) {
    logDetectionState('off-route');
    teardown();
    return;
  }

  if (isPowerAutomateRunView()) {
    logDetectionState('run-view');
    teardown();
    return;
  }

  const controls = findControlsContainer();
  if (!controls) {
    logDetectionState('waiting-controls');
    return;
  }

  if (document.getElementById(PA_V3_CONTROL_BUTTON_ID)) return;

  const storeFound = await probeDesignerStore();
  if (!storeFound) {
    logDetectionState('waiting-store', { controlsClass: controls.className });
    return;
  }

  logDetectionState('ready', { controlsClass: controls.className });
  injectPowerAutomateV3CodeViewButton();
}

let tickInFlight = false;
function scheduleTick(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  tick().finally(() => { tickInFlight = false; });
}

// The 1s interval + MutationObserver already catch a route change into /runs/ within ~1s,
// but SPA navigations don't always mutate the DOM synchronously with the URL change —
// patching history.pushState/replaceState and listening to popstate makes teardown fire on
// the same tick as the navigation itself instead of trailing it.
function patchHistoryForRouteChangeDetection(): void {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
    const result = originalPushState.apply(this, args);
    scheduleTick();
    return result;
  };
  history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
    const result = originalReplaceState.apply(this, args);
    scheduleTick();
    return result;
  };
  window.addEventListener('popstate', () => scheduleTick());
}

function init(): void {
  ensurePaV3Styles();
  installPaV3OutsideInteractionGuard();
  scheduleTick();
  window.setInterval(scheduleTick, 1000);
  patchHistoryForRouteChangeDetection();

  const observer = new MutationObserver(() => scheduleTick());
  observer.observe(document.body, { childList: true, subtree: true });
}

init();
