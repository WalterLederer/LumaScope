# Track tab

The **Track** tab manages GPX tracks displayed on the map. It supports loading GPX files directly and viewing tracks indexed in the drive-local cache database.

## Load GPX files

- Select **Add GPX files...** to choose GPX files for display.
- In the recent-files view, use **Select all** or **Deselect all** to change the active state of all listed tracks.
- Track rows provide per-track controls for visibility and appearance, including color, line style, width and direction arrows where available.
- Use the row actions to fit a track to the map, open or remove a recently loaded track, and copy its full path (the available actions depend on the list mode).

## Use GPX files from DB

Enable **Use GPX files from DB** to show database tracks intersecting the current map viewport.

- The database view is based on GPX tracks imported into the cache database for the relevant drive.
- The map viewport determines which stored tracks are listed; change the map area and refresh the list to inspect another area.
- **Show recently loaded GPX files** returns to the session's recently loaded GPX list.
- The DB list includes controls for active state and track appearance. Available row actions include fitting the track and copying its path.
- The **Columns** disclosure lets you show or hide optional metadata columns such as Points, Track time, File size, Date and Path.
- Column headers can be used to sort the displayed rows. Column widths can be adjusted with the header separators.

## Map display

Track visibility is controlled per track in the list and globally by the Track visibility control in the map overlay settings. Track opacity can be adjusted separately. The map must be displaying a compatible map view for the track geometry to be visible.

## GPX database import

Use the GPX database import controls in the Location tab's Track/Advanced area to index GPX files from a folder. The database stores timestamped track points and segment information for later viewport queries and automatic photo location matching. Importing tracks into the database is separate from loading a GPX file into the current map session.

## Tips

- Use the database mode when working with a large GPX collection and want to list tracks relevant to the current map area.
- Use the recent-files mode for tracks loaded directly during the current session.
- A track can contain multiple segments. Segment boundaries are meaningful; tools that interpolate positions must not bridge separate segments.
- If a track is missing or cannot be read, check the file path and file availability.
