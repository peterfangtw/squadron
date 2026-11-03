/** Opening policy after the host has forced a target through Uri.file. */
export function writtenFileOpener(file: {
  extension: string;
  authority: string;
}): 'markdown' | 'external' | 'editor' {
  if (file.extension === '.md') return 'markdown';
  // OS shell opens bypass the file service's UNC host restrictions.
  if (!file.authority && (file.extension === '.html' || file.extension === '.htm'))
    return 'external';
  return 'editor';
}
