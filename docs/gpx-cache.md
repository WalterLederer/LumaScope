# GPX cache database

[Back to README](../README.md) · [Feature guide](features.md)

## Purpose

LumaScope can import a large collection of GPX track files into the SQLite cache database associated with the drive containing the selected source folder. The database stores the source-file identity and the track geometry as structured records rather than repeatedly parsing every GPX XML file whenever track data is needed.

The imported data is used by viewport-based track retrieval and timestamp-based photo location enrichment. Importing GPX files populates the database; the automatic location workflow searches the selected photo drive first and then the drives referenced by Gallery favorites.

## Where the data is stored

Each drive has its own cache database:

`.cache/LumaScope.cache.sqlite`

For example, a GPX folder on drive `D:` is imported into the cache database associated with drive `D:`. The path of each GPX file is stored relative to that drive root, not as an absolute path. This keeps the database records independent of a particular drive-letter-prefixed absolute path and ensures that GPX data stays with the corresponding per-drive cache database.

The import does not copy, move, rename or modify the original GPX files.

## User workflow

1. Open **Track → Advanced** or **Location → Fix location AUTOMATIC** and expand **GPX → DB**.
2. Choose **Add all GPX tracks from folder to DB…**.
3. Select the root folder to scan.
4. LumaScope recursively searches that folder and its eligible subfolders for files with the `.gpx` extension.
5. For automatic photo location correction, import GPX data into the photo folder's drive or any drive referenced by a Gallery favorite. The refresh control lists those cache database files and shows each file path, SQLite file size, cached photo count, and GPX file/segment/point totals.

The GPX totals are counts for each listed drive's cache database, not just for the most recently selected folder. The summary also distinguishes all stored points from timestamped points, which are required for automatic photo location matching. The folder picker can be cancelled without changing the database.

### Folder traversal

The scan is recursive. Symbolic links are skipped. The following directory names are excluded from traversal to avoid scanning generated caches, system folders and development dependencies:

- `.cache`
- `$RECYCLE.BIN`
- `System Volume Information`
- `node_modules`
- `.git`

Unreadable directories are skipped. Individual files that cannot be read or imported are counted as errors; processing continues with other candidates.

## Duplicate detection and re-import behaviour

Every candidate file is read and assigned a SHA-256 hash of its content.

- **Unchanged file:** If the stored relative path already exists and its content hash matches, the existing track data is retained. The stored file size and modification time are refreshed; no points are parsed or inserted again.
- **Changed file at the same path:** If the content hash differs, the previous file record and its dependent segment/point records are replaced by the newly parsed content.
- **Identical content at another path:** If the same content hash is already stored for another path in the same drive database, the second copy is skipped. The database therefore stores identical GPX content only once per drive.
- **Previously stored path now containing duplicate content:** The stale record for that path is removed and the already stored identical content remains.
- **New content:** A new file record and its parsed segments and points are inserted.

A partial unique SQLite index enforces uniqueness for non-empty content hashes. Duplicate detection is scoped to one drive database; it does not compare GPX files across different drives.

The import is additive with respect to the selected folder: GPX records are not automatically deleted merely because a source file is no longer present in a later scan. A changed file at a known path is updated, but files removed from disk require a separate future cleanup policy.

## GPX parsing scope

The current importer extracts:

- Track points (`trkpt`) inside track segments (`trkseg`).
- Route points (`rtept`) when no non-empty track segment was found.
- Latitude and longitude from point attributes.
- Optional elevation (`ele`) and timestamp (`time`) from each point.
- XML elements with an optional namespace prefix; element-name matching is case-insensitive.

Latitude and longitude are validated against the legal geographic ranges. Timestamps are parsed as date/time values and stored as Unix epoch milliseconds. Elevation is stored in metres as provided by the GPX file. Points without a valid timestamp are retained with a `NULL` timestamp, so they remain usable as geometry but cannot participate in timestamp-based matching.

Each non-empty `trkseg` is stored as a separate segment. If no non-empty track segment is found, the importer parses available track/route points as one fallback segment. Keeping segment boundaries is important: future interpolation must not connect the end of one segment to the beginning of another.

**Current parser limitations:** this is a targeted GPX point extractor, not a general-purpose validating XML parser. Standalone waypoint elements (`wpt`) are not imported. If a file contains one or more non-empty track segments, route points outside those segments are not added as extra segments. Malformed or unusual XML constructs may be rejected or incompletely parsed; such files should be checked against the reported error count.

## SQLite schema

The GPX tables are created by cache database migration V18. Content-hash uniqueness is added by migration V19.

### `gpx_files`

One row per distinct imported GPX content item:

| Column | Meaning |
| --- | --- |
| `id` | Internal source-file ID; referenced by track segments |
| `relative_file_path` | Source path relative to the cache database drive; unique, case-insensitive |
| `file_name` | Original GPX filename |
| `file_size` | Source file size in bytes |
| `modified_at` | Source file modification time in Unix milliseconds |
| `content_hash` | SHA-256 hash used for content-based duplicate detection |
| `imported_at` | Time the content was imported, Unix milliseconds |
| `point_count` | Number of stored points belonging to the file |
| `segment_count` | Number of stored segments belonging to the file |

### `gpx_track_segments`

One row per non-empty track segment (or fallback point collection):

| Column | Meaning |
| --- | --- |
| `id` | Internal segment ID |
| `gpx_file_id` | Owning row in `gpx_files`; deleted with the source record |
| `segment_index` | Zero-based segment order within the file |
| `point_count` | Number of points in the segment |
| `start_timestamp_ms` | Earliest valid point timestamp in the segment, or `NULL` |
| `end_timestamp_ms` | Latest valid point timestamp in the segment, or `NULL` |

### `gpx_track_points`

One row per accepted track or route point:

| Column | Meaning |
| --- | --- |
| `id` | Internal point ID |
| `segment_id` | Owning segment; points are removed with that segment |
| `point_index` | Zero-based order within the segment |
| `timestamp_ms` | Point timestamp in Unix epoch milliseconds, or `NULL` |
| `latitude` / `longitude` | Geographic coordinates in decimal degrees |
| `elevation_m` | Optional elevation in metres |

## Indexing

The schema includes indexes for the expected follow-up queries:

- `idx_gpx_track_points_timestamp` — timestamp, segment and point-order lookup; rows with a `NULL` timestamp are excluded from this partial index.
- `idx_gpx_track_points_segment_order` — efficient ordered traversal of points within a segment.
- `idx_gpx_track_segments_file` — segment lookup by source GPX file.
- `idx_gpx_track_segments_time` — segment time-range lookup.
- `idx_gpx_files_content_hash_unique` — partial unique index preventing duplicate non-empty content hashes.
- `gpx_segment_rtree` — SQLite R*Tree containing one geographic bounding box per segment.

The R*Tree indexes **segment bounding boxes**, not individual points. This allows a future viewport query to find a segment whose path crosses the visible map area even if none of its stored vertices lies inside the viewport. The importer calculates each segment's minimum and maximum latitude and longitude while inserting its points, then writes one R*Tree entry after the segment is complete. It deliberately avoids an aggregate trigger that would repeatedly rescan a growing segment after every inserted point.

A delete trigger removes the corresponding R*Tree row when a segment is deleted. The source-file foreign key cascades deletion to its segments and points.

## Transaction and error handling

Each GPX file is imported or replaced in its own `BEGIN IMMEDIATE` transaction. A failure rolls back the current file's database changes without undoing previously completed files. This limits the amount of work lost if a large folder contains a damaged file or an individual import fails.

The importer reports:

| Result | Meaning |
| --- | --- |
| `files` | Total distinct GPX source records in the drive database after the scan |
| `segments` | Total stored segments in that database |
| `points` | Total stored points in that database |
| `imported` | New or changed GPX files successfully imported during this run |
| `unchanged` | Files whose content hash already matched the stored record |
| `duplicates` | Files skipped because identical content was already stored elsewhere in the database |
| `errors` | Files that could not be read, parsed into usable points or committed |
| `cancelled` | Whether the folder picker was cancelled |

The GPX file, segment, total point and timestamped point counts are shown beside the import button in Track → Advanced and Location → Fix location AUTOMATIC. Refresh updates every favorite cache database in the list, not only the currently selected drive.

## Current implementation boundary

Implemented:

- Per-drive GPX file, segment and point storage in SQLite.
- Recursive folder import and progress summary counters.
- SHA-256 content hashing and duplicate suppression.
- Replacement of changed content at a previously known path.
- Segment-preserving point storage, timestamps, optional elevation and segment bounding-box R*Tree indexing.
- Per-file database transactions and aggregate database statistics.

Not yet implemented by this import feature:

- Loading only GPX segments intersecting the current map viewport and drawing those database-backed tracks.
- Matching a photo without GPS coordinates to the temporally nearest GPX points.
- Interpolating latitude/longitude between timestamped points to derive a photo position.
- A cleanup operation for source files deleted or moved after they were imported.

These later operations can use the stored timestamp index, segment boundaries and R*Tree bounds. Any photo enrichment implementation should enforce a maximum time-distance threshold, avoid interpolation across separate segments, and define behaviour for missing or non-monotonic timestamps before writing derived coordinates into the photo record.
