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
