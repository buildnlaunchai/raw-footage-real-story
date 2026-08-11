/**
 * Inline icons.
 *
 * Drawn here rather than pulled from a set: the app ships offline, and a icon
 * dependency would be a package to audit for the sake of a dozen glyphs.
 */

interface IconProps {
  size?: number;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({ size = 20, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function SearchIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" {...stroke} />
      <path d="m20 20-3.5-3.5" {...stroke} />
    </Svg>
  );
}

export function BellIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-2 8-2 8h16s-2-1-2-8" {...stroke} />
      <path d="M13.7 20a2 2 0 0 1-3.4 0" {...stroke} />
    </Svg>
  );
}

export function FilmIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" {...stroke} />
      <path d="M3 9h18M3 15h18M8 4v16M16 4v16" {...stroke} />
    </Svg>
  );
}

export function SparkIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z" {...stroke} />
    </Svg>
  );
}

export function ScriptIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 3h9l4 4v14H6z" {...stroke} />
      <path d="M14 3v5h5M9 12h7M9 16h7" {...stroke} />
    </Svg>
  );
}

export function MicIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" {...stroke} />
    </Svg>
  );
}

export function LayersIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m12 3 9 5-9 5-9-5z" {...stroke} />
      <path d="m3 13 9 5 9-5" {...stroke} />
    </Svg>
  );
}

export function PlayIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 5.5v13l10-6.5z" fill="currentColor" />
    </Svg>
  );
}

export function DownloadIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" {...stroke} />
    </Svg>
  );
}

export function ChevronUpIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m6 14 6-6 6 6" {...stroke} />
    </Svg>
  );
}

export function ChevronDownIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m6 10 6 6 6-6" {...stroke} />
    </Svg>
  );
}

export function CheckIcon({ size = 12 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m5 12.5 4.5 4.5L19 7" {...stroke} strokeWidth={3} />
    </Svg>
  );
}

export function AlertIcon({ size = 12 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 7v6" {...stroke} strokeWidth={3} />
      <circle cx="12" cy="17.5" r="1.5" fill="currentColor" />
    </Svg>
  );
}

export function SaveIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 4h11l3 3v13H5z" {...stroke} />
      <path d="M8 4v5h7M8 20v-6h8v6" {...stroke} />
    </Svg>
  );
}

export function PencilIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16z" {...stroke} />
    </Svg>
  );
}

export function PlayCircleIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" {...stroke} />
      <path d="M10 8.5v7l6-3.5z" fill="currentColor" />
    </Svg>
  );
}

export function StarIcon({ size = 18, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <Svg size={size}>
      <path
        d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"
        {...stroke}
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  );
}

export function TrashIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13M10 11v6M14 11v6" {...stroke} />
    </Svg>
  );
}

export function UndoIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 9h10a5 5 0 0 1 0 10H9M4 9l4-4M4 9l4 4" {...stroke} />
    </Svg>
  );
}

export function HomeIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m4 11 8-6.5 8 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" {...stroke} />
    </Svg>
  );
}

export function FolderIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...stroke} />
    </Svg>
  );
}

export function FilterIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 6h16l-6.2 7.3V19l-3.6-1.8v-3.9z" {...stroke} />
    </Svg>
  );
}

export function SortIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" {...stroke} />
    </Svg>
  );
}

export function DocIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 3h8l4 4v14H6z" {...stroke} />
      <path d="M14 3v5h4" {...stroke} />
    </Svg>
  );
}

export function RefreshIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 11a8 8 0 1 0-.9 4.7" {...stroke} />
      <path d="M20 5v6h-6" {...stroke} />
    </Svg>
  );
}

/** The stage icons, in pipeline order. */
export const STAGE_ICONS = {
  footage: FilmIcon,
  story: SparkIcon,
  script: ScriptIcon,
  voice: MicIcon,
  assembly: LayersIcon,
} as const;
