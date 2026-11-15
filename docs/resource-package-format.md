# Offline resource package format

[Back to README](../README.md)

This page describes the **external map and routing data folder** selected with **Open resource package…** in the **OfflineFiles** tab. It is a data-layout guide for files that LumaScope discovers and uses at runtime. It is not a build guide: compiling LumaScope, its native helpers or the Mapsforge renderer is covered separately in [Build from source](build-from-source.md).

## 1. What the resource package is

A resource package is an ordinary directory tree on a local drive. It is not a special archive format, installer, database or single proprietary file. You may assemble it yourself from independently downloaded map files, render styles, hillshade databases and Valhalla routing data.

The folder chosen in **Open resource package…** is scanned recursively. The scanner recognises files by extension **and**, for several formats, by their parent folder names. The directory names below are therefore significant.

A practical layout is:

```text
ResourcePackage/
├── OsmAnd/
│   ├── files/
│   │   ├── Austria.obf
│   │   └── Germany.obf
│   ├── tiles/
│   │   ├── Hillshade Austria.sqlitedb
│   │   └── Hillshade Alps.sqlitedb
│   └── resources/
│       └── rendering_styles/
│           ├── default.render.xml
│           ├── topo.render.xml
│           └── ...
├── Mapsforge/
│   ├── maps/
│   │   ├── austria.map
│   │   └── germany.map
│   └── theme/
│       ├── Elevate/
│       │   └── Elevate.xml
│       └── my-custom-theme.xml
├── MBTiles/
│   └── region-vector.mbtiles
└── OpenStreetMap/
    └── Valhalla/
        └── Austria/
            ├── valhalla.json
            └── ... Valhalla graph tiles and supporting data ...
```

This is an example, not a requirement to include every format. You can use different folder names for the top-level package and for the MBTiles folder. Keep the required path segments `OsmAnd/files`, `OsmAnd/tiles`, `Mapsforge`, `Mapsforge/theme` and `OpenStreetMap` where shown.

## 2. What the scanner recognises

| Resource | File extension | Required folder placement / recognition |
| --- | --- | --- |
| OsmAnd vector map | `.obf` | A path containing both `OsmAnd` and `files` |
| Hillshade / SQLite tile database | `.sqlitedb`, `.sqlite`, `.db` | A path containing both `OsmAnd` and `tiles` |
| Mapsforge vector map | `.map` | A path containing `Mapsforge` |
| Vector MBTiles | `.mbtiles` | Any folder below the selected package |
| OsmAnd render resources | Folder | A directory containing a child directory named `rendering_styles` |
| Mapsforge XML themes | `.xml` | XML files under a directory named `theme` somewhere below `Mapsforge` |
| Valhalla configuration | `.json` | A JSON file under `OpenStreetMap` whose JSON object contains a top-level `mjolnir` property |

The scan is a discovery pass. Finding a file does not guarantee that its contents are valid, that its geographic coverage is useful, or that all runtime dependencies are present. The **Check** action and the renderer-specific validation report missing or unsupported resources.

Folder-based resources are also listed directly in the OfflineFiles file table. Their **Path** is the containing resource folder, and **File size** is the recursive total of all files below that folder. Valhalla rows use the configuration's parent folder name (for example, **Austria** or **Europe**); the OsmAnd resources row has an empty **File** value; Mapsforge theme rows use each XML theme's filename without the extension (for example, **Elements** or **Elevate**). These rows are informational resource entries and do not have map activation or coverage controls.

## 3. OsmAnd vector maps — OBF

### Folder and filenames

Place each OsmAnd vector map directly in, or in a subfolder below:

```text
ResourcePackage/OsmAnd/files/
```

Examples:

```text
OsmAnd/files/Austria.obf
OsmAnd/files/Europe/Austria.obf
OsmAnd/files/Europe/Germany.obf
```

The extension must be `.obf`. A ZIP file containing an OBF is not itself an OBF map: extract the archive first. The scanner specifically looks for `.obf` files whose path contains the two directory segments `OsmAnd` and `files`.

### Download sources

- [OsmAnd map downloads](https://download.osmand.net/) — official download service and documentation entry point for regional offline maps.
- [OsmAnd: Download maps](https://osmand.net/docs/user/start-with/download-maps/) — explains regional map downloads and map types.
- [Geofabrik downloads](https://download.geofabrik.de/) — regional OpenStreetMap source extracts in `.osm.pbf` format. These are source data, **not** ready-to-use OBF files.

The most straightforward route is to obtain a ready-made OBF map from an OsmAnd-compatible source. Observe that map availability, naming, coverage and licensing may differ by region and provider.

### Create your own OBF

OsmAnd documents creating vector maps with **OsmAndMapCreator**:

1. Download an `.osm.pbf` extract for the desired region from Geofabrik, or prepare a valid OSM XML/PBF extract yourself.
2. Download [OsmAndMapCreator](https://osmand.net/docs/technical/map-creation/create-offline-maps-yourself/).
3. Open the source extract in OsmAndMapCreator.
4. Select the map data types to include (for example, map, address, transport and routing data as appropriate).
5. Use **File → Create .obf from file**.
6. Copy the resulting `.obf` file into `OsmAnd/files/` and run the resource-package scan again.

See the official [OsmAnd map-creation guide](https://www.osmand.net/docs/technical/map-creation/create-offline-maps-yourself/) for the current tool workflow and command-line options.

### Important distinction

An OBF map is map data. It does not replace the external OsmAnd rendering resources described in the next section. A map can be discovered while its labels, symbols or selected rendering style are unavailable.

## 4. OsmAnd resources and rendering styles

### Required directory shape

Select or place the extracted OsmAnd resources repository so that the following structure exists:

```text
OsmAnd/resources/
└── rendering_styles/
    ├── default.render.xml
    ├── topo.render.xml
    ├── LightRS.render.xml
    └── ...
```

The important marker is the **rendering_styles** subdirectory. LumaScope recognises a resource root when it contains that directory. You may also choose the `rendering_styles` directory itself; in that case its parent directory is treated as the resource root.

The resource package does not have to contain `default.render.xml` specifically for the directory to be discovered, but it must contain usable `.render.xml` style files for a style to appear in the OsmAnd style selector. The standard OsmAnd repository includes `default.render.xml` and additional styles, some of which depend on the default style.

### Download

- [OsmAnd-resources on GitHub](https://github.com/osmandapp/OsmAnd-resources) — official repository.
- [Rendering styles directory](https://github.com/osmandapp/OsmAnd-resources/tree/master/rendering_styles) — individual XML style files and their descriptions.
- [Rendering styles README](https://github.com/osmandapp/OsmAnd-resources/blob/master/rendering_styles/readme.md) — describes the available styles and dependencies.

Download OsmAnd resources separately from [OsmAnd-resources on GitHub](https://github.com/osmandapp/OsmAnd-resources). Use **Code → Download ZIP** or clone the repository, then place the extracted resources folder containing `rendering_styles/default.render.xml` inside your resource package before scanning. If you download the full repository, select the extracted `OsmAnd-resources` directory; its `rendering_styles` child is what LumaScope checks for. You may also select the `rendering_styles` directory itself, in which case its parent is treated as the resource root. These resources are external and are **not bundled with LumaScope**.

### Add or modify a style yourself

A rendering style is an XML file with the `.render.xml` extension. You can copy an existing style from the official repository, edit it with a text/XML editor, and keep it in `rendering_styles/`. Preserve any dependency styles referenced by the file (for example, a style may declare `depends="default"`). A syntactically valid XML file is not necessarily a valid OsmAnd rendering style; use the OsmAnd rendering-style documentation and existing styles as references.

- [OsmAnd rendering-style format](https://osmand.net/docs/technical/osmand-file-formats/osmand-rendering-style/)
- [Example: default style](https://github.com/osmandapp/OsmAnd-resources/blob/master/rendering_styles/default.render.xml)

The selected resources folder remains external to LumaScope. It is not copied into the application installation.

## 5. Hillshade and elevation tile databases

### Folder and filenames

Put hillshade databases in:

```text
ResourcePackage/OsmAnd/tiles/
```

The scanner recognises SQLite database files with one of these extensions:

- `.sqlitedb`
- `.sqlite`
- `.db`

Examples:

```text
OsmAnd/tiles/Hillshade Austria.sqlitedb
OsmAnd/tiles/Hillshade Alps.sqlitedb
```

The scanner uses the path segments `OsmAnd` and `tiles` to classify these databases as hillshade resources. A database with the right extension in a different folder may not be classified as hillshade by the package scan.

### Download or create

OsmAnd distributes topography-related map data through its Maps & Resources downloads. Availability and packaging can vary by platform and release:

- [OsmAnd Topography documentation](https://osmand.net/docs/user/plugins/topography/)
- [OsmAnd SQLite tile format](https://download.osmand.net/docs/technical/osmand-file-formats/osmand-sqlite/)

The SQLite tile format documentation explains the database structure used for OsmAnd raster tiles and hillshade/slope files. Do not rename an arbitrary SQLite database to `.sqlitedb`: the extension alone is only the discovery hint, not proof that its tables and tile payloads are compatible.

OsmAnd's [offline map creation guide](https://osmand.net/docs/technical/map-creation/create-offline-maps-yourself/) also explains creating SQLite raster databases from a tile source. That procedure creates raster tile databases; it does not turn an arbitrary elevation raster into a hillshade database. To create new hillshade data, start with an appropriate digital elevation model (DEM), use a toolchain that can generate the OsmAnd-compatible hillshade/slope tile database, and verify the result against the SQLite format documentation.

### Overlay behaviour

Hillshade is a relief overlay, not a standalone base map. It is selected and enabled separately from the base map. Keep the database in the external resource tree; the map renderer reads it from its configured path.

## 6. Mapsforge vector maps — MAP

### Folder and filenames

Put Mapsforge map files anywhere below a directory named `Mapsforge`, preferably in:

```text
ResourcePackage/Mapsforge/maps/
```

Examples:

```text
Mapsforge/maps/austria.map
Mapsforge/maps/europe/germany.map
```

The extension must be `.map`. Extract downloaded ZIP archives before scanning. The scanner recognises `.map` files by the presence of a `Mapsforge` path segment.

### Download ready-made maps

- [Mapsforge download server](https://download.mapsforge.org/) — official server for prebuilt maps and POI files.
- [OpenAndroMaps](https://www.openandromaps.org/) — regional Mapsforge-compatible maps, including Europe and Austria.
- [OpenAndroMaps map downloads](https://www.openandromaps.org/downloads) — regional map catalogue and download information.

Choose the desired region, download its map archive, extract the `.map` file and place it under `Mapsforge/maps/`. Keep different regions in subfolders if that makes updates easier to manage.

### Create your own MAP file

Mapsforge's Map Writer converts OpenStreetMap source data into the binary `.map` format. The writer is an Osmosis plug-in:

1. Download an `.osm.pbf` extract from [Geofabrik](https://download.geofabrik.de/).
2. Obtain the Mapsforge Map Writer plug-in from the [Mapsforge releases](https://github.com/mapsforge/mapsforge/releases).
3. Install and configure Osmosis and the matching Map Writer plug-in.
4. Run Osmosis with the PBF reader and `--mapfile-writer` task, specifying the output file.
5. Copy the resulting `.map` file under `Mapsforge/maps/`.

Official instructions and command examples are maintained in [Getting Started — Map Writer](https://github.com/mapsforge/mapsforge/blob/master/docs/Getting-Started-Map-Writer.md). For large PBF extracts, use the writer's disk-backed mode (`type=hd`) rather than assuming the entire input will fit in memory. The Map Writer controls which OSM tags and zoom levels are stored; a tag that is not included in the map cannot be drawn later by a render theme.

## 7. Mapsforge XML render themes

### Folder and filenames

Place Mapsforge render-theme XML files below a directory named exactly:

```text
ResourcePackage/Mapsforge/theme/
```

Subfolders are supported. Examples:

```text
Mapsforge/theme/Elevate/Elevate.xml
Mapsforge/theme/my-theme.xml
```

The package scanner looks for a directory named `theme` whose parent path contains `Mapsforge`. The theme picker searches the selected theme directory for XML theme files. The theme is external; it is not embedded in the `.map` file.

### Download themes

- [OpenAndroMaps Elevate theme](https://www.openandromaps.org/kartenlegende/elevation-hike-theme) — detailed hiking, cycling and general-purpose theme family, with downloads and legend.
- [Mapsforge project](https://github.com/mapsforge/mapsforge) — renderer and theme-format project information.

Place the extracted Mapsforge render-theme `.xml` files in this folder; subfolders are scanned too. For example, extract the OpenAndroMaps Elevate theme ZIP here. Preserve the archive's directory structure when the theme references images or other files by relative path. Choose the active theme in the map **View** tab after scanning. The theme folder path is stored in application settings, while the theme files remain external to LumaScope.

### Create or customise a theme

A Mapsforge render theme is XML. The theme defines how the tags stored in a `.map` file are drawn: line styles, fills, symbols, text and zoom-dependent rules. You can copy an existing theme and edit its XML, but the rules must match the Mapsforge render-theme schema and the tags available in your map data.

Use the theme documentation and existing themes as references. Keep images and other referenced assets beside the XML in the relative folder structure expected by that theme. A theme file that is discovered by name may still fail to parse or render if it uses unsupported extensions or missing assets.

## 8. MBTiles vector databases

### Folder and filenames

MBTiles files can be placed in any subfolder of the selected package:

```text
ResourcePackage/MBTiles/region.mbtiles
ResourcePackage/MBTiles/Europe/region.mbtiles
```

The scanner recognises the `.mbtiles` extension regardless of the parent folder name. LumaScope's offline vector-map loader performs additional checks after discovery. The current loader expects:

- a readable SQLite database with `metadata` and `tiles` tables;
- vector tile metadata with `format=pbf`;
- valid `minzoom`, `maxzoom` and `bounds` metadata;
- a supported vector layer schema: Shortbread or OpenMapTiles;
- gzip-compressed PBF tile payloads.

A raster MBTiles file is therefore not interchangeable with the vector MBTiles sources currently supported by this loader.

### Download or create

MBTiles is a container format, not a map dataset. Obtain a vector MBTiles package from a provider that publishes the required schema, or generate one from OSM data with a vector tile toolchain such as [Planetiler](https://github.com/onthegomap/planetiler). Confirm that the output contains the required metadata and vector-layer schema before placing it in the package.

## 9. Valhalla routing configuration and graph data

### Folder and filenames

Place Valhalla configuration JSON files below a directory whose path contains `OpenStreetMap`. A convenient structure is:

```text
ResourcePackage/OpenStreetMap/Valhalla/Austria/valhalla.json
ResourcePackage/OpenStreetMap/Valhalla/Europe/valhalla.json
```

The JSON must parse successfully and contain a top-level `mjolnir` object. Valhalla configuration files are discovered automatically when you scan the extracted resource package. Select the configuration you want to use in the **Routing provider** list. The OfflineFiles table displays each configuration's parent folder (such as `Austria` or `Europe`) and the recursive size of that folder. The scanner does **not** build, download or validate the complete routing graph.

### Configuration versus routing tiles

A `valhalla.json` file is not the route graph. It tells Valhalla where to find data and how to run the routing engine. The `mjolnir.tile_dir` setting (or the equivalent configured tile location for the Valhalla version in use) must point to the actual graph-tile directory. The supporting administrative-area and timezone data must also be available where the configuration expects them.

Keep the graph tiles and supporting files in a stable local directory. Do not move the tile directory after creating the configuration unless you also update its paths. Prefer explicit absolute paths in a Windows configuration so the location is unambiguous. If several regional configurations exist, each should point to its own matching graph data.

### Download source data and create the graph

- [Geofabrik downloads](https://download.geofabrik.de/) — daily regional `.osm.pbf` extracts.
- [Valhalla project](https://github.com/valhalla/valhalla) — source project and releases.
- [Valhalla Mjolnir documentation](https://valhalla.github.io/valhalla/contributing/architecture/mjolnir/) — explains the tile-building pipeline.

The normal data workflow is:

1. Download the required regional `.osm.pbf` extract.
2. Generate a configuration with Valhalla's `valhalla_build_config` script.
3. Build graph tiles from the extract with `valhalla_build_tiles --config valhalla.json region.osm.pbf`.
4. Generate or provide the supporting admin and timezone databases required by the configuration.
5. Place the configuration under `OpenStreetMap/Valhalla/<region>/`, and make sure its tile and supporting-data paths resolve to the data you created.

The exact configuration keys and auxiliary-data steps depend on the Valhalla version and selected build options. Follow the documentation for the same Valhalla release as the runtime. LumaScope's build documentation covers compiling the routing helper; it intentionally does not duplicate that build process here.

## 10. Assemble, scan and verify

1. Create a parent directory such as `D:\Maps\ResourcePackage`.
2. Create the subfolders required by the formats you intend to use.
3. Extract downloaded ZIP archives before scanning. Do not put ZIP files where the scanner expects the actual `.obf`, `.map`, `.xml` or SQLite file.
4. Copy the files into the correct subfolders described above.
5. In LumaScope, open **Location → OfflineFiles** and click **Open resource package…**.
6. Select the parent `ResourcePackage` directory, not an individual file.
7. Review the **Found** and **Changed** scan results.
8. Click **Check** to verify availability and identify missing or duplicate paths.
9. Confirm that the OsmAnd resources folder and Mapsforge theme folder show the expected locations and that the desired Valhalla configuration is selected.
10. In the map **View** tab, choose the OsmAnd rendering style or Mapsforge theme, and activate the desired map and hillshade files.

### Common reasons a resource is not found

| Symptom | Likely cause | Correction |
| --- | --- | --- |
| OBF file not found | File is outside an `OsmAnd/files` path | Move it below `OsmAnd/files/` |
| Hillshade not found | Database is outside an `OsmAnd/tiles` path | Move it below `OsmAnd/tiles/` |
| MAP file not found | File is outside a `Mapsforge` path | Move it below `Mapsforge/` |
| Theme folder missing | No directory named `theme` below `Mapsforge` | Create `Mapsforge/theme/` and put XML themes inside |
| OsmAnd resources missing | No `rendering_styles` child directory was found | Select the extracted OsmAnd-resources root or its `rendering_styles` directory |
| Valhalla configuration missing | JSON is outside `OpenStreetMap`, invalid JSON, or lacks top-level `mjolnir` | Correct the path and validate the JSON |
| File found but unusable | Extension and folder match, but internal file format is unsupported or damaged | Obtain or regenerate a compatible file and run **Check** again |

## 11. Licensing and attribution

Map data and rendering resources are supplied by third parties and remain subject to their own licences and terms. In particular:

- OpenStreetMap-derived data is generally distributed under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/); provide the required attribution.
- Geofabrik states the licence and attribution requirements for its extracts on its [download information page](https://www.geofabrik.de/en/data/download.html).
- OsmAnd resources and maps have their own project and data notices. Review the [OsmAnd-resources repository](https://github.com/osmandapp/OsmAnd-resources) and the LumaScope [licensing notes](licensing.md).
- Mapsforge maps and render themes may have separate provider licences. Review the terms of the source from which each file was obtained.

LumaScope scans and uses local paths; it does not grant redistribution rights for downloaded maps, themes, elevation data or routing graph tiles.
