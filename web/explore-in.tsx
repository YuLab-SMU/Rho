import { languageNames, type Language } from './explore.js';
import { Icon } from './icons.js';

// Where a result or a script offers its exploration in the Notebook. One language is one
// button that says the whole phrase; more read as a phrase with a button per language.
export function ExploreIn({ languages, busy, title, onExplore }: { languages: Language[]; busy?: boolean; title: (language: Language) => string; onExplore: (language: Language) => void }) {
  if (languages.length === 1) {
    const [language] = languages;
    return <button type="button" className="explore-in explore-in-one" disabled={busy} title={title(language)} onClick={() => onExplore(language)}>
      <Icon name="code" size={13} stroke={2} />Explore in {languageNames[language]}</button>;
  }
  return <span className="explore-in" role="group" aria-label="Explore in the Notebook">
    <Icon name="code" size={13} stroke={2} /><span className="explore-in-label">Explore in</span>
    {languages.map(language => <button key={language} type="button" className="explore-in-language" disabled={busy} title={title(language)} onClick={() => onExplore(language)}>{languageNames[language]}</button>)}
  </span>;
}
