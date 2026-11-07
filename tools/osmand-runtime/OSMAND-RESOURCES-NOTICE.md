# OsmAnd resources included with LumaScope

The runtime resource set is staged from the complete OsmAnd resource tree at
`OsmAnd-SDK/vendor/osmand/resources`.

## Included runtime resource trees

- `rendering_styles/`: copied recursively in full. This includes all rendering
  style XML files and the associated graphics/assets in `style-icons/`
  (including map icons, POI icons, shields and shaders), density variants,
  rendering stubs, current fonts and legacy-font directories with their
  accompanying license files.
- `poi/`: the complete POI resource directory.
- `routing/`: the complete routing resource directory.
- `misc/`: the complete miscellaneous resource directory used by OsmAnd Core.
- `licenses/OSMAND-RESOURCES-LICENSE.txt`: the upstream resource-root license.
- `licenses/GPL-3.0.txt` and `licenses/ICU-DATA-LICENSE.txt`: accompanying
  license texts. Individual font license files remain in their original
  subdirectories under `rendering_styles/`.

The upstream resource repository says its contents are mainly GPLv3, with
exceptions for certain resources. The upstream license specifically notes
that some icons are from Flat Icons/Flaticon under CC BY 3.0. Rendering styles
and text resources are covered by the OsmAnd GPLv3 clarification referenced
below. The active font directory carries an Apache-2.0 license, and individual
legacy-font directories retain their own license files. The ICU data license
is included for ICU data shipped in the resource tree. The original upstream
license files are retained rather than replacing them with a blanket license
claim for every asset.

## Not included

The separate top-level `icons/` repository directory is not part of the
resource paths consumed by the current Atlas helper. It contains multiple
independent artwork collections and a file explicitly identifying Icons8
material as proprietary. That separate directory is therefore not copied
into the runtime package. The Atlas helper's map and shader artwork is taken
from `rendering_styles/style-icons/`, which is included in full above.

Unrelated upstream development/build scripts and resource groups not consumed
by the current Atlas helper (such as voice packs and map-generation inputs)
are not copied into the application runtime.

## Upstream references

- https://github.com/WalterLederer/PySide6-OsmAnd-SDK/tree/main/vendor/osmand/resources
- https://github.com/osmandapp/OsmAnd-resources
- https://github.com/osmandapp/Osmand/blob/master/LICENSE
- https://github.com/osmandapp/Osmand/issues/25685
- https://www.apache.org/licenses/LICENSE-2.0
- https://www.unicode.org/license.txt
