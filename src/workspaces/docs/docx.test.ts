import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { pageToDocx, wordColor, xmlText } from './docx';
import type { Block } from './model';

const text = (value: string, marks = {}) => [{ text: value, marks }];

const blocks: Block[] = [
  { id: 'h', type: 'heading', props: { level: 1 }, content: text('Results') },
  {
    id: 'p',
    type: 'paragraph',
    content: [
      { text: 'See ' },
      { text: 'the paper', marks: { link: 'https://example.org/a?b=1&c=2' } },
      { text: ' & <notes>', marks: { bold: true } },
    ],
  },
  { id: 'n1', type: 'numbered', content: text('one') },
  { id: 'n2', type: 'numbered', content: text('two') },
  { id: 'b1', type: 'bullet', content: text('point') },
  { id: 'n3', type: 'numbered', content: text('again') },
  { id: 't', type: 'todo', props: { checked: true }, content: text('done') },
  { id: 'c', type: 'code', props: { text: 'a = 1\nb = 2' } },
  { id: 'i', type: 'image', props: { asset: 'images/fig.png', caption: 'Figure 1' } },
  {
    id: 'tb',
    type: 'table',
    props: {
      header: true,
      rows: [
        [text('A'), text('B'), text('C')],
        [text('merged down'), text('x'), text('y')],
        [text('z'), text('w')],
      ],
      cells: [[], [{ rowspan: 2 }], []],
    },
  },
];

async function unzip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return {
    zip,
    document: await zip.file('word/document.xml')!.async('string'),
    rels: await zip.file('word/_rels/document.xml.rels')!.async('string'),
    numbering: await zip.file('word/numbering.xml')!.async('string'),
  };
}

describe('Word export', () => {
  it('writes a package Word can open, with headings, links, lists, code and a picture', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const bytes = await pageToDocx(
      { title: 'Lab notes', blocks },
      { image: async () => ({ data: png, type: 'png', width: 1200, height: 600 }) },
    );
    const { zip, document, rels, numbering } = await unzip(bytes);
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/styles.xml',
      'docProps/core.xml',
    ])
      expect(zip.file(part)).toBeTruthy();
    expect(document).toContain('<w:pStyle w:val="Title"/>');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('&amp; &lt;notes&gt;');
    expect(rels).toContain('Target="https://example.org/a?b=1&amp;c=2" TargetMode="External"');
    expect(document).toMatch(/<w:hyperlink r:id="rId\d+"/);
    // Two numbered runs, each starting from 1; the bullet uses the shared list.
    expect(numbering.match(/<w:startOverride w:val="1"\/>/g)).toHaveLength(2);
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(document).toContain('☑ ');
    expect(document).toContain('<w:pStyle w:val="Code"/>');
    expect(document).toContain('<w:br/>');
    // A wide picture is scaled to the 6-inch text width, keeping its shape.
    expect(document).toContain('<wp:extent cx="5486400" cy="2743200"/>');
    expect(zip.file('word/media/image1.png')).toBeTruthy();
    expect(document).toContain('<w:pStyle w:val="Caption"/>');
  });

  it('puts merged-away table cells back so every row spans the grid', async () => {
    const bytes = await pageToDocx(
      { title: '', blocks: blocks.filter((block) => block.type === 'table') },
      { image: async () => null },
    );
    const { document } = await unzip(bytes);
    expect(document.match(/<w:gridCol /g)).toHaveLength(3);
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:vMerge/>');
    const rows = document.split('<w:tr>').slice(1);
    for (const row of rows) expect(row.match(/<w:tc>/g)).toHaveLength(3);
  });

  it('leaves out a picture it cannot read, and keeps text valid XML', async () => {
    const bytes = await pageToDocx(
      { title: 'x', blocks: [{ id: 'i', type: 'image', props: { asset: 'images/gone.png' } }] },
      { image: async () => null },
    );
    expect((await unzip(bytes)).document).toContain('[图片]');
    expect(xmlText('a\u0001b"c')).toBe('ab&quot;c');
    expect(wordColor('#e03131')).toBe('E03131');
    expect(wordColor('rgba(250, 82, 82, 0.18)')).toBe('FEE0E0');
    expect(wordColor('var(--x)')).toBeNull();
  });
});
