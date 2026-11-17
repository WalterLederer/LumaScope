# Automatic photo location correction

The **Fix location AUTOMATIC** section in the Location tab assigns GPS coordinates to photos by matching their capture timestamps against GPX track points stored in the drive-local LumaScope cache database.

## Prerequisites

- Import the relevant GPX files first using **Track → Advanced → GPX → DB** (the GPX folder import).
- The imported GPX data must be available in the cache database associated with the drive containing the selected photo folder.
- GPX track points must have timestamps. Matching uses points within an individual GPX segment.

## Workflow

1. Open **Location → Fix location AUTOMATIC**.
2. Select **Check only** first to inspect the proposed results without changing any image files.
3. Set **Maximum time difference (minutes)**. The default is **2 minutes**; the allowed range is 0–1440 minutes in 0.5-minute steps.
4. Select **Select folder with photos to fix...** and choose the root folder. Its subfolders are scanned recursively.
5. Review the status report. If the results are suitable, clear **Check only** and run the operation again to write the accepted GPS positions.

## Matching and interpolation

- Photos that already contain GPS coordinates are counted but never overwritten.
- A photo needs a usable capture timestamp and a pair of GPX points bracketing that timestamp in the **same track segment**.
- The location is linearly interpolated between the bracketing points.
- The candidate time deviation is the smaller absolute time distance from the photo timestamp to either bracketing GPX point.
- Candidates whose deviation is greater than the configured maximum are rejected and counted as **Ignored (time difference too high)**. Their files are not changed.
- The candidate search considers track points within ±24 hours of the photo timestamp. Interpolation intervals wider than 48 hours are rejected. A missing timestamp or missing same-segment bracketing pair is reported as **No GPX match**, not as a time-limit rejection.

## Status report

The report includes:

- Selected start folder.
- Total folders and files processed, plus the number of photo files checked.
- Photos with GPS and photos without GPS.
- GPX matches within the configured time limit.
- Photos with no usable GPX match.
- Candidates ignored because their time deviation exceeds the limit.
- Minimum, mean and maximum candidate deviation in seconds.
- Number of files updated and any errors.
- Total elapsed runtime.

The min/mean/max deviation statistics include all usable GPX candidates, including candidates rejected by the configured time limit. This makes it possible to assess how close the rejected candidates were.

## GPS Auto Fix log file

In addition to the on-screen status report, GPS Auto Fix writes its diagnostic information to:

`%APPDATA%\LumaScope\gps-auto-fix-debug.log`

The log contains detailed information about photo timestamps, EXIF date candidates, GPX track-point comparisons, matching results and processing errors. It is recreated for each GPS Auto Fix run. Use it when investigating photos that are not matched to a GPX track.

## Timestamp and timezone considerations

Photo timestamps are read from the image metadata. EXIF capture timestamps without an explicit timezone are interpreted in the computer's local timezone. GPX timestamps are time-based track records; if the camera clock or timezone differs from the computer's interpretation of the photo timestamp, the calculated deviation may be large and a valid geographic match may be rejected. Check camera time, timezone and GPX timestamps before increasing the threshold.

## Safety and limitations

- **Check only** runs the scan and matching logic without writing GPS metadata.
- In normal mode, accepted positions are written to the original photo files' GPS EXIF metadata; the operation does not create backup copies.
- Matching requires two bracketing points in one segment. A lone nearby track point is not sufficient.
- Photos with no usable capture timestamp, and photos for which no valid same-segment pair is found, remain unchanged.
- The GPX import is a prerequisite; this operation does not automatically search arbitrary GPX files on disk or import them.
