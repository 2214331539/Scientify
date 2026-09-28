import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button, Dropdown, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { AIModel, AIProtocol, ResearchBackend } from '../../platform/research';
import type { AISettings } from './model';
import { modelServices, serviceFor } from './providers';
import '../settings/settings.css';
import './model-settings.css';

interface Props {
  value: AISettings;
  apiKey: string;
  error: string;
  saving: boolean;
  requestBusy: boolean;
  backend: ResearchBackend;
  onChange(value: AISettings): void;
  onKeyChange(value: string): void;
  onSave(value: AISettings, key: string): Promise<void>;
  onClose(): void;
}

export function ModelSettingsDialog({
  value,
  apiKey,
  error,
  saving,
  requestBusy,
  backend,
  onChange,
  onKeyChange,
  onSave,
  onClose,
}: Props) {
  const service = serviceFor(value);
  const [models, setModels] = useState<AIModel[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'verifying'>('idle');
  const [failure, setFailure] = useState('');
  const [filter, setFilter] = useState('');
  const generation = useRef(0);
  const pending = useRef(false);
  const disabled = saving || requestBusy || phase === 'verifying';
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  function invalidate() {
    generation.current++;
    pending.current = false;
    setModels([]);
    setPhase('idle');
    setFailure('');
    setFilter('');
  }
  function changeConnection(next: AISettings) {
    invalidate();
    onChange({
      ...next,
      serviceId: next.serviceId ?? service.id,
      model: '',
      modelCatalog: undefined,
    });
  }
  function safeError(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    return apiKey.trim() ? message.split(apiKey.trim()).join(t('[已隐藏密钥]')) : message;
  }
  async function discover() {
    if (pending.current || disabled) return;
    if (!value.endpoint.trim() || (value.provider !== 'ollama' && !apiKey.trim())) {
      setFailure(t('请填写服务地址和 API 密钥。'));
      return;
    }
    const ticket = ++generation.current;
    pending.current = true;
    setModels([]);
    setFilter('');
    setFailure('');
    setPhase('loading');
    try {
      const found = await backend.listModels({
        endpoint: value.endpoint.trim(),
        provider: value.provider,
        apiKey: apiKey.trim() || undefined,
      });
      if (ticket !== generation.current) return;
      if (!found.length) throw new Error(t('服务未返回可选的聊天模型。'));
      setModels(found);
      onChange({
        ...value,
        model: found.some((m) => m.id === value.model) ? value.model : found[0].id,
      });
      setPhase('ready');
    } catch (reason) {
      if (ticket !== generation.current) return;
      setFailure(safeError(reason));
      setPhase('idle');
    } finally {
      if (ticket === generation.current) pending.current = false;
    }
  }
  async function save() {
    if (
      disabled ||
      pending.current ||
      phase !== 'ready' ||
      !models.some((m) => m.id === value.model)
    )
      return;
    pending.current = true;
    setPhase('verifying');
    setFailure('');
    const ticket = ++generation.current;
    try {
      await backend.testModel({
        endpoint: value.endpoint.trim(),
        provider: value.provider,
        apiKey: apiKey.trim() || undefined,
        model: value.model,
      });
      if (ticket !== generation.current) return;
      await onSave(
        { ...value, serviceId: service.id, modelCatalog: models.map((m) => m.id) },
        apiKey.trim(),
      );
    } catch (reason) {
      if (ticket === generation.current) setFailure(safeError(reason));
    } finally {
      if (ticket === generation.current) {
        pending.current = false;
        setPhase('ready');
      }
    }
  }
  const filtered = models.filter(
    (m) =>
      m.id === value.model || (m.id + ' ' + m.name).toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Modal
      title={t('模型设置')}
      heading={t('模型配置')}
      className="settings-dialog sf-model-settings-dialog"
      busy={saving || phase === 'verifying'}
      onClose={onClose}
      sidebar={
        <nav className="settings-navigation" aria-label={t('模型设置导航')}>
          <div className="settings-title">{t('模型设置')}</div>
          <Button type="button" variant="ghost" aria-current="page">
            <Settings2 size={15} aria-hidden="true" />
            <span>{t('模型配置')}</span>
          </Button>
          <span className="settings-brand">Scientify</span>
        </nav>
      }
    >
      <form
        className="sf-model-settings-form"
        aria-busy={phase === 'loading' || phase === 'verifying' || saving}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="settings-scroll">
          <section aria-label={t('服务连接')}>
            <h3 className="settings-section-heading">{t('服务连接')}</h3>
            <div className="sf-model-settings-fields">
              <label className="sf-model-settings-row">
                <span>{t('模型提供方')}</span>
                <Dropdown
                  value={service.id}
                  disabled={disabled}
                  onChange={(event) => {
                    const item = modelServices.find((entry) => entry.id === event.target.value);
                    if (!item || item.id === service.id) return;
                    onKeyChange('');
                    changeConnection({
                      provider: item.provider,
                      serviceId: item.id,
                      endpoint: item.endpoints[0]?.url ?? '',
                      model: '',
                    });
                  }}
                >
                  {modelServices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(item.name)}
                    </option>
                  ))}
                </Dropdown>
              </label>
              {service.id === 'custom' && (
                <label className="sf-model-settings-row">
                  <span>{t('接口协议')}</span>
                  <Dropdown
                    value={value.provider}
                    disabled={disabled}
                    onChange={(event) => {
                      onKeyChange('');
                      changeConnection({ ...value, provider: event.target.value as AIProtocol });
                    }}
                  >
                    <option value="openai">OpenAI Compatible</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="ollama">Ollama</option>
                  </Dropdown>
                </label>
              )}
              {service.endpoints.length > 1 && (
                <label className="sf-model-settings-row">
                  <span>{t('服务区域')}</span>
                  <Dropdown
                    value={
                      service.endpoints.some((e) => e.url === value.endpoint) ? value.endpoint : ''
                    }
                    disabled={disabled}
                    onChange={(event) => {
                      onKeyChange('');
                      changeConnection({ ...value, endpoint: event.target.value });
                    }}
                  >
                    {!service.endpoints.some((e) => e.url === value.endpoint) && (
                      <option value="" disabled>
                        {t('自定义地址')}
                      </option>
                    )}
                    {service.endpoints.map((e) => (
                      <option key={e.url} value={e.url}>
                        {t(e.name)}
                      </option>
                    ))}
                  </Dropdown>
                </label>
              )}
              <label className="sf-model-settings-row">
                <span>{t('服务地址')}</span>
                <Input
                  type="url"
                  required
                  spellCheck={false}
                  disabled={disabled}
                  value={value.endpoint}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => {
                    onKeyChange('');
                    changeConnection({ ...value, endpoint: event.target.value });
                  }}
                />
              </label>
              <label className="sf-model-settings-row">
                <span>
                  {t('API 密钥')}
                  {value.provider === 'ollama' ? ' · ' + t('可选') : ''}
                </span>
                <Input
                  aria-label={t('API 密钥')}
                  type="password"
                  autoComplete="off"
                  disabled={disabled}
                  value={apiKey}
                  onChange={(event) => {
                    invalidate();
                    onKeyChange(event.target.value);
                  }}
                  placeholder={t('仅在本次应用会话中使用')}
                />
              </label>
            </div>
            <div className="sf-model-discovery-actions">
              <Button
                type="button"
                disabled={disabled || phase === 'loading'}
                onClick={() => void discover()}
              >
                {phase === 'loading' ? (
                  <LoaderCircle size={14} className="sf-model-spinner" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {phase === 'loading' ? t('正在获取模型…') : t('测试连接')}
              </Button>
              <span role="status" className="sf-model-status">
                {phase === 'ready' ? (
                  <>
                    <Check size={14} />
                    {t('已获取 {count} 个模型', { count: models.length })}
                  </>
                ) : phase === 'verifying' ? (
                  t('正在验证聊天模型…')
                ) : null}
              </span>
            </div>
            <p className="settings-note">{t('只保存地址和模型名称。密钥不写入工作区。')}</p>
          </section>
          <section aria-label={t('聊天模型')}>
            <h3 className="settings-section-heading">{t('聊天模型')}</h3>
            <div className="sf-model-settings-fields">
              {models.length > 12 && (
                <label className="sf-model-settings-row">
                  <span>{t('筛选模型')}</span>
                  <Input
                    type="search"
                    value={filter}
                    disabled={disabled}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
              )}
              <label className="sf-model-settings-row">
                <span>{t('选择模型')}</span>
                <Dropdown
                  value={models.length ? value.model : ''}
                  disabled={disabled || !models.length}
                  onChange={(event) => {
                    onChange({ ...value, model: event.target.value });
                    setFailure('');
                  }}
                >
                  {!models.length && <option value="">{t('测试连接后选择模型')}</option>}
                  {filtered.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name === m.id ? m.id : m.name + ' · ' + m.id}
                    </option>
                  ))}
                </Dropdown>
              </label>
            </div>
            <p className="settings-note">
              {t('保存时发送一条简短测试消息，确认模型可用；不发送研究材料。')}
            </p>
          </section>
          {(failure || error) && (
            <p role="alert" className="sf-model-settings-error">
              {translateError(failure || error)}
            </p>
          )}
        </div>
        <footer className="settings-actions sf-model-settings-actions">
          <p className="settings-note">{t('保存后返回对话，聊天草稿会保留。')}</p>
          <div className="button-row">
            <Button type="button" disabled={saving || phase === 'verifying'} onClick={onClose}>
              {t('取消')}
            </Button>
            <Button type="submit" variant="primary" disabled={disabled || phase !== 'ready'}>
              {saving ? t('正在保存…') : phase === 'verifying' ? t('正在验证…') : t('保存模型配置')}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
