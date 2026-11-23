# Manual photo location correction

The **Fix location MANUAL** section in the Fix tab assigns a geographic position to the currently selected photo by using the map crosshair.

## Workflow

1. Select the photo whose GPS position needs correction.
2. Open **Location → Location tools**.
3. Enable **Show crosshair**. The same setting is also available in **View → View settings**; both checkboxes stay synchronized. The crosshair is fixed at the map centre.
4. Pan the active map until the crosshair is positioned over the photo's actual location. The currently selected online or offline map source is used; this operation does not switch map sources.
5. In **Location → Location tools**, optionally select **Show address** in the Crosshair row to resolve the crosshair position, or **Show address** in the Photo row to resolve the selected photo's existing GPS coordinates.
6. Address lookup uses the enabled local OsmAnd OBF maps first and falls back to the online reverse-geocoding provider when no offline result is available. The lookup is read-only: it does not write a location record to the cache database.
7. Select **Update GPS infos in file...** to write the crosshair latitude and longitude to the selected image's GPS EXIF metadata.

## Important behaviour

- This is a manual correction of the currently selected image; it does not search GPX tracks or infer a location from the photo timestamp.
- Only the selected image is updated. Other photos in the folder are not processed.
- The map crosshair is a positioning aid; the map itself is not moved to the photo's existing coordinates when you pan it.
- The map source must be available and initialized for the displayed map to provide useful geographic context.
- The operation writes GPS information to the image file. Keep an independent backup of important originals before editing metadata.
- Use **Fix location AUTOMATIC** instead when many photos should be matched to previously imported, timestamped GPX tracks.
