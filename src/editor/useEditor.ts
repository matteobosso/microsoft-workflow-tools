import { MessageBarType } from "@fluentui/react/lib/MessageBar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMessageBar } from "../shared/components/Messages";
import { useApiProviderContext, IApiProvider } from "../shared/api/ApiProvider";
import { FlowError } from "./types";

const isEmbedded = new URLSearchParams(window.location.search).has('embedded');

const EDITOR_SCHEMA = "https://power-automate-tools.local/flow-editor.json#";

export interface RefetchResult {
  definition: string;
  source: 'workflow-clientdata' | 'current-draft' | 'latest-server-side' | 'published-live';
  definitionHash: string;
}

const workflowUrl = (flowId: string) => `powerautomate/flows/${flowId}`;

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

function hashClientData(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return hashText(text);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as object).sort().reduce((acc: Record<string, unknown>, k) => {
      acc[k] = canonicalize((value as Record<string, unknown>)[k]);
      return acc;
    }, {});
  }
  return value;
}

function hashDefinition(definition: unknown): string {
  return hashText(JSON.stringify(canonicalize(definition)));
}

// Module-level workflow state — authoritative source across open-code-view lifecycle.
interface WorkflowState {
  workflowId: string;
  versionNumber: number | null;
  modifiedOn: string | null;
  clientdataHash: string | null;
  definitionHash: string | null;
  source: 'workflow-clientdata-refetch' | 'initial-load';
}

let _workflowState: WorkflowState | null = null;

interface FetchCurrentResult {
  definition: unknown;
  connectionReferences: unknown;
  name: string;
  modifiedOn?: string;
  versionNumber?: string;
  source: 'workflow-clientdata' | 'published-live';
  clientdataHash?: string;
  definitionHash: string;
}

// Single source of truth: workflow.clientdata via Dynamics GET with unpublished headers.
// Falls back to PA API (published/live) only if Dynamics is unavailable.
// Pure fetch — callers are responsible for updating _workflowState.
async function fetchCurrentWorkflowClientData(
  api: IApiProvider,
  opts: { dynamicsBase?: string; workflowId: string; flowId: string; reason: string }
): Promise<FetchCurrentResult | null> {
  const { dynamicsBase, workflowId, flowId, reason } = opts;

  // Primary: Dynamics GET + unpublished headers → clientdata (current draft)
  if (dynamicsBase && workflowId) {
    try {
      const url =
        `${dynamicsBase}/api/data/v9.2/workflows(${workflowId})` +
        `?$select=clientdata,workflowid,name,statecode,modifiedon,versionnumber`;

      console.log('[MWT_DEFINITION_FETCH]', { reason, url, method: 'GET', source: 'dynamics-clientdata' });

      const wf = await api.get(url, true, {
        'mscrm.asunpublished': 'true',
        'mscrm.includeunpublished': 'true',
        'odata-maxversion': '4.0',
        'odata-version': '4.0',
      });

      if (wf?.clientdata) {
        const cd = typeof wf.clientdata === 'string' ? JSON.parse(wf.clientdata) : wf.clientdata;
        const definition = cd?.properties?.definition ?? null;
        const connectionReferences = cd?.properties?.connectionReferences ?? null;

        if (definition) {
          const clientdataHash = hashClientData(wf.clientdata);
          const definitionHash = hashDefinition(definition);

          console.log('[MWT_DEFINITION_SOURCE]', {
            reason,
            source: 'workflow-clientdata',
            workflowId,
            modifiedOn: wf.modifiedon,
            versionNumber: wf.versionnumber,
            clientdataLength: wf.clientdata?.length,
            clientdataHash,
            definitionHash,
          });

          return {
            definition,
            connectionReferences,
            name: wf.name ?? '',
            modifiedOn: wf.modifiedon,
            versionNumber: wf.versionnumber,
            source: 'workflow-clientdata',
            clientdataHash,
            definitionHash,
          };
        }
      }
    } catch (e) {
      console.warn('[fetchCurrentWorkflowClientData] dynamics-clientdata-failed (non-fatal):', e);
    }
  }

  // Fallback: PA API (published/live)
  try {
    const fallbackUrl = workflowUrl(flowId);
    console.warn('[MWT_DEFINITION_FETCH]', { reason, url: fallbackUrl, method: 'GET', source: 'published-live-fallback' });

    const wf = await api.get(fallbackUrl, true);
    if (wf?.properties?.definition) {
      const definition = wf.properties.definition;
      const connectionReferences = wf.properties.connectionReferences ?? null;
      const definitionHash = hashDefinition(definition);

      console.warn('[MWT_DEFINITION_SOURCE]', {
        reason,
        source: 'published-live',
        workflowId: flowId,
        definitionHash,
      });

      return {
        definition,
        connectionReferences,
        name: wf.properties.displayName ?? '',
        source: 'published-live',
        definitionHash,
      };
    }
  } catch (e) {
    console.warn('[fetchCurrentWorkflowClientData] pa-api-fallback-failed (non-fatal):', e);
  }

  return null;
}

function isAuthTokenMissingError(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return (
    msg.includes('no auth token') ||
    msg.includes('auth token available') ||
    msg.includes('interact with the canvas first') ||
    msg.includes('api not ready') ||
    msg.includes('no token captured')
  );
}

// ── Canvas apply bridge (Fiber path — only used on "Apply to canvas" click) ──

function sendApplyToCanvas(graph: unknown): Promise<{ success: boolean; error?: string }> {
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const requestId = Date.now() + Math.random();
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'panel-action' || e.data?.action !== 'canvas-apply-result' || e.data?.requestId !== requestId) return;
      window.removeEventListener('message', handler);
      resolve({ success: !!e.data.success, error: e.data.error });
    };
    window.addEventListener('message', handler);
    window.setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, error: 'Timeout waiting for canvas response' });
    }, 10000);
    window.parent.postMessage({ type: 'mwt-panel-action', action: 'apply-to-canvas', graph, requestId }, '*');
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export const useEditor = () => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [validationPaneIsOpen, setValidationPaneIsOpen] = useState<boolean>(false);
  const [validationResult, setValidationResult] = useState<{
    errors: FlowError[];
    warnings: FlowError[];
  }>({ errors: [], warnings: [] });

  const api = useApiProviderContext();
  const flowId = new URLSearchParams(location.search).get("flowId");
  const messageBar = useMessageBar();
  const authFailedRef = useRef(false);
  const hasLoadedRef = useRef(false);

  const addMessage = useMemo(
    () => (msg: string | string[], type?: MessageBarType) => {
      messageBar.setMessages([
        {
          key: "1",
          messageBarType: type || MessageBarType.success,
          isMultiline: typeof msg !== "string",
          children: msg,
        },
      ]);
    },
    [messageBar]
  );

  // Keep latest api and addMessage in refs so callbacks avoid stale closures.
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const addMessageRef = useRef(addMessage);
  useEffect(() => { addMessageRef.current = addMessage; }, [addMessage]);

  const [data, setData] = useState<{
    name: string;
    definition: string;
    workflowId: string | null;
  }>({
    name: "",
    definition: "",
    workflowId: null,
  });

  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // Initial load — uses workflow.clientdata via Dynamics API (no Fiber dependency).
  const fetchWorkflow = useCallback(async (): Promise<void> => {
    const currentApi = apiRef.current;
    if (!flowId || !currentApi.isApiReady) return;
    authFailedRef.current = false;
    try {
      setIsLoading(true);
      const result = await fetchCurrentWorkflowClientData(currentApi, {
        dynamicsBase: currentApi.dynamicsBaseUrl ?? undefined,
        workflowId: flowId,
        flowId,
        reason: 'initial-load',
      });
      hasLoadedRef.current = true;
      if (!result) {
        addMessageRef.current('Error fetching workflow definition.', MessageBarType.error);
        return;
      }
      _workflowState = {
        workflowId: flowId,
        versionNumber: result.versionNumber != null ? Number(result.versionNumber) : null,
        modifiedOn: result.modifiedOn ?? null,
        clientdataHash: result.clientdataHash ?? null,
        definitionHash: result.definitionHash,
        source: 'initial-load',
      };
      const definition = JSON.stringify(
        {
          $schema: EDITOR_SCHEMA,
          connectionReferences: result.connectionReferences,
          definition: result.definition,
        },
        null,
        2
      );
      setData({ name: result.name, workflowId: flowId, definition });
    } catch (error) {
      const msg = String(error);
      const isAuth = /401|autenticaz|authenticat|unauthorized/i.test(msg);
      if (isAuth) {
        authFailedRef.current = true;
        addMessageRef.current(
          'Session expired — interact with the canvas to refresh automatically.',
          MessageBarType.warning
        );
      } else {
        addMessageRef.current('Error fetching workflow: ' + error, MessageBarType.error);
      }
    } finally {
      setIsLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    if (!flowId || !api.isApiReady) return;
    if (hasLoadedRef.current && !authFailedRef.current) return;
    fetchWorkflow();
  }, [flowId, api.isApiReady, api.tokenVersion, fetchWorkflow]);

  // On-demand refetch via API — used by open-code-view and after-restore.
  // Does NOT use Fiber — safe to call regardless of canvas DOM state.
  const triggerRefetch = useCallback(async (): Promise<RefetchResult | null> => {
    const currentApi = apiRef.current;
    if (!flowId || !currentApi.isApiReady) return null;

    setIsLoading(true);

    const workflowId = dataRef.current.workflowId ?? flowId;
    const dynamicsBase = currentApi.dynamicsBaseUrl;

    try {
      const result = await fetchCurrentWorkflowClientData(currentApi, {
        dynamicsBase: dynamicsBase ?? undefined,
        workflowId,
        flowId,
        reason: 'open-code-view',
      });

      setIsLoading(false);

      if (!result) return null;

      // Version guard: don't overwrite a newer save with stale server data.
      if (_workflowState?.versionNumber && result.versionNumber != null) {
        const nextVer = Number(result.versionNumber);
        const currentVer = _workflowState.versionNumber;
        if (nextVer < currentVer) {
          console.warn('[MWT_STATE_SYNC]', {
            event: 'ignored-stale-refetch',
            currentVersion: currentVer,
            incomingVersion: nextVer,
          });
          return null;
        }
      }

      _workflowState = {
        workflowId,
        versionNumber: result.versionNumber != null ? Number(result.versionNumber) : null,
        modifiedOn: result.modifiedOn ?? null,
        clientdataHash: result.clientdataHash ?? null,
        definitionHash: result.definitionHash,
        source: 'workflow-clientdata-refetch',
      };

      const definition = JSON.stringify(
        {
          $schema: EDITOR_SCHEMA,
          connectionReferences: result.connectionReferences,
          definition: result.definition,
        },
        null,
        2
      );

      hasLoadedRef.current = true;
      setData(prev => ({
        ...prev,
        ...(result.name ? { name: result.name } : {}),
        definition,
      }));

      return { definition, source: result.source, definitionHash: result.definitionHash };
    } catch (e) {
      console.warn('[triggerRefetch] unexpected error:', e);
      setIsLoading(false);
      return null;
    }
  }, [flowId]);

  return {
    isLoading,
    validationPaneIsOpen,
    setValidationPaneIsOpen,
    validationResult,
    ...messageBar,
    name: data.name,
    definition: data.definition,
    workflowId: data.workflowId,
    triggerRefetch,
    // Apply to canvas — the ONLY path that uses Fiber/setGraph.
    // Load and refetch always use the API; Fiber is never touched outside this function.
    applyToCanvas: async (codeText: string): Promise<boolean> => {
      // Step 1: JSON parse
      let parsed: any;
      try {
        parsed = JSON.parse(codeText);
      } catch {
        addMessage('The code is not valid JSON. Fix the syntax and try again.', MessageBarType.error);
        return false;
      }

      // Step 2: PA definition shape validation
      if (!parsed?.definition) {
        addMessage('Missing "definition" property.', MessageBarType.error);
        return false;
      }
      if (!parsed?.connectionReferences) {
        addMessage('Missing "connectionReferences" property.', MessageBarType.error);
        return false;
      }

      // Step 3: extract canvas graph from definition metadata
      const canvasGraph = parsed.definition?.triggers?.manual?.metadata?.associatedData?.graph;
      if (!canvasGraph || !Array.isArray(canvasGraph.nodes) || !Array.isArray(canvasGraph.edges)) {
        addMessage(
          'No canvas graph found in the workflow definition (expected at definition.triggers.manual.metadata.associatedData.graph).',
          MessageBarType.error
        );
        return false;
      }

      // Step 4: edge consistency validation
      const nodeIds = new Set<string>(canvasGraph.nodes.map((n: any) => String(n.id ?? '')));
      const invalidEdges: string[] = canvasGraph.edges
        .filter((e: any) => !nodeIds.has(String(e.source ?? '')) || !nodeIds.has(String(e.target ?? '')))
        .map((e: any) => `${e.source ?? '?'}->${e.target ?? '?'}`);
      if (invalidEdges.length > 0) {
        console.warn('[MWT_APPLY_TO_CANVAS]', { event: 'validation-failed', reason: 'invalid-edges', details: invalidEdges });
        addMessage('The graph is invalid. One or more edges reference missing nodes.', MessageBarType.error);
        return false;
      }

      setIsLoading(true);
      try {
        console.log('[MWT_APPLY_TO_CANVAS]', {
          event: 'start',
          source: 'code-view',
          nodeCount: canvasGraph.nodes.length,
          edgeCount: canvasGraph.edges.length,
        });

        // Attach connectionReferences so content.ts can include them in the setGraph payload.
        const graphToApply = { ...canvasGraph, connectionReferences: parsed.connectionReferences };
        const result = await sendApplyToCanvas(graphToApply);

        if (result.success) {
          console.log('[MWT_APPLY_TO_CANVAS]', {
            event: 'completed',
            nodeCount: canvasGraph.nodes.length,
            edgeCount: canvasGraph.edges.length,
          });
          addMessage('Changes applied to canvas. Use Save draft to persist changes.');
          return true;
        } else {
          console.error('[MWT_APPLY_TO_CANVAS]', { event: 'failed', error: result.error });
          const errMsg = result.error ?? '';
          if (errMsg.includes('not found') || errMsg.includes('Fiber') || errMsg.includes('Canvas node') || errMsg.includes('not ready')) {
            addMessage('Unable to access the canvas graph. Refresh the page and try again.', MessageBarType.error);
          } else {
            addMessage('Unable to apply changes to canvas. Review the code and try again.', MessageBarType.error);
          }
          return false;
        }
      } finally {
        setIsLoading(false);
      }
    },
    validate: async (definition: string) => {
      if (!flowId) return;
      try {
        setIsLoading(true);
        const result = await api.post(
          `powerautomate/flows/${flowId}/checkFlowAlerts`,
          {
            properties: {
              definition: JSON.parse(definition).definition,
            },
          }
        );
        setValidationResult({
          errors: normalizeAlerts(result?.errors),
          warnings: normalizeAlerts(result?.warnings),
        });
        setValidationPaneIsOpen(true);
      } catch (error) {
        addMessage(
          "Error during validation of the workflow definition: " + error,
          MessageBarType.error
        );
      } finally {
        setIsLoading(false);
      }
    },
  };
};

function normalizeAlerts(alerts: any[] | undefined): FlowError[] {
  if (!Array.isArray(alerts)) return [];
  return alerts.map((a) => ({
    errorDescription: a?.errorDescription ?? a?.message ?? "",
    operationName: a?.operationName ?? a?.code ?? "",
    ruleId: a?.ruleId ?? a?.code ?? "",
    fixInstructions: {
      markdownText: a?.fixInstructions?.markdownText ?? "",
      htmlText: a?.fixInstructions?.htmlText ?? "",
    },
  }));
}
