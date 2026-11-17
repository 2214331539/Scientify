import { useId } from 'react';
import './mascot.css';

/**
 * Scientify's AI assistant: a soft 3D ball with two eyes, the dot that rises
 * out of the "开箱" logo come alive. Drawn in SVG so it stays sharp from a 14 px
 * button icon to the empty-state portrait.
 *
 * - `idle`: looks ahead and blinks now and then;
 * - `thinking`: glances up and around;
 * - `working`: bobs gently while its eyes scan.
 */
export type MascotMood = 'idle' | 'thinking' | 'working';

export type MascotPalette = { light: string; mid: string; edge: string; glow: string };

/** The default peach and the alternatives on the design page (docs/品牌/AI助手形象). */
export const MASCOT_PALETTES: Record<string, MascotPalette> = {
  peach: { light: '#fffaf6', mid: '#f9e6d9', edge: '#f1c9ad', glow: '#ff9446' },
  cream: { light: '#ffffff', mid: '#f5f1ea', edge: '#ddd3c5', glow: '#ffbf73' },
  mint: { light: '#fcfff5', mid: '#e8f5cf', edge: '#c3dc9b', glow: '#b8e835' },
  sky: { light: '#f8fcff', mid: '#dfedfb', edge: '#adc8ea', glow: '#6f8fff' },
};

export function Mascot({
  size = 16,
  mood = 'idle',
  shadow = false,
  palette = 'peach',
  className,
  title,
}: {
  size?: number;
  mood?: MascotMood;
  /** A soft shadow under the ball, for sizes above about 40 px. */
  shadow?: boolean;
  palette?: keyof typeof MASCOT_PALETTES;
  className?: string;
  /** Spoken name; without it the mascot is decoration next to a text label. */
  title?: string;
}) {
  const id = useId().replace(/:/g, '');
  const colors = MASCOT_PALETTES[palette] ?? MASCOT_PALETTES.peach;
  return (
    <svg
      className={`sf-mascot is-${mood}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}-body`} cx="36%" cy="30%" r="74%" fx="34%" fy="26%">
          <stop offset="0" stopColor={colors.light} />
          <stop offset="0.45" stopColor={colors.mid} />
          <stop offset="0.85" stopColor={colors.edge} />
          <stop offset="1" stopColor={colors.edge} />
        </radialGradient>
        <radialGradient id={`${id}-glow`} cx="84%" cy="90%" r="52%">
          <stop offset="0" stopColor={colors.glow} stopOpacity="0.62" />
          <stop offset="1" stopColor={colors.glow} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-rim`} cx="50%" cy="50%" r="50%">
          <stop offset="0.8" stopColor="#5b3420" stopOpacity="0" />
          <stop offset="1" stopColor="#5b3420" stopOpacity="0.09" />
        </radialGradient>
        <radialGradient id={`${id}-shine`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.6" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-shadow`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#3a2418" stopOpacity="0.22" />
          <stop offset="1" stopColor="#3a2418" stopOpacity="0" />
        </radialGradient>
      </defs>
      {shadow ? (
        <ellipse
          className="sf-mascot-shadow"
          cx="50"
          cy="95"
          rx="34"
          ry="4.5"
          fill={`url(#${id}-shadow)`}
        />
      ) : null}
      <g className="sf-mascot-body">
        <circle cx="50" cy="48" r="44" fill={`url(#${id}-body)`} />
        <circle cx="50" cy="48" r="44" fill={`url(#${id}-glow)`} />
        <circle cx="50" cy="48" r="44" fill={`url(#${id}-rim)`} />
        <ellipse
          cx="33"
          cy="27"
          rx="17"
          ry="10"
          transform="rotate(-32 33 27)"
          fill={`url(#${id}-shine)`}
        />
        {/* Small icons get bolder eyes, or they vanish below 24 px. */}
        <g className="sf-mascot-eyes" fill="#1c1b1f">
          {size < 24 ? (
            <>
              <rect x="51" y="33" width="13" height="27" rx="6.5" />
              <rect x="71" y="33" width="13" height="27" rx="6.5" />
            </>
          ) : (
            <>
              <rect x="54" y="37" width="8.5" height="19" rx="4.25" />
              <rect x="71" y="37" width="8.5" height="19" rx="4.25" />
              <ellipse cx="57.2" cy="41" rx="1.6" ry="2.4" fill="#ffffff" opacity="0.3" />
              <ellipse cx="74.2" cy="41" rx="1.6" ry="2.4" fill="#ffffff" opacity="0.3" />
            </>
          )}
        </g>
      </g>
    </svg>
  );
}
