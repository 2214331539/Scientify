import type { ChatAttachment } from './model';
import { loadTextPdf, pdfPageText } from '../../reader/pdf-text';

const images = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const textExtensions =
  /\.(?:txt|md|markdown|py|json|toml|ya?ml|ini|cfg|csv|bib|tex|js|ts|tsx|jsx|r|sh)$/i;
const TEXT_LIMIT = 12000;

/** Explicit user input only: never resolves a file path or reads sibling files. */
export async function readAttachment(file: File): Promise<ChatAttachment> {
  if (images.includes(file.type)) {
    if (file.size > 8 * 1024 * 1024) throw new Error('单张图片不能超过 8 MiB。');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('图片读取失败，请重试。'));
      reader.readAsDataURL(file);
    });
    return { name: file.name, mimeType: file.type, data };
  }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 20 * 1024 * 1024) throw new Error('PDF 附件不能超过 20 MiB。');
    const loading = await loadTextPdf(await file.arrayBuffer());
    try {
      const pdf = await loading.promise;
      let text = '';
      let pages = 0;
      for (; pages < Math.min(pdf.numPages, 20) && text.length < TEXT_LIMIT; pages++) {
        text += `\n[p. ${pages + 1}]\n` + (await pdfPageText(pdf, pages + 1));
      }
      if (!text.replace(/\[p\. \d+\]/g, '').trim())
        throw new Error('此 PDF 没有可提取的文字，请粘贴页面截图；暂不支持 OCR。');
      return {
        name: file.name,
        mimeType: 'application/pdf',
        data: '',
        text: text.slice(0, TEXT_LIMIT),
        truncated: pages < pdf.numPages || text.length > TEXT_LIMIT,
      };
    } finally {
      await loading.destroy();
    }
  }
  if (!textExtensions.test(file.name))
    throw new Error('支持图片、PDF、文本、Markdown 和代码/项目配置文件。');
  if (file.size > 2 * 1024 * 1024) throw new Error('文本附件不能超过 2 MiB。');
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('附件读取失败，请重试。'));
    reader.readAsText(file);
  });
  if (text.includes('\0')) throw new Error('附件不是可读取的文本文件。');
  return {
    name: file.name,
    mimeType: file.type || 'text/plain',
    data: '',
    text: text.slice(0, TEXT_LIMIT),
    truncated: text.length > TEXT_LIMIT,
  };
}
