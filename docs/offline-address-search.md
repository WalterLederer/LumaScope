# Offline address search

The **Offline address search** section in the Location tab searches address data contained in enabled, available OsmAnd OBF map files. It works locally with the configured offline map files and does not use an online geocoding service.

## Prerequisites

- Add the required OsmAnd `.obf` map files in **Offline Files**.
- Enable the map files that should be searched.
- Make sure the files are available at their configured paths. Disabled, unavailable, or non-OBF map sources are not searched.

## Search workflow

1. Open **Location → Offline address search**.
2. Enter at least two characters in the search field. You can enter a street, house number, city, postcode, or a combination.
3. Select **Search** or press Enter.
4. The result list displays matching address descriptions and their latitude/longitude coordinates.
5. Select a result to move the map to that location. The map is centered on the selected coordinates and zoomed to at least level 15 (or kept at the current zoom if it is already closer).

## Search scope and results

- Only enabled, available OsmAnd OBF files are passed to the offline address search.
- Other offline formats, such as MBTiles or MapsForge maps, are not address-search sources.
- Search results are shown in the result table. If no result matches, the interface reports that no matching address was found in the enabled OBF files.
- Search errors, including the case where no eligible OBF files are configured, are displayed in the Location panel.
- The result table is scrollable when it contains more entries than fit in the available space.

## Troubleshooting

- **No enabled and available OsmAnd OBF files:** add or enable an OBF file in Offline Files and verify that its path exists.
- **No matching address:** try a shorter or more specific query, check spelling, or enable an OBF file that covers the requested area.
- **Unexpectedly incomplete results:** verify that all relevant regional OBF files are enabled and available. The search cannot return address data that is not present in those files.

## Offline operation

The search is based on the address information packaged in the local OBF files. It does not download map data, contact an online address provider, or automatically fall back to an online search.
