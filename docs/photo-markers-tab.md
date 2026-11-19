# Photo Markers tab

The **Photo Markers** tab controls the display of photo-location markers on the map. Markers are based on photo records with GPS coordinates available to LumaScope.

## Show marker

Enable **Show marker** to display the available photo markers. Disable it to hide the photo markers without changing the underlying photo records.

The Summary disclosure (when markers are enabled) reports:
- The folder used for the photo-location query (or the active database/viewport scope when **Use all photos in DB** is enabled).
- The number of database records checked and the total record count.
- The number of GPS markers found.
- The minimum and maximum photo timestamps.
- The current marker-loading status.

## Use all photos in DB

Enable **Use all photos in DB** to include all eligible photos in the photo database rather than limiting markers to the current folder's photo set. The available marker set depends on the photo records and GPS coordinates indexed in the cache database.

## Cluster appearance

The **Cluster Icons** settings control how grouped photo markers appear:

- **Shape** selects the cluster symbol: Double circles, Hexagon, Circle or Square.
- **Color** selects the marker color. Choose one of the fixed colors or **Dynamic** to use varying colors, or choose **Off** to hide the marker color treatment.

These settings affect marker presentation on the map; they do not modify photo metadata or database records.

## Map display and opacity

The global **Markers** visibility control in the map overlay settings can hide or show marker overlays, and its opacity slider adjusts their transparency. This is separate from the Photo Markers tab's **Show marker** setting.

## Relationship to GPX tracks and time

Photo markers and GPX tracks are separate map layers. When timestamped photo markers and timestamped GPX points are available, the map time slider can filter them by the selected time range. Items without usable timestamps are not filtered by that time range.

## Export photo markers to GPX

The Track tab's **Marker -> GPX** section can export the currently displayed photo markers that have GPS coordinates to a GPX file. The export uses the available photo marker timestamps where present. It does not create GPS coordinates for photos that do not already have them.

## Troubleshooting

- **No markers appear:** enable **Show marker**, check that the photo records are indexed, and confirm that the photos have GPS coordinates.
- **Only some photos appear:** check whether **Use all photos in DB** is enabled and whether the relevant photos are present in the cache database.
- **Markers are hidden:** check the global Markers visibility control and its opacity setting.
- **No time range is available:** the time slider needs timestamped GPX points and/or photo markers.
