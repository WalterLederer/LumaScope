export interface ReverseGeocodingResult {
  displayName: string;
  placeName: string;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
}

interface NominatimReverseResponse {
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
  const request = requestQueue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({
      format: 'jsonv2',
      lat: String(latitude),
      lon: String(longitude),
      zoom: '18',
      addressdetails: '1'
    }).toString();

    const response = await fetch(url.toString(), {
      headers: { 'Accept-Language': language || 'en' }
    });
    if (!response.ok) throw new Error('Reverse geocoding request failed.');

    const result = await response.json() as NominatimReverseResponse;
    const placeName = result.display_name?.trim();
    if (!placeName) return null;

    const address = result.address ?? {};
    const locality = address.city ?? address.town ?? address.village
      ?? address.municipality ?? address.suburb ?? address.hamlet ?? address.county ?? null;

    return {
      displayName: placeName,
      placeName,
      countryCode: address.country_code?.toUpperCase() ?? null,
      region: address.state ?? address.region ?? address.state_district ?? null,
      locality
    };
  });

  requestQueue = request.then(() => undefined, () => undefined);
  return request;
};
