import { t } from '../../i18n';
import { ChevronDown } from 'lucide-react';
import type { WorkContext } from '../../domain/context';
import { Button, Input } from '../primitives';
import { Section } from '../workspace/Section';

const workspaceNames: Record<string, string> = {
  projects: 'Projects',
  overview: 'Overview',
  literature: 'Literature',
  notes: 'Notes',
  experiments: 'Experiments',
  writing: 'Paper',
  files: 'Files',
};

const actions = [
  { id: 'explain', label: 'Explain', prompt: '请解释当前材料中的关键概念与结论。' },
  { id: 'summarize', label: 'Summarize', prompt: '请概括当前材料的主要内容与研究要点。' },
  { id: 'writing', label: 'Improve writing', prompt: '请改进当前文字的表达与逻辑，并保留原意。' },
  {
    id: 'experiment',
    label: 'Analyze experiment',
    prompt: '请分析当前实验材料中的结果、问题与后续验证方向。',
  },
] as const;

interface Props {
  context: WorkContext;
  projectName?: string;
  includeContext: boolean;
  actionDisabledReason?: string;
  onIncludeContextChange: (included: boolean) => void;
  onAction: (prompt: string) => void;
}

/** Current material is supplied by the workspace; actions only prepare a question. */
export function ContextPanel({
  context,
  projectName,
  includeContext,
  actionDisabledReason,
  onIncludeContextChange,
  onAction,
}: Props) {
  const material = context.path || (context.resourceId ? context.title : '');
  const excerpt = context.selection || context.text;
  const hasText = !!excerpt?.trim();

  return (
    <div className="sf-ai-context-surface">
      <Section
        title={t('Context')}
        className="sf-ai-current-context"
        actions={
          <label className="sf-ai-attach" title={t('发送时附带当前材料')}>
            <Input
              type="checkbox"
              aria-label={t('发送时附带当前材料')}
              checked={includeContext}
              onChange={(event) => onIncludeContextChange(event.target.checked)}
            />
            {t('Attach')}
          </label>
        }
      >
        <dl className="sf-ai-context-fields">
          <div>
            <dt>{t('Project')}</dt>
            <dd title={projectName}>{projectName || t('Personal')}</dd>
          </div>
          <div>
            <dt>{t('Workspace')}</dt>
            <dd>{t(workspaceNames[context.workspace] || context.workspace)}</dd>
          </div>
          <div>
            <dt>{t('Current file')}</dt>
            <dd title={material || undefined}>
              {material || t('No open file')}
              {context.page != null ? ` · p. ${context.page}` : ''}
            </dd>
          </div>
          <div>
            <dt>{t('Selected text')}</dt>
            <dd title={context.selection?.slice(0, 500)}>
              {context.selection?.trim() || t('None')}
            </dd>
          </div>
        </dl>
        {excerpt ? (
          <details className="sf-ai-context-excerpt">
            <summary>
              <ChevronDown size={12} aria-hidden="true" />
              {context.selection ? t('Selection') : t('Excerpt')}
              <span>
                {Math.min(excerpt.length, 12000).toLocaleString()} {t('chars')}
              </span>
            </summary>
            <pre>{excerpt.slice(0, 12000)}</pre>
          </details>
        ) : null}
      </Section>
      <Section title={t('Actions')} className="sf-ai-action-section">
        <div className="sf-ai-context-actions">
          {actions.map((action) => {
            const unavailable = !hasText
              ? t('打开包含正文或选中文字的材料')
              : action.id === 'writing' && !['writing', 'notes'].includes(context.workspace)
                ? t('在 Paper 或 Notes 中打开文字')
                : action.id === 'experiment' && context.workspace !== 'experiments'
                  ? t('在 Experiments 中打开代码或实验记录')
                  : undefined;
            const reason =
              actionDisabledReason ||
              (!includeContext ? t('先勾选 Attach 附带当前材料') : unavailable);
            return (
              <Button
                key={action.id}
                type="button"
                variant="ghost"
                size="sm"
                disabled={!!reason}
                tooltip={reason || t('填入问题后由你发送')}
                onClick={() => onAction(t(action.prompt))}
              >
                {t(action.label)}
              </Button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
