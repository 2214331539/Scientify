import { t } from '../../i18n';

/** One wording for experiment records, recorded runs and environment tasks. */
const labels = new Map([
  ['planned', '计划中'],
  ['running', '运行中'],
  ['completed', '已完成'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
  ['interrupted', '已中断'],
]);

/** States a manual experiment record can be given by hand. */
export const MANUAL_STATUSES: readonly string[] = ['planned', 'running', 'completed', 'failed'];

/** The localized label for a status; values from older records are shown as stored. */
export const statusLabel = (status: string) => t(labels.get(status) ?? status);
