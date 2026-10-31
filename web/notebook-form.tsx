import './notebook.css';
// The Notebook has two forms of the same sessions: as a notebook, each cell with who ran it and
// why, its code, output, plots and values; and as a console, one transcript of prompts and what
// they printed with the prompt under it, as in R or Python at a terminal. The person switches.
export type NotebookForm = 'notebook' | 'console';
export function FormSwitch({ form, onForm }: { form: NotebookForm; onForm: (form: NotebookForm) => void }) {
  return <div className="nb-tabs nb-form" role="group" aria-label="Show the sessions as">
    {(['notebook', 'console'] as const).map(f => <button key={f} type="button" aria-pressed={form === f} title={f === 'notebook' ? 'Each cell with who ran it, why, its output and plots' : 'One transcript of prompts and output, with the prompt under it'} onClick={() => onForm(f)}>{f === 'notebook' ? 'Notebook' : 'Console'}</button>)}
  </div>;
}
// The page's choice stays in this browser; a Studio view's is saved with its page.
const formKey = 'rho.notebook.form';
export function savedForm(): NotebookForm { try { return localStorage.getItem(formKey) === 'console' ? 'console' : 'notebook'; } catch { return 'notebook'; } }
export function saveForm(form: NotebookForm) { try { localStorage.setItem(formKey, form); } catch { /* the choice lasts for this page */ } }
