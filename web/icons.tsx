export function Icon({ name }: { name: 'home' | 'project' | 'plugins' | 'panel' | 'arrow' | 'close' }) {
  const paths = {
    home: 'm3 10 9-7 9 7v10h-6v-7H9v7H3z',
    project: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',
    plugins: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 17.5h7m-3.5-3.5v7',
    panel: 'M3 4h18v16H3zM9 4v16',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    close: 'm6 6 12 12M6 18 18 6',
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d={paths[name]} /></svg>;
}
