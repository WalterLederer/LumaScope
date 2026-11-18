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
  return date.toLocaleString();
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
