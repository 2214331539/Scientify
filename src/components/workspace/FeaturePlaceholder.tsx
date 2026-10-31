import { Construction, House, PenLine, UsersRound, Rss } from 'lucide-react';
import { t } from '../../i18n';
import './feature-placeholder.css';

// A single catalog keeps unavailable destinations consistent across both windows.
const features = {
  recommendations: { title: '消息推荐', icon: Rss },
  collaboration: { title: '团队协作空间', icon: UsersRound, Rss },
  overview: { title: 'Overview', icon: House },
  writing: { title: 'LaTeX 论文撰写', icon: PenLine },
} as const;

export function FeaturePlaceholder({ feature }: { feature: keyof typeof features }) {
  const { title, icon: Icon } = features[feature];
  return (
    <section className="sf-feature-placeholder" aria-label={t(title)}>
      <header className="workspace-commandbar">
        <span className="workspace-name">{t(title)}</span>
      </header>
      <div className="sf-feature-placeholder-body">
        <Icon className="sf-feature-placeholder-icon" size={32} aria-hidden="true" />
        <p className="sf-feature-placeholder-status">
          <Construction size={15} aria-hidden="true" />
          {t('开发中')}
        </p>
        <p>{t('敬请期待')}</p>
      </div>
    </section>
  );
}
