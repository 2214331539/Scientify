import { t } from '../i18n';
import { Button } from './primitives';
import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Modal({
  title,
  children,
  onClose,
  busy = false,
  dirty = false,
  className,
  sidebar,
  heading,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  dirty?: boolean;
  className?: string;
  sidebar?: ReactNode;
  heading?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  function close() {
    if (!busy && (!dirty || window.confirm(t('放弃尚未保存的修改？')))) onClose();
  }
  const content = (
    <>
      <header className="dialog-heading">
        <h2 id={id}>{heading ?? title}</h2>
        <Button
          type="button"
          variant="ghost"
          iconOnly
          className="icon-button"
          onClick={close}
          disabled={busy}
          aria-label={t('关闭弹窗')}
        >
          ×
        </Button>
      </header>
      {children}
    </>
  );
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={sidebar ? title : undefined}
      aria-labelledby={sidebar ? undefined : id}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      {sidebar ? (
        <>
          {sidebar}
          <div className="modal-main">{content}</div>
        </>
      ) : (
        content
      )}
    </dialog>
  );
}
