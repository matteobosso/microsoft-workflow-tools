import { mergeStyles } from '@fluentui/merge-styles';
import { IMessageBarProps, MessageBarType } from '@fluentui/react/lib/MessageBar';
import { useCallback, useEffect, useRef, useState } from 'react';

interface NodePanelShellProps {
  onClose: () => void;
  onApply?: () => void;
  messages?: IMessageBarProps[];
  children: React.ReactNode;
}

const AUTO_DISMISS_MS = 5000;
const FADE_MS = 240;

type TooltipState = {
  text: string;
  x: number;
  y: number;
  placement: 'top' | 'bottom';
} | null;

// ── Icons ──────────────────────────────────────────────────────────────────

const ApplyIcon = () => (
  <svg fill="currentColor" aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 2a8 8 0 1 1 0 16A8 8 0 0 1 10 2Zm3.36 5.65a.5.5 0 0 0-.64-.06l-.07.06L9 11.3 7.35 9.65l-.07-.06a.5.5 0 0 0-.7.7l.07.07 2 2 .07.06c.17.11.4.11.56 0l.07-.06 4-4 .07-.08a.5.5 0 0 0-.06-.63Z" fill="currentColor" />
  </svg>
);

const CloseIcon = () => (
  <svg fill="currentColor" aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.09 4.22a.63.63 0 0 1 .88 0L10 9.25l5.03-5.03a.63.63 0 0 1 .88.88L10.88 10l5.03 5.03a.63.63 0 1 1-.88.88L10 10.88l-5.03 5.03a.63.63 0 0 1-.88-.88L9.12 10 4.09 4.97a.63.63 0 0 1 0-.75Z" fill="currentColor" />
  </svg>
);

const WarningIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M8.68 2.79a1.5 1.5 0 0 1 2.64 0l6.5 12A1.5 1.5 0 0 1 16.5 17h-13a1.5 1.5 0 0 1-1.32-2.21l6.5-12ZM10.5 7.5a.5.5 0 0 0-1 0v4a.5.5 0 0 0 1 0v-4Zm.25 6.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
  </svg>
);

const SuccessIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm3.36 5.65a.5.5 0 0 0-.64-.06l-.07.06L9 11.3 7.35 9.65l-.07-.06a.5.5 0 0 0-.7.7l.07.07 2 2 .07.06c.17.11.4.11.56 0l.07-.06 4-4 .07-.08a.5.5 0 0 0-.06-.63Z" />
  </svg>
);

const ErrorIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm2.85 10.15a.5.5 0 0 1-.7.7L10 10.71l-2.15 2.14a.5.5 0 0 1-.7-.7L9.29 10 7.15 7.85a.5.5 0 1 1 .7-.7L10 9.29l2.15-2.14a.5.5 0 0 1 .7.7L10.71 10l2.14 2.15Z" />
  </svg>
);

// ── Message palette ────────────────────────────────────────────────────────

const messagePalette = {
  warning: {
    background: '#FFF8F0',
    border: '#F5C18B',
    foreground: '#7A3E00',
    hover: 'rgba(122, 62, 0, 0.08)',
  },
  error: {
    background: '#FDF3F4',
    border: '#EEACB2',
    foreground: '#A4262C',
    hover: 'rgba(164, 38, 44, 0.08)',
  },
  success: {
    background: '#F1FAF1',
    border: '#9FD89F',
    foreground: '#0E700E',
    hover: 'rgba(14, 112, 14, 0.08)',
  },
};

type MessageIntent = keyof typeof messagePalette;

function getIntent(msg: IMessageBarProps): MessageIntent {
  switch ((msg as any).messageBarType as MessageBarType | undefined) {
    case MessageBarType.success: return 'success';
    case MessageBarType.error:
    case MessageBarType.blocked:
    case MessageBarType.severeWarning: return 'error';
    default: return 'warning';
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────

const rootStyles = mergeStyles({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  fontFamily: 'var(--fontFamilyBase)',
  color: 'var(--colorNeutralForeground1, #242424)',
  backgroundColor: 'var(--colorNeutralBackground1, rgba(255,255,255,0.92))',
  borderRadius: 14,
  overflow: 'hidden',
  contain: 'layout style' as any,
  isolation: 'isolate' as any,
});

const headerStyles = mergeStyles({
  height: 56,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 16px',
  borderBottom: '1px solid var(--colorNeutralStroke2, #DEDEDE)',
  backgroundColor: 'transparent',
  boxSizing: 'border-box',
});

const titleStyles = mergeStyles({
  fontFamily: 'var(--fontFamilyBase)',
  fontSize: 'var(--fontSizeBase300, 14px)',
  lineHeight: 'var(--lineHeightBase300, 20px)',
  fontWeight: 'var(--fontWeightSemibold, 600)' as any,
  color: 'var(--colorNeutralForeground1, #242424)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const headerActionsStyles = mergeStyles({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
});

const iconButtonStyles = mergeStyles({
  width: 32,
  height: 32,
  minWidth: 32,
  border: '1px solid transparent',
  borderRadius: 'var(--elevateRadiusCompact, 8px)',
  backgroundColor: 'var(--colorSubtleBackground, transparent)',
  color: 'var(--colorNeutralForeground2, #484848)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  cursor: 'pointer',
  transition:
    'background-color var(--durationFaster, 100ms) var(--curveEasyEase, ease), color var(--durationFaster, 100ms) var(--curveEasyEase, ease)',
  selectors: {
    ':hover': {
      backgroundColor: 'var(--colorSubtleBackgroundHover, #F5F5F5)',
      color: 'var(--colorNeutralForeground1, #242424)',
    },
    ':active': {
      backgroundColor: 'var(--colorSubtleBackgroundPressed, #E0E0E0)',
    },
    ':focus-visible': {
      outline: '2px solid var(--colorStrokeFocus2, #000)',
      outlineOffset: '-2px',
    },
  },
});

const messageOverlayStyles = mergeStyles({
  position: 'absolute',
  top: 64,
  left: 16,
  right: 16,
  zIndex: 120,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
});

const floatingMessageBase = {
  pointerEvents: 'auto' as any,
  position: 'relative' as any,
  boxSizing: 'border-box' as any,
  minHeight: 48,
  padding: '10px 42px 10px 14px',
  borderRadius: 12,
  fontFamily: 'var(--fontFamilyBase)',
  fontSize: 13,
  lineHeight: '18px',
  fontWeight: 400 as any,
  boxShadow: '0 4px 12px rgba(0,0,0,.08)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  opacity: 1,
  transform: 'translateY(0)',
  transition: 'opacity 240ms ease, transform 240ms ease',
};

const floatingMessageStylesByIntent = {
  warning: mergeStyles(floatingMessageBase, {
    background: messagePalette.warning.background,
    border: `1px solid ${messagePalette.warning.border}`,
    color: messagePalette.warning.foreground,
  }),
  error: mergeStyles(floatingMessageBase, {
    background: messagePalette.error.background,
    border: `1px solid ${messagePalette.error.border}`,
    color: messagePalette.error.foreground,
  }),
  success: mergeStyles(floatingMessageBase, {
    background: messagePalette.success.background,
    border: `1px solid ${messagePalette.success.border}`,
    color: messagePalette.success.foreground,
  }),
};

const fadingMessageStyles = mergeStyles({
  opacity: 0,
  transform: 'translateY(-4px)',
  pointerEvents: 'none' as any,
});

const dismissButtonBase = {
  position: 'absolute' as any,
  top: 6,
  right: 8,
  width: 28,
  height: 28,
  border: '1px solid transparent',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  color: 'inherit',
};

const dismissButtonStylesByIntent = {
  warning: mergeStyles(dismissButtonBase, { selectors: { ':hover': { background: messagePalette.warning.hover } } }),
  error: mergeStyles(dismissButtonBase, { selectors: { ':hover': { background: messagePalette.error.hover } } }),
  success: mergeStyles(dismissButtonBase, { selectors: { ':hover': { background: messagePalette.success.hover } } }),
};

const editorHostStyles = mergeStyles({
  flex: 1,
  minHeight: 0,
  position: 'relative',
});

const editorInnerStyles = mergeStyles({
  position: 'absolute',
  inset: 0,
});

const tooltipContentStyles = mergeStyles({
  position: 'fixed',
  padding: '4px 11px 6px',
  color: 'rgb(36, 36, 36)',
  backgroundColor: 'rgb(255, 255, 255)',
  border: '1.11111px solid rgba(0, 0, 0, 0)',
  borderRadius: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.14)',
  fontFamily: '"Segoe UI Variable", "Segoe UI Variable Text", "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif',
  fontSize: 12,
  lineHeight: '16px',
  fontWeight: 400,
  whiteSpace: 'nowrap',
  overflow: 'visible',
  pointerEvents: 'none',
  zIndex: 2147483647,
});

// ── IntentIcon ─────────────────────────────────────────────────────────────

const IntentIcon: React.FC<{ intent: MessageIntent }> = ({ intent }) => {
  if (intent === 'success') return <SuccessIcon />;
  if (intent === 'error') return <ErrorIcon />;
  return <WarningIcon />;
};

// ── FloatingMessage ────────────────────────────────────────────────────────

interface FloatingMessageProps {
  intent: MessageIntent;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
  persistent?: boolean;
  children: React.ReactNode;
}

const FloatingMessage: React.FC<FloatingMessageProps> = ({ intent, onDismiss, action, persistent, children }) => {
  const [isFading, setIsFading] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  const startDismiss = useCallback(() => {
    setIsFading(true);
    window.setTimeout(() => { onDismissRef.current?.(); }, FADE_MS + 40);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (persistent || action) return;
    const timer = window.setTimeout(startDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const className = `${floatingMessageStylesByIntent[intent]}${isFading ? ` ${fadingMessageStyles}` : ''}`;

  function showTooltip(e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>, text: string): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const hasSpaceAbove = rect.top >= 32;
    setTooltip({
      text,
      x: rect.left + rect.width / 2,
      y: hasSpaceAbove ? rect.top - 4 : rect.bottom + 4,
      placement: hasSpaceAbove ? 'top' : 'bottom',
    });
  }

  function hideTooltip(): void {
    setTooltip(null);
  }

  return (
    <div className={className}>
      <IntentIcon intent={intent} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span>{children}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{
              alignSelf: 'flex-start',
              padding: '3px 10px',
              borderRadius: 6,
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className={dismissButtonStylesByIntent[intent]}
        onClick={startDismiss}
        aria-label="Dismiss"
        onMouseEnter={(e) => showTooltip(e, 'Dismiss')}
        onMouseLeave={hideTooltip}
        onFocus={(e) => showTooltip(e, 'Dismiss')}
        onBlur={hideTooltip}
      >
        <CloseIcon />
      </button>
      {tooltip && (
        <div
          role="tooltip"
          className={tooltipContentStyles}
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: tooltip.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
};

// ── Internal message type ──────────────────────────────────────────────────

interface InternalMessage {
  id: string;
  intent: MessageIntent;
  text: React.ReactNode;
  action?: { label: string; onClick: () => void };
  persistent?: boolean;
}

// ── WorkflowNodePanelShell ─────────────────────────────────────────────────

export const NodePanelShell: React.FC<NodePanelShellProps> = ({
  onClose,
  onApply,
  messages,
  children,
}) => {
  const [internalMessages, setInternalMessages] = useState<InternalMessage[]>([]);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const counterRef = useRef(0);

  const showTooltip = useCallback((e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>, text: string): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hasSpaceAbove = rect.top >= 32;
    setTooltip({
      text,
      x: rect.left + rect.width / 2,
      y: hasSpaceAbove ? rect.top - 4 : rect.bottom + 4,
      placement: hasSpaceAbove ? 'top' : 'bottom',
    });
  }, []);

  const hideTooltip = useCallback((): void => {
    setTooltip(null);
  }, []);

  useEffect(() => {
    if (!messages?.length) {
      setInternalMessages([]);
      return;
    }
    setInternalMessages(
      messages.map((msg) => ({
        id: `msg-${++counterRef.current}`,
        intent: getIntent(msg),
        text: (msg as any).children ?? (msg as any).text ?? String(msg),
        action: (msg as any).action,
        persistent: (msg as any).persistent,
      }))
    );
  }, [messages]);

  const dismissMessage = useCallback((id: string) => {
    setInternalMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  return (
    <div className={rootStyles}>
      <div className={headerStyles}>
        <div className={titleStyles}>Edit Code</div>
        <div className={headerActionsStyles}>
          {onApply && (
            <button
              type="button"
              className={iconButtonStyles}
              aria-label="Apply to canvas"
              onClick={onApply}
              onMouseEnter={(e) => showTooltip(e, 'Apply to canvas')}
              onMouseLeave={hideTooltip}
              onFocus={(e) => showTooltip(e, 'Apply to canvas')}
              onBlur={hideTooltip}
            >
              <ApplyIcon />
            </button>
          )}
          <button
            type="button"
            className={iconButtonStyles}
            aria-label="Close"
            onClick={onClose}
            onMouseEnter={(e) => showTooltip(e, 'Close')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e, 'Close')}
            onBlur={hideTooltip}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className={editorHostStyles}>
        <div className={editorInnerStyles}>
          {children}
        </div>
      </div>

      {internalMessages.length > 0 && (
        <div className={messageOverlayStyles}>
          {internalMessages.map((message) => (
            <FloatingMessage
              key={message.id}
              intent={message.intent}
              action={message.action}
              persistent={message.persistent}
              onDismiss={() => dismissMessage(message.id)}
            >
              {message.text}
            </FloatingMessage>
          ))}
        </div>
      )}
      {tooltip && (
        <div
          role="tooltip"
          className={tooltipContentStyles}
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: tooltip.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
};
