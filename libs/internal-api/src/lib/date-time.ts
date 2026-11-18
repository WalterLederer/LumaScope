/**
 * Formats a date/time using the operating system's active locale and regional
 * date/time conventions. No application-specific locale or date pattern is
 * imposed here.
 */
export const formatOsDateTime = (
  value: Date | number | string | null | undefined,
  fallback = '—'
): string => {
  if (value === null || value === undefined) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
};
