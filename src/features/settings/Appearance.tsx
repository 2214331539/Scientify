import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button, Dropdown } from '../../components/primitives';
import { t } from '../../i18n';
import { setPreferences, usePreferences, type Language, type Theme } from '../../i18n/preferences';
import './appearance.css';

export function PreferenceFields({ field }: { field: 'language' | 'theme' }) {
  const preferences = usePreferences();
  return (
    <div className="preference-fields">
      {field === 'theme' && (
        <label>
          {t('界面主题')}
          <Dropdown
            aria-label={t('界面主题')}
            value={preferences.theme}
            onChange={(event) => setPreferences({ theme: event.target.value as Theme })}
          >
            <option value="system">{t('跟随系统')}</option>
            <option value="light">{t('浅色')}</option>
            <option value="dark">{t('深色')}</option>
          </Dropdown>
        </label>
      )}
      {field === 'language' && (
        <label>
          {t('界面语言')}
          <Dropdown
            aria-label={t('界面语言')}
            value={preferences.language}
            onChange={(event) => setPreferences({ language: event.target.value as Language })}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </Dropdown>
        </label>
      )}
    </div>
  );
}

export function AppearanceControls() {
  const prefs = usePreferences();
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark);
  const themeLabel = t(dark ? '切换为浅色' : '切换为深色');
  return (
    <Button
      variant="ghost"
      iconOnly
      className="theme-toggle"
      aria-label={themeLabel}
      title={themeLabel}
      onClick={() => setPreferences({ theme: dark ? 'light' : 'dark' })}
    >
      <span className="theme-glyph" data-dark={dark} aria-hidden="true">
        <Sun className="theme-sun" />
        <Moon className="theme-moon" />
      </span>
    </Button>
  );
}
