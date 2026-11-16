import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import type { OfficialModelProblem } from '../../platform/collaboration';

export const openAccountSettings = () =>
  window.dispatchEvent(new CustomEvent('scientify-open-settings', { detail: 'account' }));

const TEXT: Record<OfficialModelProblem, { title: string; detail: string }> = {
  quota_exhausted: {
    title: '官方模型额度已用完',
    detail: '这条消息没有发出。可以用兑换码补充额度，等下个周期恢复，或改用自己的模型密钥。',
  },
  daily_limit: {
    title: '今天的用量已到单日上限',
    detail: '明天 0 点恢复。单日上限防止对话失控时用光整月的额度；也可以改用自己的模型密钥。',
  },
  model_not_in_plan: {
    title: '当前套餐不包含这个模型',
    detail: '换一个模型，或在“账号与订阅”里查看套餐。',
  },
  rate_limited: {
    title: '请求太频繁',
    detail: '同时进行的对话太多或请求太快，请稍等再试。',
  },
  account_disabled: {
    title: '账号已停用',
    detail: '无法使用官方模型。如有疑问请联系我们。',
  },
  model_token_invalid: {
    title: '官方模型连接已失效',
    detail: '这台电脑的官方模型令牌被移除了，重新连接即可。',
  },
};

/** What to do when the official model refused a request, in place of the raw error. */
export function OfficialModelNotice({
  problem,
  onChooseModel,
  onReconnect,
}: {
  problem: OfficialModelProblem;
  onChooseModel(): void;
  onReconnect(): void;
}) {
  const text = TEXT[problem];
  return (
    <div className="sf-official-notice">
      <strong>{t(text.title)}</strong>
      <p>{t(text.detail)}</p>
      <div>
        {problem === 'model_token_invalid' ? (
          <Button variant="ghost" size="sm" onClick={onReconnect}>
            {t('重新连接')}
          </Button>
        ) : null}
        {problem === 'quota_exhausted' || problem === 'model_not_in_plan' ? (
          <Button variant="ghost" size="sm" onClick={openAccountSettings}>
            {t('账号与订阅')}
          </Button>
        ) : null}
        {problem !== 'account_disabled' &&
        problem !== 'model_token_invalid' &&
        problem !== 'rate_limited' ? (
          <Button variant="ghost" size="sm" onClick={onChooseModel}>
            {problem === 'model_not_in_plan' ? t('换一个模型') : t('改用自己的密钥')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
