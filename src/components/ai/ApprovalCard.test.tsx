import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalRequest } from '../../platform/agent';

afterEach(cleanup);

const request = (method: ApprovalRequest['method'], params: unknown): ApprovalRequest =>
  ({ kind: 'request', id: 'a1', method, params }) as ApprovalRequest;

describe('ApprovalCard', () => {
  it('shows the command and reports the decision the user picked', async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        event={request('item/commandExecution/requestApproval', {
          command: 'python train.py',
          cwd: 'D:/work/repo',
          reason: '需要网络访问',
        })}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByText('python train.py').textContent).toBe('python train.py');
    expect(screen.getByText('需要网络访问').textContent).toBe('需要网络访问');
    await userEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecide).toHaveBeenCalledWith('accept');
  });

  it('keeps cancelling the turn distinct from refusing one action', () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard event={request('item/fileChange/requestApproval', {})} onDecide={onDecide} />,
    );
    // Both actions must exist and must not collapse into one another.
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '中止任务' })).not.toBeNull();
  });

  it('survives a prompt with no command, path or reason', () => {
    render(
      <ApprovalCard event={request('item/fileChange/requestApproval', {})} onDecide={vi.fn()} />,
    );
    // The transport marks every field optional, so an empty prompt must still
    // render a usable card rather than throwing.
    expect(screen.queryByRole('group', { name: '请求修改文件' })).not.toBeNull();
  });

  it('offers the permission profile response for a permission request', async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        event={request('item/permissions/requestApproval', {
          reason: '需要读取数据目录',
          permissions: { fileSystem: { read: ['D:/data'] } },
        })}
        onDecide={onDecide}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '允许本次权限' }));
    expect(onDecide).toHaveBeenCalledWith('grantPermissions');
  });
});
