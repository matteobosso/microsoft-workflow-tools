export interface RefreshInitiator {
  type: 'refresh';
}

export interface AppLoaded {
  type: 'app-loaded';
}

export interface TokenChanged {
  type: 'token-changed';
  token: string;
  apiUrl: string;
  legacyApiUrl?: string;
  legacyToken?: string;
  dynamicsBaseUrl?: string;
}

export interface TogglePanel {
  type: 'toggle-panel';
  envId: string;
  flowId: string;
}

export interface ThemeChanged {
  type: 'theme-changed';
  theme: 'light' | 'dark';
}

export interface RefreshHost {
  type: 'refresh-host';
}

export interface ApiRequest {
  type: 'api-request';
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  body?: any;
  extraHeaders?: Record<string, string>;
  noCache?: boolean;
}

export type Actions = RefreshInitiator | TokenChanged | AppLoaded | TogglePanel | ThemeChanged | RefreshHost | ApiRequest;
