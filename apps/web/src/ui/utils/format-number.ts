/**
 * Formats numeric values using the user's regional number-format settings.
 * On Windows the locale is read from HKCU\\Control Panel\\International
 * during renderer startup; other platforms retain the runtime default.
 */
let numberLocale: string | undefined;
let numberFormatter = new Intl.NumberFormat(undefined);
let decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

export const setNumberLocale = (locale: string | null): void => {
  const nextLocale = typeof locale === 'string' && locale.trim() ? locale.trim() : undefined;
  try {
    const nextNumberFormatter = new Intl.NumberFormat(nextLocale);
    const nextDecimalFormatter = new Intl.NumberFormat(nextLocale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    numberLocale = nextLocale;
    numberFormatter = nextNumberFormatter;
    decimalFormatter = nextDecimalFormatter;
  } catch (error) {
    console.warn('[NumberFormat] Invalid regional locale; keeping runtime default.', error);
  }
};

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  options ? new Intl.NumberFormat(numberLocale, options).format(value) : numberFormatter.format(value);

export const formatDecimalNumber = (value: number): string => decimalFormatter.format(value);
