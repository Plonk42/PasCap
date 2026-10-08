export type IconName =
  | 'mountain'
  | 'folder'
  | 'play'
  | 'pause'
  | 'back'
  | 'forward'
  | 'download'
  | 'reset'
  | 'check'
  | 'arrow'
  | 'activity'
  | 'x'
  | 'sliders'
  | 'search'
  | 'grid'
  | 'list'
  | 'plus'
  | 'video'
  | 'undo'
  | 'redo'
  | 'split'
  | 'trash'
  | 'eye'
  | 'eye-off'
  | 'help'
  | 'pin'
  | 'layout'
  | 'chevron-up'
  | 'chevron-down'
  | 'start'
  | 'end'
  | 'more'
  | 'speed'
  | 'colour'
  | 'layers'
  | 'music'
  | 'curve'
  | 'magnet'
  | 'cut'
  | 'warning'
  | 'disk'
  | 'wand';
const paths: Record<IconName, string> = {
  mountain: 'M3 19 9 6l5 9 3-6 4 10H3Zm6-13 2 4-2 2-2-2',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Zm0 3h18',
  play: 'm9 5 11 7-11 7V5Z',
  pause: 'M8 5v14M16 5v14',
  back: 'M5 5v14m14-14L9 12l10 7V5Z',
  forward: 'M19 5v14M5 5l10 7-10 7V5Z',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  reset: 'M3 10a9 9 0 1 1 2 9M3 4v6h6',
  check: 'm5 12 4 4 10-10',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  x: 'm6 6 12 12M18 6 6 18',
  sliders: 'M4 7h16M4 17h16M9 4v6m6 4v6',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1',
  plus: 'M12 5v14M5 12h14',
  video: 'M3 4h18v16H3V4Zm0 4h18M7 4v4m10-4v4m-7 3 5 3-5 3v-6Z',
  undo: 'M3 9h10a7 7 0 0 1 0 14M3 9l5-5M3 9l5 5',
  redo: 'M21 9H11a7 7 0 0 0 0 14M21 9l-5-5m5 5-5 5',
  split: 'M12 3v18M3 7h6v10H3V7Zm12 0h6v10h-6V7Z',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  'eye-off': 'm3 3 18 18M10 5h2c6 0 10 7 10 7s-1 2-3 4M6 6c-3 2-4 6-4 6s4 7 10 7c2 0 4-.8 5-2M9 9a4 4 0 0 0 6 6',
  help: 'M9 9a3 3 0 1 1 5 2c-1 1-2 1-2 3m0 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  pin: 'm9 3 6 0-1 5 4 4v2H6v-2l4-4-1-5Zm3 11v7',
  layout: 'M3 4h18v16H3V4Zm5 0v16m8-16v16M8 15h8',
  'chevron-up': 'm6 15 6-6 6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  start: 'M5 5v14m13-14L8 12l10 7',
  end: 'M19 5v14M6 5l10 7-10 7',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  speed: 'M4 18a9 9 0 1 1 16 0M12 13l5-6M5 13h1m6-9v1m6 8h1M10 18h4',
  colour: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 0-10h-4ZM7 8h.1M12 6h.1M6 13h.1',
  layers: 'm3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5',
  music: 'M9 17V5l11-2v12M9 17a3 3 0 1 1-3-3c2 0 3 1 3 3Zm11-2a3 3 0 1 1-3-3c2 0 3 1 3 3Z',
  curve: 'M3 18c8 0 10-12 18-12M3 15v6m18-18v6',
  magnet: 'M5 3v9a7 7 0 0 0 14 0V3h-5v9a2 2 0 0 1-4 0V3H5Zm0 5h5m4 0h5',
  cut: 'm7 7 10 10M7 17 17 7M6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 12a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm11-8 4-4m-4 14 4 4',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3h.1',
  disk: 'M4 4h14l3 3v14H3V4h1Zm3 0v7h10V4M7 21v-7h10v7M14 7h.1',
  wand: 'm3 21 12-12 2 2L5 23M15 9l2 2M17 2v4m-2-2h4M21 8v3m-1.5-1.5h3M10 3v2M9 4h2',
};
export function Icon({ name, size = 18 }: Readonly<{ name: IconName; size?: number }>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
