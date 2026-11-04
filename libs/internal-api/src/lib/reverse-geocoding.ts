export interface ReverseGeocodingResult {
  displayName: string;
  placeName: string;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
}

interface NominatimReverseResponse {
  name?: string;
  display_name?: string;
  address?: {
    country_code?: string;
    state?: string;
    region?: string;
    state_district?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    suburb?: string;
    hamlet?: string;
    county?: string;
  };
}

let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Resolve GPS coordinates through the same Nominatim reverse-geocoding
 * endpoint used by the Location window. Requests are serialized and spaced
 * at least one second apart to respect the public Nominatim service policy.
 */
export const lookupReverseGeocoding = (
  latitude: number,
  longitude: number,
  language = 'en'
): Promise<ReverseGeocodingResult | null> => {
  const queuedAt = Date.now();
  console.debug('[ReverseGeocoding] Queued request', { latitude, longitude, language });
  const request = requestQueue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastRequestAt));
    if (wait > 0) {
      console.debug('[ReverseGeocoding] Waiting for provider rate limit', { waitMs: wait, latitude, longitude });
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    lastRequestAt = Date.now();
    const startedAt = Date.now();

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({
      format: 'jsonv2',
      lat: String(latitude),
      lon: String(longitude),
      zoom: '18',
      addressdetails: '1'
    }).toString();

    console.info('[ReverseGeocoding] Request started', {
      latitude, longitude, queueWaitMs: startedAt - queuedAt, url: url.toString()
    });
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'LumaScope/1.0 (+https://github.com/WalterLederer/light-matter)',
          'Accept-Language': language || 'en'
        },
        signal: AbortSignal.timeout(15000)
      });
      console.info('[ReverseGeocoding] Provider response', {
        status: response.status, statusText: response.statusText,
        durationMs: Date.now() - startedAt
      });
      if (!response.ok) throw new Error(`Nominatim returned HTTP ${response.status} ${response.statusText}`);

      const result = await response.json() as NominatimReverseResponse;
      const displayName = result.display_name?.trim();
      if (!displayName) {
        console.warn('[ReverseGeocoding] Provider returned no display_name', { latitude, longitude });
        return null;
      }

      const address = result.address ?? {};
      const locality = address.city ?? address.town ?? address.village
        ?? address.municipality ?? address.suburb ?? address.hamlet ?? address.county ?? null;
      const placeName = result.name?.trim() || locality || displayName;
      console.info('[ReverseGeocoding] Resolved location', {
        latitude, longitude, placeName, countryCode: address.country_code?.toUpperCase() ?? null,
        durationMs: Date.now() - startedAt
      });

      return {
        displayName,
        placeName,
        countryCode: address.country_code?.toUpperCase() ?? null,
        region: address.state ?? address.region ?? address.state_district ?? null,
        locality
      };
    } catch (error) {
      console.error('[ReverseGeocoding] Request failed', {
        latitude, longitude, durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });

  requestQueue = request.then(() => undefined, () => undefined);
  return request;
};
