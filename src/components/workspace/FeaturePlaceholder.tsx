import { Construction, House, PenLine, Rss, UsersRound } from 'lucide-react';
import { t } from '../../i18n';
import './feature-placeholder.css';

// A single catalog keeps unavailable destinations consistent across both windows.
const features = {
  collaboration: { title: '团队协作空间', icon: UsersRound },
  overview: { title: 'Overview', icon: House },
  writing: { title: 'LaTeX 论文撰写', icon: PenLine },
  subscriptions: { title: '文献订阅', icon: Rss },
} as const;

export function FeaturePlaceholder({
  feature,
  compact = false,
}: {
  feature: keyof typeof features;
  compact?: boolean;
}) {
  const { title, icon: Icon } = features[feature];
  return (
    <section
      className={`sf-feature-placeholder${compact ? ' sf-feature-placeholder--compact' : ''}`}
      aria-label={t(title)}
    >
      {!compact && (
        <header className="workspace-commandbar">
          <span className="workspace-name">{t(title)}</span>
        </header>
      )}
      <div className="sf-feature-placeholder-body">
        <Icon className="sf-feature-placeholder-icon" size={32} aria-hidden="true" />
        {compact && <h2>{t(title)}</h2>}
        <p className="sf-feature-placeholder-status">
          <Construction size={15} aria-hidden="true" />
          {t('开发中')}
        </p>
        <p>{t('敬请期待')}</p>
      </div>
    </section>
  );
}
