const fileTypeIconCache = new Map<string, Promise<string | null>>();

/**
 * Share native file-type icon lookups between the file list and Image view.
 * Windows may return an inconsistent association icon on a repeated lookup;
 * reusing the first lookup keeps the same file extension visually consistent.
 */
export const getCachedFileTypeIcon = (
  filePath: string,
  extension: string,
  load: (path: string) => Promise<string | null>
): Promise<string | null> => {
  const key = extension.toLowerCase() || '(no-extension)';
  let request = fileTypeIconCache.get(key);
  if (!request) {
    request = load(filePath).catch(() => null);
    fileTypeIconCache.set(key, request);
  }
  return request;
};
