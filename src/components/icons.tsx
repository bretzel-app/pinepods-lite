/** Minimal inline icon set (stroke style, inherits currentColor). */

interface IconProps {
  className?: string;
}

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
};

export const HomeIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </svg>
);

export const GridIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </svg>
);

export const SearchIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </svg>
);

export const StarIcon = ({ className, filled }: IconProps & { filled?: boolean }) => (
  <svg {...base} fill={filled ? 'currentColor' : 'none'} className={className}>
    <path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.3 6.4 20.3l1.2-6.3L3 9.6l6.3-.8Z" />
  </svg>
);

export const DownloadIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 21h16" />
  </svg>
);

export const TrashIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 14h10l1-14" />
  </svg>
);

export const PlayIcon = ({ className }: IconProps) => (
  <svg {...base} fill="currentColor" stroke="none" className={className}>
    <path d="M7 4.5v15l13-7.5Z" />
  </svg>
);

export const PauseIcon = ({ className }: IconProps) => (
  <svg {...base} fill="currentColor" stroke="none" className={className}>
    <rect x="6" y="4" width="4.5" height="16" rx="1" />
    <rect x="13.5" y="4" width="4.5" height="16" rx="1" />
  </svg>
);

export const SkipBackIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M11 8.5 7 12l4 3.5" />
    <path d="M20 19a9 9 0 1 0-16-5.6" />
    <text x="10.5" y="15.5" fontSize="7" fill="currentColor" stroke="none">
      15
    </text>
  </svg>
);

export const SkipFwdIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m13 8.5 4 3.5-4 3.5" />
    <path d="M4 19a9 9 0 1 1 16-5.6" />
    <text x="6.5" y="15.5" fontSize="7" fill="currentColor" stroke="none">
      30
    </text>
  </svg>
);

export const UserIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m4.5 12.5 5 5L19.5 7" />
  </svg>
);

export const CloudOffIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6.6 6.6A6 6 0 0 0 6 18h11" />
    <path d="M20.3 15.6A4.5 4.5 0 0 0 17 9h-1.3A6 6 0 0 0 10 5" />
    <path d="m3 3 18 18" />
  </svg>
);

export const SwapIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 8h13" />
    <path d="m14 4 4 4-4 4" />
    <path d="M20 16H7" />
    <path d="m10 12-4 4 4 4" />
  </svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
