import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { t, translateError } from '../../i18n';
import type { Paper } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import { beginFileOperation } from '../../editor/sessions';
const str = (value: unknown) => (typeof value === 'string' ? value : '');
export function PaperForm({
  paper,
  isNew,
  store,
  backend,
  onClose,
  onSaved,
}: {
  paper: Paper;
  isNew: boolean;
  store: WorkspaceStore;
  backend: ResearchBackend;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState(paper),
    [dirty, setDirty] = useState(isNew),
    [attaching, setAttaching] = useState(false),
    [error, setError] = useState('');
  const busy = useStore(store, (s) => s.busy);
  useEffect(() => {
    store.getState().setDirtySource('paper-form', dirty);
    return () => store.getState().setDirtySource('paper-form', false);
  }, [dirty, store]);
  function field(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }
  return (
    <Modal
      title={isNew ? t('收录文献') : t('文献信息')}
      busy={busy || attaching}
      dirty={dirty}
      onClose={onClose}
    >
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.title.trim()) return;
          const ok = await store.getState().update((d) => {
            const value = {
              ...draft,
              title: draft.title.trim(),
              updatedAt: new Date().toISOString(),
            };
            if (isNew) d.papers.push(value);
            else {
              const index = d.papers.findIndex((p) => p.id === paper.id);
              if (index < 0) throw new Error(t('文献不存在'));
              d.papers[index] = value;
            }
          });
          if (ok) onSaved(draft.id);
          else setError(store.getState().error || t('保存失败，请重试。'));
        }}
      >
        <label>
          {t('文献标题')}
          <Input
            autoFocus
            required
            value={draft.title}
            disabled={busy}
            onChange={(e) => field('title', e.target.value)}
            maxLength={600}
          />
        </label>
        <label>
          {t('作者')}
          <Input
            value={str(draft.authors)}
            disabled={busy}
            onChange={(e) => field('authors', e.target.value)}
          />
        </label>
        <div className="form-pair">
          <label>
            {t('年份')}
            <Input
              value={str(draft.year)}
              disabled={busy}
              onChange={(e) => field('year', e.target.value)}
            />
          </label>
          <label>
            DOI
            <Input
              value={str(draft.doi)}
              disabled={busy}
              onChange={(e) => field('doi', e.target.value)}
            />
          </label>
        </div>
        <label>
          {t('摘要')}
          <Textarea
            rows={4}
            value={str(draft.abstract)}
            disabled={busy}
            onChange={(e) => field('abstract', e.target.value)}
          />
        </label>
        <label>
          {t('备注')}
          <Textarea
            rows={2}
            value={str(draft.note)}
            disabled={busy}
            onChange={(e) => field('note', e.target.value)}
          />
        </label>
        <div className="setting-row">
          <div>
            <h3>{t('本地 PDF')}</h3>
            <p>{str(draft.fileName) || t('尚未附加全文')}</p>
          </div>
          <Button
            type="button"
            disabled={busy || attaching}
            onClick={async () => {
              setAttaching(true);
              const finish = beginFileOperation(backend);
              try {
                const file = await backend.importPdf();
                if (file) {
                  setDraft((d) => ({ ...d, ...file }));
                  setDirty(true);
                }
              } catch (e) {
                setError(String(e));
              } finally {
                finish();
                setAttaching(false);
              }
            }}
          >
            {attaching ? t('正在导入…') : draft.assetId ? t('更换 PDF') : t('附加 PDF')}
          </Button>
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {translateError(error)}
          </p>
        ) : null}
        <footer className="dialog-footer">
          <span className="muted">{t('文件复制到本地资料目录')}</span>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || attaching || !draft.title.trim()}
          >
            {busy ? t('正在保存…') : isNew ? t('收录文献') : t('保存文献')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
