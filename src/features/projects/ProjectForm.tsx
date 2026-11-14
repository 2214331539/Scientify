import { canEditProject } from '../../platform/collaboration';
import { t, translateError } from '../../i18n';
import { Button, Input, Textarea } from '../../components/primitives';
import { useEffect, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { Modal } from '../../components/Modal';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { ProjectCoverArt } from './ProjectCover';
import { coverColor, projectCoverColors } from './model';

/** Edits a project's name, question, cover and code directory. Creating a project uses the wizard. */
export function ProjectForm({
  project,
  store,
  onClose,
}: {
  project: Project;
  store: WorkspaceStore;
  onClose(): void;
}) {
  const busy = useStore(store, (s) => s.busy);
  const fileEditsPending = useStore(store, (s) => !!s.dirtySources.files);
  const error = useStore(store, (s) => s.error);
  const [draft, setDraft] = useState(() => ({
    name: project.name,
    question: project.question ?? '',
    field: project.field ?? '',
    path: project.path || project.repo || '',
    repo: project.repo ?? '',
    color: coverColor(project),
  }));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    store.getState().setDirty(dirty);
    return () => store.getState().setDirty(false);
  }, [dirty, store]);
  function field(key: keyof typeof draft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return;
    const saved = await store.getState().update((workspace) => {
      const target = workspace.projects.find((p) => p.id === project.id);
      if (!target) throw new Error(t('项目不存在，请重新载入。'));
      if (
        store.getState().dirtySources.files &&
        ((target.path ?? '') !== draft.path || (target.repo ?? '') !== draft.repo)
      ) {
        throw new Error(t('请先保存或丢弃所有文件修改，并等待文件写入完成，再更改项目目录。'));
      }
      Object.assign(target, draft, {
        name: draft.name.trim(),
        updatedAt: new Date().toISOString(),
      });
    });
    if (saved) onClose();
  }
  return (
    <Modal
      title={t('编辑项目信息')}
      onClose={onClose}
      busy={busy}
      dirty={dirty}
      className="wizard-dialog"
    >
      <form onSubmit={submit} className="form-grid wizard">
        <div className="wizard-body">
          <div className="wizard-preview" aria-hidden="true">
            <ProjectCoverArt
              name={draft.name.trim() || t('项目名称')}
              field={draft.field.trim() || t('研究方向')}
              question={draft.question.trim()}
              color={draft.color}
            />
          </div>
          <div className="wizard-fields">
            <label>
              {t('项目名称')}
              <Input
                disabled={busy || !canEditProject(project)}
                autoFocus
                required
                maxLength={160}
                value={draft.name}
                onChange={(e) => field('name', e.target.value)}
                placeholder={t('例如：小样本学习中的表征泛化')}
              />
            </label>
            <label>
              {t('研究问题')}
              <Textarea
                disabled={busy || !canEditProject(project)}
                rows={3}
                value={draft.question}
                onChange={(e) => field('question', e.target.value)}
                placeholder={t('这个项目希望回答什么问题？')}
              />
            </label>
            <label>
              {t('研究方向')}
              <Input
                disabled={busy || !canEditProject(project)}
                value={draft.field}
                onChange={(e) => field('field', e.target.value)}
                placeholder={t('例如：多模态、幻觉')}
              />
            </label>
            <fieldset className="wizard-colors" disabled={busy || !canEditProject(project)}>
              <legend>{t('封面颜色')}</legend>
              {projectCoverColors.map((color) => (
                <label key={color} className="wizard-swatch" style={{ background: color }}>
                  <input
                    type="radio"
                    name="cover-color"
                    aria-label={color}
                    checked={draft.color === color}
                    onChange={() => field('color', color)}
                  />
                </label>
              ))}
              <label className="wizard-swatch custom" title={t('自定义颜色')}>
                <input
                  type="color"
                  aria-label={t('自定义颜色')}
                  value={draft.color}
                  onChange={(e) => field('color', e.target.value)}
                />
              </label>
            </fieldset>
            <label>
              {t('项目目录')}
              <div className="input-action">
                <Input
                  disabled={busy || !canEditProject(project)}
                  readOnly
                  value={draft.path}
                  placeholder={t('尚未关联本地目录')}
                />
                <Button
                  type="button"
                  disabled={busy || fileEditsPending}
                  onClick={async () => {
                    const path = await store.getState().chooseDirectory();
                    if (path) field('path', path);
                  }}
                >
                  {t('选择目录')}
                </Button>
                <Button
                  type="button"
                  disabled={busy || fileEditsPending || !draft.path}
                  onClick={() => {
                    setDraft((value) => ({ ...value, path: '', repo: '' }));
                    setDirty(true);
                  }}
                >
                  {t('清除')}
                </Button>
              </div>
            </label>
            {fileEditsPending ? (
              <p className="muted">{t('存在未保存文件或文件正在写入，暂时不能更改目录。')}</p>
            ) : null}
          </div>
        </div>
        {error ? (
          <p role="alert" className="error-text">
            {translateError(error)}
          </p>
        ) : null}
        <footer className="dialog-footer">
          <span className="muted">{t('保存在本机工作区')}</span>
          <Button
            variant="primary"
            disabled={busy || !canEditProject(project) || !draft.name.trim()}
            type="submit"
          >
            {busy ? t('正在保存…') : t('保存项目')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
