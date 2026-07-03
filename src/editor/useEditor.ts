import { MessageBarType } from "@fluentui/react/lib/MessageBar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMessageBar } from "../shared/components/Messages";
import { useApiProviderContext, IApiProvider } from "../shared/api/ApiProvider";
import { FlowError } from "./types";
import { mwtLog, mwtWarn } from "../shared/debug";

const EDITOR_SCHEMA = "https://power-automate-tools.local/flow-editor.json#";

export interface RefetchResult {
  definition: string;
  source: 'workflow-clientdata' | 'current-draft' | 'latest-server-side' | 'published-live' | 'live-store';
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
  source: 'workflow-clientdata-refetch' | 'initial-load' | 'live-store' | 'live-store-refetch';
}

let _workflowState: WorkflowState | null = null;

// Trigger that carries associatedData.graph — remembered from the last live-store
// load so Apply can merge root graph/nodeActionMapping aliases back into place.
let _csTriggerName: string | null = null;

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

// ── Explicit diagnostic API path (token-based) ────────────────────────────────
// This is NOT part of the normal Code View flow anymore. Load/refetch/apply go
// through the live in-page designer store (see the cs-store bridge below). The
// API path is kept only as an explicit, manually-triggered diagnostic fallback —
// it is never called automatically and never used as a silent fallback.
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

      mwtLog('[MWT_DEFINITION_FETCH]', { reason, url, method: 'GET', source: 'dynamics-clientdata' });

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

          mwtLog('[MWT_DEFINITION_SOURCE]', {
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
      mwtWarn('[fetchCurrentWorkflowClientData] dynamics-clientdata-failed (non-fatal):', e);
    }
  }

  // Fallback: PA API (published/live)
  try {
    const fallbackUrl = workflowUrl(flowId);
    mwtWarn('[MWT_DEFINITION_FETCH]', { reason, url: fallbackUrl, method: 'GET', source: 'published-live-fallback' });

    const wf = await api.get(fallbackUrl, true);
    if (wf?.properties?.definition) {
      const definition = wf.properties.definition;
      const connectionReferences = wf.properties.connectionReferences ?? null;
      const definitionHash = hashDefinition(definition);

      mwtWarn('[MWT_DEFINITION_SOURCE]', {
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
    mwtWarn('[fetchCurrentWorkflowClientData] pa-api-fallback-failed (non-fatal):', e);
  }

  return null;
}

// ── Copilot Studio live store bridge (iframe → content.ts → interceptor.ts) ──
// Load and Apply for the normal Code View flow: no API calls, no bearer token.
// content.ts enforces the host branch (copilotstudio.microsoft.com only) and
// relays to the MAIN-world resolver in interceptor.ts.

interface CsStoreGetPayload {
  definition: any;
  connectionReferences: any;
  graph: any;
  nodeActionMapping: any;
  triggerName: string;
  name?: string;
  sourcePath?: string;
  diagnostics?: Record<string, unknown>;
}

function sendCsStoreGet(): Promise<CsStoreGetPayload> {
  return new Promise<CsStoreGetPayload>((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2) + Date.now();
    const timeoutHandle = window.setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(
        'Unable to access Copilot Studio live workflow state. Make sure the workflow designer is open and fully loaded.'
      ));
    }, 15000);
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'panel-action' || e.data?.action !== 'cs-store-get-result' || e.data?.requestId !== requestId) return;
      window.clearTimeout(timeoutHandle);
      window.removeEventListener('message', handler);
      if (e.data.success) {
        resolve(e.data.payload as CsStoreGetPayload);
      } else {
        reject(new Error(e.data.error ?? 'Unable to access Copilot Studio live workflow state.'));
      }
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: 'mwt-panel-action', action: 'cs-store-get', requestId }, '*');
  });
}

function sendCsStoreApply(payload: {
  definition: unknown;
  connectionReferences?: unknown;
}): Promise<{ success: boolean; error?: string }> {
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const requestId = Math.random().toString(36).slice(2) + Date.now();
    const timeoutHandle = window.setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, error: 'Apply to canvas failed. The workflow data was not applied to the visual canvas.' });
    }, 25000);
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'panel-action' || e.data?.action !== 'cs-store-apply-result' || e.data?.requestId !== requestId) return;
      window.clearTimeout(timeoutHandle);
      window.removeEventListener('message', handler);
      resolve({ success: !!e.data.success, error: e.data.error });
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: 'mwt-panel-action', action: 'cs-store-apply', requestId, payload }, '*');
  });
}

function buildEditorWrapper(payload: CsStoreGetPayload): string {
  return JSON.stringify(
    {
      $schema: EDITOR_SCHEMA,
      connectionReferences: payload.connectionReferences ?? {},
      definition: payload.definition,
      graph: payload.graph,
      nodeActionMapping: payload.nodeActionMapping,
    },
    null,
    2
  );
}

// ── Graph/action consistency validation ──────────────────────────────────────
// Copilot Studio workflows are graph-backed: nodeActionMapping bridges graph
// nodes and WDL actions, and nested actions (If/Scope/Switch branches) count.

function collectActions(actions: any, out: Map<string, any>): void {
  if (!actions || typeof actions !== 'object') return;
  for (const name of Object.keys(actions)) {
    const a = actions[name];
    out.set(name, a);
    if (!a || typeof a !== 'object') continue;
    if (a.actions) collectActions(a.actions, out);
    if (a.else?.actions) collectActions(a.else.actions, out);
    if (a.cases && typeof a.cases === 'object') {
      for (const c of Object.keys(a.cases)) {
        if (a.cases[c]?.actions) collectActions(a.cases[c].actions, out);
      }
    }
    if (a.default?.actions) collectActions(a.default.actions, out);
  }
}

function validateGraphConsistency(definition: any, graph: any, mapping: any): string[] {
  const problems: string[] = [];

  const actionsMap = new Map<string, any>();
  collectActions(definition.actions, actionsMap);
  const knownNames = new Set<string>(actionsMap.keys());
  for (const t of Object.keys(definition.triggers ?? {})) knownNames.add(t);

  const nodeIds = new Set<string>(
    (graph.nodes as any[]).map((n: any) => String(n?.id ?? ''))
  );

  // Every edge must connect existing graph nodes.
  for (const e of (graph.edges as any[])) {
    const s = String(e?.source ?? '');
    const t = String(e?.target ?? '');
    if (!nodeIds.has(s) || !nodeIds.has(t)) {
      problems.push(`Edge "${s || '?'}" -> "${t || '?'}" references a missing graph node.`);
    }
  }

  // nodeActionMapping entries — tolerate both directions and both shapes
  // (array of {nodeId, actionName} or object map). Flag only true breaks:
  // exactly one side resolves and the other does not.
  const pairs: Array<{ a: string; b: string }> = [];
  if (Array.isArray(mapping)) {
    for (const m of mapping) {
      if (m && typeof m === 'object') {
        pairs.push({ a: String(m.nodeId ?? m.node ?? ''), b: String(m.actionName ?? m.action ?? '') });
      }
    }
  } else if (mapping && typeof mapping === 'object') {
    for (const k of Object.keys(mapping)) {
      const v = (mapping as any)[k];
      if (typeof v === 'string') {
        pairs.push({ a: k, b: v });
      } else if (v && typeof v === 'object') {
        pairs.push({ a: k, b: String(v.actionName ?? v.action ?? v.name ?? '') });
      }
    }
  }
  for (const { a, b } of pairs) {
    const aNode = nodeIds.has(a);
    const aName = knownNames.has(a);
    const bNode = nodeIds.has(b);
    const bName = knownNames.has(b);
    if (aNode && b && !bName && !bNode) {
      problems.push(`nodeActionMapping: node "${a}" maps to "${b}", which is not an action or trigger in the definition.`);
    } else if (aName && b && !bNode && !bName) {
      problems.push(`nodeActionMapping: "${a}" maps to node "${b}", which does not exist in graph.nodes.`);
    } else if (!aNode && !aName && (bNode || bName)) {
      problems.push(`nodeActionMapping: entry "${a}" matches neither a graph node nor an action.`);
    }
  }

  // Actions carrying an explicit metadata.nodeId must point to an existing node.
  actionsMap.forEach((action, name) => {
    const nid = action?.metadata?.nodeId;
    if (typeof nid === 'string' && nid && !nodeIds.has(nid)) {
      problems.push(`Action "${name}" has metadata.nodeId "${nid}" which does not exist in graph.nodes.`);
    }
  });

  return problems;
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

  // Initial load — reads the live in-page clientdata via the store bridge.
  // No API call and no token are involved.
  const fetchWorkflow = useCallback(async (): Promise<void> => {
    if (!flowId) return;
    try {
      setIsLoading(true);
      const payload = await sendCsStoreGet();
      hasLoadedRef.current = true;
      _csTriggerName = payload.triggerName ?? null;
      _workflowState = {
        workflowId: flowId,
        versionNumber: null,
        modifiedOn: null,
        clientdataHash: null,
        definitionHash: hashDefinition(payload.definition),
        source: 'live-store',
      };
      setData({ name: payload.name ?? '', workflowId: flowId, definition: buildEditorWrapper(payload) });
    } catch (error) {
      hasLoadedRef.current = true;
      addMessageRef.current(
        String(error instanceof Error ? error.message : error),
        MessageBarType.error
      );
    } finally {
      setIsLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    if (!flowId) return;
    if (hasLoadedRef.current) return;
    fetchWorkflow();
  }, [flowId, fetchWorkflow]);

  // On-demand refetch from the live store — used by open-code-view and after-restore.
  const triggerRefetch = useCallback(async (): Promise<RefetchResult | null> => {
    if (!flowId) return null;

    setIsLoading(true);
    try {
      const payload = await sendCsStoreGet();
      _csTriggerName = payload.triggerName ?? null;
      const definitionHash = hashDefinition(payload.definition);
      _workflowState = {
        workflowId: flowId,
        versionNumber: null,
        modifiedOn: null,
        clientdataHash: null,
        definitionHash,
        source: 'live-store-refetch',
      };
      const definition = buildEditorWrapper(payload);
      hasLoadedRef.current = true;
      setData(prev => ({
        ...prev,
        ...(payload.name ? { name: payload.name } : {}),
        definition,
      }));
      return { definition, source: 'live-store', definitionHash };
    } catch (e) {
      mwtWarn('[triggerRefetch] live-store error:', e);
      addMessageRef.current(
        String(e instanceof Error ? e.message : e),
        MessageBarType.error
      );
      return null;
    } finally {
      setIsLoading(false);
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
    // Explicit diagnostic fallback ONLY — never called by the normal flow, never
    // used as a silent fallback when the store path fails.
    diagnosticApiRefetch: async (): Promise<FetchCurrentResult | null> => {
      const currentApi = apiRef.current;
      if (!currentApi.isApiReady) {
        addMessage(
          'The diagnostic API path needs a captured token. Refresh the workflow tab, then retry.',
          MessageBarType.warning
        );
        return null;
      }
      return fetchCurrentWorkflowClientData(currentApi, {
        dynamicsBase: currentApi.dynamicsBaseUrl ?? undefined,
        workflowId: dataRef.current.workflowId ?? flowId ?? '',
        flowId: flowId ?? '',
        reason: 'manual-diagnostic',
      });
    },
    // Apply to canvas — merges the edited wrapper back into the live clientdata
    // (store bridge), then the interceptor drives the existing setGraph path.
    applyToCanvas: async (codeText: string): Promise<boolean> => {
      // Step 1: JSON parse
      let parsed: any;
      try {
        parsed = JSON.parse(codeText);
      } catch {
        addMessage('The code is not valid JSON. Fix the syntax and try again.', MessageBarType.error);
        return false;
      }

      // Step 2: basic structure validation
      if (!parsed?.definition || typeof parsed.definition !== 'object') {
        addMessage('Missing "definition" property.', MessageBarType.error);
        return false;
      }
      if (!parsed.definition.triggers || typeof parsed.definition.triggers !== 'object') {
        addMessage('Missing "definition.triggers" property.', MessageBarType.error);
        return false;
      }
      if (!parsed.definition.actions || typeof parsed.definition.actions !== 'object') {
        addMessage('Missing "definition.actions" property.', MessageBarType.error);
        return false;
      }

      // Step 3: resolve the trigger that holds the canvas graph. Root-level
      // "graph"/"nodeActionMapping" aliases are authoritative when present.
      const triggers = parsed.definition.triggers as Record<string, any>;
      const triggerNames = Object.keys(triggers);
      let triggerName =
        triggerNames.find(t => triggers[t]?.metadata?.associatedData?.graph) ??
        (_csTriggerName && triggers[_csTriggerName] ? _csTriggerName : null) ??
        (triggerNames.length === 1 ? triggerNames[0] : null);
      if (!triggerName) {
        addMessage(
          'Unable to determine which trigger holds the canvas graph (no trigger has metadata.associatedData.graph).',
          MessageBarType.error
        );
        return false;
      }

      const nestedAssociatedData = triggers[triggerName]?.metadata?.associatedData ?? {};
      const graph = parsed.graph ?? nestedAssociatedData.graph;
      const nodeActionMapping = parsed.nodeActionMapping ?? nestedAssociatedData.nodeActionMapping;

      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        addMessage(
          'No canvas graph found (expected "graph" at the root or at definition.triggers.' +
            triggerName + '.metadata.associatedData.graph).',
          MessageBarType.error
        );
        return false;
      }
      if (!nodeActionMapping) {
        addMessage(
          'Missing "nodeActionMapping" (expected at the root or at definition.triggers.' +
            triggerName + '.metadata.associatedData.nodeActionMapping).',
          MessageBarType.error
        );
        return false;
      }

      // Step 4: graph/action consistency (recursive over nested actions).
      const problems = validateGraphConsistency(parsed.definition, graph, nodeActionMapping);
      if (problems.length > 0) {
        mwtWarn('[MWT_APPLY_TO_CANVAS]', { event: 'validation-failed', reason: 'graph-inconsistent', details: problems });
        addMessage(['The graph and definition are inconsistent:', ...problems.slice(0, 5)], MessageBarType.error);
        return false;
      }

      // Step 5: write the authoritative root aliases into the nested trigger location.
      const mergedDefinition = parsed.definition;
      const trigger = mergedDefinition.triggers[triggerName];
      trigger.metadata = trigger.metadata ?? {};
      trigger.metadata.associatedData = trigger.metadata.associatedData ?? {};
      trigger.metadata.associatedData.graph = JSON.parse(JSON.stringify(graph));
      trigger.metadata.associatedData.nodeActionMapping = JSON.parse(JSON.stringify(nodeActionMapping));

      setIsLoading(true);
      try {
        mwtLog('[MWT_APPLY_TO_CANVAS]', {
          event: 'start',
          source: 'code-view-live-store',
          triggerName,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
        });

        const result = await sendCsStoreApply({
          definition: mergedDefinition,
          connectionReferences: parsed.connectionReferences,
        });

        if (result.success) {
          mwtLog('[MWT_APPLY_TO_CANVAS]', {
            event: 'completed',
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
          });
          addMessage('Applied to canvas. Use native Save draft to persist.');
          return true;
        }

        console.error('[MWT_APPLY_TO_CANVAS]', { event: 'failed', error: result.error });
        addMessage(
          result.error ?? 'Apply to canvas failed. The workflow data was not applied to the visual canvas.',
          MessageBarType.error
        );
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    // Validation calls the checkFlowAlerts API — explicit user action only.
    validate: async (definition: string) => {
      if (!flowId) return;
      if (!api.isApiReady) {
        addMessage(
          'Validation calls the Copilot Studio API and needs a captured token. Refresh the workflow tab, then retry.',
          MessageBarType.warning
        );
        return;
      }
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
