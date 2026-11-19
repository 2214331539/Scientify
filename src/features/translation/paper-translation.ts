// A paper's full-text translation opens in the note pane beside it, under a tab
// named after the paper. The translation itself is BabelDOC's (platform/translator.ts).

/** Note-pane tabs show a paper's translation under this id prefix. */
export const TRANSLATION_TAB = 'translation:';
export const translationTab = (paperId: string) => TRANSLATION_TAB + paperId;
export const isTranslationTab = (id: string) => id.startsWith(TRANSLATION_TAB);
/** The paper a note-pane tab belongs to. */
export const paperOfTab = (id: string) =>
  isTranslationTab(id) ? id.slice(TRANSLATION_TAB.length) : id;
