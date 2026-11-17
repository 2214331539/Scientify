export type OperatingSystem = 'macos' | 'windows' | 'linux' | 'unknown';

/** Keep platform detection in one boundary for UI and shortcut behavior. */
export function operatingSystem(): OperatingSystem {
  if (typeof navigator === 'undefined') return 'unknown';
  const value = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (value.includes('mac') || value.includes('iphone') || value.includes('ipad')) return 'macos';
  if (value.includes('win')) return 'windows';
  if (value.includes('linux')) return 'linux';
  return 'unknown';
}

export function isMacOS() {
  return operatingSystem() === 'macos';
}

export function platformClass() {
  return `platform-${operatingSystem()}`;
}

/** A local path as people write it, without Windows' `\\?\` long-path prefix. */
export function displayPath(path: string) {
  return path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
}

/** Whether two folders are the same or one holds the other (Windows ignores case). */
export function sameOrInside(a: string, b: string) {
  const windows = /^[a-z]:|^\\\\/i.test(displayPath(a));
  const plain = (path: string) => {
    const folder = displayPath(path).replace(/\\/g, '/').replace(/\/+$/, '');
    return `${windows ? folder.toLowerCase() : folder}/`;
  };
  const [x, y] = [plain(a), plain(b)];
  return x.startsWith(y) || y.startsWith(x);
}
