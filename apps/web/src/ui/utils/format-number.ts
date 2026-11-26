/**
 * Shared locale-aware number formatting.
 *
 * The locale is supplied by Electron's cross-platform system-locale API so
 * renderer formatting does not depend on Chromium's independently resolved
 * default locale.
 */
let numberLocale: string | undefined;
let numberFormatter = new Intl.NumberFormat();
let decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

export const setNumberLocale = (locale: string): void => {
  if (typeof locale !== 'string' || !locale.trim()) return;
  try {
    const nextNumberFormatter = new Intl.NumberFormat(locale);
    const nextDecimalFormatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    numberLocale = nextNumberFormatter.resolvedOptions().locale;
    numberFormatter = nextNumberFormatter;
    decimalFormatter = nextDecimalFormatter;
  } catch (error) {
    console.warn('[NumberFormat] Could not apply system locale; keeping runtime default.', { locale, error });
  }
};

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  options ? new Intl.NumberFormat(numberLocale, options).format(value) : numberFormatter.format(value);

export const formatDecimalNumber = (value: number): string => decimalFormatter.format(value);
