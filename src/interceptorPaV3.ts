// Runs in MAIN world at document_start, on make.powerautomate.com / make.powerapps.com only
// (see manifest.json — this content script is never matched on copilotstudio.microsoft.com).
//
// Fully parallel to interceptor.ts: separate file, separate bundle, separate message
// namespace (MWT_PA_V3_*). Does not import from or reference interceptor.ts in any way.
//
// Responsibility: discover the native Power Automate v3 designerHostContextStore through
// React Fiber and perform the confirmed Apply-to-canvas mechanism (setFlowData +
// setIsFlowDirty). No Dataverse/PATCH fallback — if the store cannot be found, callers get
// a hard error and must stop (see findPowerAutomateV3DesignerHostContextStore).
(function () {

  // ── Designer host context store shape ─────────────────────────────────────

  interface DesignerHostContextStore {
    flowWorkflowData: { definition: unknown; connectionReferences?: unknown; [key: string]: unknown };
    flowData: { properties?: { definition?: unknown; connectionReferences?: unknown; parameters?: unknown; [key: string]: unknown }; [key: string]: unknown };
    setFlowData: (next: unknown) => void;
    setFlowWorkflowData?: (next: unknown) => void;
    setIsFlowDirty: (dirty: boolean) => void;
    setSelectedNode?: (node: unknown) => void;
    resetAllMessageBarProps?: () => void;
    setMessageBarProps?: (props: unknown) => void;
    [key: string]: unknown;
  }

  function looksLikeDesignerHostContextStore(candidate: unknown): candidate is DesignerHostContextStore {
    if (!candidate || typeof candidate !== 'object') return false;
    const store = candidate as Record<string, unknown>;
    const flowWorkflowData = store.flowWorkflowData as Record<string, unknown> | undefined;
    return Boolean(
      flowWorkflowData &&
      typeof flowWorkflowData === 'object' &&
      flowWorkflowData.definition &&
      store.flowData &&
      typeof store.setFlowData === 'function' &&
      typeof store.setIsFlowDirty === 'function'
    );
  }

  // Values known (from discovery notes) to sometimes hold the store one level down.
  const NESTED_STORE_KEYS = [
    'designerHostContextStore',
    '_connectionDesignerContext',
    'connectionService',
    'designerConnectionService',
  ];

  function deepFindStore(value: unknown, depth: number, visited: Set<unknown>): DesignerHostContextStore | null {
    if (!value || typeof value !== 'object' || depth > 4) return null;
    if (visited.has(value)) return null;
    visited.add(value);

    if (looksLikeDesignerHostContextStore(value)) return value;

    for (const key of NESTED_STORE_KEYS) {
      const nested = (value as Record<string, unknown>)[key];
      if (looksLikeDesignerHostContextStore(nested)) return nested;
      const deeper = deepFindStore(nested, depth + 1, visited);
      if (deeper) return deeper;
    }

    return null;
  }

  // ── Fiber traversal ────────────────────────────────────────────────────────

  function getFiberFromNode(node: Element): any {
    const key = Object.keys(node).find(
      k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    return key ? (node as any)[key] : null;
  }

  // The React mount point is not reliably `#root` or a direct child of `<body>` on this
  // host, so guessing at it can walk zero fibers and fail silently. Anchor on a concrete,
  // known-to-exist element deep in the designer's own component tree instead — same
  // approach interceptor.ts uses for Copilot Studio (mwtGetCanvasNode), just PA-v3-specific
  // anchors. Only fall back to a full-document scan if none of those carry a fiber key.
  function findFiberAnchorElement(): Element | null {
    const knownAnchors = [
      '.react-flow__controls',
      '.xyflow__controls',
      '.react-flow',
      '.xyflow',
    ];
    for (const selector of knownAnchors) {
      const el = document.querySelector(selector);
      if (el && getFiberFromNode(el)) return el;
    }

    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length; i++) {
      if (getFiberFromNode(all[i])) return all[i];
    }
    return null;
  }

  function getFiberRoot(): any {
    const anchor = findFiberAnchorElement();
    if (!anchor) return null;
    let current = getFiberFromNode(anchor);
    if (!current) return null;
    while (current.return) current = current.return;
    return current;
  }

  const MAX_VISITED_FIBERS = 40000;

  function findPowerAutomateV3DesignerHostContextStoreOnce(): DesignerHostContextStore | null {
    const anchor = findFiberAnchorElement();
    if (!anchor) {
      console.warn('[MWT_PA_V3_BRIDGE]', { event: 'no-fiber-anchor-found' });
      return null;
    }

    const root = getFiberRoot();
    if (!root) {
      console.warn('[MWT_PA_V3_BRIDGE]', { event: 'no-fiber-root', anchorTag: anchor.tagName, anchorClass: (anchor as HTMLElement).className });
      return null;
    }

    const stack: any[] = [root];
    const seenFibers = new Set<any>();
    let visited = 0;

    while (stack.length && visited < MAX_VISITED_FIBERS) {
      const fiber = stack.pop();
      if (!fiber || seenFibers.has(fiber)) continue;
      seenFibers.add(fiber);
      visited++;

      // Context.Provider fibers expose the provided value at memoizedProps.value —
      // confirmed path: fiber.memoizedProps.value.designerHostContextStore
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object' && 'value' in props) {
        const value = (props as Record<string, unknown>).value;
        const found = deepFindStore(value, 0, new Set());
        if (found) {
          console.log('[MWT_PA_V3_BRIDGE]', { event: 'store-found', fibersVisited: visited });
          return found;
        }
      }

      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }

    console.warn('[MWT_PA_V3_BRIDGE]', { event: 'store-not-found-after-walk', fibersVisited: visited });
    return null;
  }

  function findPowerAutomateV3DesignerHostContextStore(
    options: { silent?: boolean } = {}
  ): DesignerHostContextStore | null {
    const store = findPowerAutomateV3DesignerHostContextStoreOnce();
    if (!store && !options.silent) {
      console.error('[MWT_PA_V3_BRIDGE]', {
        event: 'store-not-found',
        message: 'Power Automate designer store was not found. Apply to canvas cannot continue.',
      });
    }
    return store;
  }

  // ── Graph-backed detection — get-payload metadata only ────────────────────
  // Reported to the content script as an informational flag on the get-payload response.
  // Never consulted on the Apply path: in PA v3, definition.actions is the sole source of
  // truth, and stale Copilot-Studio-derived graph metadata rides along untouched inside
  // definition.triggers without being read, synchronized, or validated during Apply.

  function isGraphBackedWorkflow(definition: any): boolean {
    const triggers = definition?.triggers || {};
    return Object.values(triggers).some(
      (trigger: any) => Boolean(trigger?.metadata?.associatedData?.graph)
    );
  }

  // ── Get-payload handler ────────────────────────────────────────────────────

  function handleGetPayloadRequest(requestId: string): void {
    const store = findPowerAutomateV3DesignerHostContextStore();

    if (!store) {
      window.postMessage({
        type: 'MWT_PA_V3_GET_PAYLOAD_RESPONSE',
        requestId,
        success: false,
        error: 'Power Automate designer store was not found. Apply to canvas cannot continue.',
      }, '*');
      return;
    }

    const definition = store.flowWorkflowData?.definition ?? store.flowData?.properties?.definition;
    const connectionReferences =
      store.flowWorkflowData?.connectionReferences ??
      store.flowData?.properties?.connectionReferences ??
      {};
    const parameters = store.flowData?.properties?.parameters;

    window.postMessage({
      type: 'MWT_PA_V3_GET_PAYLOAD_RESPONSE',
      requestId,
      success: true,
      payload: { definition, connectionReferences, ...(parameters !== undefined ? { parameters } : {}) },
      isGraphBacked: isGraphBackedWorkflow(definition),
    }, '*');
  }

  // ── ReactFlow controlled props + parent node/edge hooks (visual-kick fallback) ───────────
  // setFlowData/setIsFlowDirty is the confirmed data-layer mechanism and is sufficient on its
  // own in the common case — PA v3 regenerates its canonical ReactFlow layout from
  // definition.actions asynchronously. This section is a fallback for native (non-graph-
  // backed) flows only, for when that regeneration doesn't visibly land within a short
  // window: it seeds a provisional layout by dispatching directly into the parent React state
  // that controls ReactFlow's `nodes`/`edges` props, then lets PA v3 overwrite it with the
  // canonical layout. It never replaces or fights the canonical layout once it appears. It is
  // driven purely by definition.actions — graph presence (stale Copilot-Studio-derived
  // metadata) never changes this path.

  function findReactFlowWrapperElement(): Element | null {
    return (
      document.querySelector('[data-testid="rf__wrapper"]') ||
      document.querySelector('.react-flow') ||
      document.querySelector('.xyflow')
    );
  }

  function looksLikeNodeArray(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0 && value.every((n: any) => n && typeof n === 'object' && 'id' in n);
  }

  function looksLikeEdgeArray(value: unknown): boolean {
    return Array.isArray(value) && value.every((e: any) => e && typeof e === 'object' && 'source' in e && 'target' in e);
  }

  // The controlled ReactFlow component fiber may sit at the wrapper element or a few hops
  // away from it — search outward (parents, children, siblings) rather than assuming an exact
  // position, since that position isn't stable across PA v3 deploys.
  function findControlledReactFlowFiber(): any {
    const wrapper = findReactFlowWrapperElement();
    if (!wrapper) return null;
    const startFiber = getFiberFromNode(wrapper);
    if (!startFiber) return null;

    const seen = new Set<any>();
    const queue: any[] = [startFiber];

    while (queue.length && seen.size < 3000) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);

      const props = current.memoizedProps;
      if (props && Array.isArray(props.nodes) && Array.isArray(props.edges)) {
        return current;
      }

      if (current.return) queue.push(current.return);
      if (current.child) queue.push(current.child);
      if (current.sibling) queue.push(current.sibling);
    }
    return null;
  }

  function readReactFlowControlledProps(): { nodes: any[]; edges: any[] } | null {
    const fiber = findControlledReactFlowFiber();
    const props = fiber?.memoizedProps;
    if (!props || !Array.isArray(props.nodes) || !Array.isArray(props.edges)) return null;
    return { nodes: props.nodes, edges: props.edges };
  }

  interface PA3NodeEdgeHooks {
    nodeHook: any;
    edgeHook: any;
  }

  // Do not hardcode exact hook indexes/levels as permanent truth (they are not stable across
  // PA v3 deploys) — instead walk ancestor fibers' hook lists looking for the shape of state
  // (array of node-like / edge-like objects) paired with a dispatch function.
  function findPA3ReactFlowParentHooks(): PA3NodeEdgeHooks {
    const reactFlowFiber = findControlledReactFlowFiber();
    if (!reactFlowFiber) return { nodeHook: null, edgeHook: null };

    let nodeHook: any = null;
    let edgeHook: any = null;

    let current = reactFlowFiber.return;
    let depth = 0;
    while (current && depth < 30 && (!nodeHook || !edgeHook)) {
      let hook = current.memoizedState;
      while (hook) {
        const state = hook.memoizedState;
        const dispatch = hook.queue?.dispatch;
        if (typeof dispatch === 'function') {
          if (!nodeHook && looksLikeNodeArray(state)) {
            nodeHook = hook;
          } else if (!edgeHook && Array.isArray(state) && looksLikeEdgeArray(state)) {
            edgeHook = hook;
          }
        }
        hook = hook.next;
      }
      current = current.return;
      depth++;
    }

    return { nodeHook, edgeHook };
  }

  interface PA3VisualNode {
    id: string;
    position: { x: number; y: number };
    data: { label: string };
  }
  interface PA3VisualEdge {
    id: string;
    source: string;
    target: string;
  }

  function collectActionNamesRecursive(actions: Record<string, any> | undefined, out: string[]): void {
    if (!actions) return;
    for (const [name, action] of Object.entries(actions)) {
      out.push(name);
      if (action?.actions) collectActionNamesRecursive(action.actions, out);
      if (action?.else?.actions) collectActionNamesRecursive(action.else.actions, out);
    }
  }

  // Provisional layout only — deliberately simple (flat rows, direct runAfter/nesting edges).
  // PA v3's own layout regeneration is expected to replace this shortly after; the kick exists
  // only to nudge a stalled controlled-state rerender, not to be a good-looking diagram.
  function buildPA3VisualKickFromDefinition(definition: any): { nodes: PA3VisualNode[]; edges: PA3VisualEdge[] } {
    const nodes: PA3VisualNode[] = [];
    const edges: PA3VisualEdge[] = [];
    let row = 0;

    const triggerNames = Object.keys(definition?.triggers ?? {});
    for (const name of triggerNames) {
      nodes.push({ id: name, position: { x: 0, y: row * 120 }, data: { label: name } });
      row++;
    }

    function addAction(name: string, action: any, parentName: string | null, indentX: number): void {
      nodes.push({ id: name, position: { x: indentX, y: row * 120 }, data: { label: name } });
      row++;

      const runAfter = action?.runAfter ?? {};
      const deps = Object.keys(runAfter);
      if (deps.length > 0) {
        for (const dep of deps) edges.push({ id: `mwt-kick-${dep}-${name}`, source: dep, target: name });
      } else if (parentName) {
        edges.push({ id: `mwt-kick-${parentName}-${name}`, source: parentName, target: name });
      } else {
        for (const t of triggerNames) edges.push({ id: `mwt-kick-${t}-${name}`, source: t, target: name });
      }

      for (const nested of [action?.actions, action?.else?.actions]) {
        if (!nested) continue;
        for (const [nestedName, nestedAction] of Object.entries(nested) as [string, any][]) {
          addAction(nestedName, nestedAction, name, indentX + 40);
        }
      }
    }

    for (const [name, action] of Object.entries(definition?.actions ?? {}) as [string, any][]) {
      addAction(name, action, null, 0);
    }

    return { nodes, edges };
  }

  function canvasReflectsDefinition(definition: any): boolean {
    const current = readReactFlowControlledProps();
    if (!current) return false;

    const actionNames: string[] = [];
    collectActionNamesRecursive(definition?.actions, actionNames);
    if (actionNames.length === 0) return true;

    // PA v3's canonical layout may use suffixed/derived ids for nested action groups (e.g.
    // "<action>-#scope", "<action>-actions"), so an action counts as represented if any node
    // id starts with its name rather than requiring an exact match.
    const nodeIds = current.nodes.map((n: any) => n.id).filter((id: unknown) => typeof id === 'string') as string[];
    return actionNames.every(name => nodeIds.some(id => id.startsWith(name)));
  }

  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForPA3CanvasToReflectDefinition(
    definition: any,
    options: { timeoutMs: number; intervalMs?: number }
  ): Promise<boolean> {
    const intervalMs = options.intervalMs ?? 150;
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (canvasReflectsDefinition(definition)) return true;
      await delay(intervalMs);
    }
    return canvasReflectsDefinition(definition);
  }

  async function ensurePA3CanvasReflectsDefinition(definition: any): Promise<boolean> {
    const alreadyReflected = await waitForPA3CanvasToReflectDefinition(definition, { timeoutMs: 1200 });
    if (alreadyReflected) {
      console.log('[MWT_PA_V3_BRIDGE]', { event: 'canvas-reflected-without-kick' });
      return true;
    }

    const hooks = findPA3ReactFlowParentHooks();
    if (!hooks.nodeHook || !hooks.edgeHook) {
      console.warn('[MWT_PA_V3_BRIDGE]', {
        event: 'visual-kick-hooks-not-found',
        nodeHookFound: Boolean(hooks.nodeHook),
        edgeHookFound: Boolean(hooks.edgeHook),
      });
      return false;
    }

    const kick = buildPA3VisualKickFromDefinition(definition);
    console.log('[MWT_PA_V3_BRIDGE]', { event: 'visual-kick-dispatch', nodeCount: kick.nodes.length, edgeCount: kick.edges.length });
    hooks.nodeHook.queue.dispatch(kick.nodes);
    hooks.edgeHook.queue.dispatch(kick.edges);

    const reflectedAfterKick = await waitForPA3CanvasToReflectDefinition(definition, { timeoutMs: 1500 });
    console.log('[MWT_PA_V3_BRIDGE]', { event: 'visual-kick-result', reflected: reflectedAfterKick });
    return reflectedAfterKick;
  }

  // ── Apply-to-canvas handler (confirmed mechanism — spec section 9) ────────

  async function applyPowerAutomateV3CodeViewToCanvas(payload: { definition: unknown; connectionReferences?: unknown; parameters?: unknown }): Promise<{ readbackVerified: boolean; canvasVerified: boolean }> {
    const store = findPowerAutomateV3DesignerHostContextStore();

    if (!store) {
      throw new Error('Power Automate designer store was not found. Apply to canvas cannot continue.');
    }

    const currentFlowData = store.flowData;
    const currentWorkflowData = store.flowWorkflowData;

    const nextDefinition = structuredClone(payload.definition);

    const nextFlowData: any = structuredClone(currentFlowData ?? {});
    nextFlowData.properties = nextFlowData.properties || {};
    nextFlowData.properties.definition = structuredClone(nextDefinition);
    if (payload.connectionReferences !== undefined) {
      nextFlowData.properties.connectionReferences = structuredClone(payload.connectionReferences);
    }
    if (payload.parameters !== undefined) {
      nextFlowData.properties.parameters = structuredClone(payload.parameters);
    }

    const nextWorkflowData: any = structuredClone(currentWorkflowData ?? {});
    nextWorkflowData.definition = structuredClone(nextDefinition);
    if (payload.connectionReferences !== undefined) {
      nextWorkflowData.connectionReferences = structuredClone(payload.connectionReferences);
    }

    console.log('[MWT_PA_V3_BRIDGE]', { event: 'setFlowData-call' });

    // flowWorkflowData is MobX-observable state on this store. Assigning to it directly
    // (`store.flowWorkflowData = nextWorkflowData`) bypasses MobX's action/setter machinery
    // and trips "[mobx] An invariant failed" — MobX enforces that observable properties are
    // only written inside a recognized action. setFlowData is the confirmed native mutator
    // and is sufficient on its own (flowWorkflowData is derived from/kept in sync with
    // flowData by the host app). Only use a setFlowWorkflowData setter if the host actually
    // exposes one; never fall back to direct assignment.
    store.setFlowData(nextFlowData);
    if (typeof store.setFlowWorkflowData === 'function') {
      store.setFlowWorkflowData(nextWorkflowData);
    } else {
      console.log('[MWT_PA_V3_BRIDGE]', {
        event: 'no-setFlowWorkflowData-setter',
        message: 'Skipping direct flowWorkflowData mutation; setFlowData is the source of truth for canvas update.',
      });
    }
    store.setIsFlowDirty(true);

    store.resetAllMessageBarProps?.();
    store.setSelectedNode?.(undefined);

    // Read back the store's own live state instead of trusting that the setter calls above
    // "took" — this is the only signal available from this MAIN-world bridge that the model
    // was actually accepted. It cannot observe whether the canvas *visually* rerendered (that
    // would need DOM introspection this bridge doesn't do); it verifies the data layer only.
    const afterDefinition: any = store.flowWorkflowData?.definition;

    console.info('[MWT_PA_V3_BRIDGE]', {
      event: 'apply-readback',
      actionNames: Object.keys(afterDefinition?.actions ?? {}),
    });

    const expectedActionNames = new Set(Object.keys((nextDefinition as any)?.actions ?? {}));
    const actualActionNames = new Set(Object.keys(afterDefinition?.actions ?? {}));
    const readbackVerified =
      expectedActionNames.size === actualActionNames.size &&
      [...expectedActionNames].every(name => actualActionNames.has(name));

    console.log('[MWT_PA_V3_BRIDGE]', { event: 'apply-completed', readbackVerified });

    // Data-layer readback above only confirms the store accepted the model. This confirms the
    // ReactFlow-controlled canvas actually reflects it — falling back to a provisional
    // visual-kick dispatch (native flows only) if PA v3's own regeneration hasn't landed yet.
    const canvasVerified = await ensurePA3CanvasReflectsDefinition(afterDefinition);

    return { readbackVerified, canvasVerified };
  }

  async function handleApplyRequest(requestId: string, payload: any): Promise<void> {
    try {
      const { readbackVerified, canvasVerified } = await applyPowerAutomateV3CodeViewToCanvas(payload);
      window.postMessage({ type: 'MWT_PA_V3_APPLY_RESPONSE', requestId, success: true, readbackVerified, canvasVerified }, '*');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MWT_PA_V3_BRIDGE]', { event: 'apply-failed', requestId, error: err.message });
      window.postMessage({ type: 'MWT_PA_V3_APPLY_RESPONSE', requestId, success: false, error: err.message }, '*');
    }
  }

  // ── Message listener ───────────────────────────────────────────────────────

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('MWT_PA_V3_')) return;

    switch (data.type) {
      case 'MWT_PA_V3_STORE_PROBE': {
        const found = Boolean(findPowerAutomateV3DesignerHostContextStore({ silent: true }));
        window.postMessage({ type: 'MWT_PA_V3_STORE_PROBE_RESULT', requestId: data.requestId, found }, '*');
        break;
      }
      case 'MWT_PA_V3_GET_PAYLOAD_REQUEST':
        handleGetPayloadRequest(data.requestId);
        break;
      case 'MWT_PA_V3_APPLY_REQUEST':
        handleApplyRequest(data.requestId, data.payload);
        break;
      default:
        break;
    }
  });

  // Manual debugging aid — mirrors the `_dbg` convention already used in background.ts.
  // From DevTools console (top frame, default context): window.__mwtPaV3Debug.findStore()
  (window as any).__mwtPaV3Debug = {
    findStore: () => findPowerAutomateV3DesignerHostContextStore({ silent: true }),
    findFiberAnchorElement,
    getFiberRoot,
  };

  console.log('[MWT_PA_V3_BRIDGE]', { event: 'installed' });

})();
