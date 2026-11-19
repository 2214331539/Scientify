import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteWorkspace } from './RemoteWorkspace';
import type { RemoteApi, RemoteEntry } from '../../platform/remote';

vi.mock('../../components/prompts', () => ({
  confirmAction: vi.fn(async () => true),
  requestText: vi.fn(async () => 'results'),
}));

const project = { id: 'p', name: 'Study', question: '', createdAt: '', space: 'personal' };
const entry = (path: string, kind: 'file' | 'directory'): RemoteEntry => ({
  name: path.split('/').at(-1)!,
  path,
  kind,
  link: false,
  size: 10,
  modified: 0,
});
const tree: Record<string, RemoteEntry[]> = {
  '/home/pp': [entry('/home/pp/src', 'directory'), entry('/home/pp/train.py', 'file')],
  '/home/pp/src': [entry('/home/pp/src/model.py', 'file')],
  '/data': [entry('/data/raw', 'directory')],
};

function fakeApi() {
  const api = {
    hosts: vi.fn(async () => [{ alias: 'gpu', hostName: '10.0.0.5', user: 'alice', port: '22' }]),
    connect: vi.fn(async (target: string, password?: string) => {
      if (target === 'pp@lab' && !password)
        throw new Error('AUTH:pp@lab: Permission denied (publickey,password).');
      return { id: 'c1', target, home: '/home/pp' };
    }),
    disconnect: vi.fn(async () => {}),
    list: vi.fn(async (_id: string, path: string) => tree[path] ?? []),
    resolve: vi.fn(async (_id: string, path: string) => path.replace(/\/$/, '') || '/'),
    read: vi.fn(async (_id: string, path: string) => ({
      path,
      content: `# ${path}\nprint('hi')\n`,
      version: '1:20',
    })),
    write: vi.fn(async (_id: string, path: string, content: string) => ({
      path,
      content,
      version: '2:30',
    })),
    create: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    terminal: vi.fn(),
  };
  return api as unknown as RemoteApi & typeof api;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('asks for a password when the key is refused, then shows the host folder', async () => {
  const user = userEvent.setup();
  const api = fakeApi();
  render(<RemoteWorkspace project={project} onContext={vi.fn()} api={api} />);
  // Hosts from the SSH config are one click away.
  expect(await screen.findAllByRole('button', { name: /gpu/ })).not.toHaveLength(0);
  await user.type(screen.getByRole('textbox', { name: '主机' }), 'pp@lab{Enter}');
  const password = await screen.findByLabelText('密码');
  await user.type(password, 'secret{Enter}');
  await waitFor(() => expect(api.connect).toHaveBeenLastCalledWith('pp@lab', 'secret'));
  const files = await screen.findByRole('tree', { name: '云主机文件' });
  expect(within(files).getByText('src')).toBeTruthy();
  expect(within(files).getByText('train.py')).toBeTruthy();
  expect(screen.getByText('SSH: pp@lab')).toBeTruthy();
  // The host and folder are remembered for next time.
  expect(JSON.parse(localStorage.getItem('scientify.remote.recent')!)[0]).toEqual({
    target: 'pp@lab',
    folder: '/home/pp',
  });
});

it('expands folders on demand, opens files and creates folders where selected', async () => {
  const user = userEvent.setup();
  const api = fakeApi();
  render(<RemoteWorkspace project={{ ...project, id: 'p2' }} onContext={vi.fn()} api={api} />);
  const [gpu] = await screen.findAllByRole('button', { name: /gpu/ });
  await user.click(gpu);
  const files = await screen.findByRole('tree', { name: '云主机文件' });
  expect(api.list).toHaveBeenCalledTimes(1);
  await user.click(within(files).getByText('src'));
  expect(await within(files).findByText('model.py')).toBeTruthy();
  expect(api.list).toHaveBeenCalledWith('c1', '/home/pp/src');
  await user.click(within(files).getByText('model.py'));
  expect(await screen.findByRole('tab', { name: /model\.py/ })).toBeTruthy();
  await waitFor(() => expect(api.read).toHaveBeenCalledWith('c1', '/home/pp/src/model.py'));
  // A new folder goes into the selected file's folder.
  await user.click(screen.getByRole('button', { name: '新建文件夹' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledWith('c1', '/home/pp/src/results', true));
});

it('opens another folder on the host from the folder picker', async () => {
  const user = userEvent.setup();
  const api = fakeApi();
  render(<RemoteWorkspace project={{ ...project, id: 'p3' }} onContext={vi.fn()} api={api} />);
  const [gpu] = await screen.findAllByRole('button', { name: /gpu/ });
  await user.click(gpu);
  await screen.findByRole('tree', { name: '云主机文件' });
  await user.click(screen.getByRole('button', { name: '打开文件夹' }));
  const path = await screen.findByRole('textbox', { name: '文件夹路径' });
  await user.clear(path);
  await user.type(path, '/data{Enter}');
  expect(await screen.findByRole('button', { name: /raw/ })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '打开' }));
  const files = await screen.findByRole('tree', { name: '云主机文件' });
  expect(await within(files).findByText('raw')).toBeTruthy();
});

it('goes back to connecting when the line drops', async () => {
  const user = userEvent.setup();
  const api = fakeApi();
  render(<RemoteWorkspace project={{ ...project, id: 'p4' }} onContext={vi.fn()} api={api} />);
  const [gpu] = await screen.findAllByRole('button', { name: /gpu/ });
  await user.click(gpu);
  const files = await screen.findByRole('tree', { name: '云主机文件' });
  vi.mocked(api.list).mockRejectedValueOnce(new Error('DISCONNECTED:连接已断开，请重新连接。'));
  await user.click(within(files).getByText('src'));
  expect(await screen.findByText('连接已断开，请重新连接。')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '主机' }) as HTMLInputElement).value).toBe('gpu');
});
