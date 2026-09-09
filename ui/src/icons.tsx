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
const paths: Record<IconName, React.ReactNode> = {
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
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
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
