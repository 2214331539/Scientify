import {
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import { displayPath } from '../../platform/os';

const KINDS: [RegExp, LucideIcon][] = [
  [/\.(png|jpe?g|gif|webp|svg|bmp)$/i, FileImage],
  [/\.(csv|tsv|xlsx?|parquet)$/i, FileSpreadsheet],
  [/\.html?$/i, Globe],
  [/\.(pptx?|key)$/i, Presentation],
  [/\.(py|ipynb|js|ts|tsx|rs|c|cpp|h|java|go|sh|r|m|jl|json|ya?ml|toml|tex|bib)$/i, FileCode],
];

/** The last part of a path, whichever separators it uses. */
export const baseName = (path: string) =>
  displayPath(path).split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * A local file named in an answer: its name in link colour with an icon by type,
 * the full path on hover; clicking opens it in the center.
 */
export function FileChip({
  path,
  label,
  onOpen,
}: {
  path: string;
  label?: string;
  onOpen?(path: string): void;
}) {
  const Icon = KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? FileText;
  const name =
    label && label !== path && !/^(?:file:|[a-z]:[\\/]|\\\\|\/)/i.test(label)
      ? label
      : baseName(path);
  return (
    <button
      type="button"
      className="sf-file-chip"
      title={displayPath(path)}
      disabled={!onOpen}
      onClick={() => onOpen?.(path)}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{name}</span>
    </button>
  );
}
