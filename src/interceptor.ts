// Runs in MAIN world at document_start.
// 1. Captures the Dynamics Bearer token from the host page's fetch calls.
// 2. Intercepts GET /api/data/v9.2/workflows({id}) requests and substitutes stale
//    responses with the authoritative PATCH response captured after a Code View save.
//    The snapshot is posted from content.ts (ISOLATED world) via window.postMessage.
(function () {

  // ── Canonical hash (mirrors useFlowEditor.ts) ─────────────────────────────

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

  function hashText(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  function hashDefinition(definition: unknown): string {
    return hashText(JSON.stringify(canonicalize(definition)));
  }

  // ── Authoritative snapshot ─────────────────────────────────────────────────

  interface AuthoritativeWorkflowSnapshot {
    workflowId: string;
    workflow: Record<string, unknown>;
    versionNumber: number | null;
    modifiedOn: string | null;
    clientdataHash: string | null;
    definitionHash: string | null;
    createdAt: number;
    expiresAt: number;
    source: 'save-patch-response';
  }

  let _authoritativeSnapshot: AuthoritativeWorkflowSnapshot | null = null;

  // content.ts bridges the snapshot here via window.postMessage (structured clone).
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'MWT_AUTHORITATIVE_SNAPSHOT_SET') return;
    const snapshot = e.data.snapshot as AuthoritativeWorkflowSnapshot | undefined;
    if (!snapshot?.workflowId) return;
    _authoritativeSnapshot = snapshot;
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isSnapshotValid(): boolean {
    return !!_authoritativeSnapshot && Date.now() < _authoritativeSnapshot.expiresAt;
  }

  function extractWorkflowIdFromUrl(url: string): string | null {
    const match = /\/workflows\(([^)]+)\)/i.exec(url);
    return match ? match[1].toLowerCase() : null;
  }

  function isWorkflowGetRequest(url: string, method: string): boolean {
    return method.toUpperCase() === 'GET' && url.includes('/api/data/v9.2/workflows(');
  }

  function getIncomingDefinitionHash(nativeJson: Record<string, unknown>): string {
    try {
      const clientdataStr = nativeJson.clientdata;
      const cd = typeof clientdataStr === 'string'
        ? JSON.parse(clientdataStr as string)
        : clientdataStr;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return hashDefinition((cd as any)?.properties?.definition);
    } catch {
      return 'parse-error';
    }
  }

  function cloneResponseHeaders(headers: Headers): Headers {
    const cloned = new Headers();
    headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-length') cloned.set(k, v);
    });
    cloned.set('content-type', 'application/json; odata.metadata=minimal');
    return cloned;
  }

  function makeAuthoritativeResponse(
    nativeResponse: Response,
    snapshot: AuthoritativeWorkflowSnapshot,
    urlWorkflowId: string,
    event: string,
    extra: Record<string, unknown>
  ): Response {
    console.warn('[MWT_NATIVE_WORKFLOW_GET_INTERCEPTED]', {
      event,
      workflowId: urlWorkflowId,
      authoritativeVersion: snapshot.versionNumber,
      authoritativeModifiedOn: snapshot.modifiedOn,
      authoritativeDefinitionHash: snapshot.definitionHash,
      ...extra,
    });
    return new Response(JSON.stringify(snapshot.workflow), {
      status: nativeResponse.status,
      statusText: nativeResponse.statusText,
      headers: cloneResponseHeaders(nativeResponse.headers),
    });
  }

  // ── Fetch wrapper ──────────────────────────────────────────────────────────

  const _origFetch = window.fetch;
  (window as any).fetch = async function (...args: any[]) {
    const req = args[0];
    const url = typeof req === 'string' ? req : ((req as Request)?.url ?? '');
    const opts: RequestInit = args[1] ?? {};
    const method = (opts.method ?? (req instanceof Request ? req.method : 'GET')) as string;

    // 1. Capture Dynamics Bearer token (existing behaviour).
    if (url.includes('dynamics.com/api/data')) {
      let auth: string | null | undefined;
      if (opts.headers instanceof Headers) {
        auth = opts.headers.get('Authorization') ?? opts.headers.get('authorization');
      } else if (opts.headers && typeof opts.headers === 'object') {
        const h = opts.headers as Record<string, string>;
        auth = h['Authorization'] ?? h['authorization'];
      }
      if (auth) (window as any)._mwtDynamicsToken = auth;
    }

    // 2. Intercept workflow GET requests during the authoritative-snapshot window.
    if (isWorkflowGetRequest(url, method) && isSnapshotValid()) {
      const snapshot = _authoritativeSnapshot!;
      const urlWorkflowId = extractWorkflowIdFromUrl(url);
      const snapshotWorkflowId = snapshot.workflowId.toLowerCase();

      if (urlWorkflowId && urlWorkflowId === snapshotWorkflowId) {
        let nativeResponse: Response;
        try {
          nativeResponse = await _origFetch.apply(this, args as [RequestInfo | URL, RequestInit?]);
        } catch (fetchErr) {
          throw fetchErr;
        }

        try {
          const nativeJson = await nativeResponse.clone().json() as Record<string, unknown>;
          const incomingVersion = Number(nativeJson.versionnumber ?? 0);
          const authoritativeVersion = Number(snapshot.versionNumber ?? 0);

          // Primary: versionnumber comparison.
          if (authoritativeVersion > 0 && incomingVersion > 0) {
            if (incomingVersion < authoritativeVersion) {
              return makeAuthoritativeResponse(nativeResponse, snapshot, urlWorkflowId,
                'replaced-stale-native-get', {
                  incomingVersion,
                  incomingModifiedOn: nativeJson.modifiedon,
                  incomingDefinitionHash: getIncomingDefinitionHash(nativeJson),
                });
            }
            console.log('[MWT_NATIVE_WORKFLOW_GET_PASSTHROUGH]', {
              workflowId: urlWorkflowId,
              incomingVersion,
              authoritativeVersion,
              reason: 'native-current-or-newer',
            });
            return nativeResponse;
          }

          // Fallback A: modifiedon comparison (versionnumber absent in response).
          if (!incomingVersion && authoritativeVersion > 0) {
            const incomingModifiedOn = nativeJson.modifiedon as string | undefined;
            const authoritativeModifiedOn = snapshot.modifiedOn;

            if (authoritativeModifiedOn && incomingModifiedOn && incomingModifiedOn < authoritativeModifiedOn) {
              console.warn('[MWT_NATIVE_WORKFLOW_GET_VERSION_MISSING]', {
                event: 'replaced-stale-native-get-by-modifiedon',
                workflowId: urlWorkflowId,
                incomingModifiedOn,
                authoritativeModifiedOn,
              });
              return makeAuthoritativeResponse(nativeResponse, snapshot, urlWorkflowId,
                'replaced-stale-native-get-by-modifiedon', { incomingModifiedOn });
            }

            // Fallback B: definition hash comparison within TTL window.
            const incomingHash = getIncomingDefinitionHash(nativeJson);
            if (incomingHash !== 'parse-error' && incomingHash !== snapshot.definitionHash) {
              console.warn('[MWT_NATIVE_WORKFLOW_GET_VERSION_MISSING]', {
                event: 'replaced-stale-native-get-by-hash',
                workflowId: urlWorkflowId,
                incomingHash,
                authoritativeHash: snapshot.definitionHash,
              });
              return makeAuthoritativeResponse(nativeResponse, snapshot, urlWorkflowId,
                'replaced-stale-native-get-by-hash', {
                  incomingHash,
                  authoritativeHash: snapshot.definitionHash,
                });
            }
          }

          console.log('[MWT_NATIVE_WORKFLOW_GET_PASSTHROUGH]', {
            workflowId: urlWorkflowId,
            incomingVersion,
            authoritativeVersion,
            reason: !authoritativeVersion ? 'no-authoritative-version' : 'no-stale-detected',
          });
          return nativeResponse;

        } catch (parseErr) {
          console.warn('[MWT_NATIVE_WORKFLOW_GET_PARSE_ERROR]', parseErr);
          return nativeResponse;
        }
      }
    }

    return _origFetch.apply(this, args as [RequestInfo | URL, RequestInit?]);
  };

})();

// ── MWT Page Bridge — Fiber discovery + setGraph (MAIN world only) ───────────
// Receives MWT_APPLY_TO_CANVAS_REQUEST from content.ts (isolated world) via
// window.postMessage and performs all React Fiber access here in MAIN world,
// where __reactFiber$... expando properties are visible.

function mwtGetCanvasNode(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-testid="canvas-node"].react-flow__node-builtinFunction') ||
    document.querySelector<HTMLElement>('[data-testid="canvas-node"]') ||
    document.querySelector<HTMLElement>('.react-flow__node')
  );
}

function mwtGetReactFiber(node: HTMLElement): unknown {
  const fiberKey = Object.keys(node).find(
    k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  if (!fiberKey) throw new Error('React Fiber not found on canvas node');
  return (node as any)[fiberKey];
}

function mwtFindNativeSetGraph(): (graph: unknown, opts: unknown) => void {
  const node = mwtGetCanvasNode();
  if (!node) throw new Error('Canvas node not found');
  const fiber = mwtGetReactFiber(node);
  let current: any = fiber;
  while (current) {
    let hook: any = current.memoizedState;
    while (hook) {
      for (const candidate of [hook.memoizedState?.inst?.value, hook.baseState?.inst?.value]) {
        if (typeof candidate === 'function' && candidate.name === 'setGraph') {
          console.log('[MWT_PAGE_BRIDGE]', { event: 'setGraph-found' });
          return candidate;
        }
      }
      hook = hook.next;
    }
    current = current.return;
  }
  throw new Error('Native setGraph not found in Fiber');
}

function mwtFindCurrentGraph(): Record<string, unknown> {
  const node = mwtGetCanvasNode();
  if (!node) throw new Error('Canvas node not found');
  const fiber = mwtGetReactFiber(node);
  let current: any = fiber;
  while (current) {
    let hook: any = current.memoizedState;
    while (hook) {
      for (const candidate of [
        hook.memoizedState?.current?.value,
        hook.memoizedState?.inst?.value,
        hook.baseState?.current?.value,
        hook.baseState?.inst?.value,
        hook.memoizedState,
        hook.baseState,
      ]) {
        if (
          candidate &&
          typeof candidate === 'object' &&
          !Array.isArray(candidate) &&
          Array.isArray((candidate as any).nodes) &&
          Array.isArray((candidate as any).edges)
        ) {
          return candidate as Record<string, unknown>;
        }
      }
      hook = hook.next;
    }
    current = current.return;
  }
  throw new Error('Current graph not found in Fiber');
}

async function mwtFindNativeSetGraphWithRetry(timeoutMs = 3000): Promise<(graph: unknown, opts: unknown) => void> {
  const started = Date.now();
  let lastErr: unknown;
  while (Date.now() - started < timeoutMs) {
    try { return mwtFindNativeSetGraph(); } catch (e) { lastErr = e; }
    await new Promise<void>(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`setGraph not found after ${timeoutMs}ms: ${lastErr}`);
}

async function mwtFindCurrentGraphWithRetry(timeoutMs = 3000): Promise<Record<string, unknown>> {
  const started = Date.now();
  let lastErr: unknown;
  while (Date.now() - started < timeoutMs) {
    try { return mwtFindCurrentGraph(); } catch (e) { lastErr = e; }
    await new Promise<void>(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Current graph not found after ${timeoutMs}ms: ${lastErr}`);
}

function mwtBuildFullGraph(
  incoming: { nodes: any[]; edges: any[]; [key: string]: unknown },
  currentGraph: Record<string, unknown>
): Record<string, unknown> {
  const currentNodes: any[] = (currentGraph.nodes as any[]) ?? [];
  const currentById = new Map(currentNodes.map(n => [String(n.id ?? ''), n]));
  const nextNodes = incoming.nodes.map((parsedNode: any) => {
    const current = currentById.get(String(parsedNode.id ?? ''));
    return current ? { ...current, ...parsedNode } : parsedNode;
  });
  return {
    ...currentGraph,
    nodes: nextNodes,
    edges: incoming.edges,
    ...(incoming.name !== undefined ? { name: incoming.name } : {}),
    ...(incoming.connectionReferences !== undefined ? { connectionReferences: incoming.connectionReferences } : {}),
  };
}

async function mwtApplyGraphToCanvas(incomingGraph: unknown): Promise<{ nodeCount: number; edgeCount: number }> {
  const incoming = incomingGraph as any;
  const currentGraph = await mwtFindCurrentGraphWithRetry();
  const nextGraph = mwtBuildFullGraph(incoming, currentGraph);
  const setGraph = await mwtFindNativeSetGraphWithRetry();

  const nextNodes: any[] = nextGraph.nodes as any[];
  const nextEdges: any[] = nextGraph.edges as any[];

  console.log('[MWT_PAGE_BRIDGE]', {
    event: 'setGraph-call',
    currentNodeCount: (currentGraph.nodes as any[])?.length,
    nextNodeCount: nextNodes.length,
    nextEdgeCount: nextEdges.length,
  });

  setGraph(nextGraph, { source: 'user' });

  console.log('[MWT_PAGE_BRIDGE]', {
    event: 'apply-completed',
    nodeCount: nextNodes.length,
    edgeCount: nextEdges.length,
  });

  return { nodeCount: nextNodes.length, edgeCount: nextEdges.length };
}

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window) return;

  if (event.data?.type === 'MWT_PAGE_BRIDGE_PING') {
    window.postMessage({ type: 'MWT_PAGE_BRIDGE_READY' }, '*');
    return;
  }

  if (event.data?.type !== 'MWT_APPLY_TO_CANVAS_REQUEST') return;

  const requestId = event.data.requestId as string;
  const graph = event.data.graph as unknown;

  console.log('[MWT_PAGE_BRIDGE]', {
    event: 'apply-start',
    requestId,
    nodeCount: (graph as any)?.nodes?.length,
    edgeCount: (graph as any)?.edges?.length,
  });

  try {
    const result = await mwtApplyGraphToCanvas(graph);
    window.postMessage({ type: 'MWT_APPLY_TO_CANVAS_RESPONSE', requestId, success: true, result }, '*');
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[MWT_PAGE_BRIDGE]', { event: 'apply-failed', requestId, error: err.message, stack: err.stack });
    window.postMessage({ type: 'MWT_APPLY_TO_CANVAS_RESPONSE', requestId, success: false, error: err.message }, '*');
  }
});

console.log('[MWT_PAGE_BRIDGE]', { event: 'installed' });
