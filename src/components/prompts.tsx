import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from './Modal';
import { Button, Input } from './primitives';
import { t } from '../i18n';
import { usePreferences } from '../i18n/preferences';

const pending = new Map<string, Promise<string | null>>();

/** The same dialog and focus contract as forms, including native browser overlays. */
function promptDialog(message: string, initial?: string): Promise<string | null> {
  const key = JSON.stringify([message, initial]);
  const existing = pending.get(key);
  if (existing) return existing;
  const result = new Promise<string | null>((resolve) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      queueMicrotask(() => {
        root.unmount();
        container.remove();
        pending.delete(key);
        resolve(value);
      });
    };
    function Prompt() {
      usePreferences();
      const [value, setValue] = useState(initial ?? '');
      return (
        <Modal title={initial === undefined ? t('确认操作') : message} onClose={() => finish(null)}>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              finish(initial === undefined ? 'confirmed' : value);
            }}
          >
            {initial === undefined ? (
              <p>{message}</p>
            ) : (
              <label>
                {message}
                <Input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
              </label>
            )}
            <footer className="dialog-footer">
              <Button type="button" autoFocus={initial === undefined} onClick={() => finish(null)}>
                {t('取消')}
              </Button>
              <Button type="submit" variant="primary">
                {t('确认')}
              </Button>
            </footer>
          </form>
        </Modal>
      );
    }
    root.render(<Prompt />);
  });
  pending.set(key, result);
  return result;
}

export async function confirmAction(message: string): Promise<boolean> {
  return (await promptDialog(message)) !== null;
}
export const requestText = (message: string, initial: string) => promptDialog(message, initial);
