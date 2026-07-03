![Extension Logo](public/icons/pa-tools-128.png)

# Microsoft Workflow Tools

A Chrome/Edge extension (Manifest V3) that lets you view and edit workflow
definitions as JSON, directly in the browser, using an embedded Monaco editor.
It supports two hosts, each with its own fully isolated implementation:

- **Copilot Studio workflows** — the agentic canvas released in 2026
  (`copilotstudio.microsoft.com`).
- **Power Automate v3 Flow Designer** — the ReactFlow-based designer on
  `make.powerautomate.com` / `make.powerapps.com`.

## How it works

### Copilot Studio

**Load** and **Apply to canvas** need no access token and make no API calls at all —
same approach as Power Automate v3 below. The definition is read directly from, and
written directly back into, the live in-page designer state: Code View resolves the
canvas's own React Query cache through React Fiber for load, and applies edits back
into that live state (plus the existing native `setGraph` bridge for the visual
canvas) for Apply. **Save draft**/**Publish** is then done with the designer's own
native controls, exactly like Power Automate v3.

The one thing still gated on a captured token is **Validate**, an explicit,
manually-triggered action that calls the Copilot Studio `checkFlowAlerts` API. For
that (and only that), the extension reuses your existing Copilot Studio session by
intercepting the `Authorization` bearer token from requests the portal already makes
(via `chrome.webRequest`), keeping it **in memory only** (never persisted).

> Note on the format: a Copilot Studio workflow definition is classic Workflow
> Definition Language (WDL, the Logic Apps schema). The visual canvas graph (node
> positions and config) is persisted *inside* the definition under
> `metadata.associatedData.graph`, so the same operation config appears in two
> places — the executable `actions`/`triggers` (what runs) and the graph (visual
> mirror). Only the `actions`/`triggers` branch affects execution.

### Power Automate v3

No backend calls at all. A **Code view** button is injected into the designer's
canvas controls; it opens a native-styled side panel with a Monaco JSON editor.
The definition is read directly from — and applied directly back into — the live
in-memory designer store (found via React Fiber), so **Apply to canvas** updates
the open designer without any API call. Persisting the change is then done with
the designer's own native **Save draft** button.

> `definition.actions` (plus nesting and `runAfter`) is the sole source of truth
> for Apply. Graph metadata that Copilot-Studio-derived flows may carry inside
> `definition.triggers` rides along untouched and is never read or validated.

## Getting started (load unpacked)

1. Run `npm install` then `npm run build` (output goes to `dist/`).
2. Open `edge://extensions` (or `chrome://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.

**Copilot Studio:**

4. Open a workflow in Copilot Studio (a token is only needed if you plan to use
   **Validate** — refresh the tab first so it gets captured from the portal's own
   requests).
5. Click the **Code view** button in the canvas toolbar to open the JSON editor.
6. Edit the definition and click **Apply to canvas**, then use the native
   **Save**/**Publish** to persist.

**Power Automate v3:**

4. Open a flow in the Flow Designer (`make.powerautomate.com`).
5. Click the **`</>` Code view** button in the canvas controls (bottom-left).
6. Edit the JSON and click the **✓ Apply to canvas** button in the panel header,
   then use the native **Save draft** button to persist.

## Known limitations

- **Copilot Studio:** the captured token (used only by the explicit **Validate**
  action) is not refreshed automatically. If validation fails, refresh the workflow
  tab that was used to open the extension, then retry.
- **Copilot Studio:** editing the executable `actions`/`triggers` does not
  automatically update the duplicated config in the canvas graph
  (`metadata.associatedData.graph`); the designer reconciles the visual layout when
  reopened.
- **Copilot Studio & Power Automate v3:** Apply to canvas only updates the live
  in-memory designer state and marks the draft dirty — saving/publishing is
  deliberately left to the native **Save**/**Save draft**/**Publish** controls.
- This is a power-user tool intended for use on your own tenant/account, in line with
  Microsoft's terms of service.

## Change Log

### v2.1 — Copilot Studio live store bridge

- **Load** and **Apply to canvas** for Copilot Studio no longer need a captured
  access token or any API call — brought in line with the Power Automate v3
  approach. Code View now resolves the live clientdata directly from the designer's
  own React Query cache (found via React Fiber) and writes edits straight back into
  it, alongside the existing native `setGraph` canvas bridge.
- Only the explicit, manually-triggered **Validate** action still calls the
  Copilot Studio API and needs a captured bearer token; the old token-based
  load/save path is kept solely as a manual diagnostic fallback, never used silently.
- After Apply, the panel now points users to the native **Save**/**Publish**
  controls to persist, matching the Power Automate v3 UX.
- Added a global, off-by-default debug logging gate (`MWT_DEBUG`) shared across all
  entry points — toggle at runtime with `localStorage.setItem('MWT_DEBUG', '1')` or
  `window.__MWT_DEBUG__ = true` in the host page.

### v2.0 — Power Automate v3 compatibility

- New, fully isolated implementation for the Power Automate v3 Flow Designer
  (`make.powerautomate.com` / `make.powerapps.com`): separate content scripts,
  message namespace, and DOM ids — nothing shared with the Copilot Studio path.
- **Code view** button injected into the ReactFlow canvas controls.
- Native-styled Fluent/Fabric side panel (`Edit code`) with an inline Monaco JSON
  editor bundled directly into the content script.
- **Apply to canvas** writes the edited definition straight into the live designer
  store via React Fiber (`setFlowData` + `setIsFlowDirty`) — no API calls, with
  store readback verification so edits are never silently lost.
- Unapplied-changes guard: clicking outside the panel with dirty edits shows a
  native-styled dialog offering Apply to canvas / Keep editing / Discard changes.
- JSON syntax highlighting and validation in the panel editor.

### v1.0 — Copilot Studio workflows compatibility

- Initial release as **Microsoft Workflow Tools**, targeting the new Copilot Studio
  workflows (agentic canvas).
- Code view button injected directly into the Copilot Studio canvas toolbar.
- All API calls proxied through the background service worker.
- Dataverse `clientdata` read/save, `*.dynamics.com` token capture.
- `checkFlowAlerts` validation endpoint.
- Canvas desync fix, native GET interception.
