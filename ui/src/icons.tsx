type IconName =
  | "studio"
  | "file"
  | "components"
  | "settings"
  | "agent" | "terminal" | "code" | "back" | "chevron" | "link"
  | "folder"
  | "search"
  | "reset"
  | "play";
type ExtraIcon = "plus" | "close" | "more" | "stop" | "send" | "shield" | "attach" | "image" | "object" | "plot" | "table" | "check" | "clock" | "warning" | "lock";
const paths: Record<IconName | ExtraIcon, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  send: <path d="M12 20V4M5 11l7-7 7 7" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z" /><path d="m8 11 3 3 5-5" /></>,
  attach: <path d="m9 14 8-8a3 3 0 1 1 4 4L10 21a5 5 0 0 1-7-7L14 3M7 16l10-10" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m4 18 6-6 4 4 3-6 4 7" /></>,
  object: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z" /><path d="m3 7 9 5 9-5M12 12v10" /></>,
  plot: <path d="M3 3v18h18M6 16l4-6 5 3 5-8" />,
  table: <><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 9h18M3 15h18M9 3v18" /></>,
  check: <path d="m5 12 5 5L20 7" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l5 3" /></>,
  warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.5" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  agent: <><rect x="4" y="6" width="16" height="14" rx="5" /><path d="M12 3v3M2 11v4m20-4v4M9 15h6M9 11h.1M15 11h.1" /></>,
  terminal: <path d="m5 6 5 6-5 6m9 0h5" />,
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" />,
  back: <path d="m14 6-6 6 6 6M8 12h13" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  link: <path d="m8 4 12 12m-16-4L12 4m0 16 8-8M4 12l8 8M7 9l8 8M9 7l8 8" />,
  studio: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 13h18M14 3v18" />
    </>
  ),
  file: <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h7M8 16h5" />,
  components: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M17.5 13v9M13 17.5h9" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" fill="white" />
      <circle cx="15" cy="17" r="3" fill="white" />
    </>
  ),
  folder: <path d="M3 6h7l2 2h9v12H3z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  reset: <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />,
  play: <path d="m8 5 11 7-11 7z" />,
};
export function Icon({ name, size = 16 }: { name: IconName | ExtraIcon; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
    >
      {paths[name]}
    </svg>
  );
}
