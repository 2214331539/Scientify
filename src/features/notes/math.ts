import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { RootContent } from 'mdast';
import type { Extension as MarkdownExtension } from 'mdast-util-from-markdown';
import type { Code, Extension, State, Tokenizer } from 'micromark-util-types';
import type { PluggableList, Processor } from 'unified';
import 'katex/dist/katex.min.css';
import './math.css';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    scientifyMath: 'scientifyMath';
    scientifyMathData: 'scientifyMathData';
  }
}

// Extend Markdown tokenization so LaTeX delimiters cannot rewrite code or links.
const tokenizeLatex: Tokenizer = function (effects, ok, nok) {
  let closing: Code;
  return start;
  function start(code: Code) {
    if (code !== 92) return nok(code);
    effects.enter('scientifyMath');
    effects.consume(code);
    return opening;
  }
  function opening(code: Code) {
    if (code !== 40 && code !== 91) return nok(code);
    closing = code === 40 ? 41 : 93;
    effects.consume(code);
    return between;
  }
  function between(code: Code): ReturnType<State> {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return between;
    }
    effects.enter('scientifyMathData');
    return inside(code);
  }
  function inside(code: Code): ReturnType<State> {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      effects.exit('scientifyMathData');
      return between(code);
    }
    effects.consume(code);
    return code === 92 ? afterSlash : inside;
  }
  function afterSlash(code: Code): ReturnType<State> {
    if (code === closing) {
      effects.consume(code);
      effects.exit('scientifyMathData');
      effects.exit('scientifyMath');
      return ok;
    }
    if (code === 92) {
      effects.consume(code);
      return inside;
    }
    return inside(code);
  }
};

function remarkLatex(this: Processor) {
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: MarkdownExtension[];
  };
  const syntax: Extension = {
    text: { 92: { name: 'scientifyMath', tokenize: tokenizeLatex } },
  };
  const nodes: MarkdownExtension = {
    enter: {
      scientifyMath(token) {
        this.enter({ type: 'inlineMath', value: '' }, token);
        this.buffer();
      },
    },
    exit: {
      scientifyMath(token) {
        this.resume();
        const source = this.sliceSerialize(token);
        const node = this.stack[this.stack.length - 1] as Extract<
          RootContent,
          { type: 'inlineMath' }
        >;
        node.value = source.slice(2, -2);
        node.data = {
          hName: 'code',
          hProperties: {
            className: ['language-math', source[1] === '[' ? 'math-display' : 'math-inline'],
          },
          hChildren: [{ type: 'text', value: node.value }],
        };
        this.exit(token);
      },
    },
  };
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(nodes);
}

export const mathRemarkPlugins: PluggableList = [remarkMath, remarkLatex];
export const mathRehypePlugins: PluggableList = [
  [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }],
];

/**
 * Models occasionally return a small TeX fragment without delimiters, for
 * example `{A_b}`. Normalize only recognisable fragments and never touch code
 * fences, so ordinary prose and source snippets remain unchanged.
 */
export function normalizeMathDelimiters(source: string) {
  return source
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let value = part.replace(
        /\{([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+))\}/g,
        (_match, expression: string) => `\\(${expression}\\)`,
      );
      // Bare fraction/square-root commands are another common provider
      // formatting error. Limit this to a complete, single-line command.
      const hasUnclosedDelimiter =
        (value.match(/\\\[/g)?.length ?? 0) > (value.match(/\\\]\s*/g)?.length ?? 0) ||
        (value.match(/\\\(/g)?.length ?? 0) > (value.match(/\\\)\s*/g)?.length ?? 0);
      if (!hasUnclosedDelimiter)
        value = value.replace(
          /(?<![\\$])((?:\\frac\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt\{[^{}\n]+\}))(?![\\$])/g,
          (_match, expression: string) => `\\(${expression}\\)`,
        );
      return value;
    })
    .join('');
}
