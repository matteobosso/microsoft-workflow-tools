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

The extension does **not** implement its own login. It reuses your existing Copilot
Studio session by intercepting the `Authorization` bearer token from requests the
portal already makes (via `chrome.webRequest`), keeps it **in memory only** (never
persisted), and uses it for its own read/save/validate calls (PA API for load and
validation, Dataverse for save).

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

4. Open a workflow in Copilot Studio and **refresh** the page (so the tokens are
   captured from the portal's own requests).
5. Click the **Code view** button in the canvas toolbar to open the JSON editor.
6. Edit the definition and click **Save**.

**Power Automate v3:**

4. Open a flow in the Flow Designer (`make.powerautomate.com`).
5. Click the **`</>` Code view** button in the canvas controls (bottom-left).
6. Edit the JSON and click the **✓ Apply to canvas** button in the panel header,
   then use the native **Save draft** button to persist.

## Known limitations

- **Copilot Studio:** the authentication token is not refreshed automatically. If a
  call fails, refresh the workflow tab that was used to open the extension, then retry.
- **Copilot Studio:** editing the executable `actions`/`triggers` does not
  automatically update the duplicated config in the canvas graph
  (`metadata.associatedData.graph`); the designer reconciles the visual layout when
  reopened.
- **Power Automate v3:** Apply to canvas only updates the in-memory designer model
  and marks the draft dirty — saving/publishing is deliberately left to the native
  **Save draft** button.
- This is a power-user tool intended for use on your own tenant/account, in line with
  Microsoft's terms of service.

## Change Log

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
