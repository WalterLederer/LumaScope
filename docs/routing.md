# Routing

[Back to README](../README.md) · [Feature guide](features.md)

## Overview

The Routing tab calculates a route between locations selected on the map. It supports local **Valhalla** routing and the online **openrouteservice** provider. Route waypoints are managed independently from ordinary GPX tracks; after a successful calculation, the returned route is saved as a GPX track and added to the Track list.

## Add and manage route points

1. Open the map **Routing** tab.
2. Right-click the map at each location you want to include. Points are added in the order selected.
3. Use the waypoint list to review and manage the points:
   - The numbered entries show each point's resolved place name and latitude/longitude.
   - The first and last entries are marked as the route start and end when at least two points exist.
   - Use the checkbox to include or temporarily exclude a point from route calculation. Excluded points remain in the list.
   - Use the up and down buttons to change the order.
   - Use **×** to remove an individual point.
   - Use **× All** to clear the complete waypoint list.
4. Use the map-points visibility checkbox beside **Calculate route…** to show or hide the waypoint markers on the map.

At least two active points are required. The openrouteservice provider accepts a maximum of 50 active waypoints per request. Inactive points are not sent to the routing provider.

The map context menu handler adds points only while the Routing tab is active, so right-clicking in other settings tabs does not add route waypoints.

## Route options

### Travel mode

Choose the profile used for route calculation:

- **Car** — driving profile.
- **Bicycle** — cycling profile.
- **Walking** — pedestrian profile.

The selected profile is sent to the chosen routing provider.

### Route name and save location

Enter a route name in **Route name**. LumaScope uses it as the base filename for the generated GPX file. Characters that are not valid in Windows filenames are replaced.

Use **Select save location…** to choose a folder for generated routes. The selected folder is remembered. If no folder is configured, LumaScope opens a Save File dialog when a route is calculated; the initial suggestion uses the folder of the most recently loaded file-backed GPX track when possible.

The generated filename includes a timestamp, for example:

`Route_2026-11-16_13-45-20-000.gpx`

The `.gpx` extension is added automatically when necessary.

## Routing providers

Open **Advanced** to select the routing provider.

### Offline Valhalla

Choose one of the available **Offline Valhalla** configurations. Valhalla calculates routes locally using its configuration and routing graph tiles.

- Add and manage Valhalla configuration entries in the **Offline** settings.
- Select an available configuration in **Routing provider**.
- The selected configuration must reference valid local Valhalla data, including the routing tiles and required supporting files.
- No online routing request is required for the route calculation.

A `valhalla.json` file by itself is not a routing dataset. The referenced tile data and supporting files must remain accessible.

### openrouteservice

Select **openrouteservice** to calculate routes using the online service.

- Enter your personal API key in the **openrouteservice API key** field.
- Use **Get API key** to open the provider's account page.
- An internet connection and a valid API key are required.
- The service currently accepts up to 50 active waypoints per request.

The API key is stored in the application's location UI settings. Treat it as a personal credential and do not share it in screenshots or exported configuration files.

## Calculate and save a route

1. Add at least two waypoints and make sure the desired points are active.
2. Select the travel mode.
3. Select and configure the routing provider under **Advanced**.
4. Set a route name and, optionally, a save folder.
5. Choose **Calculate route…**.

While the request is running, the button shows **Calculating…** and the status line reports the current operation. On success, LumaScope writes the returned route geometry to a GPX file, adds that file to the Track list, displays it on the map and fits the map to the new track. The status reports the output path and the number of geometry points returned by the provider.

If the provider returns an error, the status line displays the error. Check the provider selection, local Valhalla configuration and data availability, or the openrouteservice API key and network connection.

If the Save File dialog is cancelled, the calculated route is not written as a GPX file.

## Save and restore routing waypoints

LumaScope stores the current routing waypoint list in its location UI state, including each point's coordinates, resolved name and active/inactive state. The list can therefore be restored with the saved application settings.

When a calculated route is saved, LumaScope also embeds the original routing waypoints and their active states in a LumaScope-specific metadata comment in the GPX file. The GPX track geometry represents the route returned by the provider; the embedded metadata preserves the original input points, which may differ from the returned geometry.

To restore those input points from a previously calculated route:

1. Load the route GPX file in the **Track** tab.
2. Return to **Routing → Advanced**.
3. Choose **Read routing waypoints from GPX**.

The command reads the LumaScope routing metadata from the most recently loaded GPX file that contains it and replaces the current routing waypoint list. It restores coordinates, names and active states. Ordinary GPX files without this LumaScope metadata cannot restore the original routing waypoint list.

## Delete the last generated route

After a route has been saved, the **×** button beside the status message can delete the last saved route GPX file and remove it from the Track list. Use this only when you intend to remove that generated file; it is not a general cleanup command for other GPX tracks.

## Troubleshooting

- **No route points:** Right-click the map while the Routing tab is active.
- **Calculate route is disabled:** Add or activate at least two points. For openrouteservice, also enter an API key; more than 50 active points are not supported.
- **Valhalla configuration unavailable:** Check the configuration entry in Offline settings and confirm that its referenced routing tiles and supporting files exist.
- **openrouteservice request fails:** Check the API key, internet connection and service response shown in the status line.
- **Route is not saved:** Select a save folder or complete the Save File dialog. Cancelling that dialog leaves the calculated route unsaved.
- **Waypoint list needs restoring:** Load the previously generated route GPX in Track, then use **Read routing waypoints from GPX** under Routing → Advanced. This requires the LumaScope routing metadata embedded in that file.
