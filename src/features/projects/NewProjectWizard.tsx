import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { isTauri } from '@tauri-apps/api/core';
import { ChevronLeft } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button, Input, Textarea } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import { collaboration, requestSignIn } from '../../platform/collaboration';
import { nativeLibrary } from '../../platform/library';
import { refreshCloud, useCloud } from './cloud';
import { InviteList, type InviteRole } from './ProjectDialogs';
import { ProjectCoverArt } from './ProjectCover';
import { COLLABORATION_TEAM_ID, ensureCollaborationTeam, projectCoverColors } from './model';

export type NewProjectMode = 'personal' | 'team';

/** Two steps: what the project is about, then its folders and who it is shared with. */
export function NewProjectWizard({
  store,
  mode,
  onClose,
  onCreated,
}: {
  store: WorkspaceStore;
  mode: NewProjectMode;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy);
  const fileEditsPending = useStore(store, (s) => !!s.dirtySources.files);
  const error = useStore(store, (s) => s.error);
  const cloud = useCloud();
  const team = mode === 'team';
  const signedIn = cloud.available && !!cloud.state?.authenticated;
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState(() => ({
    name: '',
    question: '',
    field: '',
    color: projectCoverColors[data.projects.length % projectCoverColors.length],
  }));
  const [codePath, setCodePath] = useState('');
  const [library, setLibrary] = useState<'later' | 'pick'>('later');
  const [sync, setSync] = useState(false);
  const [invites, setInvites] = useState<{ phone: string; role: InviteRole }[]>([]);
  const [working, setWorking] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    store.getState().setDirty(dirty);
    return () => store.getState().setDirty(false);
  }, [dirty, store]);
  function edit(key: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  const name = draft.name.trim();
  const duplicate = !!name && data.projects.some((project) => project.name === name);
  const locked = busy || working;
  async function create() {
    if (!name) return;
    setWorking(true);
    store.getState().clearMessage();
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    try {
      const saved = await store.getState().update((workspace) => {
        if (team) ensureCollaborationTeam(workspace);
        workspace.projects.push({
          id,
          name,
          question: draft.question.trim(),
          field: draft.field.trim(),
          color: draft.color,
          space: team ? COLLABORATION_TEAM_ID : 'personal',
          path: codePath,
          repo: '',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
      if (!saved) return;
      let notice = '';
      if (team || sync) {
        try {
          await collaboration.createProject(name, id);
          for (const invite of invites)
            await collaboration.inviteMember(id, invite.phone, invite.role);
          await store.getState().update((workspace) => {
            const target = workspace.projects.find((project) => project.id === id);
            if (target) Object.assign(target, { collaborationRole: 'owner' });
          });
          void collaboration
            .syncProject(id)
            .catch(() => {})
            .finally(() => void refreshCloud(store.getState().data?.projects ?? []));
        } catch (reason) {
          if (team)
            await store.getState().update((workspace) => {
              const target = workspace.projects.find((project) => project.id === id);
              if (target) target.space = 'personal';
            });
          notice = t('项目已在本机创建，但没有开启云端同步：{message}', {
            message: translateError(String(reason)),
          });
        }
      }
      if (library === 'pick' && isTauri()) {
        try {
          await nativeLibrary.choose(id);
        } catch (reason) {
          notice = translateError(String(reason));
        }
      }
      setDirty(false);
      store.getState().setDirty(false);
      if (notice) store.setState({ error: notice });
      onCreated(id);
    } finally {
      setWorking(false);
    }
  }
  const title = team ? t('新建团队项目') : t('新建项目');
  return (
    <Modal title={title} onClose={onClose} busy={locked} dirty={dirty} className="wizard-dialog">
      <form
        className="form-grid wizard"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 1 && name) setStep(2);
          else if (step === 2) void create();
        }}
      >
        <p className="wizard-step">
          {t('第 {step} 步，共 2 步：{label}', {
            step,
            label: step === 1 ? t('基本信息') : team ? t('文件夹与成员') : t('文件夹与同步'),
          })}
        </p>
        {step === 1 ? (
          <div className="wizard-body">
            <div className="wizard-preview" aria-hidden="true">
              <ProjectCoverArt
                name={name || t('项目名称')}
                field={draft.field.trim() || t('研究方向')}
                color={draft.color}
                badges={team ? ['team'] : []}
              />
              <small>{t('封面预览')}</small>
            </div>
            <div className="wizard-fields">
              <label>
                {t('项目名称')}
                <Input
                  autoFocus
                  required
                  maxLength={160}
                  disabled={locked}
                  value={draft.name}
                  placeholder={t('例如：小样本学习中的表征泛化')}
                  onChange={(event) => edit('name', event.target.value)}
                />
                {duplicate ? <small className="wizard-warn">{t('已有同名项目')}</small> : null}
              </label>
              <label>
                {t('研究问题')}
                <Textarea
                  rows={3}
                  disabled={locked}
                  value={draft.question}
                  placeholder={t('这个项目希望回答什么问题？')}
                  onChange={(event) => edit('question', event.target.value)}
                />
              </label>
              <label>
                {t('研究方向')}
                <Input
                  disabled={locked}
                  value={draft.field}
                  placeholder={t('例如：多模态、幻觉')}
                  onChange={(event) => edit('field', event.target.value)}
                />
              </label>
              <fieldset className="wizard-colors" disabled={locked}>
                <legend>{t('封面颜色')}</legend>
                {projectCoverColors.map((color) => (
                  <label key={color} className="wizard-swatch" style={{ background: color }}>
                    <input
                      type="radio"
                      name="cover-color"
                      aria-label={color}
                      checked={draft.color === color}
                      onChange={() => edit('color', color)}
                    />
                  </label>
                ))}
              </fieldset>
            </div>
          </div>
        ) : (
          <div className="wizard-fields">
            <fieldset className="wizard-choice" disabled={locked}>
              <legend>{t('文献文件夹')}</legend>
              <label>
                <input
                  type="radio"
                  name="library"
                  checked={library === 'later'}
                  onChange={() => setLibrary('later')}
                />
                <span>
                  <strong>{t('稍后关联')}</strong>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="library"
                  checked={library === 'pick'}
                  disabled={!isTauri()}
                  onChange={() => setLibrary('pick')}
                />
                <span>
                  <strong>{t('选择已有文件夹')}</strong>
                  <small>{t('文件留在原位置')}</small>
                </span>
              </label>
            </fieldset>
            <div className="wizard-choice">
              <span className="center-label">{t('代码目录')}</span>
              <div className="wizard-path">
                <Input
                  readOnly
                  disabled={locked}
                  value={codePath}
                  placeholder={t('稍后关联')}
                  aria-label={t('代码目录')}
                />
                <Button
                  type="button"
                  disabled={locked || fileEditsPending}
                  onClick={async () => {
                    const path = await store.getState().chooseDirectory();
                    if (path) {
                      setCodePath(path);
                      setDirty(true);
                    }
                  }}
                >
                  {t('选择目录')}
                </Button>
                {codePath ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => setCodePath('')}
                  >
                    {t('清除')}
                  </Button>
                ) : null}
              </div>
            </div>
            {team ? (
              <div className="center-field">
                <span className="center-label">
                  {t('邀请成员')}
                  <small>{t('可选')}</small>
                </span>
                <InviteList invites={invites} onChange={setInvites} disabled={locked} />
                <small className="muted">{t('未注册的号码会在对方首次登录后加入。')}</small>
              </div>
            ) : signedIn ? (
              <label className={`wizard-check${sync ? ' checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={sync}
                  disabled={locked}
                  onChange={(event) => setSync(event.target.checked)}
                />
                <span>
                  <strong>{t('在多台设备上同步')}</strong>
                  <small>{t('同步到你登录的其他设备')}</small>
                </span>
              </label>
            ) : (
              <p className="wizard-check disabled">
                <span>
                  <strong>{t('在多台设备上同步')}</strong>
                  <small>
                    {t('登录后可用。')}
                    <Button type="button" variant="ghost" size="sm" onClick={requestSignIn}>
                      {t('登录')}
                    </Button>
                  </small>
                </span>
              </p>
            )}
          </div>
        )}
        {error ? (
          <p role="alert" className="error-text">
            {translateError(error)}
          </p>
        ) : null}
        <footer className="dialog-footer center-dialog-footer">
          <span className="center-dialog-extra">
            {step === 2 ? (
              <Button type="button" variant="ghost" disabled={locked} onClick={() => setStep(1)}>
                <ChevronLeft />
                {t('上一步')}
              </Button>
            ) : null}
          </span>
          <span className="center-dialog-buttons">
            <Button type="button" disabled={locked} onClick={onClose}>
              {t('取消')}
            </Button>
            {step === 1 ? (
              <Button type="submit" variant="primary" disabled={locked || !name}>
                {t('下一步')}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={locked || !name}>
                {working || busy ? t('正在创建…') : team ? t('创建团队项目') : t('创建项目')}
              </Button>
            )}
          </span>
        </footer>
      </form>
    </Modal>
  );
}
