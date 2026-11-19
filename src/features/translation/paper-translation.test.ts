import { expect, it } from 'vitest';
import { isTranslationTab, paperOfTab, translationTab } from './paper-translation';

it('names translation tabs by their paper', () => {
  expect(paperOfTab(translationTab('p1'))).toBe('p1');
  expect(paperOfTab('p1')).toBe('p1');
  expect(isTranslationTab(translationTab('p1'))).toBe(true);
  expect(isTranslationTab('p1')).toBe(false);
});
