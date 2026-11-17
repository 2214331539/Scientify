import type { PermissionMode } from '../../platform/agent';

/** The four ways a chat may work, from most to least careful (shown through `t`). */
export const PERMISSIONS: { id: PermissionMode; name: string; detail: string }[] = [
  {
    id: 'readonly',
    name: '只读',
    detail: '只读文件、检索和回答；不改文件，也不执行会写入的命令。',
  },
  { id: 'ask', name: '询问', detail: '在沙箱里工作，可以联网；每条命令和每次改文件前都先问你。' },
  { id: 'auto', name: '自动', detail: '在项目的文件夹里自己改文件、运行命令；超出范围时才问你。' },
  { id: 'full', name: '完全访问', detail: '不用沙箱，可以访问工作区外的文件，不再询问。' },
];

export const permissionName = (mode: PermissionMode) =>
  PERMISSIONS.find((item) => item.id === mode)?.name ?? '询问';

export function asPermission(value: unknown): PermissionMode {
  return PERMISSIONS.some((item) => item.id === value) ? (value as PermissionMode) : 'ask';
}
