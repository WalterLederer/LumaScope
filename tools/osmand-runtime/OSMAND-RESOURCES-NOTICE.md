# OsmAnd resources and licensing

The standard LumaScope release build does **not** bundle the OsmAnd resources tree. The production commands `npm run make:prod` and `build.ps1` stage the native OsmAnd helper executables and runtime dependencies, but do not run `stage-resources.ps1`.

To use the OsmAnd renderers, download the resources separately from the upstream project:

- https://github.com/osmandapp/OsmAnd-resources

After extracting the repository, select its resources root folder in the LumaScope Offline Files / map settings. The selected root must contain:

- `rendering_styles/default.render.xml`

LumaScope stores the selected local folder path in its application settings. The resources remain external to the standard application installation and are not copied into the normal LumaScope release package.

## License terms

The resources do not receive a different license when used with LumaScope. They remain subject to the upstream OsmAnd license and any file-specific third-party terms. The upstream resources repository describes its contents as mainly GPLv3, except for some resources. The OsmAnd project license identifies additional exceptions, including artwork, fonts, icons and voice resources. In particular, some artwork may be CC-BY-NC-ND 4.0 or proprietary; do not assume every file can be modified or redistributed.

See:

- [OsmAnd-resources LICENSE](https://github.com/osmandapp/OsmAnd-resources/blob/master/LICENSE)
- [OsmAnd project LICENSE](https://github.com/osmandapp/Osmand/blob/master/LICENSE)
- [LumaScope licensing guide](../../docs/licensing.md)

## Optional manual staging

The separate `stage-resources.ps1` script can copy selected resource folders (`rendering_styles`, `poi`, `routing` and `misc`) into `tools/osmand-runtime/stage/resources/`. It also copies the upstream resources LICENSE, GPL-3.0 text, ICU data license and this notice.

This script is not part of the normal production packaging sequence. If staged resources are ever added to a release package, the upstream license obligations still apply; staging the top-level license files does not automatically clear every included graphic, font, icon or other third-party asset for redistribution. Perform a file-level license audit before publishing such a package.
