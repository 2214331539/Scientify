import { t, translateError } from '../../i18n';
import { Button, Input, Textarea, Dropdown } from '../../components/primitives';
import { useEffect, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { Modal } from '../../components/Modal';
import type { Project, Team } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';

export function ProjectForm({
  project,
  space,
  store,
  onClose,
}: {
  project?: Project;
  space: string;
  store: WorkspaceStore;
  onClose(): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy);
  const fileEditsPending = useStore(store, (s) => !!s.dirtySources.files);
  const error = useStore(store, (s) => s.error);
  const [draft, setDraft] = useState(() => ({
    name: project?.name ?? '',
    question: project?.question ?? '',
    field: project?.field ?? '',
    space: project?.space ?? space,
    path: project?.path ?? '',
    repo: project?.repo ?? '',
    color: project?.color ?? '#657b71',
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
      const timestamp = new Date().toISOString();
      if (project) {
        const target = workspace.projects.find((p) => p.id === project.id);
        if (!target) throw new Error(t('项目不存在，请重新载入。'));
        if (
          store.getState().dirtySources.files &&
          ((target.path ?? '') !== draft.path || (target.repo ?? '') !== draft.repo)
        ) {
          throw new Error(t('请先保存或丢弃所有文件修改，并等待文件写入完成，再更改项目目录。'));
        }
        Object.assign(target, draft, { name: draft.name.trim(), updatedAt: timestamp });
      } else {
        workspace.projects.push({
          ...draft,
          name: draft.name.trim(),
          id: crypto.randomUUID(),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    });
    if (saved) onClose();
  }
  return (
    <Modal
      title={project ? t('编辑项目') : t('新建科研项目')}
      onClose={onClose}
      busy={busy}
      dirty={dirty}
    >
      <form onSubmit={submit} className="form-grid">
        <label>
          {t('项目名称')}
          <Input
            disabled={busy}
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
            disabled={busy}
            rows={3}
            value={draft.question}
            onChange={(e) => field('question', e.target.value)}
            placeholder={t('这个项目希望回答什么问题？')}
          />
        </label>
        <div className="form-pair">
          <label>
            {t('所属空间')}
            <Dropdown
              disabled={busy}
              value={draft.space}
              onChange={(e) => field('space', e.target.value)}
            >
              <option value="personal">{t('我的工作空间')}</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Dropdown>
          </label>
          <label>
            {t('研究方向')}
            <Input
              disabled={busy}
              value={draft.field}
              onChange={(e) => field('field', e.target.value)}
              placeholder={t('研究领域或关键词')}
            />
          </label>
        </div>
        <label>
          {t('项目目录')}
          <div className="input-action">
            <Input
              disabled={busy}
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
              onClick={() => field('path', '')}
            >
              {t('清除')}
            </Button>
          </div>
        </label>
        <label>
          {t('Git 仓库目录')}
          <div className="input-action">
            <Input
              disabled={busy}
              readOnly
              value={draft.repo}
              placeholder={t('可单独关联 Git 仓库')}
            />
            <Button
              type="button"
              disabled={busy || fileEditsPending}
              onClick={async () => {
                const path = await store.getState().chooseDirectory();
                if (path) field('repo', path);
              }}
            >
              {t('选择仓库')}
            </Button>
            <Button
              type="button"
              disabled={busy || fileEditsPending || !draft.repo}
              onClick={() => field('repo', '')}
            >
              {t('清除')}
            </Button>
          </div>
        </label>
        {fileEditsPending ? (
          <p className="muted">{t('存在未保存文件或文件正在写入，暂时不能更改目录。')}</p>
        ) : null}
        <label className="color-label">
          {t('项目颜色')}
          <Input
            disabled={busy}
            type="color"
            value={draft.color}
            onChange={(e) => field('color', e.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="error-text">
            {translateError(error)}
          </p>
        ) : null}
        <footer className="dialog-footer">
          <span className="muted">{t('保存在本机工作区')}</span>
          <Button variant="primary" disabled={busy || !draft.name.trim()} type="submit">
            {busy ? t('正在保存…') : t('保存项目')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

export function TeamForm({
  team,
  store,
  onClose,
}: {
  team?: Team;
  store: WorkspaceStore;
  onClose(): void;
}) {
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const dirty = name !== (team?.name ?? '') || description !== (team?.description ?? '');
  const busy = useStore(store, (s) => s.busy);
  const error = useStore(store, (s) => s.error);
  useEffect(() => {
    store.getState().setDirty(dirty);
    return () => store.getState().setDirty(false);
  }, [dirty, store]);
  return (
    <Modal
      title={team ? t('团队信息') : t('创建团队空间')}
      busy={busy}
      dirty={dirty}
      onClose={onClose}
    >
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          if (
            await store.getState().update((d) => {
              if (team)
                Object.assign(
                  d.teams.find((t) => t.id === team.id)!,
                  { name: name.trim(), description },
                );
              else
                d.teams.push({
                  id: crypto.randomUUID(),
                  name: name.trim(),
                  description,
                  color: '#657b71',
                });
            })
          )
            onClose();
        }}
      >
        <label>
          {t('团队名称')}
          <Input
            disabled={busy}
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t('团队介绍')}
          <Textarea
            disabled={busy}
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <p className="muted">{t('团队空间用于本机项目分类，成员邀请与在线协作尚未开放。')}</p>
        {error ? (
          <p role="alert" className="error-text">
            {translateError(error)}
          </p>
        ) : null}
        <footer className="dialog-footer">
          <span />
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? t('正在保存…') : t('保存团队')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
