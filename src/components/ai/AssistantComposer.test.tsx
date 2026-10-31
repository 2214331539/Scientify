import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantComposer } from './AssistantComposer';
import { useState } from 'react';
import type { AgentSkillRef } from '../../platform/agent';

afterEach(cleanup);

it('keeps local stop and context commands usable when message submission is temporarily blocked', () => {
  const onCommand = vi.fn();
  const props = {
    prompt: '/stop',
    disabled: true,
    isBusy: true,
    canInterrupt: true,
    model: 'fixture',
    endpoint: 'local',
    onPromptChange: vi.fn(),
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onModelMenu: vi.fn(),
    modelMenuOpen: false,
    onCommand,
  };
  const view = render(<AssistantComposer {...props} />);
  fireEvent.keyDown(screen.getByLabelText('向 AI 提问'), { key: 'Enter' });
  expect(onCommand).toHaveBeenCalledWith('stop');
  view.rerender(<AssistantComposer {...props} prompt="/context" />);
  fireEvent.keyDown(screen.getByLabelText('向 AI 提问'), { key: 'Enter' });
  expect(onCommand).toHaveBeenCalledWith('context');
  expect(props.onSend).not.toHaveBeenCalled();
});

it('uses keyboard slash commands locally, respects IME and Escape, and sends ordinary paths unchanged', () => {
  const onSend = vi.fn();
  const onPermissionMenu = vi.fn();
  function Fixture() {
    const [prompt, setPrompt] = useState('');
    return (
      <AssistantComposer
        prompt={prompt}
        onPromptChange={setPrompt}
        disabled={false}
        isBusy={false}
        canInterrupt={false}
        model="fixture"
        endpoint="local"
        onSend={onSend}
        onInterrupt={vi.fn()}
        onModelMenu={vi.fn()}
        modelMenuOpen={false}
        onPermissionMenu={onPermissionMenu}
      />
    );
  }
  render(<Fixture />);
  const input = screen.getByLabelText('向 AI 提问');
  fireEvent.change(input, { target: { value: '/permission' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onPermissionMenu).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onPermissionMenu).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '/' } });
  expect(screen.getByRole('listbox', { name: '快捷命令' })).toBeTruthy();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: /\/skills/ }).getAttribute('aria-selected')).toBe(
    'true',
  );
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.change(input, { target: { value: '/Users/project/readme.md' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
  expect((input as HTMLTextAreaElement).value).toBe('/Users/project/readme.md');
  fireEvent.change(input, { target: { value: '/new draft text' } });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect((input as HTMLTextAreaElement).value).toBe('/new draft text');
  expect(onSend).toHaveBeenCalledTimes(2);
  fireEvent.change(input, { target: { value: '/' } });
  expect(screen.getByRole('listbox')).toBeTruthy();
});

it('selects real skills for the next message without steering them into the active task', () => {
  const onSkillsOpen = vi.fn();
  const onSend = vi.fn();
  const onSteer = vi.fn();
  function Fixture() {
    const [prompt, setPrompt] = useState('/skills ');
    const [skills, setSkills] = useState<AgentSkillRef[]>([]);
    return (
      <AssistantComposer
        prompt={prompt}
        onPromptChange={setPrompt}
        disabled={false}
        isBusy
        canInterrupt
        canSteer
        model="fixture"
        endpoint="local"
        onSend={onSend}
        onSteer={onSteer}
        onInterrupt={vi.fn()}
        onModelMenu={vi.fn()}
        modelMenuOpen={false}
        skillsAvailable
        onSkillsOpen={onSkillsOpen}
        skills={[
          {
            name: 'paper-review',
            path: 'F:/papers/.agents/skills/review/SKILL.md',
            description: 'Review papers',
            enabled: true,
          },
        ]}
        selectedSkills={skills}
        onSelectSkill={(skill) => setSkills([...skills, skill])}
        onRemoveSkill={() => setSkills([])}
      />
    );
  }
  render(<Fixture />);
  const input = screen.getByLabelText('向 AI 提问');
  expect(onSkillsOpen).toHaveBeenCalledOnce();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByLabelText('待发送技能').textContent).toContain('paper-review');
  fireEvent.change(input, { target: { value: 'Review the method' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSteer).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '移除技能 paper-review' }));
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSteer).toHaveBeenCalledOnce();
});

it('keeps image drafts for the next message while allowing stop and text-only steering', () => {
  const onSteer = vi.fn();
  const onInterrupt = vi.fn();
  const props = {
    prompt: '查看图片',
    disabled: false,
    isBusy: true,
    canInterrupt: true,
    canSteer: true,
    model: 'fixture',
    endpoint: 'http://localhost',
    modelMenuOpen: false,
    onPromptChange: vi.fn(),
    onSend: vi.fn(),
    onSteer,
    onInterrupt,
    onModelMenu: vi.fn(),
  };
  const view = render(
    <AssistantComposer
      {...props}
      attachments={[{ name: 'image.png', mimeType: 'image/png', data: 'fixture' }]}
    />,
  );
  const input = screen.getByRole('textbox', { name: '向 AI 提问' }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(false);
  expect(screen.queryByRole('button', { name: '补充指令' })).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSteer).not.toHaveBeenCalled();
  expect(input.value).toBe('查看图片');
  fireEvent.click(screen.getByRole('button', { name: '中止任务' }));
  expect(onInterrupt).toHaveBeenCalledOnce();
  view.rerender(<AssistantComposer {...props} attachments={[]} />);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSteer).toHaveBeenCalledOnce();
});
