export type IconName = 'home' | 'project' | 'plugins' | 'sidebar' | 'context' | 'lock' | 'folder' | 'folder-plus' | 'plus' | 'chevron' | 'info' | 'close' | 'overview' | 'layout' | 'document' | 'table' | 'image' | 'file' | 'offline' | 'prompt' | 'refresh' | 'unlink' | 'enter' | 'check';
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
    overview: 'M4 6h16M4 12h16M4 18h10',
    layout: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4zM11 4v16M11 12h10',
    document: 'M6 3h8l4 4v14H6zM9 12h6M9 16h6',
    table: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 10h18M9 10v10',
    image: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 17l5-5 4 4 3-3 6 6',
    file: 'M6 3h8l4 4v14H6z',
    offline: 'M3 9.3a12.75 12.75 0 0 1 18 0M6.3 12.9a7.95 7.95 0 0 1 11.4 0M9.6 16.5a3.3 3.3 0 0 1 4.8 0M3.75 3.75l16.5 16.5',
    prompt: 'M6 7.5l4.5 4.5L6 16.5M12.75 17.25H18',
    refresh: 'M19.5 12a7.5 7.5 0 1 1-2.25-5.4M19.5 4.2v3.9h-3.9',
    unlink: 'M9.75 17.25 7.2 19.8a3.6 3.6 0 0 1-5.1-5.1l2.55-2.55M14.25 6.75l2.55-2.55a3.6 3.6 0 0 1 5.1 5.1l-2.55 2.55M4.5 4.5l15 15',
    enter: 'M18.9 6v5.5a2.6 2.6 0 0 1-2.6 2.6H6M9.4 10.3 5.5 14.1l3.9 3.9',
    check: 'M5.1 12.3 9.9 17.1 18.9 7.5',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round"><path d={paths[name]} /></svg>;
}
