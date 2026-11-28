import { Desktop, lookupReverseGeocoding } from 'internal-api';

export interface ReverseGeocodingDisplay {
  text: string;
  offlineParts: Array<{ label: string; value: string }>;
  onlineParts: Array<{ label: string; value: string }>;
  comments: string[];
}

export function formatManualGpsPosition(latitude: number, longitude: number): string {
  const dms = (value: number, positive: string, negative: string, digits: number): string => {
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute);
    const minutesFloat = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesFloat);
    const seconds = (minutesFloat - minutes) * 60;
    return String(degrees).padStart(digits, '0') + '° ' + String(minutes).padStart(2, '0') + '′ ' + seconds.toFixed(2).padStart(5, '0') + '″ ' + (value < 0 ? negative : positive);
  };
  const decimal = (value: number, positive: string, negative: string): string => Math.abs(value).toFixed(5) + '° ' + (value < 0 ? negative : positive);
  return dms(latitude, 'N', 'S', 2) + ', ' + dms(longitude, 'E', 'W', 3) + ' | Decimal: ' + decimal(latitude, 'N', 'S') + ', ' + decimal(longitude, 'E', 'W');
}

export function formatCoordinateDms(value: number, latitude: boolean): string {
  const hemisphere = latitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesFull = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = ((minutesFull - minutes) * 60).toFixed(2).padStart(5, '0');
  return `${degrees}° ${String(minutes).padStart(2, '0')}′ ${seconds}″ ${hemisphere}`;
}

export function calculateGpsDistanceMeters(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (latitudeB - latitudeA) * radians;
  const longitudeDelta = (longitudeB - longitudeA) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA * radians) * Math.cos(latitudeB * radians)
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export class ReverseGeocodingManager {
  constructor(
    private readonly desktop: Desktop | undefined,
    private readonly lookupOnline: typeof lookupReverseGeocoding,
    private readonly onOfflineRequestChange: (delta: number) => void,
    private readonly onOnlineRequestChange: (delta: number) => void
  ) {}

  async lookupBothReverseGeocoders(latitude: number, longitude: number, useOnline: boolean, language: string): Promise<ReverseGeocodingDisplay> {
    const offlineLookup = this.desktop
      ? (() => {
          this.onOfflineRequestChange(1);
          return Promise.resolve().then(() => this.desktop!.OsmAndAtlas.reverseGeocode(latitude, longitude, language));
        })()
        .then(async result => {
          if (!result.found) return { text: 'No result', offlineParts: [], comments: [] };

          // OsmAnd supplies the street/place hierarchy; Valhalla's SpatiaLite
          // admin polygons provide the country and state through true
          // point-in-polygon checks.
          let valhallaAreas: Array<{ admin_level: number; name: string }> = [];
          try {
            const status = await this.desktop!.Valhalla.getRuntimeStatus();
            if (status.configAvailable) {
              const lookup = await this.desktop!.Valhalla.lookupAdminAreas(latitude, longitude);
              if (lookup.available) {
                valhallaAreas = lookup.admin_areas
                  .filter(area => area.admin_level === 2 || area.admin_level === 4)
                  .map(area => ({ admin_level: area.admin_level, name: area.name }));
              }
            }
          } catch {
            // Keep the OsmAnd result usable when Valhalla is not configured
            // or its optional administrative database cannot be queried.
          }

          const areas = [
            ...(result.administrative_areas ?? []).filter(area => area.admin_level !== 2 && area.admin_level !== 4),
            ...valhallaAreas
          ];
          const areaForLevel = (level: number): string => areas
            .filter(area => area.admin_level === level)
            .map(area => area.name.trim())
            .filter(Boolean)[0] ?? '';
          const place = result.place.trim();
          const municipality = areaForLevel(8);
          const knownLevels = new Set([2, 4, 6, 8, 9]);
          const otherAreas = areas
            .filter(area => !knownLevels.has(area.admin_level))
            .map(area => area.name.trim())
            .filter(Boolean);
          const parts = [
            { label: 'Street', value: result.street.trim() },
            { label: 'House number', value: result.building.trim() },
            { label: 'Place', value: place },
            { label: 'Municipality', value: municipality && municipality.toLocaleLowerCase() !== place.toLocaleLowerCase() ? municipality : '' },
            { label: 'District', value: areaForLevel(6) },
            { label: 'State', value: areaForLevel(4) },
            { label: 'Postcode', value: result.postcode.trim() },
            { label: 'Country', value: areaForLevel(2) },
            { label: 'Other regions', value: otherAreas.join(', ') }
          ];
          const addressParts = [
            result.building,
            result.street,
            result.place,
            result.postcode,
            areaForLevel(6),
            ...otherAreas,
            areaForLevel(4)
          ];
          const uniqueParts: string[] = [];
          const seenParts = new Set<string>();
          for (const part of addressParts) {
            const value = part.trim();
            const key = value.toLocaleLowerCase();
            if (!value || seenParts.has(key)) continue;
            seenParts.add(key);
            uniqueParts.push(value);
          }
          const address = uniqueParts.join(', ') || 'No address details available';
          const diagnostics = result.diagnostics;
          const lineSamples = diagnostics.boundary_line_samples
            .map(sample => `L${sample.admin_level}:${sample.first}→${sample.last}(${sample.point_count})${sample.name ? `[${sample.name}]` : ''}`)
            .join(',');
          const lineRelationGroups = diagnostics.boundary_line_relation_groups
            .map(group => `L${group.admin_level}/${group.is_relation ? 'R' : 'W'}${group.osm_id || '-'}:segments=${group.line_segments},ends=${group.unique_endpoints},dangling=${group.dangling_endpoints},degree2=${group.degree_two_endpoints},branch=${group.branch_or_duplicate_endpoints},split=${group.has_split_ids ? 'yes' : 'no'}${group.name ? `[${group.name}]` : ''}`)
            .join(';');
          const targetLineRelationGroups = diagnostics.target_boundary_line_relation_groups
            .map(group => `L${group.admin_level}/${group.is_relation ? 'R' : 'W'}${group.osm_id || '-'}:segments=${group.line_segments},ends=${group.unique_endpoints},dangling=${group.dangling_endpoints},degree2=${group.degree_two_endpoints},branch=${group.branch_or_duplicate_endpoints},split=${group.has_split_ids ? 'yes' : 'no'}${group.name ? `[${group.name}]` : ''}`)
            .join(';');
          const targetLineSegments = diagnostics.target_boundary_line_segments
            .map(segment => `L${segment.admin_level}/${segment.is_relation ? 'R' : 'W'}${segment.osm_id || '-'}:id=${segment.raw_id},key=${segment.object_key || '-'},split=${segment.is_split ? 'yes' : 'no'},area=${segment.is_area ? 'yes' : 'no'},closed=${segment.is_closed_figure ? 'yes' : 'no'},points=${segment.point_count},${segment.first}→${segment.last},bbox=${segment.bbox}${segment.name ? `[${segment.name}]` : ''}`)
            .join(';');
          const addressSectionRegions = diagnostics.address_section_regions
            .map(region => `${region.name}[contains=${region.contains_point ? 'yes' : 'no'},bbox=${region.bbox31.join(',')}]`)
            .join(';');
          const helperInfo = `OsmAnd offline helper v${result.helper_version}; SDK=${result.osmand_sdk_revision}; addressSections=${addressSectionRegions || '-'}; target_segments=${targetLineSegments || '-'}; areas=${diagnostics.resolved_administrative_areas}; target_relation_groups=${diagnostics.target_boundary_line_relation_group_count}; target_relation_details=${targetLineRelationGroups || '-'}; mapObjects=${diagnostics.loaded_map_objects}; adminBoundaries=${diagnostics.administrative_boundary_objects}; addressBoundaries=${diagnostics.matching_address_boundary_groups}/${diagnostics.loaded_address_boundary_groups}; idMatches=${diagnostics.matched_address_boundary_object_ids}; mapIds=${diagnostics.map_boundary_object_ids.join(',') || '-'}; addressIds=${diagnostics.address_boundary_object_ids.join(',') || '-'}; matchedIds=${diagnostics.matched_boundary_object_ids.join(',') || '-'}; boundarySearchArea=${diagnostics.boundary_search_area_available ? 'yes' : 'no'}; lineDiagnostics=${diagnostics.boundary_line_diagnostics_enabled ? 'on' : 'off'}; boundary_line_counts=${JSON.stringify(diagnostics.boundary_line_counts)}; boundary_line_relation_group_count=${diagnostics.boundary_line_relation_group_count}; boundary_line_relation_groups=${lineRelationGroups}; boundary_geometry_points=${diagnostics.boundary_geometry_points}; boundary_area_objects=${diagnostics.boundary_area_objects}; boundary_line_samples=${JSON.stringify(lineSamples)}`;
          return {
            text: `${address} (${helperInfo})`,
            offlineParts: parts,
            comments: result.selection_comments ?? []
          };
        })
        .catch(error => ({
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          offlineParts: [],
          comments: []
        }))
        .finally(() => this.onOfflineRequestChange(-1))
      : Promise.resolve({ text: 'Unavailable', offlineParts: [], comments: [] });
    const onlineLookup = useOnline
      ? (() => {
          this.onOnlineRequestChange(1);
          return Promise.resolve().then(() => this.lookupOnline(latitude, longitude, language));
        })()
          .then(result => ({
            text: result?.displayName?.trim() || 'No result',
            parts: result ? [
              { label: 'Street', value: result.street ?? '' },
              { label: 'House number', value: result.houseNumber ?? '' },
              { label: 'Place', value: result.locality && result.locality !== result.municipality && result.locality !== result.district ? result.locality : '' },
              { label: 'Municipality', value: result.municipality ?? '' },
              { label: 'District', value: result.district ?? '' },
              { label: 'State', value: result.region ?? '' },
              { label: 'Postcode', value: result.postcode ?? '' },
              { label: 'Country', value: result.country ?? '' },
              { label: 'Other regions', value: '' }
            ] : []
          }))
          .catch(error => ({
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            parts: []
          }))
          .finally(() => this.onOnlineRequestChange(-1))
      : Promise.resolve({ text: '', parts: [] });
    const [offline, online] = await Promise.all([offlineLookup, onlineLookup]);
    return {
      text: useOnline
        ? `Offline: ${offline.text}\nOnline: ${online.text}`
        : `Offline: ${offline.text}`,
      offlineParts: offline.offlineParts,
      onlineParts: useOnline ? online.parts : [],
      comments: offline.comments
    };
  }
}
