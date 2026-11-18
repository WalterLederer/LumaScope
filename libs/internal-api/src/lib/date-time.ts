/**
 * Formats a date/time using the operating system's active locale and regional
 * date/time conventions. No application-specific locale or date pattern is
 * imposed here.
 */
export const formatOsDateTime = (
  value: Date | number | string | null | undefined,
  fallback = '—',
  style: 'regional' | 'compact' = 'regional'
): string => {
  if (value === null || value === undefined) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  if (style === 'regional') return date.toLocaleString();

  // Keep the operating system's regional date-field order, but use a compact
  // dotted date and a 24-hour time without the locale's comma separator.
  const parts = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const dateParts = parts.filter(part => part.type === 'day' || part.type === 'month' || part.type === 'year');
  const timeParts = parts.filter(part => part.type === 'hour' || part.type === 'minute' || part.type === 'second');
  if (dateParts.length !== 3 || timeParts.length !== 3) return date.toLocaleString();
  return dateParts.map(part => part.value).join('.') + ' ' + timeParts.map(part => part.value).join(':');
};

/**
 * Formats a single GPS coordinate with its cardinal direction.
 */
export const formatGpsCoordinate = (
  value: number | null | undefined,
  positiveDirection: string,
  negativeDirection: string,
  precision = 6
): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.abs(value).toFixed(precision)}° ${value >= 0 ? positiveDirection : negativeDirection}`;
};

/**
 * Formats a latitude/longitude pair consistently throughout the application.
 */
export const formatGpsCoordinates = (
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  precision = 6
): string => {
  if (latitude === null || latitude === undefined || !Number.isFinite(latitude)
    || longitude === null || longitude === undefined || !Number.isFinite(longitude)) return '—';
  return `${formatGpsCoordinate(latitude, 'N', 'S', precision)}, ${formatGpsCoordinate(longitude, 'E', 'W', precision)}`;
};
