![Extension Logo](public/icons/pa-tools-128.png)

# Copilot Studio Workflow Tools

A Chrome/Edge extension (Manifest V3) that lets you view and edit the underlying
JSON definition of the **new Copilot Studio workflows** — the agentic canvas
released in 2026 — directly in the browser, using an embedded Monaco editor.

## How it works

The extension does **not** implement its own login. It reuses your existing Copilot
Studio session by intercepting the `Authorization` bearer token from requests the
portal already makes (via `chrome.webRequest`), keeps it **in memory only** (never
persisted), and uses it for its own read/save/validate calls.

> Note on the format: a Copilot Studio workflow definition is classic Workflow
> Definition Language (WDL, the Logic Apps schema). The visual canvas graph (node
> positions and config) is persisted *inside* the definition under
> `metadata.associatedData.graph`, so the same operation config appears in two
> places — the executable `actions`/`triggers` (what runs) and the graph (visual
> mirror). Only the `actions`/`triggers` branch affects execution.

## Getting started (load unpacked)

1. Run `npm install` then `npm run build` (output goes to `dist/`).
2. Open `edge://extensions` (or `chrome://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. Open a workflow in Copilot Studio and **refresh** the page (so the tokens are
   captured from the portal's own requests).
5. Click the extension icon to open the JSON editor in a new tab.
6. Edit the definition and click **Save**.

## Known limitations

- The authentication token is not refreshed automatically. If a call fails, refresh
  the Copilot Studio workflow tab that was used to open the extension, then retry.
- Editing the executable `actions`/`triggers` does not automatically update the
  duplicated config in the canvas graph (`metadata.associatedData.graph`); the
  designer reconciles the visual layout when reopened.
- This is a power-user tool intended for use on your own tenant/account, in line with
  Microsoft's terms of service.

## Change Log

### v2.0
- Code view button injected directly into the Copilot Studio canvas toolbar.
- All API calls proxied through the background service worker.
- Dataverse `clientdata` read/save, `*.dynamics.com` token capture.
- `checkFlowAlerts` validation endpoint.
- Canvas desync fix, native GET interception.

### v1.0
- Initial release as **Copilot Studio Workflow Tools**.
