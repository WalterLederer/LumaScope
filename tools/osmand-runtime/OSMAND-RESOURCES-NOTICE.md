# OsmAnd resources included with LumaScope

This directory is assembled from the vendored resource snapshot at
`OsmAnd-SDK/vendor/osmand/resources`. It is intentionally a whitelist, not a
copy of the complete upstream resource repository.

## Included files and license basis

- `rendering_styles/*.render.xml`, `poi/poi_types.xml`, and
  `routing/routing.xml`: GPL-3.0-or-later. OsmAnd maintainer clarification:
  all text files and rendering styles are GPLv3 (OsmAnd issue #25685).
- `rendering_styles/fonts/*.ttf`: Apache-2.0, accompanied by the upstream
  `rendering_styles/fonts/LICENSE.txt`.
- `misc/icu4c/icudt52l.dat`: Unicode License 3.0 / ICU license terms. The
  corresponding license text is included in `licenses/ICU-DATA-LICENSE.txt`.

The upstream resource repository's own `LICENSE` is also retained in
`licenses/OSMAND-RESOURCES-LICENSE.txt`. The GPLv3 license text is included
as `licenses/GPL-3.0.txt`.

## Deliberately excluded

No SVG/PNG artwork is staged: this includes map icons, shaders/shields, POI
icons, and rendering stubs. The upstream OsmAnd license warns that artwork
may be CC-BY-NC-ND or proprietary, and the repository's top-level notice
identifies several different icon sources/licenses. A blanket license for
the complete graphics tree cannot be established from those notices alone.

Legacy fonts, voices, generated voice data, and unrelated resource folders
are also excluded. They are not required by the current helper resource
provider's mapped resource paths.

## Upstream references

- https://github.com/osmandapp/OsmAnd-resources
- https://github.com/osmandapp/Osmand/blob/master/LICENSE
- https://github.com/osmandapp/Osmand/issues/25685
- https://www.apache.org/licenses/LICENSE-2.0
- https://www.unicode.org/license.txt

The absence of graphics means that map geometry and text can be rendered, but
some symbol-based features (POI icons, shields, and other artwork) may be
missing until those assets are individually cleared for redistribution.
