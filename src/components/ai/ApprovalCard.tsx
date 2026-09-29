import { ShieldAlert, TerminalSquare, FileWarning } from 'lucide-react';
import { Button } from '../primitives';
import { t } from '../../i18n';
import type { ApprovalDecision, ApprovalRequest } from '../../platform/agent';
import './approval-card.css';

/** Fields the engine sends with an approval prompt. They are optional in the
 * transport, so every one of them has to survive being absent. */
type ApprovalParams = {
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : '');

function describe(event: ApprovalRequest): {
  icon: typeof ShieldAlert;
  title: string;
  detail: string;
  target: string;
} {
  const params = (event.params ?? {}) as ApprovalParams;
  if (event.method === 'item/commandExecution/requestApproval') {
    return {
      icon: TerminalSquare,
      title: t('请求执行命令'),
      detail: text(params.reason),
      target: text(params.command),
    };
  }
  if (event.method === 'item/fileChange/requestApproval') {
    return {
      icon: FileWarning,
      title: t('请求修改文件'),
      detail: text(params.reason),
      // `grantRoot` asks for write access under a root, not a single file.
      target: text(params.grantRoot) ? t('目录：{path}', { path: text(params.grantRoot) }) : '',
    };
  }
  return {
    icon: ShieldAlert,
    title: t('请求提升权限'),
    detail: '',
    target: '',
  };
}

/**
 * An inline prompt for one engine approval request.
 *
 * The engine decides when to ask (approval policy plus sandbox); the host owns
 * presentation and the answer. Answering is mandatory — an ignored request
 * blocks the turn, so the card never renders without a way to reply.
 */
export function ApprovalCard({
  event,
  busy = false,
  onDecide,
}: {
  event: ApprovalRequest;
  busy?: boolean;
  onDecide(decision: ApprovalDecision): void;
}) {
  const { icon: Icon, title, detail, target } = describe(event);
  // `item/permissions/requestApproval` answers with a permission profile rather
  // than a decision, so it uses the dedicated grant/deny response shape below.
  const permissionRequest = event.method === 'item/permissions/requestApproval';
  return (
    <article className="sf-approval" role="group" aria-label={title} data-method={event.method}>
      <header className="sf-approval-head">
        <Icon size={15} aria-hidden="true" />
        <strong>{title}</strong>
      </header>
      {target ? <pre className="sf-approval-target">{target}</pre> : null}
      {detail ? <p className="sf-approval-detail">{detail}</p> : null}
      {permissionRequest ? (
        <div className="sf-approval-actions">
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onDecide('grantPermissions')}
          >
            {t('允许本次权限')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onDecide('denyPermissions')}
          >
            {t('拒绝权限')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onDecide('cancel')}
          >
            {t('中止任务')}
          </Button>
        </div>
      ) : (
        <div className="sf-approval-actions">
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onDecide('accept')}
          >
            {t('允许')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onDecide('acceptForSession')}
          >
            {t('本会话允许')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onDecide('decline')}
          >
            {t('拒绝')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy}
            // Distinct from decline: cancelling aborts the turn instead of
            // refusing this one action.
            onClick={() => onDecide('cancel')}
          >
            {t('中止任务')}
          </Button>
        </div>
      )}
    </article>
  );
}
