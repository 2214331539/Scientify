import { t, locale } from '../../i18n';
import { useState } from 'react';
import { useStore } from 'zustand';
import { ArrowUpRight, Plus, Settings2 } from 'lucide-react';
import { Badge, Button, Input } from '../../components/primitives';
import { Panel } from '../../components/layout/Panel';
import { Section } from '../../components/workspace/Section';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { ActivityList } from '../../components/workspace/ActivityList';
import type { Project } from '../../domain/workspace';
import type { WorkspaceId } from '../../domain/context';
import type { WorkspaceStore } from '../../stores/workspace';
import { buildResearchHome, type ResumeTarget } from './home-model';
import './overview.css';

const updatedDate = (timestamp: string) =>
  new Date(timestamp).toLocaleString(locale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export function Overview({
  project,
  store,
  onNavigate,
  onEdit,
  onNotes,
  onResume,
  lastPaths,
  lastPaperId,
}: {
  project: Project;
  store: WorkspaceStore;
  onNavigate: (id: WorkspaceId) => void;
  onEdit: () => void;
  onNotes: (id?: string) => void;
  onResume?: (target: ResumeTarget) => void;
  lastPaths?: Partial<Record<WorkspaceId, string | null>>;
  lastPaperId?: string | null;
}) {
  const data = useStore(store, (state) => state.data)!;
  const busy = useStore(store, (state) => state.busy);
  const [task, setTask] = useState('');
  const { continued, activity, tasks } = buildResearchHome(
    data,
    project.id,
    lastPaths,
    lastPaperId,
  );
  const lastUpdated = [
    project.updatedAt,
    project.createdAt,
    ...activity.map((item) => item.timestamp),
  ]
    .filter(
      (value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)),
    )
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const open = (target: ResumeTarget) => {
    if (onResume) onResume(target);
    else if (target.noteId) onNotes(target.noteId);
    else onNavigate(target.workspace);
  };
  return (
    <Panel
      className="research-home"
      header={
        <>
          <span>{t('Overview')}</span>
          <span className="spacer" />
          <Button variant="ghost" iconOnly onClick={onEdit} aria-label={t('项目设置')}>
            <Settings2 />
          </Button>
        </>
      }
    >
      <div className="panel-scroll">
        <div className="research-home-content">
          <header className="research-home-project">
            <div className="research-home-title-line">
              <h1>{project.name}</h1>
              {project.stage ? <Badge>{project.stage}</Badge> : null}
            </div>
            {project.question ? <p>{project.question}</p> : null}
            <div className="research-home-metadata">
              {project.field ? <span>{project.field}</span> : null}
              {lastUpdated ? (
                <time dateTime={lastUpdated} title={new Date(lastUpdated).toLocaleString(locale())}>
                  {t('Last updated')} {updatedDate(lastUpdated)}
                </time>
              ) : null}
            </div>
          </header>
          <Section
            className="research-home-section"
            title={t('Continue working')}
            id="continue-heading"
          >
            {continued.length ? (
              <ResourceList className="research-continue-list" label={t('继续工作')}>
                {continued.map((item) => (
                  <ResourceRow
                    className="research-continue-row"
                    key={item.id}
                    onClick={() => open(item.target)}
                  >
                    <span className="research-row-module">{item.module}</span>
                    <span className="research-row-resource">
                      <span className="research-row-title">{item.title}</span>
                      <span className="research-row-detail">{item.detail}</span>
                    </span>
                    <ArrowUpRight aria-hidden="true" />
                  </ResourceRow>
                ))}
              </ResourceList>
            ) : (
              <div className="research-home-start">
                <span>{t('暂无工作记录')}</span>
                <div>
                  <Button variant="ghost" onClick={() => onNavigate('literature')}>
                    {t('Literature')}
                    <ArrowUpRight />
                  </Button>
                  <Button variant="ghost" onClick={() => onNavigate('experiments')}>
                    {t('Experiments')}
                    <ArrowUpRight />
                  </Button>
                  <Button variant="ghost" onClick={() => onNavigate('writing')}>
                    {t('Paper')}
                    <ArrowUpRight />
                  </Button>
                </div>
              </div>
            )}
          </Section>
          <Section
            className="research-home-section"
            title={t('Recent activity')}
            id="activity-heading"
          >
            {activity.length ? (
              <ActivityList
                items={activity.map((item) => ({ ...item, onOpen: () => open(item.target) }))}
              />
            ) : (
              <p className="research-home-empty">{t('暂无最近活动')}</p>
            )}
          </Section>
          <Section className="research-home-section" title={t('Next steps')} id="next-heading">
            <div className="research-task-list">
              {tasks.map((item) => (
                <label
                  className={`research-task-row ${item.done ? 'completed' : ''}`}
                  key={item.id}
                >
                  <Input
                    type="checkbox"
                    checked={Boolean(item.done)}
                    disabled={busy}
                    onChange={() =>
                      void store.getState().update((draft) => {
                        const saved = draft.tasks.find((candidate) => candidate.id === item.id);
                        if (saved) saved.done = !saved.done;
                      })
                    }
                  />
                  <span>{item.title}</span>
                </label>
              ))}
              <form
                className="research-task-add"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const title = task.trim();
                  if (
                    title &&
                    (await store.getState().update((draft) => {
                      draft.tasks.push({
                        id: crypto.randomUUID(),
                        project: project.id,
                        title,
                        done: false,
                      });
                    }))
                  )
                    setTask('');
                }}
              >
                <Plus size={14} aria-hidden="true" />
                <Input
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  aria-label={t('新增待办')}
                  placeholder={t('添加下一步…')}
                  maxLength={300}
                  disabled={busy}
                />
                {task.trim() ? (
                  <Button type="submit" size="sm" disabled={busy}>
                    {t('添加')}
                  </Button>
                ) : null}
              </form>
            </div>
          </Section>
          {project.path || project.repo ? (
            <footer className="research-home-location">
              {project.path ? <span title={project.path}>{project.path}</span> : null}
              {project.repo ? <span title={project.repo}>Git · {project.repo}</span> : null}
            </footer>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
