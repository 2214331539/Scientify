import { useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Columns2,
  Grid2x2X,
  PaintBucket,
  PanelLeft,
  PanelTop,
  Rows2,
  TableCellsMerge,
  TableCellsSplit,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
} from 'lucide-react';
import { t } from '../../../i18n';

type Chain = ReturnType<Editor['chain']>;

/** The table around the cursor, for the toolbar to sit on. */
function tableElement(editor: Editor) {
  const { node } = editor.view.domAtPos(editor.state.selection.from);
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest('.tableWrapper, table') ?? null;
}

/** The current cell's attribute, to show which colour and alignment are set. */
function cellAttribute(editor: Editor, name: string) {
  return (
    editor.getAttributes('tableCell')[name] ?? editor.getAttributes('tableHeader')[name] ?? null
  );
}

/**
 * Above a table while the cursor is in it, as in Feishu: insert and delete
 * rows and columns, merge and split, header row and column, cell colour and
 * alignment, delete the table.
 */
export function TableToolbar({
  editor,
  backgrounds,
}: {
  editor: Editor;
  backgrounds: [string, string | null][];
}) {
  const [colours, setColours] = useState(false);
  const run = (step: (chain: Chain) => Chain) => step(editor.chain().focus()).run();
  const button = (
    label: string,
    icon: ReactNode,
    step: (chain: Chain) => Chain,
    options: { disabled?: boolean; pressed?: boolean; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      title={t(label)}
      aria-label={t(label)}
      aria-pressed={options.pressed}
      disabled={options.disabled}
      className={options.danger ? 'doc-toolbar-danger' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => run(step)}
    >
      {icon}
    </button>
  );
  const align = cellAttribute(editor, 'align');
  const background = cellAttribute(editor, 'background');
  const can = editor.can();
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableToolbar"
      className="doc-toolbar doc-table-toolbar"
      shouldShow={({ editor: current }) => current.isEditable && current.isActive('table')}
      getReferencedVirtualElement={() => {
        const table = tableElement(editor);
        return table
          ? {
              getBoundingClientRect: () => table.getBoundingClientRect(),
              getClientRects: () => table.getClientRects(),
            }
          : null;
      }}
      options={{ placement: 'top-start', offset: 6 }}
    >
      {button('上方插入行', <BetweenHorizontalStart size={15} />, (c) => c.addRowBefore())}
      {button('下方插入行', <BetweenHorizontalEnd size={15} />, (c) => c.addRowAfter())}
      {button('左侧插入列', <BetweenVerticalStart size={15} />, (c) => c.addColumnBefore())}
      {button('右侧插入列', <BetweenVerticalEnd size={15} />, (c) => c.addColumnAfter())}
      <span className="doc-toolbar-sep" />
      {button('删除行', <Rows2 size={15} />, (c) => c.deleteRow())}
      {button('删除列', <Columns2 size={15} />, (c) => c.deleteColumn())}
      <span className="doc-toolbar-sep" />
      {button('合并单元格', <TableCellsMerge size={15} />, (c) => c.mergeCells(), {
        disabled: !can.mergeCells(),
      })}
      {button('拆分单元格', <TableCellsSplit size={15} />, (c) => c.splitCell(), {
        disabled: !can.splitCell(),
      })}
      {button('表头行', <PanelTop size={15} />, (c) => c.toggleHeaderRow())}
      {button('表头列', <PanelLeft size={15} />, (c) => c.toggleHeaderColumn())}
      <span className="doc-toolbar-sep" />
      {button('左对齐', <TextAlignStart size={15} />, (c) => c.setCellAttribute('align', null), {
        pressed: !align,
      })}
      {button('居中', <TextAlignCenter size={15} />, (c) => c.setCellAttribute('align', 'center'), {
        pressed: align === 'center',
      })}
      {button('右对齐', <TextAlignEnd size={15} />, (c) => c.setCellAttribute('align', 'right'), {
        pressed: align === 'right',
      })}
      <span className="doc-table-colours">
        <button
          type="button"
          title={t('单元格底色')}
          aria-label={t('单元格底色')}
          aria-expanded={colours}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setColours((open) => !open)}
        >
          <PaintBucket size={15} />
        </button>
        {colours ? (
          <span className="doc-table-swatches" role="menu">
            {backgrounds.map(([label, value]) => (
              <button
                key={label}
                type="button"
                role="menuitemradio"
                aria-checked={background === value}
                title={t(label)}
                aria-label={t(label)}
                className="doc-swatch"
                style={{ background: value ?? 'transparent' }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  run((c) => c.setCellAttribute('background', value));
                  setColours(false);
                }}
              />
            ))}
          </span>
        ) : null}
      </span>
      <span className="doc-toolbar-sep" />
      {button('删除表格', <Grid2x2X size={15} />, (c) => c.deleteTable(), { danger: true })}
    </BubbleMenu>
  );
}
