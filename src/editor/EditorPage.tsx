import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { useEffect, useMemo, useRef } from 'react';
import { useEditor } from './useEditor';
import { NodePanelShell } from './NodePanelShell';
import { mwtLog } from '../shared/debug';

export const EditorPage: React.FC = () => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Suppresses dirty flag during programmatic setValue calls.
  const isSettingValueRef = useRef(false);
  const isDirtyRef = useRef(false);

  const {
    definition,
    applyToCanvas,
    validate,
    messages,
    triggerRefetch,
  } = useEditor();

  const triggerRefetchRef = useRef(triggerRefetch);
  useEffect(() => { triggerRefetchRef.current = triggerRefetch; }, [triggerRefetch]);

  function reportDirty(dirty: boolean): void {
    if (isDirtyRef.current === dirty) return;
    isDirtyRef.current = dirty;
    window.parent.postMessage({ type: 'mwt-panel-action', action: 'dirty-changed', isDirty: dirty }, '*');
  }

  const handleApply = useMemo(
    () => async () => {
      const editor = editorRef.current;
      if (!editor) return;
      const success = await applyToCanvas(editor.getValue());
      if (success) {
        reportDirty(false);
        mwtLog('[MWT_APPLY_EXTENSION] apply-completed-dispatched', { success: true });
        window.parent.postMessage({ type: 'mwt-panel-action', action: 'apply-completed', success: true }, '*');
      } else {
        mwtLog('[MWT_APPLY_EXTENSION] apply-completed-dispatched', { success: false });
        window.parent.postMessage({ type: 'mwt-panel-action', action: 'apply-completed', success: false }, '*');
      }
    },
    [applyToCanvas]
  );

  const handleValidate = useMemo(
    () => () => {
      const editor = editorRef.current;
      if (editor) validate(editor.getValue());
    },
    [validate]
  );

  const handleApplyRef = useRef(handleApply);
  const handleValidateRef = useRef(handleValidate);
  useEffect(() => { handleApplyRef.current = handleApply; }, [handleApply]);
  useEffect(() => { handleValidateRef.current = handleValidate; }, [handleValidate]);

  useEffect(() => {
    const listener = async (e: MessageEvent) => {
      if (e.data?.type !== 'panel-action') return;

      if (e.data.action === 'apply') {
        handleApplyRef.current();
      } else if (e.data.action === 'validate') {
        handleValidateRef.current();
      } else if (e.data.action === 'refetch' || e.data.action === 'background-refetch') {
        mwtLog('[CodeViewLifecycle] refetch-started-in-iframe', { action: e.data.action });
        const result = await triggerRefetchRef.current();
        if (result) {
          const editor = editorRef.current;
          if (editor) {
            isSettingValueRef.current = true;
            editor.setValue(result.definition);
            isSettingValueRef.current = false;
            reportDirty(false);
          }
          window.parent.postMessage({
            type: 'MWT_CODEVIEW_REFETCH_COMPLETED',
            resolved: {
              source: result.source,
              definitionHash: result.definitionHash,
            },
          }, '*');
          mwtLog('[CodeViewLifecycle] refetch-completed-in-iframe', {
            source: result.source,
            definitionHash: result.definitionHash,
          });
        }
      } else if (e.data.action === 'discard') {
        reportDirty(false);
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  return (
    <NodePanelShell
      onApply={handleApply}
      onClose={() => {
        window.parent.postMessage(
          { type: 'mwt-panel-action', action: 'close' },
          '*'
        );
      }}
      messages={messages}
    >
      {!!definition && (
        <Editor
          height="100%"
          defaultValue={definition}
          language="json"
          onMount={(editorInstance) => {
            editorRef.current = editorInstance;
            editorInstance.onDidChangeModelContent(() => {
              if (!isSettingValueRef.current) {
                reportDirty(true);
              }
            });
          }}
          options={{
            minimap: { enabled: false },
            wordWrap: 'on',
            fontSize: 12,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            folding: true,
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            tabSize: 2,
            padding: { top: 8 },
          }}
        />
      )}
    </NodePanelShell>
  );
};
