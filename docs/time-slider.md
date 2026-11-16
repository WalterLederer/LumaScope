# Time Slider

The **Time Slider** tab filters timestamped GPX track points and photo markers to a selected time interval. It can also animate that interval to show movement over time.

## Data sources and availability

The time range is derived from timestamped data currently available to the map:

- Timestamped points in loaded GPX tracks or GPX tracks queried from the cache database for the current map viewport.
- Timestamped photo markers, when photo markers are enabled and available.

If neither source provides usable timestamps, the tab explains what data is missing. Load timestamped GPX tracks and/or enable photo markers with timestamps.

## Enable time filtering

1. Open **Time Slider**.
2. Review the **Start**, **End** and duration readouts.
3. Enable the checkbox at the left of the range control to activate time filtering.
4. Drag the two range handles to choose the visible time interval.

Only timestamped GPX track points and photo markers inside the selected interval are filtered into view. Items without timestamps remain visible. GPX routes without timestamped points are also independent of the time slider and remain visible.

The slider's selected interval can be narrower than the full available range. The full data boundaries and their sources are shown in the **MinMax** section.

## MinMax

Expand **MinMax** to inspect:

- The earliest available timestamp (**Min**) and its source.
- The latest available timestamp (**Max**) and its source.
- The complete time span.

The source labels indicate whether the boundary comes from GPX track data or photo marker data. The boundaries describe the available data range; they are not the currently selected Start and End values.

## Animation

Expand **Animate** to play the selected time interval. The Play button advances the time window; Stop ends playback. The selected interval must be active and data must be available.

See [Time Slider animation and symbol settings](time-slider-animation.md) for playback speed and moving-symbol options.

## Troubleshooting

- **No time range available:** load GPX tracks with point timestamps and/or enable photo markers that have timestamps.
- **Tracks do not change when the slider moves:** check that the track points have timestamps. Untimestamped routes remain visible.
- **Photo markers do not change:** enable photo markers and verify that their photo records have usable timestamps.
- **Some objects remain visible outside the interval:** objects without timestamps are intentionally not filtered.
