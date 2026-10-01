/** A suggested browser download name is a basename, never a filesystem path. */
export function downloadFilename(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value === '.' || value === '..' ||
      /[\p{Cc}/\\:]/u.test(value) || new TextEncoder().encode(value).length > 240)
    throw new Error('Choose a filename without a directory path or control characters.');
  return value;
}
