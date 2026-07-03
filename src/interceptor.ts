// Runs in MAIN world at document_start.
// 1. Captures the Dynamics Bearer token from the host page's fetch calls.
// 2. Intercepts GET /api/data/v9.2/workflows({id}) requests and substitutes stale
//    responses with the authoritative PATCH response captured after a Code View save.
//    The snapshot is posted from content.ts (ISOLATED world) via window.postMessage.
import { mwtLog, mwtWarn, mwtDebugEnabled } from './shared/debug';

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
    mwtWarn('[MWT_NATIVE_WORKFLOW_GET_INTERCEPTED]', {
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
            mwtLog('[MWT_NATIVE_WORKFLOW_GET_PASSTHROUGH]', {
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
              mwtWarn('[MWT_NATIVE_WORKFLOW_GET_VERSION_MISSING]', {
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
              mwtWarn('[MWT_NATIVE_WORKFLOW_GET_VERSION_MISSING]', {
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

          mwtLog('[MWT_NATIVE_WORKFLOW_GET_PASSTHROUGH]', {
            workflowId: urlWorkflowId,
            incomingVersion,
            authoritativeVersion,
            reason: !authoritativeVersion ? 'no-authoritative-version' : 'no-stale-detected',
          });
          return nativeResponse;

        } catch (parseErr) {
          mwtWarn('[MWT_NATIVE_WORKFLOW_GET_PARSE_ERROR]', parseErr);
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
          mwtLog('[MWT_PAGE_BRIDGE]', { event: 'setGraph-found' });
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

  mwtLog('[MWT_PAGE_BRIDGE]', {
    event: 'setGraph-call',
    currentNodeCount: (currentGraph.nodes as any[])?.length,
    nextNodeCount: nextNodes.length,
    nextEdgeCount: nextEdges.length,
  });

  setGraph(nextGraph, { source: 'user' });

  mwtLog('[MWT_PAGE_BRIDGE]', {
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

  mwtLog('[MWT_PAGE_BRIDGE]', {
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

mwtLog('[MWT_PAGE_BRIDGE]', { event: 'installed' });

// ── MWT Copilot Studio live store bridge (MAIN world only) ───────────────────
// Store-based Code View path: resolves the LIVE clientdata object used by the
// designer (via the React Query cache reached through React Fiber), serves it to
// Code View for load, and merges edited definitions back into it on Apply.
// No API calls and no bearer token are involved in this path. Graph apply still
// goes through the existing Copilot Studio setGraph bridge above — never through
// any PA v3 mechanism.

const MWT_CS_ERR_NO_LIVE_STORE =
  'Unable to access Copilot Studio live workflow state. Make sure the workflow designer is open and fully loaded.';
const MWT_CS_ERR_PARSED_ONLY =
  'Only a parsed workflow snapshot was found. Live designer state was not accessible.';
const MWT_CS_ERR_NO_GRAPH =
  'Unable to access associatedData.graph from Copilot Studio workflow state.';
const MWT_CS_ERR_APPLY_FAILED =
  'Apply to canvas failed. The workflow data was not applied to the visual canvas.';
const MWT_CS_ERR_NO_QUERY_SETTER =
  'Copilot Studio workflow query found, but no query update method was available.';

function mwtCsIsCopilotStudioHost(): boolean {
  return window.location.hostname.toLowerCase().includes('copilotstudio.microsoft.com');
}

function mwtCsLog(event: string, extra: Record<string, unknown> = {}): void {
  mwtLog('[MWT_COPILOT_STORE]', { event, ...extra });
}

function mwtCsJsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Shape checks ──────────────────────────────────────────────────────────────

function mwtCsFindGraphTrigger(definition: any): string | null {
  const triggers = definition?.triggers;
  if (!triggers || typeof triggers !== 'object') return null;
  for (const name of Object.keys(triggers)) {
    const ad = triggers[name]?.metadata?.associatedData;
    if (ad && typeof ad === 'object' && ad.graph && ad.nodeActionMapping) return name;
  }
  return null;
}

// A clientdata candidate must be graph-backed: properties.definition.triggers with
// at least one trigger carrying metadata.associatedData.graph + nodeActionMapping.
function mwtCsMatchClientDataShape(obj: any): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const def = obj.properties?.definition;
  if (!def || typeof def !== 'object' || !def.triggers) return null;
  return mwtCsFindGraphTrigger(def);
}

function mwtCsCollectActionNames(actions: any, out: Set<string>): void {
  if (!actions || typeof actions !== 'object') return;
  for (const name of Object.keys(actions)) {
    out.add(name);
    const a = actions[name];
    if (!a || typeof a !== 'object') continue;
    if (a.actions) mwtCsCollectActionNames(a.actions, out);
    if (a.else?.actions) mwtCsCollectActionNames(a.else.actions, out);
    if (a.cases && typeof a.cases === 'object') {
      for (const c of Object.keys(a.cases)) {
        if (a.cases[c]?.actions) mwtCsCollectActionNames(a.cases[c].actions, out);
      }
    }
    if (a.default?.actions) mwtCsCollectActionNames(a.default.actions, out);
  }
}

// ── Fiber / query-cache discovery ─────────────────────────────────────────────

// QueryClient-like detector: accepts either the standard getQueryCache() API or a
// bare queryCache property (the shape actually found on the live Copilot Studio
// page), and a cache exposing queries via getAll()/findAll()/queries[]/queriesMap.
function mwtCsGetQueryCacheFromClient(candidate: any): any | null {
  if (!candidate || typeof candidate !== 'object') return null;

  let cache: any = null;
  try {
    if (typeof candidate.getQueryCache === 'function') {
      cache = candidate.getQueryCache();
    }
  } catch {
    cache = null;
  }

  if (!cache && candidate.queryCache && typeof candidate.queryCache === 'object') {
    cache = candidate.queryCache;
  }

  if (!cache || typeof cache !== 'object') return null;

  const hasQueries =
    Array.isArray(cache.queries) ||
    typeof cache.getAll === 'function' ||
    typeof cache.findAll === 'function' ||
    !!cache.queriesMap;

  return hasQueries ? cache : null;
}

function mwtCsIsQueryClient(v: any): boolean {
  return !!mwtCsGetQueryCacheFromClient(v);
}

interface MwtCsFiberCarrier {
  value: any;
  path: string;
}

// Finds all React fiber/props/container carriers on the page. Broader than a
// __reactContainer$-only scan: the live Copilot Studio page exposes the relevant
// query client via __reactInternalInstance$ carriers, not just root containers.
function mwtCsFindReactFiberCarriers(): MwtCsFiberCarrier[] {
  const carriers: MwtCsFiberCarrier[] = [];
  const elements = Array.from(document.querySelectorAll('*')) as any[];

  for (const el of elements) {
    let names: string[] = [];
    try {
      names = Object.getOwnPropertyNames(el);
    } catch {
      continue;
    }

    for (const key of names) {
      if (
        key.startsWith('__reactFiber$') ||
        key.startsWith('__reactProps$') ||
        key.startsWith('__reactContainer$') ||
        key.startsWith('__reactInternalInstance$')
      ) {
        const value = el[key];
        if (value && typeof value === 'object') {
          carriers.push({ value, path: `element<${el.tagName}>.${key}` });
        }
      }
    }
  }

  return carriers;
}

interface MwtCsFiberScanResult {
  queryClients: any[];
  directClientData: Array<{ obj: any; triggerName: string; path: string }>;
}

function mwtCsScanFiberTree(rootFiber: any, into: MwtCsFiberScanResult, seenValues: Set<any>): void {
  const seenFibers = new Set<any>();
  const stack: any[] = [rootFiber];
  let visited = 0;

  const inspect = (value: any, path: string): void => {
    if (!value || typeof value !== 'object' || seenValues.has(value)) return;
    seenValues.add(value);
    if (mwtCsIsQueryClient(value)) {
      into.queryClients.push(value);
      return;
    }
    const trig = mwtCsMatchClientDataShape(value);
    if (trig) {
      into.directClientData.push({ obj: value, triggerName: trig, path });
      return;
    }
    // One nesting level for common wrappers ({ queryClient }, { clientData }, refs).
    for (const key of ['queryClient', 'client', 'clientData', 'clientdata', 'current', 'value']) {
      const inner = value[key];
      if (!inner || typeof inner !== 'object' || seenValues.has(inner)) continue;
      seenValues.add(inner);
      if (mwtCsIsQueryClient(inner)) {
        into.queryClients.push(inner);
      } else {
        const t = mwtCsMatchClientDataShape(inner);
        if (t) into.directClientData.push({ obj: inner, triggerName: t, path: `${path}.${key}` });
      }
    }
  };

  while (stack.length) {
    const fiber = stack.pop();
    if (!fiber || seenFibers.has(fiber)) continue;
    seenFibers.add(fiber);
    if (++visited > 300000) break;

    const mp = fiber.memoizedProps;
    if (mp && typeof mp === 'object') {
      if (mp.value !== undefined) inspect(mp.value, 'fiber.memoizedProps.value');
      if (mp.client !== undefined) inspect(mp.client, 'fiber.memoizedProps.client');
    }
    let hook = fiber.memoizedState;
    let hookIdx = 0;
    while (hook && typeof hook === 'object' && hookIdx < 64) {
      if (hook.memoizedState !== undefined) {
        inspect(hook.memoizedState, `fiber.hook[${hookIdx}].memoizedState`);
      }
      hook = hook.next;
      hookIdx++;
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
}

function mwtCsGetQueries(queryClient: any): any[] {
  try {
    const cache = mwtCsGetQueryCacheFromClient(queryClient);
    if (!cache) return [];
    if (typeof cache.getAll === 'function') return cache.getAll();
    if (typeof cache.findAll === 'function') return cache.findAll();
    if (Array.isArray(cache.queries)) return cache.queries;
    if (cache.queriesMap && typeof cache.queriesMap === 'object') {
      return typeof cache.queriesMap.values === 'function'
        ? Array.from(cache.queriesMap.values())
        : Object.keys(cache.queriesMap).map(k => cache.queriesMap[k]);
    }
    return [];
  } catch {
    return [];
  }
}

// A query's live clientdata can live in several places depending on how
// react-query has settled the observer: the query's own state.data, the
// currentResult/currentResultState snapshots, or per-observer copies of those.
// The live Copilot Studio page proved candidates in state.data AND in
// observers[0].currentResult(State).data, so all locations must be scanned.
function mwtCsCollectQueryDataLocations(query: any, queryPath: string): Array<{ value: any; path: string }> {
  const locations: Array<{ value: any; path: string }> = [];

  const push = (value: any, path: string) => {
    if (value && typeof value === 'object') {
      locations.push({ value, path });
    }
  };

  push(query?.state?.data, `${queryPath}.state.data`);
  push(query?.currentResult?.data, `${queryPath}.currentResult.data`);
  push(query?.currentResultState?.data, `${queryPath}.currentResultState.data`);

  const observers = query?.observers;
  if (Array.isArray(observers)) {
    observers.slice(0, 20).forEach((observer: any, i: number) => {
      push(observer?.currentResult?.data, `${queryPath}.observers[${i}].currentResult.data`);
      push(observer?.currentResultState?.data, `${queryPath}.observers[${i}].currentResultState.data`);
    });
  }

  return locations;
}

// Bounded deep scan of a query's state.data. Finds BOTH:
// - live clientdata objects (properties.definition already an object), and
// - string-serialized clientdata (the usual Dataverse workflow query shape:
//   state.data.clientdata is a JSON string) whose parse is graph-backed. These
//   are live-backed candidates too — the live reference is the query data object
//   that owns the string, updated through the native query setter.
function mwtCsScanValueForClientData(
  root: any,
  basePath: string,
  maxDepth: number
): {
  live: Array<{ obj: any; triggerName: string; path: string; container: any }>;
  strings: Array<{ container: any; parsed: any; triggerName: string; path: string }>;
} {
  const live: Array<{ obj: any; triggerName: string; path: string; container: any }> = [];
  const strings: Array<{ container: any; parsed: any; triggerName: string; path: string }> = [];
  const seen = new Set<any>();

  const walk = (v: any, path: string, depth: number, parent: any): void => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > maxDepth) return;
    seen.add(v);
    const trig = mwtCsMatchClientDataShape(v);
    if (trig) {
      live.push({ obj: v, triggerName: trig, path, container: parent ?? v });
      return;
    }
    if (typeof v.clientdata === 'string' && v.clientdata.includes('"definition"')) {
      try {
        const parsed = JSON.parse(v.clientdata);
        const t = mwtCsMatchClientDataShape(parsed);
        if (t) strings.push({ container: v, parsed, triggerName: t, path: `${path}.clientdata` });
      } catch {}
    }
    if (Array.isArray(v)) {
      const n = Math.min(v.length, 100);
      for (let i = 0; i < n; i++) walk(v[i], `${path}[${i}]`, depth + 1, parent ?? v);
      return;
    }
    const keys = Object.keys(v);
    const n = Math.min(keys.length, 200);
    for (let i = 0; i < n; i++) walk(v[keys[i]], `${path}.${keys[i]}`, depth + 1, parent ?? v);
  };

  walk(root, basePath, 0, null);
  return { live, strings };
}

// Re-locate the (first) clientdata string inside a query's current state.data.
// Needed for readback after a native setter update, which may rebuild the tree.
function mwtCsFindClientdataString(root: any, maxDepth: number): { container: any; raw: string } | null {
  const seen = new Set<any>();
  const walk = (v: any, depth: number): { container: any; raw: string } | null => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > maxDepth) return null;
    seen.add(v);
    if (typeof v.clientdata === 'string' && v.clientdata.includes('"definition"')) {
      return { container: v, raw: v.clientdata };
    }
    if (Array.isArray(v)) {
      const n = Math.min(v.length, 100);
      for (let i = 0; i < n; i++) {
        const hit = walk(v[i], depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const keys = Object.keys(v);
    const n = Math.min(keys.length, 200);
    for (let i = 0; i < n; i++) {
      const hit = walk(v[keys[i]], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

// ── Resolver ──────────────────────────────────────────────────────────────────

interface MwtCsCandidate {
  // 'clientdata-string': the usual shape — query.state.data owns a serialized
  // clientdata string; the live reference is the query data object, updated via
  // the native query setter. 'live-object': clientdata already a live object.
  kind: 'live-object' | 'clientdata-string';
  clientData: any; // live object, or the PARSED clientdata for string candidates
  liveQueryData: any | null; // object owning the clientdata string (string kind)
  triggerName: string;
  sourcePath: string;
  queryClient: any | null;
  query: any | null;
  queryDataRoot: any | null;
  workflowIdMatch: boolean;
  active: boolean;
  updateMethod: string | null;
}

interface MwtCsResolveResult {
  kind: 'live-object' | 'clientdata-string';
  source: string;
  liveClientData: any; // for string kind this is parsedClientdata
  liveDefinition: any;
  parsedClientdata: any | null;
  liveQueryData: any | null;
  queryKey: unknown;
  triggerName: string;
  associatedData: any;
  graph: any;
  nodeActionMapping: any;
  sourcePath: string;
  workflowName: string;
  queryClient: any | null;
  query: any | null;
  updateQueryData: (() => boolean) | null;
  updateClientdataString: ((nextClientdata: any) => any) | null;
  graphNodeCount: number;
  actionCountRecursive: number;
  candidateCount: number;
}

// Write data back into the query through a NATIVE update path, preferring
// queryClient.setQueryData, then query.setData, then a direct state write with
// a native cache notify when exposed.
function mwtCsWriteQueryData(
  cand: { query: any; queryClient: any | null },
  data: any
): 'setQueryData' | 'query.setData' | 'state-write' | null {
  const q = cand.query;
  if (!q) return null;
  try {
    if (cand.queryClient && q.queryKey !== undefined && typeof cand.queryClient.setQueryData === 'function') {
      cand.queryClient.setQueryData(q.queryKey, data);
      return 'setQueryData';
    }
  } catch {}
  try {
    if (typeof q.setData === 'function') {
      q.setData(data);
      return 'query.setData';
    }
  } catch {}
  try {
    if (q.state && typeof q.state === 'object' && 'data' in q.state) {
      q.state.data = data;
      try { q.cache?.notify?.({ query: q, type: 'updated' }); } catch {}
      return 'state-write';
    }
  } catch {}
  return null;
}

// Liveness probe for query-backed candidates: publish a harmless temporary
// marker OUTSIDE clientdata via the native setter, read it back from
// query.state.data, then remove it the same way. Graph/actions are untouched.
function mwtCsProbeQueryLiveness(cand: MwtCsCandidate): { ok: boolean; method: string | null } {
  const q = cand.query;
  const original = q?.state?.data;
  if (!original || typeof original !== 'object') return { ok: false, method: null };
  const probeClone: any = Array.isArray(original) ? original.slice() : Object.assign({}, original);
  probeClone.__mwtProbe = true;
  const method = mwtCsWriteQueryData(cand, probeClone);
  if (!method) return { ok: false, method: null };
  const readback: any = q.state?.data;
  const ok = !!readback && readback.__mwtProbe === true;
  const cleaned: any = Array.isArray(readback) ? readback.slice() : Object.assign({}, readback ?? {});
  try { delete cleaned.__mwtProbe; } catch {}
  mwtCsWriteQueryData(cand, cleaned);
  return { ok, method };
}

// Serialize nextClientdata into the query via the native setter and return the
// re-parsed clientdata read back from query.state.data.
function mwtCsBuildUpdateClientdataString(cand: MwtCsCandidate): (nextClientdata: any) => any {
  return (nextClientdata: any) => {
    const q = cand.query;
    const nextString = JSON.stringify(nextClientdata);

    // Write onto the live container first (covers nested containers), then
    // republish the root through the native setter so observers are notified.
    if (cand.liveQueryData && typeof cand.liveQueryData === 'object') {
      cand.liveQueryData.clientdata = nextString;
    }
    const root = q?.state?.data ?? cand.queryDataRoot;
    if (!root || typeof root !== 'object') throw new Error(MWT_CS_ERR_NO_QUERY_SETTER);
    const rootClone: any = Array.isArray(root) ? root.slice() : Object.assign({}, root);
    if ('clientdata' in rootClone) rootClone.clientdata = nextString;
    const method = mwtCsWriteQueryData(cand, rootClone);
    if (!method) throw new Error(MWT_CS_ERR_NO_QUERY_SETTER);
    mwtCsLog('query-update-method', { method });

    const readbackHit = mwtCsFindClientdataString(q?.state?.data, 8);
    if (!readbackHit) throw new Error(MWT_CS_ERR_APPLY_FAILED);
    const readbackOk = readbackHit.raw === nextString;
    mwtCsLog('clientdata-readback', { ok: readbackOk });
    if (!readbackOk) throw new Error(MWT_CS_ERR_APPLY_FAILED);
    return JSON.parse(readbackHit.raw);
  };
}

function mwtCsExtractWorkflowIdFromLocation(): string | null {
  const m = /flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(window.location.href);
  return m ? m[1].toLowerCase() : null;
}

function mwtCsCandidateMatchesWorkflow(cand: MwtCsCandidate, wfId: string | null): boolean {
  if (!wfId) return false;
  try {
    const container = cand.queryDataRoot ?? cand.clientData;
    const idFields = [
      container?.workflowid,
      container?.workflowId,
      container?.id,
      cand.liveQueryData?.workflowid,
      cand.liveQueryData?.workflowId,
      cand.liveQueryData?.id,
      cand.clientData?.workflowid,
    ];
    for (const f of idFields) {
      if (typeof f === 'string' && f.toLowerCase().includes(wfId)) return true;
    }
    if (cand.query && String(cand.query.queryHash ?? '').toLowerCase().includes(wfId)) return true;
  } catch {}
  return false;
}

function mwtCsQueryIsActive(query: any): boolean {
  try {
    if (typeof query?.getObserversCount === 'function') return query.getObserversCount() > 0;
    if (Array.isArray(query?.observers)) return query.observers.length > 0;
  } catch {}
  return false;
}

// Non-destructive liveness check: a temporary marker set on the candidate must be
// readable back through the same live source, then it is removed. Graph and
// actions are never mutated here.
function mwtCsValidateLiveReference(cand: MwtCsCandidate): boolean {
  const marker = '__mwtLiveCheck_' + Math.random().toString(36).slice(2);
  try {
    cand.clientData[marker] = true;
    if (cand.query) {
      const rescan = mwtCsScanValueForClientData(cand.query.state?.data, 'q', 8);
      return rescan.live.some(r => r.obj === cand.clientData && (r.obj as any)[marker] === true);
    }
    return (cand.clientData as any)[marker] === true;
  } catch {
    return false;
  } finally {
    try { delete cand.clientData[marker]; } catch {}
  }
}

function mwtCsBuildUpdateQueryData(cand: MwtCsCandidate): (() => boolean) | null {
  if (!cand.query) return null;
  return () => {
    try {
      const q = cand.query;
      const current = q.state?.data;
      const next = Array.isArray(current)
        ? current.slice()
        : current && typeof current === 'object'
          ? Object.assign({}, current)
          : current;
      if (cand.queryClient && q.queryKey !== undefined && typeof cand.queryClient.setQueryData === 'function') {
        cand.queryClient.setQueryData(q.queryKey, next);
        return true;
      }
      if (typeof q.setData === 'function') {
        q.setData(next);
        return true;
      }
    } catch (e) {
      mwtWarn('[MWT_COPILOT_STORE]', { event: 'query-cache-update-failed', error: String(e) });
    }
    return false;
  };
}

function findCopilotStudioLiveClientData(): MwtCsResolveResult {
  if (!mwtCsIsCopilotStudioHost()) {
    throw new Error(MWT_CS_ERR_NO_LIVE_STORE);
  }

  mwtCsLog('resolver-started');

  const scan: MwtCsFiberScanResult = { queryClients: [], directClientData: [] };
  const seenValues = new Set<any>();

  const carriers = mwtCsFindReactFiberCarriers();
  mwtCsLog('react-carriers', {
    carrierCount: carriers.length,
    samplePaths: carriers.slice(0, 20).map(c => c.path),
  });

  for (const carrier of carriers) {
    mwtCsScanFiberTree(carrier.value, scan, seenValues);
  }

  if (carriers.length === 0) {
    mwtCsLog('diagnostic', { message: 'No React carriers found from MAIN world.' });
  } else if (scan.queryClients.length === 0) {
    mwtCsLog('diagnostic', { message: 'React carriers were found but no QueryClient-like object was discovered.' });
  }

  const candidates: MwtCsCandidate[] = [];
  const wfId = mwtCsExtractWorkflowIdFromLocation();

  const seenClientData = new Set<any>();
  let totalQueryCount = 0;
  let dataLocationsScanned = 0;
  for (const qc of scan.queryClients) {
    const queries = mwtCsGetQueries(qc);
    totalQueryCount += queries.length;
    for (const query of queries) {
      const locations = mwtCsCollectQueryDataLocations(query, 'queryCache.query');
      for (const loc of locations) {
        dataLocationsScanned++;
        const { live, strings } = mwtCsScanValueForClientData(loc.value, loc.path, 8);
        for (const hit of strings) {
          if (seenClientData.has(hit.container)) continue;
          seenClientData.add(hit.container);
          candidates.push({
            kind: 'clientdata-string',
            clientData: hit.parsed,
            liveQueryData: hit.container,
            triggerName: hit.triggerName,
            sourcePath: hit.path,
            queryClient: qc,
            query,
            queryDataRoot: query?.state?.data ?? null,
            workflowIdMatch: false,
            active: mwtCsQueryIsActive(query),
            updateMethod: null,
          });
        }
        for (const hit of live) {
          if (seenClientData.has(hit.obj)) continue;
          seenClientData.add(hit.obj);
          candidates.push({
            kind: 'live-object',
            clientData: hit.obj,
            liveQueryData: null,
            triggerName: hit.triggerName,
            sourcePath: hit.path,
            queryClient: qc,
            query,
            queryDataRoot: query?.state?.data ?? null,
            workflowIdMatch: false,
            active: mwtCsQueryIsActive(query),
            updateMethod: null,
          });
        }
      }
    }
  }

  mwtCsLog('query-client-scan', {
    queryClients: scan.queryClients.length,
    queryCount: totalQueryCount,
    dataLocationsScanned,
  });

  for (const hit of scan.directClientData) {
    if (seenClientData.has(hit.obj)) continue;
    seenClientData.add(hit.obj);
    candidates.push({
      kind: 'live-object',
      clientData: hit.obj,
      liveQueryData: null,
      triggerName: hit.triggerName,
      sourcePath: hit.path,
      queryClient: null,
      query: null,
      queryDataRoot: null,
      workflowIdMatch: false,
      active: false,
      updateMethod: null,
    });
  }

  for (const c of candidates) c.workflowIdMatch = mwtCsCandidateMatchesWorkflow(c, wfId);

  mwtCsLog('candidate-count', {
    candidates: candidates.length,
    stringCandidates: candidates.filter(c => c.kind === 'clientdata-string').length,
    liveObjectCandidates: candidates.filter(c => c.kind === 'live-object').length,
    queryClients: scan.queryClients.length,
    workflowId: wfId,
  });

  if (candidates.length === 0) {
    throw new Error(MWT_CS_ERR_NO_LIVE_STORE);
  }

  // Rank: query-cache-backed first; within those, prefer the serialized
  // clientdata-string shape (the designer re-reads the string, so it is the
  // authoritative live reference), then workflow-id match, then active query.
  candidates.sort((a, b) => {
    const score = (c: MwtCsCandidate) =>
      (c.query ? 8 : 0) +
      (c.kind === 'clientdata-string' ? 4 : 0) +
      (c.workflowIdMatch ? 2 : 0) +
      (c.active ? 1 : 0);
    return score(b) - score(a);
  });

  let selected: MwtCsCandidate | null = null;
  let sawStringCandidateWithoutSetter = false;
  for (const c of candidates) {
    if (c.kind === 'clientdata-string') {
      const probe = mwtCsProbeQueryLiveness(c);
      if (probe.ok) {
        c.updateMethod = probe.method;
        selected = c;
        break;
      }
      if (!probe.method) sawStringCandidateWithoutSetter = true;
      mwtCsLog('candidate-rejected-not-live', { sourcePath: c.sourcePath, kind: c.kind, method: probe.method });
    } else {
      if (mwtCsValidateLiveReference(c)) { selected = c; break; }
      mwtCsLog('candidate-rejected-not-live', { sourcePath: c.sourcePath, kind: c.kind });
    }
  }
  if (!selected) {
    throw new Error(sawStringCandidateWithoutSetter ? MWT_CS_ERR_NO_QUERY_SETTER : MWT_CS_ERR_PARSED_ONLY);
  }

  const liveClientData = selected.clientData;
  const liveDefinition = liveClientData?.properties?.definition;
  if (!liveDefinition) {
    throw new Error(MWT_CS_ERR_NO_LIVE_STORE);
  }
  const triggerName = selected.triggerName;
  const associatedData = liveDefinition.triggers[triggerName].metadata.associatedData;
  if (!associatedData?.graph) {
    throw new Error(MWT_CS_ERR_NO_GRAPH);
  }

  const actionNames = new Set<string>();
  mwtCsCollectActionNames(liveDefinition.actions, actionNames);
  const graphNodeCount = Array.isArray(associatedData.graph?.nodes) ? associatedData.graph.nodes.length : 0;
  const workflowName = String(
    (selected.queryDataRoot as any)?.name ??
    (selected.liveQueryData as any)?.name ??
    liveClientData.name ??
    ''
  );

  const result: MwtCsResolveResult = {
    kind: selected.kind,
    source: selected.kind === 'clientdata-string' ? 'react-query-clientdata-string' : 'live-object',
    liveClientData,
    liveDefinition,
    parsedClientdata: selected.kind === 'clientdata-string' ? liveClientData : null,
    liveQueryData: selected.liveQueryData,
    queryKey: selected.query?.queryKey,
    triggerName,
    associatedData,
    graph: associatedData.graph,
    nodeActionMapping: associatedData.nodeActionMapping,
    sourcePath: selected.sourcePath,
    workflowName,
    queryClient: selected.queryClient,
    query: selected.query,
    updateQueryData: mwtCsBuildUpdateQueryData(selected),
    updateClientdataString: selected.kind === 'clientdata-string'
      ? mwtCsBuildUpdateClientdataString(selected)
      : null,
    graphNodeCount,
    actionCountRecursive: actionNames.size,
    candidateCount: candidates.length,
  };

  mwtCsLog('candidate-type', { type: selected.kind });
  try {
    mwtCsLog('query-key', { queryKey: JSON.stringify(selected.query?.queryKey ?? null)?.slice(0, 300) });
  } catch {}
  mwtCsLog('query-update-method', { method: selected.updateMethod });
  mwtCsLog('selected-source-path', { sourcePath: result.sourcePath, queryBacked: !!selected.query });
  mwtCsLog('trigger-name', { triggerName });
  mwtCsLog('graph-node-count', { graphNodeCount });
  mwtCsLog('action-count-recursive', { actionCountRecursive: actionNames.size });

  if (mwtDebugEnabled()) {
    (window as any).__MWT_COPILOT_LIVE_CLIENTDATA__ = liveClientData;
    (window as any).__MWT_COPILOT_LIVE_DEFINITION__ = liveDefinition;
    (window as any).__MWT_COPILOT_GRAPH__ = associatedData.graph;
    (window as any).__MWT_COPILOT_NODE_ACTION_MAPPING__ = associatedData.nodeActionMapping;
  }

  return result;
}

// Snapshot of the live clientdata captured at Code View load — retained for
// discard/diagnostics only, never re-applied automatically.
let _mwtCsOriginalSnapshot: unknown = null;

// ── Visual readback ───────────────────────────────────────────────────────────

async function mwtCsVerifyGraphApplied(expectedGraph: any, timeoutMs: number): Promise<boolean> {
  const expectedIds = new Set<string>(
    (Array.isArray(expectedGraph?.nodes) ? expectedGraph.nodes : []).map((n: any) => String(n?.id ?? ''))
  );
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = mwtFindCurrentGraph();
      const currentIds = new Set<string>(
        ((current.nodes as any[]) ?? []).map(n => String(n?.id ?? ''))
      );
      if (currentIds.size === expectedIds.size) {
        let allMatch = true;
        expectedIds.forEach(id => { if (!currentIds.has(id)) allMatch = false; });
        if (allMatch) return true;
      }
    } catch {}
    await new Promise<void>(resolve => setTimeout(resolve, 150));
  }
  return false;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function mwtCsHandleGet(): {
  definition: unknown;
  connectionReferences: unknown;
  graph: unknown;
  nodeActionMapping: unknown;
  triggerName: string;
  name: string;
  sourcePath: string;
  diagnostics: Record<string, unknown>;
} {
  const resolved = findCopilotStudioLiveClientData();
  _mwtCsOriginalSnapshot = mwtCsJsonClone(resolved.liveClientData);
  return mwtCsJsonClone({
    definition: resolved.liveDefinition,
    connectionReferences: resolved.liveClientData.properties.connectionReferences ?? {},
    graph: resolved.graph,
    nodeActionMapping: resolved.nodeActionMapping,
    triggerName: resolved.triggerName,
    name: resolved.workflowName,
    sourcePath: resolved.sourcePath,
    diagnostics: {
      candidateCount: resolved.candidateCount,
      graphNodeCount: resolved.graphNodeCount,
      actionCountRecursive: resolved.actionCountRecursive,
      queryCacheBacked: !!resolved.query,
    },
  });
}

async function mwtCsHandleApply(payload: {
  definition: any;
  connectionReferences?: unknown;
}): Promise<{ nodeCount: number; edgeCount: number; queryCacheUpdated: boolean }> {
  if (!payload?.definition || typeof payload.definition !== 'object') {
    throw new Error('Apply payload is missing "definition".');
  }
  const triggerName = mwtCsFindGraphTrigger(payload.definition);
  if (!triggerName) {
    throw new Error(MWT_CS_ERR_NO_GRAPH);
  }
  const graph = payload.definition.triggers[triggerName].metadata.associatedData.graph;

  const resolved = findCopilotStudioLiveClientData();

  let queryCacheUpdated = false;
  let appliedGraph: any = graph;

  if (resolved.kind === 'clientdata-string' && resolved.updateClientdataString) {
    // Usual shape: clientdata lives as a serialized string in the query data.
    // Merge into the parsed clientdata, re-serialize through the native query
    // setter, then drive the visual apply from the READBACK — never from a
    // reference that was only mutated locally.
    const nextClientdata = resolved.parsedClientdata ?? { properties: {} };
    nextClientdata.properties = nextClientdata.properties ?? {};
    nextClientdata.properties.definition = payload.definition;
    if (payload.connectionReferences !== undefined) {
      nextClientdata.properties.connectionReferences = payload.connectionReferences;
    }
    const readbackClientdata = resolved.updateClientdataString(nextClientdata);
    queryCacheUpdated = true;

    const readbackTrigger = mwtCsFindGraphTrigger(readbackClientdata?.properties?.definition);
    if (!readbackTrigger) {
      throw new Error(MWT_CS_ERR_NO_GRAPH);
    }
    appliedGraph =
      readbackClientdata.properties.definition.triggers[readbackTrigger].metadata.associatedData.graph;
    mwtCsLog('apply-merge-completed', { triggerName: readbackTrigger, mode: 'clientdata-string' });
  } else {
    // Live object shape: merge into the live reference, then re-publish through
    // the native React Query setter so observers see the change.
    resolved.liveClientData.properties.definition = payload.definition;
    if (payload.connectionReferences !== undefined) {
      resolved.liveClientData.properties.connectionReferences = payload.connectionReferences;
    }
    mwtCsLog('apply-merge-completed', { triggerName, mode: 'live-object' });

    if (resolved.updateQueryData) {
      queryCacheUpdated = resolved.updateQueryData();
    }
  }
  mwtCsLog('query-cache-updated', { queryCacheUpdated });

  // Visual apply through the EXISTING Copilot Studio graph-backed setGraph path.
  const graphToApply = {
    ...appliedGraph,
    ...(payload.connectionReferences !== undefined
      ? { connectionReferences: payload.connectionReferences }
      : {}),
  };
  const applyResult = await mwtApplyGraphToCanvas(graphToApply);
  mwtCsLog('set-graph-called', { nodeCount: applyResult.nodeCount, edgeCount: applyResult.edgeCount });

  const readbackOk = await mwtCsVerifyGraphApplied(appliedGraph, 3000);
  mwtCsLog('visual-graph-readback', { success: readbackOk });
  if (!readbackOk) {
    throw new Error(MWT_CS_ERR_APPLY_FAILED);
  }

  return { ...applyResult, queryCacheUpdated };
}

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window) return;
  const type = event.data?.type;
  if (type !== 'MWT_CS_STORE_GET_REQUEST' && type !== 'MWT_CS_STORE_APPLY_REQUEST') return;

  const requestId = event.data.requestId as string;
  const responseType = type === 'MWT_CS_STORE_GET_REQUEST'
    ? 'MWT_CS_STORE_GET_RESPONSE'
    : 'MWT_CS_STORE_APPLY_RESPONSE';

  try {
    if (type === 'MWT_CS_STORE_GET_REQUEST') {
      const payload = mwtCsHandleGet();
      window.postMessage({ type: responseType, requestId, success: true, payload }, '*');
    } else {
      const result = await mwtCsHandleApply(event.data.payload);
      window.postMessage({ type: responseType, requestId, success: true, result }, '*');
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[MWT_COPILOT_STORE]', { event: `${type}-failed`, requestId, error: err.message, stack: err.stack });
    window.postMessage({ type: responseType, requestId, success: false, error: err.message }, '*');
  }
});

// Keeps TS from flagging the retained-snapshot variable as write-only; also a
// handy diagnostic hook.
(window as any).__MWT_CS_GET_ORIGINAL_SNAPSHOT__ = () => _mwtCsOriginalSnapshot;

mwtCsLog('installed');
