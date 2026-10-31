import { languageNames, type Language } from './explore.js';
import { Icon } from './icons.js';

// Where a result or a script offers its exploration in the Notebook: one button per language
// that can read it. The name of what it opens comes first, so the buttons read as one phrase.
export function ExploreIn({ languages, busy, title, onExplore }: { languages: Language[]; busy?: boolean; title: (language: Language) => string; onExplore: (language: Language) => void }) {
  return <span className="explore-in" role="group" aria-label="Explore in the Notebook">
    <Icon name="code" size={13} stroke={2} /><span className="explore-in-label">Explore in</span>
    {languages.map(language => <button key={language} type="button" disabled={busy} title={title(language)} onClick={() => onExplore(language)}>{languageNames[language]}</button>)}
  </span>;
}
