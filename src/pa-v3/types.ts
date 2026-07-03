// Shared message contract for the Power Automate v3 isolated-world <-> MAIN-world bridge.
// Fully namespaced (MWT_PA_V3_*) and independent from the Copilot Studio bridge in
// content.ts / interceptor.ts — no message type or DOM id overlaps with that path.

export interface PaV3EditorPayload {
  definition: Record<string, unknown>;
  connectionReferences: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

export interface PaV3StoreProbeRequest {
  type: 'MWT_PA_V3_STORE_PROBE';
  requestId: string;
}

export interface PaV3StoreProbeResult {
  type: 'MWT_PA_V3_STORE_PROBE_RESULT';
  requestId: string;
  found: boolean;
}

export interface PaV3GetPayloadRequest {
  type: 'MWT_PA_V3_GET_PAYLOAD_REQUEST';
  requestId: string;
}

export interface PaV3GetPayloadResponse {
  type: 'MWT_PA_V3_GET_PAYLOAD_RESPONSE';
  requestId: string;
  success: boolean;
  payload?: PaV3EditorPayload;
  isGraphBacked?: boolean;
  error?: string;
}

export interface PaV3ApplyRequest {
  type: 'MWT_PA_V3_APPLY_REQUEST';
  requestId: string;
  payload: PaV3EditorPayload;
}

export interface PaV3ApplyResponse {
  type: 'MWT_PA_V3_APPLY_RESPONSE';
  requestId: string;
  success: boolean;
  error?: string;
  readbackVerified?: boolean;
  canvasVerified?: boolean;
}

export type PaV3BridgeMessage =
  | PaV3StoreProbeRequest
  | PaV3StoreProbeResult
  | PaV3GetPayloadRequest
  | PaV3GetPayloadResponse
  | PaV3ApplyRequest
  | PaV3ApplyResponse;

export const PA_V3_CONTROL_BUTTON_ID = 'mwt-pa-v3-code-view-control-button';
export const PA_V3_PANEL_ID = 'mwt-pa-v3-codeview-panel';
export const PA_V3_MONACO_HOST_ID = 'mwt-pa-v3-monaco-host';
export const PA_V3_ACTIVE_CLASS = 'mwt-pa-v3-code-view-active';
export const PA_V3_PANEL_MESSAGE_HOST_ID = 'mwt-pa-v3-panel-message-host';
export const PA_V3_STYLE_TAG_ID = 'mwt-pa-v3-style';
export const PA_V3_DIRTY_DIALOG_ID = 'mwt-pa-v3-dirty-dialog';
