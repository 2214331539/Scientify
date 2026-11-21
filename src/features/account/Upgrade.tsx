import { useEffect, useState } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { Check, LoaderCircle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import { collaboration } from '../../platform/collaboration';
import { describeError } from './account';
import './upgrade.css';

/** Which model asked for the upgrade card, if any; null while it is closed. */
const upgradeStore = createStore<{ open: boolean; model: string }>(() => ({ open: false, model: '' }));

/** Opens the upgrade card, from the model list or a "plan does not include" notice. */
export function openUpgrade(model = '') {
  upgradeStore.setState({ open: true, model });
}

const features = ['每月 3,000 点，开放全部官方模型', '50 GB 同步空间', '团队项目每个最多 20 人', '电子普通发票'];

/** Mounted once in the app: the plan card, then the WeChat group QR code to upgrade by hand. */
export function UpgradeHost() {
  const { open, model } = useStore(upgradeStore);
  const [step, setStep] = useState<'plan' | 'contact'>('plan');
  const [qr, setQr] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setStep('plan');
      setQr(undefined);
      setError('');
    }
  }, [open]);
  if (!open) return null;
  const close = () => upgradeStore.setState({ open: false, model: '' });
  async function contact() {
    setStep('contact');
    try {
      setQr((await collaboration.contact()).wechatQr);
    } catch (reason) {
      setQr(null);
      setError(describeError(reason));
    }
  }
  return (
    <Modal
      title={step === 'plan' ? t('升级到专业版') : t('加入微信群开通')}
      className="sf-upgrade-dialog"
      onClose={close}
    >
      {step === 'plan' ? (
        <div className="sf-upgrade">
          <p className="sf-upgrade-lead">
            {model
              ? t('{model} 需要个人专业版。', { model })
              : t('个人专业版开放全部官方模型。')}
          </p>
          <div className="sf-upgrade-plan">
            <div className="sf-upgrade-price">
              <strong>{t('个人专业版')}</strong>
              <span>
                ¥29 <small>{t('/ 月')}</small>
              </span>
              <small>{t('按年 ¥288')}</small>
            </div>
            <ul>
              {features.map((item) => (
                <li key={item}>
                  <Check size={14} />
                  {t(item)}
                </li>
              ))}
            </ul>
          </div>
          <p className="sf-upgrade-note">
            {t('目前不支持在线支付。加入微信群说明手机号，我们在后台为你开通，开通后重新选择模型即可。')}
          </p>
          <footer>
            <Button onClick={close}>{t('暂不升级')}</Button>
            <Button variant="primary" onClick={() => void contact()}>
              {t('加入微信群开通')}
            </Button>
          </footer>
        </div>
      ) : (
        <div className="sf-upgrade sf-upgrade-contact">
          {qr === undefined ? (
            <div className="sf-upgrade-qr is-loading">
              <LoaderCircle className="is-spinning" />
            </div>
          ) : qr ? (
            <img className="sf-upgrade-qr" src={qr} alt={t('微信群二维码')} />
          ) : (
            <div className="sf-upgrade-qr is-empty">{t('二维码暂时不可用')}</div>
          )}
          <p className="sf-upgrade-note">
            {qr
              ? t('用微信扫码加入，发送手机号和想开通的套餐。')
              : t('请发邮件到 2214331539@qq.com，写明手机号和想开通的套餐。')}
          </p>
          {error ? <p className="sf-upgrade-error">{error}</p> : null}
          <footer>
            <Button onClick={() => setStep('plan')}>{t('返回')}</Button>
            <Button variant="primary" onClick={close}>
              {t('完成')}
            </Button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
