export interface ReverseGeocodingResult {
  displayName: string;
  placeName: string;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  street: string | null;
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
    road?: string;
    pedestrian?: string;
    residential?: string;
    footway?: string;
    path?: string;
    cycleway?: string;
    living_street?: string;
    service?: string;
    track?: string;
    steps?: string;
    corridor?: string;
    busway?: string;
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
      if (!response.ok) {
        console.info('[ReverseGeocoding] Provider response', {
          status: response.status, statusText: response.statusText,
          durationMs: Date.now() - startedAt
        });
        throw new Error(`Nominatim returned HTTP ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as NominatimReverseResponse;
      const address = result.address ?? {};
      const streetFields = {
        road: address.road ?? null,
        pedestrian: address.pedestrian ?? null,
        residential: address.residential ?? null,
        footway: address.footway ?? null,
        path: address.path ?? null,
        cycleway: address.cycleway ?? null,
        living_street: address.living_street ?? null,
        service: address.service ?? null,
        track: address.track ?? null,
        steps: address.steps ?? null,
        corridor: address.corridor ?? null,
        busway: address.busway ?? null
      };
      console.info('[ReverseGeocoding] Provider response', {
        status: response.status, statusText: response.statusText,
        display_name: result.display_name ?? null,
        street: address.road ?? address.pedestrian ?? address.residential ?? address.footway ?? address.path
          ?? address.cycleway ?? address.living_street ?? address.service ?? address.track ?? address.steps
          ?? address.corridor ?? address.busway ?? null,
        streetFields,
        durationMs: Date.now() - startedAt
      });
      const displayName = result.display_name?.trim();
      if (!displayName) {
        console.warn('[ReverseGeocoding] Provider returned no display_name', { latitude, longitude });
        return null;
      }

      const locality = address.city ?? address.town ?? address.village
        ?? address.municipality ?? address.suburb ?? address.hamlet ?? address.county ?? null;
      const placeName = result.name?.trim() || locality || displayName;
      const street = address.road ?? address.pedestrian ?? address.residential
        ?? address.footway ?? address.path ?? address.cycleway ?? address.living_street
        ?? address.service ?? address.track ?? address.steps ?? address.corridor ?? address.busway ?? null;
      console.info('[ReverseGeocoding] Resolved location', {
        latitude, longitude, placeName,
        display_name: displayName,
        street, streetFields,
        countryCode: address.country_code?.toUpperCase() ?? null,
        durationMs: Date.now() - startedAt
      });

      return {
        displayName,
        placeName,
        countryCode: address.country_code?.toUpperCase() ?? null,
        region: address.state ?? address.region ?? address.state_district ?? null,
        locality,
        street
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
