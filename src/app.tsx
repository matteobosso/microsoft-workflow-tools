import { initializeIcons } from '@fluentui/react/lib/Icons';
import { Stack } from '@fluentui/react/lib/Stack';
import { ThemeProvider } from '@fluentui/react/lib/Theme';
import { mergeStyles } from '@fluentui/react/lib/Styling';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';
import {
  ApiProviderContext,
  ApiProviderContextRoot
} from './shared/api/ApiProvider';
import { EditorPage } from './editor/EditorPage';
import { theme, darkTheme } from './theme';
import { useState, useEffect } from 'react';
import { Actions } from './shared/messages/backgroundActions';

const isEmbedded = new URLSearchParams(window.location.search).has('embedded');

initMonaco();

initializeIcons();

mergeStyles({
  ':global(body,html,#app)': {
    margin: 0,
    padding: 0,
    height: '100vh',
    fontFamily: 'var(--fontFamilyBase)',
    background: 'transparent',
  },
  ':global(#app > div)': {
    height: '100%',
  },
});

createRoot(document.getElementById('app')!).render(<App />);

function App() {
  const apiProviderRoot = ApiProviderContextRoot();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    if (!isEmbedded) return;

    const handler = (action: Actions, _sender: any, sendResponse: () => void) => {
      sendResponse();
      if (action.type === 'theme-changed') {
        const dark = action.theme === 'dark';
        setIsDark(dark);
        monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  return (
    <ThemeProvider theme={isDark ? darkTheme : theme} applyTo="body">
      <HashRouter>
        <ApiProviderContext.Provider value={apiProviderRoot}>
          <Stack
            styles={{
              root: {
                height: '100vh',
              },
            }}
          >
            <Stack.Item grow styles={{ root: { minHeight: 0, display: 'flex', flexDirection: 'column' } }}>
              {/* Embedded Code View loads from the live in-page store — no token
                  needed, so don't gate it on isApiReady. The API/token gate only
                  applies to the standalone (side panel) mode. */}
              {(isEmbedded || apiProviderRoot.isApiReady) ? (
                <Routes>
                  <Route path="/">
                    <Route index element={<EditorPage />} />
                  </Route>
                </Routes>
              ) : (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  padding: 24,
                  textAlign: 'center',
                  color: '#605e5c',
                }}>
                  <span style={{ fontSize: 32, marginBottom: 12 }}>⚡</span>
                  <strong style={{ fontSize: 14, marginBottom: 8, color: '#242424' }}>
                    No active workflow
                  </strong>
                  <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                    Open a flow in Copilot Studio, then click the extension icon.
                  </span>
                </div>
              )}
            </Stack.Item>
          </Stack>
        </ApiProviderContext.Provider>
      </HashRouter>
    </ThemeProvider>
  );
}

function initMonaco() {
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    enableSchemaRequest: true,
    schemas: [
      {
        uri: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json',
        schema: require('./schemas/workflowdefinition'),
      },
      {
        uri: 'https://power-automate-tools.local/flow-editor.json',
        schema: require('./schemas/flow-editor'),
        fileMatch: ['*']
      },
    ],
  });

  loader.config({
    monaco: monaco,
  });
}
