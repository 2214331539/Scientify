import { useEffect } from 'react';
import { useStore } from 'zustand';
import { t } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import { maskPhone } from '../account/account';
import { classifyCloud, refreshCloud, useCloud } from '../projects/cloud';
import { roleName } from '../projects/ProjectDialogs';
import { ProjectSyncControl } from '../projects/ProjectSyncControl';

/** Settings → 协作: the team projects I am in, my role and who else is there. */
export function CollaborationPreferences({ store }: { store: WorkspaceStore }) {
  const data = useStore(store, (s) => s.data);
  const cloud = useCloud();
  useEffect(() => {
    void refreshCloud(store.getState().data?.projects ?? []);
  }, [store]);
  const userId = cloud.state?.userId;
  const { team } = classifyCloud(cloud, data?.projects ?? []);
  if (!team.length)
    return (
      <p className="muted settings-team-empty">
        {t('还没有团队项目。在“团队项目”里新建，或把自己的项目共享给团队。')}
      </p>
    );
  return (
    <div className="settings-teams">
      {team.map(({ remote, local, members }) => (
        <section key={remote.id} className="settings-team" aria-label={remote.name}>
          <header>
            <div>
              <strong>{remote.name}</strong>
              <small>
                {remote.role === 'owner'
                  ? t('你是所有者')
                  : t('你是{role}', { role: roleName(remote.role) })}
              </small>
            </div>
            {local ? <ProjectSyncControl project={local} store={store} /> : null}
          </header>
          <ul aria-label={t('成员')}>
            {(members ?? []).map((member) => (
              <li key={member.id}>
                <span>{member.id === userId ? t('我') : maskPhone(member.phone)}</span>
                <small>
                  {roleName(member.role)}
                  {member.pending ? ` · ${t('待加入')}` : ''}
                </small>
              </li>
            ))}
            {!members ? <li className="muted">{t('正在载入成员…')}</li> : null}
          </ul>
        </section>
      ))}
    </div>
  );
}
