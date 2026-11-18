import { expect, it } from 'vitest';
import { errorReport, errorReportsOn, scrub, setErrorReports } from './error-reports';

it('blanks the account name in home-folder paths', () => {
  expect(scrub('C:\\Users\\li\\x.pdf and /Users/wang/y')).toBe(
    'C:\\Users\\~\\x.pdf and /Users/~/y',
  );
});

it('sends the message and stack, and skips noise', () => {
  const error = new TypeError('x is undefined');
  expect(errorReport(error, 'error')).toMatchObject({
    message: 'TypeError: x is undefined',
    source: 'error',
  });
  expect(
    errorReport('ResizeObserver loop completed with undelivered notifications', 'error'),
  ).toBeNull();
  expect(errorReport('', 'promise')).toBeNull();
});

it('is on until turned off', () => {
  localStorage.removeItem('scientify.errorReports');
  expect(errorReportsOn()).toBe(true);
  setErrorReports(false);
  expect(errorReportsOn()).toBe(false);
  setErrorReports(true);
});
