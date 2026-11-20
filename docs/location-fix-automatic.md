# Automatic photo location correction


During a normal GPS Auto Fix run (not **Check only**), the selected timestamp is also written to the photo's `gps_timestamp` field in the drive's SQLite cache database. This database update is performed for every scanned photo, including photos that already have GPS coordinates or cannot be matched to a GPX track. The same timestamp priority applies: GPSDateTime, XMP GPSDateTime, camera filename timestamp, DateTimeOriginal, XMP DateCreated, CreateDate, then filesystem last-modified time.

The **Fix location AUTOMATIC** section in the Location tab assigns GPS coordinates to photos by matching their capture timestamps against GPX track points and GPS positions from already geotagged images stored in the drive-local LumaScope cache databases.

## Prerequisites

- GPX import is optional if the cache databases already contain suitable geotagged image references. Otherwise, use **STEP 1 - Add GPX to search** and expand **GPX → DB** to import the relevant GPX folder. The section lists cache databases for favorite drives and shows each database file path, cache size/entries, and GPX file/segment/point totals, including timestamped points. The same shared importer is also available under **Track → Advanced**.
- Auto Fix searches the selected photo folder's drive first, followed by every drive referenced by a Gallery favorite. Import GPX data into any of these drive-local cache databases; a favorite drive is included even when no image from it is open.
- Auto Fix searches both timestamped GPX track points and timestamped GPS positions from geotagged images in the selected photo folder's drive and every drive represented by a Gallery favorite. A GPX import is no longer mandatory when suitable geotagged image references are already cached.
- GPX track points must have timestamps and are matched within an individual GPX segment. Geotagged image references must have cached GPS coordinates and a capture timestamp.

## Workflow

1. Open **Location → Fix location AUTOMATIC**.
2. If no suitable geotagged image references are already cached, use **STEP 1 - Add GPX to search** to import the GPX folder into a drive referenced by the selected photo folder or a Gallery favorite.
3. Under **STEP 2 - Add GPS info from GPX to photos**, select **Check only** first to inspect the proposed results without changing any image files.
4. Set **Maximum time difference (minutes)**. The default is **2 minutes**; the allowed range is 0–1440 minutes in 0.5-minute steps.
5. Select **Select folder with photos to fix...** and choose the root folder. Its subfolders are scanned recursively.
6. Review the status report. If the results are suitable, clear **Check only** and run the operation again to write the accepted GPS positions.

## Matching and interpolation

- Photos that already contain GPS coordinates are counted but never overwritten.
- The photo timestamp is selected in this priority order: EXIF `GPSDateTime`, XMP `GPSDateTime`, a camera timestamp in the filename, EXIF `DateTimeOriginal`, XMP `DateCreated`, and EXIF `CreateDate`. If none of these is usable, the filesystem last-modified timestamp is the final fallback.
- Samsung-style filenames such as `IMG_20261009_093728.jpg` are recognized as `YYYYMMDD_HHmmss`. The date and time are validated (including calendar values) and interpreted as camera-local time in the computer's local timezone, like EXIF capture dates without an explicit timezone.
- This filename fallback is particularly useful for photos copied from Android devices with `adb pull`: the Windows Created/Modified timestamps may reflect the copy time rather than the original capture time. In that case, the timestamp embedded in the camera-generated filename takes precedence over those filesystem dates.
- A photo needs a usable capture timestamp and either a pair of GPX points bracketing that timestamp in the **same track segment**, or cached geotagged image references.
- With two image references bracketing the timestamp, the location is linearly interpolated between their GPS positions. With only one image reference available, its exact GPS position is used as a single anchor; no interpolation or extrapolation is performed.
- The candidate time deviation is the smaller absolute time distance to the bracketing references, or the absolute time distance to the single image anchor. The configured **Maximum time difference** is applied to either candidate type, so a lone image reference is only accepted when it is sufficiently close in time.
- Auto Fix compares the valid GPX and image-reference candidates across all searched cache databases and uses the candidate with the smallest time deviation. Existing geotagged images are never modified; their cached coordinates are references only.
- Candidates whose deviation is greater than the configured maximum are rejected and counted as **Ignored (time difference too high)**. Their files are not changed.
- The candidate search considers track points within ±24 hours of the photo timestamp. Interpolation intervals wider than 48 hours are rejected. A missing timestamp or absence of any valid GPX/image-reference candidate is reported as **No GPX match**, not as a time-limit rejection.

## Status report

The report includes:

- Selected start folder.
- Total folders and files processed, plus the number of photo files checked.
- Photos with GPS and photos without GPS.
- Matches within the configured time limit.
- Photos with no usable GPX or geotagged-image reference match.
- Candidates ignored because their time deviation exceeds the limit.
- Minimum, mean and maximum candidate deviation in seconds.
- Number of files updated and any errors.
- Total elapsed runtime.
- Cache database drive letters searched (for example, `C:, D:`).
- Earliest and latest timestamp across all timestamped points in all imported GPX files; this range is queried once before photo scanning.
- Earliest and latest selected photo timestamps seen so far; this range is updated after every scanned photo.

The min/mean/max deviation statistics include all usable GPX candidates, including candidates rejected by the configured time limit. This makes it possible to assess how close the rejected candidates were.

### Interpreting GPS availability and match results

**GPS availability** refers only to coordinates embedded directly in the photo file's metadata (EXIF/XMP). It does not refer to GPS records stored in the LumaScope cache database. Photos whose files already contain GPS coordinates are counted separately and skipped; their coordinates are not overwritten.

A usable GPX match requires track points both before and after the photo timestamp, with both points belonging to the same track segment. An image-reference match can use either two cached geotagged images bracketing the target timestamp or one nearby image as a single anchor. A single anchor supplies its exact coordinates without interpolation and is accepted only when its time deviation is within the configured maximum. When multiple candidates are available, the candidate with the smallest time deviation is selected. **No usable match** means that neither source supplied a valid candidate within the search window. **Rejected by the time limit** counts candidates whose nearest reference was farther from the photo timestamp than the configured maximum time difference.

**Check only** reports the scan and matching results without writing changes to photo files. EXIF timestamps that do not contain an explicit timezone are interpreted in the computer's local timezone.

## GPS Auto Fix log file

In addition to the on-screen status report, GPS Auto Fix writes its diagnostic information to:

`%APPDATA%\LumaScope\gps-auto-fix-debug.log`

The log contains detailed information about photo timestamps, EXIF date candidates, GPX track-point and geotagged-image reference comparisons, selected matching sources, matching results and processing errors. It is recreated for each GPS Auto Fix run. Use it when investigating photos that are not matched to a GPX track.

## Timestamp and timezone considerations

Photo timestamps are selected using the priority described above. Filename timestamps and EXIF capture timestamps without an explicit timezone are interpreted in the computer's local timezone. GPX timestamps are time-based track records; if the camera clock or timezone differs from the computer's interpretation of the photo timestamp, the calculated deviation may be large and a valid geographic match may be rejected. Check camera time, timezone and GPX timestamps before increasing the threshold.

## Safety and limitations

- **Check only** runs the scan and matching logic without writing GPS metadata.
- In normal mode, accepted positions are written to the original photo files' GPS EXIF metadata; the operation does not create backup copies.
- GPX matching requires two bracketing points from one segment. Image matching can use two bracketing references or one nearby cached geotagged image; a single image anchor is used without interpolation and remains subject to the configured time-difference limit.
- Photos with no usable capture timestamp, and photos for which no valid GPX pair or image-reference anchor/pair is found, remain unchanged.
- GPX import is optional when suitable geotagged image references are already cached. The operation does not automatically search arbitrary GPX files on disk or import them.
