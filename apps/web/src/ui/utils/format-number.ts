/**
 * Shared locale-aware number formatting.
 *
 * Intl.NumberFormat without an explicit locale uses the runtime's default
 * locale, allowing the host platform/browser to provide the appropriate
 * regional number conventions without platform-specific APIs.
 */
const numberFormatter = new Intl.NumberFormat();
const decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  options ? new Intl.NumberFormat(undefined, options).format(value) : numberFormatter.format(value);

export const formatDecimalNumber = (value: number): string => decimalFormatter.format(value);
