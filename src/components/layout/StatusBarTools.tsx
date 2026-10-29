import { Bot, NotebookPen } from 'lucide-react';
import { Button } from '../primitives';
import { t } from '../../i18n';

export function StatusBarTools({
  ready,
  tool,
  open,
  notesWorkspace,
  onTool,
}: {
  ready: boolean;
  tool: 'assistant' | 'notes';
  open: boolean;
  notesWorkspace: boolean;
  onTool: (tool: 'assistant' | 'notes') => void;
}) {
  return (
    <div className="statusbar-tools" role="group" aria-label={t('全局辅助工具')}>
      <Button
        variant="ghost"
        iconOnly
        id="assistant-toggle"
        aria-label={t('AI 助手')}
        title={t('AI Assistant')}
        aria-pressed={open && tool === 'assistant'}
        disabled={!ready}
        onClick={() => onTool('assistant')}
      >
        <Bot />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        id="notes-toggle"
        aria-label={t('研究笔记')}
        title={t('Research Notes')}
        aria-pressed={notesWorkspace || (open && tool === 'notes')}
        disabled={!ready}
        onClick={() => onTool('notes')}
      >
        <NotebookPen />
      </Button>
    </div>
  );
}
