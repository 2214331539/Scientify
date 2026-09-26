import { locale } from '../../i18n';
import { Button } from '../primitives/Button';
import './workspace-primitives.css';

export interface ActivityListItem {
  id: string;
  title: string;
  action: string;
  timestamp: string;
  onOpen: () => void;
}

export function ActivityList({
  items,
  className = '',
}: {
  items: ActivityListItem[];
  className?: string;
}) {
  return (
    <ol className={`sf-activity-list ${className}`.trim()}>
      {items.map((item) => (
        <li key={item.id}>
          <Button type="button" variant="ghost" className="sf-activity-row" onClick={item.onOpen}>
            <time
              dateTime={item.timestamp}
              title={new Date(item.timestamp).toLocaleString(locale())}
            >
              {new Date(item.timestamp).toLocaleDateString(locale(), {
                month: '2-digit',
                day: '2-digit',
              })}
            </time>
            <span className="sf-activity-marker" aria-hidden="true" />
            <span className="sf-activity-action">{item.action}</span>
            <span className="sf-activity-title">{item.title}</span>
          </Button>
        </li>
      ))}
    </ol>
  );
}
