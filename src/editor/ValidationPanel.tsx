import { INavLinkGroup, Nav } from '@fluentui/react/lib/Nav';
import { Panel, PanelType } from '@fluentui/react/lib/Panel';
import { FlowError } from './types';

export interface ValidationPanelProps {
  warnings: FlowError[];
  errors: FlowError[];
  isOpen: boolean;
  onClose: () => void;
}

export const ValidationPanel: React.FC<ValidationPanelProps> = ({
  warnings,
  errors,
  isOpen,
  onClose,
}) => {
  const result: INavLinkGroup[] = [
    {
      name: 'Errors',
      links: errors.map((x) => ({
        name: `${x.operationName}: ${x.errorDescription}.`,
        title: x.fixInstructions.markdownText,
        url: '#',
        onClick: (e) => {
          e?.preventDefault();
          navigator.clipboard.writeText(x.fixInstructions.markdownText);
        },
      })),
    },
    {
      name: 'Warnings',
      links: warnings.map((x) => ({
        name: `${x.operationName}: ${x.errorDescription}.`,
        title: x.fixInstructions.markdownText,
        url: '#',
        onClick: (e) => {
          e?.preventDefault();
          navigator.clipboard.writeText(x.fixInstructions.markdownText);
        },
      })),
    },
  ];

  return (
    <Panel
      headerText="Validation Result"
      isOpen={isOpen}
      onDismiss={onClose}
      type={PanelType.large}
    >
      <Nav groups={result} />
    </Panel>
  );
};
