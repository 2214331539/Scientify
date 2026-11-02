import { t, translateError } from '../../i18n';

/** A mainland mobile number as the server expects it: 11 digits, no +86 or separators. */
export function normalizePhone(value: string): string {
  return value.replace(/[\s-]/g, '').replace(/^\+?86(?=1\d{10}$)/, '');
}

export function isPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(normalizePhone(value));
}

/** 138****5678: enough to recognise one's own number on a shared screen. */
export function maskPhone(phone: string): string {
  const digits = normalizePhone(phone);
  return /^\d{11}$/.test(digits) ? `${digits.slice(0, 3)}****${digits.slice(7)}` : phone;
}

/**
 * A collaboration failure as one sentence: the server's own message without
 * the HTTP wrapper, or a plain explanation when the service cannot answer.
 */
export function describeError(reason: unknown): string {
  const message = String(reason instanceof Error ? reason.message : (reason ?? ''));
  if (message.startsWith('协作服务器连接失败')) return t('无法连接协作服务，请检查网络后重试。');
  const failed = /^协作服务器请求失败（HTTP (\d{3})[^）]*）(?:：([\s\S]*)|。)?$/.exec(message);
  if (!failed) return translateError(message);
  const detail = failed[2]?.trim() ?? '';
  // Proxies answer with HTML pages; their text means nothing to people.
  if (detail && !detail.startsWith('<')) return translateError(detail);
  return failed[1] === '429'
    ? t('请求过于频繁，请稍后再试。')
    : t('协作服务暂时不可用，请稍后再试。');
}
