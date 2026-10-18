import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Settings2, Plus, Trash2 } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button, Dropdown, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { AIModel, AIProtocol, ResearchBackend } from '../../platform/research';
import type { AISettings } from './model';
import type { ModelProfile } from '../../domain/workspace';
import { modelServices, serviceFor } from './providers';
import '../settings/settings.css';
import './model-settings.css';

interface Props {
  profiles: ModelProfile[];
  profileId: string;
  profileName: string;
  onNameChange(value: string): void;
  onProfileChange(profile: ModelProfile | null): Promise<void>;
  onDeleteProfile(id: string): Promise<void>;
  value: AISettings;
  apiKey: string;
  /** True when `apiKey` came back from this machine rather than from typing. */
  keyStored: boolean;
  error: string;
  saving: boolean;
  requestBusy: boolean;
  backend: ResearchBackend;
  loadKey(value: AISettings): Promise<string>;
  onChange(value: AISettings): void;
  onKeyChange(value: string): void;
  onSave(value: AISettings, key: string): Promise<void>;
  onClose(): void;
}

export function ModelSettingsDialog({
  profiles,
  profileId,
  profileName,
  onNameChange,
  onProfileChange,
  onDeleteProfile,
  value,
  apiKey,
  keyStored,
  error,
  saving,
  requestBusy,
  backend,
  loadKey,
  onChange,
  onKeyChange,
  onSave,
  onClose,
}: Props) {
  const service = serviceFor(value);
  const [models, setModels] = useState<AIModel[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'verifying'>('idle');
  const [failure, setFailure] = useState('');
  const [capability, setCapability] = useState(value.verification);
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  // A key we already hold for the chosen provider must come back into the field
  // instead of asking the user to type it again.
  const [recalled, setRecalled] = useState(keyStored);
  const keyTicket = useRef(0);
  const disabled = saving || requestBusy || phase === 'verifying';
  useEffect(
    () => () => {
      generation.current++;
      keyTicket.current++;
    },
    [],
  );
  useEffect(() => {
    invalidate();
    setCapability(value.verification);
  }, [profileId]);

  function invalidate() {
    generation.current++;
    keyTicket.current++;
    pending.current = false;
    setModels([]);
    setPhase('idle');
    setFailure('');
    setFilter('');
    setCapability(undefined);
  }
  function changeConnection(next: AISettings) {
    invalidate();
    onChange({
      ...next,
      serviceId: next.serviceId ?? service.id,
      model: '',
      modelCatalog: undefined,
      verification: undefined,
    });
  }
  async function recallKey(next: AISettings) {
    const ticket = ++keyTicket.current;
    setRecalled(false);
    onKeyChange('');
    if (!next.endpoint.trim()) return;
    let stored: string;
    try {
      stored = await loadKey(next);
    } catch (reason) {
      if (ticket === keyTicket.current) setFailure(safeError(reason));
      return;
    }
    // Anything typed while the read was in flight wins.
    if (ticket !== keyTicket.current || !stored) return;
    setRecalled(true);
    onKeyChange(stored);
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
      (!manual && phase !== 'ready') ||
      (!manual && !models.some((m) => m.id === value.model)) ||
      !value.model.trim()
    )
      return;
    pending.current = true;
    setPhase('verifying');
    setFailure('');
    const ticket = ++generation.current;
    try {
      const request = {
        endpoint: value.endpoint.trim(),
        provider: value.provider,
        apiKey: apiKey.trim() || undefined,
        model: value.model.trim(),
      };
      const verified = backend.verifyModel
        ? await backend.verifyModel(request)
        : await backend.testModel(request).then(() => ({
            chat: true,
            agent: false,
            agentError: undefined,
            chatError: undefined,
          }));
      if (!verified.chat && !verified.agent)
        throw new Error(
          [verified.chatError, verified.agentError].filter(Boolean).join('\n') ||
            t('模型验证失败。'),
        );
      const verification = {
        model: request.model,
        checkedAt: new Date().toISOString(),
        ...verified,
      };
      setCapability(verification);
      if (ticket !== generation.current) return;
      await onSave(
        {
          ...value,
          model: request.model,
          serviceId: service.id,
          modelCatalog: models.length ? models.map((m) => m.id) : [request.model],
          verification: backend.verifyModel ? verification : undefined,
        },
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
          <div className="sf-model-profile-list">
            {profiles.map((profile) => (
              <Button
                key={profile.id}
                type="button"
                variant="ghost"
                aria-pressed={profileId === profile.id}
                disabled={disabled}
                onClick={() => {
                  keyTicket.current++;
                  void onProfileChange(profile);
                }}
              >
                <span>{profile.name}</span>
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              keyTicket.current++;
              void onProfileChange(null);
            }}
          >
            <Plus size={15} />
            <span>{t('新连接')}</span>
          </Button>
          {profiles.some((profile) => profile.id === profileId) ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => void onDeleteProfile(profileId)}
            >
              <Trash2 size={15} />
              <span>{t('删除连接')}</span>
            </Button>
          ) : null}
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
                <span>{t('连接名称')}</span>
                <Input
                  value={profileName}
                  disabled={disabled}
                  maxLength={80}
                  onChange={(event) => onNameChange(event.target.value)}
                />
              </label>
              <label className="sf-model-settings-row">
                <span>{t('模型提供方')}</span>
                <Dropdown
                  value={service.id}
                  disabled={disabled}
                  onChange={(event) => {
                    const item = modelServices.find((entry) => entry.id === event.target.value);
                    if (!item || item.id === service.id) return;
                    const next = {
                      provider: item.provider,
                      serviceId: item.id,
                      endpoint: item.endpoints[0]?.url ?? '',
                      model: '',
                    };
                    changeConnection(next);
                    void recallKey(next);
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
                      const next = { ...value, provider: event.target.value as AIProtocol };
                      changeConnection(next);
                      void recallKey(next);
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
                      const next = { ...value, endpoint: event.target.value };
                      changeConnection(next);
                      void recallKey(next);
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
                    setRecalled(false);
                    invalidate();
                    onKeyChange(event.target.value);
                  }}
                  placeholder={t('保存在本机数据目录，下次自动填入')}
                />
                {recalled ? (
                  <span className="sf-model-key-hint" role="status">
                    {t('已读取本机保存的密钥。')}
                  </span>
                ) : null}
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
                  t('正在验证聊天与 Agent…')
                ) : null}
              </span>
            </div>
            {capability ? (
              <div className="sf-model-capabilities" role="status">
                <span>{capability.chat ? t('聊天验证通过') : t('聊天接口不可用')}</span>
                <span>
                  {capability.agent ? t('Agent 工具验证通过') : t('仅聊天，Agent 未通过验证')}
                </span>
                {!capability.agent && capability.agentError ? (
                  <p>{translateError(capability.agentError)}</p>
                ) : null}
              </div>
            ) : null}
            <p className="settings-note">
              {t('地址和模型名称写入工作区配置；密钥只保存在本机数据目录，不随项目同步。')}
            </p>
          </section>
          <section aria-label={t('聊天模型')}>
            <h3 className="settings-section-heading">{t('聊天模型')}</h3>
            <label className="sf-model-manual">
              <input
                type="checkbox"
                checked={manual}
                disabled={disabled}
                onChange={(event) => {
                  setManual(event.target.checked);
                  setFailure('');
                }}
              />
              <span>{t('手动填写模型 ID')}</span>
            </label>
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
              {manual ? (
                <label className="sf-model-settings-row">
                  <span>{t('模型 ID')}</span>
                  <Input
                    value={value.model}
                    required
                    maxLength={256}
                    disabled={disabled}
                    onChange={(event) => {
                      onChange({ ...value, model: event.target.value, verification: undefined });
                      setCapability(undefined);
                    }}
                  />
                </label>
              ) : (
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
              )}
            </div>
            <p className="settings-note">
              {t('保存时验证聊天及 Agent 工具回传；只发送测试内容。')}
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
            <Button
              type="submit"
              variant="primary"
              disabled={
                disabled ||
                phase === 'loading' ||
                !value.endpoint.trim() ||
                !value.model.trim() ||
                (!manual && phase !== 'ready')
              }
            >
              {saving ? t('正在保存…') : phase === 'verifying' ? t('正在验证…') : t('保存模型配置')}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
