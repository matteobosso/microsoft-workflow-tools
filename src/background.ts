import { Actions } from "./shared/messages/backgroundActions";

const sidePanel = (chrome as any).sidePanel as {
  setOptions(opts: { tabId?: number; path?: string; enabled?: boolean }, cb?: () => void): void;
  open(opts: { tabId?: number }): Promise<void>;
};

interface TabState {
  apiUrl?: string;
  apiToken?: string;
  legacyApiUrl?: string;
  legacyApiToken?: string;
  lastMatchedRequest?: { envId: string | null; flowId: string } | null;
  dynamicsToken?: string;
  dynamicsBaseUrl?: string;
}

interface State {
  initiatorTabId?: number;
  tabs: Record<number, TabState>;
}

const state: State = { tabs: {} };
(globalThis as any)._dbg = state;

function getTabState(tabId: number): TabState {
  if (!state.tabs[tabId]) {
    state.tabs[tabId] = {};
  }
  return state.tabs[tabId];
}

function getActiveTabState(): TabState | undefined {
  if (state.initiatorTabId !== undefined) {
    return state.tabs[state.initiatorTabId];
  }
  return undefined;
}

chrome.action.disable();

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;

  const tabState = state.tabs[tab.id];
  if (!tabState?.lastMatchedRequest || !tabState.lastMatchedRequest.envId) return;

  state.initiatorTabId = tab.id;

  openSidePanel(
    tab.id,
    tabState.lastMatchedRequest.envId,
    tabState.lastMatchedRequest.flowId
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.tabs[tabId];
  if (state.initiatorTabId === tabId) {
    delete state.initiatorTabId;
  }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  listenFlowApiRequests,
  {
    urls: [
      "https://*.api.flow.microsoft.com/*",
      "https://*.api.powerplatform.com/*",
      "https://*.dynamics.com/*",
    ],
  },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener(
  (action: Actions, sender, sendResponse) => {
    const senderTabId = sender.tab?.id;

    switch (action.type) {
      case "toggle-panel":
        sendResponse();
        if (senderTabId) {
          state.initiatorTabId = senderTabId;
          // Overlay managed by content.ts; extension icon click still opens side panel
        }
        break;

      case "app-loaded":
        sendResponse();
        sendTokenChanged();
        break;

      case "refresh-host":
        sendResponse();
        if (state.initiatorTabId) {
          chrome.tabs.reload(state.initiatorTabId);
        }
        break;

      case "api-request":
        handleApiRequest(action).then(sendResponse);
        return true;

      default:
        sendResponse();
        break;
    }
  }
);


async function handleApiRequest(action: { method: string; url: string; body?: any; extraHeaders?: Record<string, string>; noCache?: boolean }) {
  const tabState = getActiveTabState();

  let fetchUrl: string;
  let authToken: string | undefined;

  if (action.url.startsWith('https://')) {
    fetchUrl = action.url;
    const hostname = new URL(action.url).hostname;
    authToken = hostname.includes('.dynamics.com')
      ? tabState?.dynamicsToken
      : tabState?.apiToken;
  } else {
    if (!tabState?.apiUrl || !tabState?.apiToken) {
      return { ok: false, error: 'API not ready — no token captured yet.' };
    }
    const endpoint = tabState.apiUrl + action.url;
    fetchUrl = endpoint.includes('?') ? `${endpoint}&api-version=1` : `${endpoint}?api-version=1`;
    authToken = tabState.apiToken;
  }

  if (!authToken) {
    return { ok: false, error: 'No auth token available for this endpoint. Interact with the canvas first.' };
  }

  const isSavePatch = action.method === 'PATCH' && /\/workflows\(/i.test(fetchUrl);
  if (isSavePatch) {
    console.log('[MWT_SAVE_EXTENSION] save-patch-start', { url: fetchUrl, method: action.method });
  }

  try {
    const r = await fetch(fetchUrl, {
      method: action.method,
      cache: action.noCache ? 'no-store' : 'default',
      headers: {
        authorization: authToken,
        'Content-Type': 'application/json',
        ...(action.noCache ? { 'Cache-Control': 'no-cache, no-store, max-age=0', 'Pragma': 'no-cache' } : {}),
        ...action.extraHeaders,
      },
      body: action.body != null ? JSON.stringify(action.body) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (r.ok) {
      if (isSavePatch) {
        console.log('[MWT_SAVE_EXTENSION] save-patch-response-ok', { status: r.status });
      }
      return { ok: true, data };
    }
    const errMsg = data?.error?.message ?? data?.Message ?? `[${r.status}] ${r.statusText}`;
    if (isSavePatch) {
      console.warn('[MWT_SAVE_EXTENSION] save-patch-response-error', { status: r.status, errMsg });
    }
    return { ok: false, error: errMsg };
  } catch (e: any) {
    if (isSavePatch) {
      console.error('[MWT_SAVE_EXTENSION] save-patch-fetch-exception', { error: e.message || String(e) });
    }
    return { ok: false, error: e.message || String(e) };
  }
}

function openSidePanel(tabId: number, envId: string, flowId: string) {
  const path = `app.html?envId=${envId}&flowId=${flowId}&embedded=true`;

  sidePanel.setOptions({ tabId, path, enabled: true }, () => {
    sidePanel.open({ tabId });
  });
}

function sendTokenChanged() {
  const tabState = getActiveTabState();
  if (!tabState) return;

  if (!tabState.apiUrl || !tabState.apiToken) return;

  chrome.runtime.sendMessage({
    type: "token-changed",
    token: tabState.apiToken,
    apiUrl: tabState.apiUrl,
    legacyApiUrl: tabState.legacyApiUrl,
    legacyToken: tabState.legacyApiToken,
    dynamicsBaseUrl: tabState.dynamicsBaseUrl,
  } as Actions);
}

function listenFlowApiRequests(
  details: chrome.webRequest.WebRequestHeadersDetails
) {
  if (details.tabId < 0) return;

  const tabState = getTabState(details.tabId);

  const matchedRequest = extractFlowDataFromUrl(details);
  if (matchedRequest) {
    tabState.lastMatchedRequest = matchedRequest;
  }

  const token = details.requestHeaders?.find(
    (x) => x.name.toLowerCase() === "authorization"
  )?.value;

  const url = new URL(details.url);
  const baseUrl = `${url.protocol}//${url.hostname}/`;

  if (url.hostname.includes("api.powerplatform.com")) {
    tabState.apiUrl = baseUrl;
    if (token) {
      tabState.apiToken = token;
    }
  } else if (url.hostname.includes("api.flow.microsoft.com")) {
    tabState.legacyApiUrl = baseUrl;
    if (token) {
      tabState.legacyApiToken = token;
    }
    if (!tabState.apiUrl) {
      tabState.apiUrl = baseUrl;
      if (token) {
        tabState.apiToken = token;
      }
    }
  } else if (url.hostname.includes(".dynamics.com") && token) {
    tabState.dynamicsToken = token;
    tabState.dynamicsBaseUrl = `${url.protocol}//${url.hostname}`;
  }

  if (details.tabId === state.initiatorTabId) {
    sendTokenChanged();
  }

  if (tabState.lastMatchedRequest && tabState.lastMatchedRequest.envId) {
    chrome.action.enable(details.tabId);
  } else if (tabState.lastMatchedRequest && !tabState.lastMatchedRequest.envId) {
    tryResolveEnvIdFromTab(details.tabId);
  } else {
    tryExtractFlowDataFromTabUrl(details.tabId);
  }
}

function tryExtractFlowDataFromTabUrl(tabId: number) {
  chrome.tabs.get(tabId, (tab) => {
    const tabData = extractFlowDataFromTabUrl(tab.url);
    if (tabData) {
      const tabState = getTabState(tabId);
      tabState.lastMatchedRequest = tabData;
      chrome.action.enable(tabId);
    }
  });
}

function tryResolveEnvIdFromTab(tabId: number) {
  chrome.tabs.get(tabId, (tab) => {
    const envId = extractEnvIdFromTabUrl(tab.url);
    const tabState = state.tabs[tabId];
    if (envId && tabState?.lastMatchedRequest) {
      tabState.lastMatchedRequest.envId = envId;
      chrome.action.enable(tabId);
    }
  });
}

function extractEnvIdFromTabUrl(url?: string): string | null {
  if (!url) return null;
  const envPattern = /environments\/([a-zA-Z0-9\-]+)/i;
  const envResult = envPattern.exec(url);
  return envResult ? envResult[1] : null;
}

function extractFlowDataFromTabUrl(url?: string) {
  if (!url) return null;

  const envId = extractEnvIdFromTabUrl(url);
  if (!envId) return null;

  const flowPattern =
    /flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const flowResult = flowPattern.exec(url);
  if (!flowResult) return null;

  return { envId, flowId: flowResult[1] };
}

function extractFlowDataFromUrl(
  details: chrome.webRequest.WebRequestHeadersDetails
) {
  const requestUrl = details.url;
  if (!requestUrl) return null;

  const oldPattern =
    /\/providers\/Microsoft\.ProcessSimple\/environments\/([^/]+)\/flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const oldResult = oldPattern.exec(requestUrl);
  if (oldResult) {
    return { envId: oldResult[1], flowId: oldResult[2] };
  }

  const newPattern =
    /\.api\.powerplatform\.com\/powerautomate\/flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const newResult = newPattern.exec(requestUrl);
  if (newResult) {
    return { envId: null, flowId: newResult[1] };
  }

  return null;
}
