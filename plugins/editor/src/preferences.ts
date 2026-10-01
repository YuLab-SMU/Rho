export interface EditorPreferences { font_size: 12 | 14 | 16 | 18; indent_width: 2 | 4 | 8; }
export const defaultPreferences: EditorPreferences = { font_size: 14, indent_width: 4 };
export function editorPreferences(value: unknown): EditorPreferences {
  const prefs = value as EditorPreferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || Object.keys(prefs).some(key => !['font_size', 'indent_width'].includes(key)) ||
    ![12, 14, 16, 18].includes(prefs.font_size) || ![2, 4, 8].includes(prefs.indent_width)) throw new Error('Choose a supported code font size and indent width.');
  return { font_size: prefs.font_size, indent_width: prefs.indent_width };
}
