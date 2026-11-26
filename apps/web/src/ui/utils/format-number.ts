import type { WindowsNumberFormatSettings } from 'internal-api';

/**
 * Uses the user's Windows regional number settings, including custom
 * decimal/group separators. Other platforms use the runtime locale.
 */
let numberSettings: WindowsNumberFormatSettings | null = null;
let numberFormatter = new Intl.NumberFormat(undefined);
let decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

const applyWindowsSeparators = (parts: Intl.NumberFormatPart[]): string => parts.map(part => {
  if (!numberSettings) return part.value;
  if (part.type === 'group') return numberSettings.groupSeparator;
  if (part.type === 'decimal') return numberSettings.decimalSeparator;
  return part.value;
}).join('');

export const setNumberLocale = (settings: WindowsNumberFormatSettings | null): void => {
  try {
    const locale = settings?.locale || undefined;
    const nextNumberFormatter = new Intl.NumberFormat(locale);
    const nextDecimalFormatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    numberSettings = settings;
    numberFormatter = nextNumberFormatter;
    decimalFormatter = nextDecimalFormatter;
  } catch (error) {
    console.warn('[NumberFormat] Invalid regional locale; keeping runtime default.', error);
  }
};

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string => {
  const formatter = options ? new Intl.NumberFormat(numberSettings?.locale, options) : numberFormatter;
  return applyWindowsSeparators(formatter.formatToParts(value));
};

export const formatDecimalNumber = (value: number): string =>
  applyWindowsSeparators(decimalFormatter.formatToParts(value));
