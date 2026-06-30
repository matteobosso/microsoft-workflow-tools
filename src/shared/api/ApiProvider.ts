import { createContext, useContext, useEffect, useState } from 'react';
import { Actions, ApiRequest } from '../messages/backgroundActions';

export interface IApiProvider {
  get(url: string, noCache?: boolean, extraHeaders?: Record<string, string>): Promise<any>;
  post(url: string, data: any, extraHeaders?: Record<string, string>): Promise<any>;
  patch(url: string, data: any, extraHeaders?: Record<string, string>): Promise<any>;
  isApiReady: boolean;
  tokenVersion: number;
  dynamicsBaseUrl: string;
}

export const ApiProviderContext = createContext<IApiProvider>({} as any);

export const ApiProviderContextRoot = (): IApiProvider => {
  const [isReady, setIsReady] = useState(false);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [dynamicsBaseUrl, setDynamicsBaseUrl] = useState('');

  const makeRequest = (method: ApiRequest['method'], url: string, body?: any, extraHeaders?: Record<string, string>, noCache?: boolean): Promise<any> =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'api-request', method, url, body, extraHeaders, noCache } as Actions,
        (result: { ok: boolean; data?: any; error?: string }) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (result?.ok) {
            resolve(result.data);
          } else {
            reject(new Error(result?.error ?? 'Unknown error'));
          }
        }
      );
    });

  useEffect(() => {
    const handler = (action: Actions, _sender: any, sendResponse: () => void) => {
      sendResponse();
      if (action.type === 'token-changed') {
        setIsReady(true);
        setTokenVersion(v => v + 1);
        if (action.dynamicsBaseUrl) setDynamicsBaseUrl(action.dynamicsBaseUrl);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    chrome.runtime.sendMessage({ type: 'app-loaded' } as Actions);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  return {
    get: (url, noCache, extraHeaders) => makeRequest('GET', url, undefined, extraHeaders, noCache),
    post: (url, data, extraHeaders) => makeRequest('POST', url, data, extraHeaders),
    patch: (url, data, extraHeaders) => makeRequest('PATCH', url, data, extraHeaders),
    isApiReady: isReady,
    tokenVersion,
    dynamicsBaseUrl,
  };
};

export const useApiProviderContext = () => useContext(ApiProviderContext);
