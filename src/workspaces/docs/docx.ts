/**
 * A page as a Word document (.docx), as Feishu's "导出为 Word": title, headings,
 * lists, to-dos, quotes, callouts, code, tables (with merged cells), images and
 * links. Written straight as WordprocessingML and zipped with JSZip.
 */
import type { TableCellProps } from './convert';
import type { Block, Inline, Marks, Page } from './model';

/** An image ready for Word: PNG, JPEG or GIF bytes and its size in pixels. */
export type DocxImage = {
  data: Uint8Array;
  type: 'png' | 'jpeg' | 'gif';
  width: number;
  height: number;
};
export type DocxOptions = {
  /** A stored image (`images/…`); null leaves it out. */
  image(asset: string): Promise<DocxImage | null>;
};

const WORD_TYPES: Record<string, DocxImage['type']> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
};

/** An image (as a data URL) for Word, drawn again as PNG when Word can't take its format (WebP). */
export async function imageForWord(url: string): Promise<DocxImage | null> {
  const picture = new Image();
  picture.src = url;
  await picture.decode();
  const width = picture.naturalWidth || 600;
  const height = picture.naturalHeight || 400;
  const type = WORD_TYPES[/^data:([^;,]+)/.exec(url)?.[1] ?? ''];
  if (type)
    return { data: new Uint8Array(await (await fetch(url)).arrayBuffer()), type, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(picture, 0, 0);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return png ? { data: new Uint8Array(await png.arrayBuffer()), type: 'png', width, height } : null;
}

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  doc: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** A4 with 2.54 cm margins: the text is 9026 twips wide. */
const TEXT_WIDTH = 9026;
const MAX_IMAGE = 5_486_400; // 6 inches, in EMU
const EMU_PER_PX = 9525;
const INDENT = 420;

/** Text XML can hold: control characters and lone surrogates dropped, markup escaped. */
export function xmlText(text: string) {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 9 || code === 10 || code === 13) return true;
      return (
        code >= 32 && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff
      );
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "#e03131" or "rgba(250, 82, 82, 0.18)" (over white) as Word's "E03131"; null otherwise. */
export function wordColor(value?: string | null) {
  if (!value) return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return hex[1].toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
    value.trim(),
  );
  if (!rgb) return null;
  const alpha = rgb[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(rgb[4])));
  return [rgb[1], rgb[2], rgb[3]]
    .map((part) => Math.round(Number(part) * alpha + 255 * (1 - alpha)))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

type RunStyle = { bold?: boolean; italic?: boolean; color?: string; font?: string };

class Writer {
  rels: string[] = [];
  media: { name: string; data: Uint8Array }[] = [];
  lists: { id: number; level: number }[] = [];
  private nextRel = 2;
  private pictures = 0;
  constructor(private options: DocxOptions) {}

  relationship(type: string, target: string, external = false) {
    const id = `rId${++this.nextRel}`;
    this.rels.push(
      `<Relationship Id="${id}" Type="${NS.doc}/${type}" Target="${xmlText(target)}"${external ? ' TargetMode="External"' : ''}/>`,
    );
    return id;
  }

  /** A numbered list that starts again from 1. */
  newList(level: number) {
    const id = this.lists.length + 2;
    this.lists.push({ id, level });
    return id;
  }

  async image(asset: string) {
    const picture = await this.options.image(asset).catch(() => null);
    if (!picture) return null;
    const n = ++this.pictures;
    const name = `image${n}.${picture.type}`;
    this.media.push({ name, data: picture.data });
    const id = this.relationship('image', `media/${name}`);
    let cx = Math.max(1, picture.width) * EMU_PER_PX;
    let cy = Math.max(1, picture.height) * EMU_PER_PX;
    if (cx > MAX_IMAGE) [cx, cy] = [MAX_IMAGE, Math.round((cy * MAX_IMAGE) / cx)];
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }

  runs(content: Inline[] = [], base: RunStyle = {}) {
    return content
      .map((item) => {
        if ('text' in item) return this.text(item.text, item.marks, base);
        if (item.type === 'mention')
          return this.text(item.kind === 'page' ? item.label : `@${item.label}`, {}, base);
        if (item.type === 'math')
          return this.text(item.latex, {}, { ...base, italic: true, font: 'Cambria Math' });
        return '<w:r><w:br/></w:r>';
      })
      .join('');
  }

  text(text: string, marks: Marks = {}, base: RunStyle = {}) {
    const external = marks.link && /^(?:https?|mailto):/i.test(marks.link);
    const color = wordColor(marks.color) ?? base.color;
    const fill = wordColor(marks.background);
    const font = marks.code ? 'Consolas' : base.font;
    const props = [
      external ? '<w:rStyle w:val="Hyperlink"/>' : marks.code ? '<w:rStyle w:val="CodeChar"/>' : '',
      font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : '',
      marks.bold || base.bold ? '<w:b/>' : '',
      marks.italic || base.italic ? '<w:i/>' : '',
      marks.strike ? '<w:strike/>' : '',
      color && !external ? `<w:color w:val="${color}"/>` : '',
      marks.underline && !external ? '<w:u w:val="single"/>' : '',
      fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '',
    ].join('');
    const runs = text
      .split('\n')
      .map(
        (part, i) =>
          `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${i ? '<w:br/>' : ''}` +
          `${part ? `<w:t xml:space="preserve">${xmlText(part)}</w:t>` : ''}</w:r>`,
      )
      .join('');
    if (!external) return runs;
    return `<w:hyperlink r:id="${this.relationship('hyperlink', marks.link!, true)}" w:history="1">${runs}</w:hyperlink>`;
  }

  async blocks(list: Block[], depth: number): Promise<string> {
    let out = '';
    let numbered = 0;
    for (const [i, block] of list.entries()) {
      if (block.type === 'numbered' && list[i - 1]?.type !== 'numbered')
        numbered = this.newList(Math.min(depth, 8));
      out += await this.block(block, depth, numbered);
    }
    return out;
  }

  async block(block: Block, depth: number, numbered: number): Promise<string> {
    const p = block.props ?? {};
    const indent = depth ? `<w:ind w:left="${depth * INDENT}"/>` : '';
    const children = block.children?.length ? await this.blocks(block.children, depth + 1) : '';
    const plain = (props: string, runs: string) => para(props, runs) + children;
    switch (block.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(p.level ?? 2)));
        return plain(`<w:pStyle w:val="Heading${level}"/>${indent}`, this.runs(block.content));
      }
      case 'bullet':
      case 'numbered': {
        const level = Math.min(depth, 8);
        const id = block.type === 'bullet' ? 1 : numbered;
        return plain(
          `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`,
          this.runs(block.content),
        );
      }
      case 'todo':
        return plain(
          `<w:pStyle w:val="ListParagraph"/>${indent}`,
          this.text(p.checked ? '☑ ' : '☐ ') +
            this.runs(block.content, p.checked ? { color: '8B8B93' } : {}),
        );
      case 'quote':
        return plain(
          `<w:pStyle w:val="Quote"/><w:ind w:left="${depth * INDENT + 240}"/>`,
          this.runs(block.content),
        );
      case 'callout':
        return plain(
          `<w:pBdr>${['top', 'left', 'bottom', 'right'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="4" w:color="E3E5E8"/>`).join('')}</w:pBdr>` +
            `<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>${indent}`,
          this.text(`${String(p.emoji ?? '💡')} `) + this.runs(block.content),
        );
      case 'divider':
        return para(
          '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D4DA"/></w:pBdr>',
          '',
        );
      case 'code':
        return para(`<w:pStyle w:val="Code"/>${indent}`, this.text(String(p.text ?? '')));
      case 'math':
        return para(
          '<w:jc w:val="center"/>',
          this.text(String(p.latex ?? ''), {}, { italic: true, font: 'Cambria Math' }),
        );
      case 'image': {
        const picture = await this.image(String(p.asset ?? ''));
        const caption = String(p.caption ?? '');
        return (
          para('<w:jc w:val="center"/>', picture ?? this.text('[图片]', {}, { color: '8B8B93' })) +
          (caption ? para('<w:pStyle w:val="Caption"/>', this.text(caption)) : '')
        );
      }
      case 'table':
        return this.table(p) + '<w:p/>';
      case 'toggle':
        return plain(indent, this.runs(block.content, { bold: true }));
      case 'paper':
      case 'paperNote':
      case 'file': {
        const icon = block.type === 'paper' ? '📄' : block.type === 'paperNote' ? '📝' : '📎';
        return plain(indent, this.text(`${icon} ${String(p.title || p.path || '')}`));
      }
      case 'link':
        return plain(
          indent,
          this.text(String(p.title || p.url || ''), { link: String(p.url ?? '') }),
        );
      case 'attachment':
        return plain(indent, this.text(`📎 ${String(p.name ?? '')}`));
      case 'conflict':
        return plain(indent, this.text(`⚠️ ${String(p.from ?? '')}`, {}, { bold: true }));
      default:
        return plain(indent, this.runs(block.content));
    }
  }

  /** Rows as the editor keeps them: merged-away cells are absent, so they are put back here. */
  table(p: Record<string, unknown>) {
    const rows = (p.rows as Inline[][][] | undefined) ?? [];
    const extras = (p.cells as (TableCellProps | null)[][] | undefined) ?? [];
    const header = p.header !== false;
    const headerCol = p.headerCol === true;
    const covered = new Map<number, { rows: number; span: number }>();
    const laid: { cells: string[]; width: number }[] = [];
    rows.forEach((row, r) => {
      const cells: string[] = [];
      let col = 0;
      const skip = () => {
        for (let below = covered.get(col); below; below = covered.get(col)) {
          cells.push(cell('<w:vMerge/>', below.span, '<w:p/>'));
          below.rows -= 1;
          if (!below.rows) covered.delete(col);
          col += below.span;
        }
      };
      row.forEach((content, c) => {
        skip();
        const extra = extras[r]?.[c] ?? {};
        const span = Math.max(1, extra.colspan ?? 1);
        const down = Math.max(1, extra.rowspan ?? 1);
        const head = (header && r === 0) || (headerCol && c === 0);
        const fill = wordColor(extra.bg) ?? (head ? 'F2F3F5' : null);
        const align = extra.align ? `<w:jc w:val="${extra.align}"/>` : '';
        cells.push(
          cell(
            (down > 1 ? '<w:vMerge w:val="restart"/>' : '') +
              (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''),
            span,
            para(align, this.runs(content, head ? { bold: true } : {})),
          ),
        );
        if (down > 1) covered.set(col, { rows: down - 1, span });
        col += span;
      });
      skip();
      laid.push({ cells, width: col });
    });
    const width = Math.max(1, ...laid.map((row) => row.width));
    const column = Math.floor(TEXT_WIDTH / width);
    return (
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>` +
      `<w:tblGrid>${`<w:gridCol w:w="${column}"/>`.repeat(width)}</w:tblGrid>` +
      laid
        .map(
          (row) =>
            `<w:tr>${row.cells.join('')}${cell('', 1, '<w:p/>').repeat(width - row.width)}</w:tr>`,
        )
        .join('') +
      `</w:tbl>`
    );
  }
}

const para = (props: string, runs: string) =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`;

const cell = (props: string, span: number, body: string) =>
  `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${props}</w:tcPr>${body}</w:tc>`;

const STYLES =
  `${HEAD}<w:styles xmlns:w="${NS.w}">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>` +
  `<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
  `<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>` +
  [
    [1, 36],
    [2, 30],
    [3, 26],
  ]
    .map(
      ([level, size]) =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`,
    )
    .join('') +
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
  `<w:pPr><w:spacing w:after="60"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
  `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D4DA"/></w:pBdr></w:pPr><w:rPr><w:color w:val="555B66"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F6F8"/><w:spacing w:after="120" w:line="260" w:lineRule="auto"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="8B8B93"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
  `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F63D6"/><w:u w:val="single"/></w:rPr></w:style>` +
  `<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/>` +
  `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F0F1F3"/></w:rPr></w:style>` +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:tblPr><w:tblBorders>` +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/>`)
    .join('') +
  `</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>` +
  `<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
  `</w:styles>`;

const BULLETS = ['•', '◦', '▪'];
const NUMBERS = ['decimal', 'lowerLetter', 'lowerRoman'];
const level = (i: number, format: string, text: string) =>
  `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/>` +
  `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${INDENT * (i + 1)}" w:hanging="300"/></w:pPr></w:lvl>`;

function numbering(lists: { id: number; level: number }[]) {
  const levels = (make: (i: number) => string) =>
    Array.from({ length: 9 }, (_, i) => make(i)).join('');
  return (
    `${HEAD}<w:numbering xmlns:w="${NS.w}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels((i) => level(i, 'bullet', BULLETS[i % 3]))}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels((i) => level(i, NUMBERS[i % 3], `%${i + 1}.`))}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    lists
      .map(
        (list) =>
          `<w:num w:numId="${list.id}"><w:abstractNumId w:val="1"/>` +
          `<w:lvlOverride w:ilvl="${list.level}"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
      )
      .join('') +
    `</w:numbering>`
  );
}

/** The page as .docx bytes. */
export async function pageToDocx(page: Pick<Page, 'title' | 'blocks'>, options: DocxOptions) {
  const { default: JSZip } = await import('jszip');
  const writer = new Writer(options);
  const title = page.title ? para('<w:pStyle w:val="Title"/>', writer.text(page.title)) : '';
  const body = await writer.blocks(page.blocks, 0);
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Default Extension="gif" ContentType="image/gif"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${HEAD}<Relationships xmlns="${NS.rel}">` +
      `<Relationship Id="rId1" Type="${NS.doc}/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    'docProps/core.xml',
    `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xmlText(page.title)}</dc:title><dc:creator>Scientify</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>` +
      `</cp:coreProperties>`,
  );
  zip.file(
    'word/document.xml',
    `${HEAD}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}">` +
      `<w:body>${title}${body}` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>` +
      `</w:body></w:document>`,
  );
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', numbering(writer.lists));
  zip.file(
    'word/_rels/document.xml.rels',
    `${HEAD}<Relationships xmlns="${NS.rel}">` +
      `<Relationship Id="rId1" Type="${NS.doc}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="${NS.doc}/numbering" Target="numbering.xml"/>` +
      writer.rels.join('') +
      `</Relationships>`,
  );
  for (const item of writer.media) zip.file(`word/media/${item.name}`, item.data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
