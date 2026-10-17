export type IconName = 'home' | 'project' | 'plugins' | 'sidebar' | 'context' | 'lock' | 'folder' | 'folder-plus' | 'plus' | 'chevron' | 'info' | 'close';
export function Icon({ name, size = 20, stroke = 1.6 }: { name: IconName; size?: number; stroke?: number }) {
  const paths = {
    home: 'm3 10 9-7 9 7v10h-6v-7H9v7H3z',
    project: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',
    plugins: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 17.5h7m-3.5-3.5v7',
    sidebar: 'M5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9A2.5 2.5 0 0 1 5.5 5zM9.5 5v14',
    context: 'M5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9A2.5 2.5 0 0 1 5.5 5zM14.5 5v14',
    lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5',
    plus: 'M12 4.5v15M4.5 12h15',
    chevron: 'M9 5.25 15.75 12 9 18.75',
    info: 'M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 1 0 0-19.2zM12 10.8v5.8M12 7.5v.2',
    close: 'm6 6 12 12M6 18 18 6',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round"><path d={paths[name]} /></svg>;
}
