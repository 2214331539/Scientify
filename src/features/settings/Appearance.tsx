import { Dropdown } from '../../components/primitives';
import { t } from '../../i18n';
import {
  setPreferences,
  usePreferences,
  type Language,
  type Palette,
} from '../../i18n/preferences';

export function PreferenceFields({ field }: { field: 'language' | 'theme' }) {
  const preferences = usePreferences();
  return (
    <div className="preference-fields">
      {field === 'theme' && <PalettePicker />}
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

const palettes = [
  { id: 'system', label: '跟随系统' },
  { id: 'graphite', label: '石墨' },
  { id: 'paper', label: '纸' },
  { id: 'night', label: '夜' },
] as const;

/** Four small window previews; “System” keeps the light palette by day and uses night after dark. */
function PalettePicker() {
  const preferences = usePreferences();
  const current =
    preferences.theme === 'light'
      ? preferences.palette
      : preferences.theme === 'dark'
        ? 'night'
        : 'system';
  function choose(value: (typeof palettes)[number]['id']) {
    if (value === 'system') setPreferences({ theme: 'system' });
    else if (value === 'night') setPreferences({ theme: 'dark' });
    else setPreferences({ theme: 'light', palette: value as Palette });
  }
  return (
    <div className="palette-picker" role="radiogroup" aria-label={t('配色')}>
      {palettes.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={current === id}
          className="palette-option"
          onClick={() => choose(id)}
        >
          <span className="palette-preview" data-palette={id} aria-hidden="true">
            <i />
            <b />
          </span>
          <span>{t(label)}</span>
        </button>
      ))}
    </div>
  );
}
