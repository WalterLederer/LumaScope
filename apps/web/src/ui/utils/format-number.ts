/**
 * Formats numeric values with the operating system's current locale.
 * Do not pass a fixed locale: the browser/Electron runtime resolves the
 * user's regional number separators and grouping conventions.
 */
const numberFormatter = new Intl.NumberFormat(undefined);
const decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

export const formatNumber = (value: number): string => numberFormatter.format(value);

export const formatDecimalNumber = (value: number): string => decimalFormatter.format(value);
