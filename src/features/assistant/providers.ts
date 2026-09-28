import type { AIProtocol } from '../../platform/research';
import type { AISettings } from './model';

/** Service branding is separate from the wire protocol. Models always come from the service. */
export const modelServices: {
  id: string;
  name: string;
  provider: AIProtocol;
  endpoints: { name: string; url: string }[];
}[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    endpoints: [{ name: '默认', url: 'https://api.openai.com/v1' }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    provider: 'anthropic',
    endpoints: [{ name: '默认', url: 'https://api.anthropic.com/v1' }],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    provider: 'gemini',
    endpoints: [{ name: '默认', url: 'https://generativelanguage.googleapis.com/v1beta' }],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'openai',
    endpoints: [{ name: '默认', url: 'https://api.deepseek.com/v1' }],
  },
  {
    id: 'qwen',
    name: '通义千问',
    provider: 'openai',
    endpoints: [
      { name: '中国内地', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { name: '国际', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot · Kimi',
    provider: 'openai',
    endpoints: [
      { name: '中国内地', url: 'https://api.moonshot.cn/v1' },
      { name: '国际', url: 'https://api.moonshot.ai/v1' },
    ],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    provider: 'openai',
    endpoints: [
      { name: '中国内地', url: 'https://api.siliconflow.cn/v1' },
      { name: '国际', url: 'https://api.siliconflow.com/v1' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    provider: 'openai',
    endpoints: [{ name: '默认', url: 'https://openrouter.ai/api/v1' }],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    provider: 'ollama',
    endpoints: [{ name: '本地', url: 'http://127.0.0.1:11434' }],
  },
  { id: 'custom', name: '自定义服务商', provider: 'openai', endpoints: [] },
];

export function serviceFor(value: AISettings) {
  return (
    modelServices.find((service) => service.id === value.serviceId) ??
    modelServices.find(
      (service) =>
        service.provider === value.provider &&
        service.endpoints.some(
          (endpoint) => endpoint.url.replace(/\/$/, '') === value.endpoint.replace(/\/$/, ''),
        ),
    ) ??
    modelServices[modelServices.length - 1]
  );
}
