# Licensing and third-party notices

[Back to README](../README.md)

This document describes the upstream licenses relevant to LumaScope and its separately built or distributed components. It is a practical project inventory, not legal advice. License terms can change between upstream revisions; every release must be checked against the exact source revisions and binaries included in that release.

## 1. LumaScope and the Light Matter fork

LumaScope originated as a fork of [Auxx/light-matter](https://github.com/Auxx/light-matter).

The repository's root [`LICENSE.md`](../LICENSE.md) is the MIT License notice from the original Light Matter project:

- Copyright 2025 Aleksandr 'Aux' Ivanov.
- The copyright notice and permission notice must remain in copies or substantial portions of the software.
- The license permits use, modification, distribution and sublicensing, subject to retaining those notices.

**Do not replace or remove the inherited MIT license notice.** The fork acknowledgement in the README should also remain. LumaScope-specific contributions can be acknowledged separately, but that does not remove the original copyright or the license obligations for inherited code.

The root `package.json` also declares `MIT`; this is not a replacement for notices belonging to bundled third-party components.

## 2. Important third-party components

| Component | Upstream license information | Release consideration |
| --- | --- | --- |
| LumaScope code inherited from Light Matter | MIT | Preserve the root `LICENSE.md` notice. |
| Valhalla routing engine | MIT | Include the applicable MIT notice when redistributing Valhalla binaries or code. |
| Mapsforge library used by the Java renderer | LGPL-3.0; upstream states that LGPLv3 sections 4(d) and 4(e) are waived | Include the LGPL license and preserve upstream notices. The shaded JAR contains Mapsforge and other Maven dependencies, each of which needs its own license review. |
| OsmAnd Core native libraries | GPL-3.0 according to the current OsmAnd project license, subject to listed third-party exceptions | The native OsmAnd helper executables are built against OsmAnd Core. Review GPLv3 source-code, notice and distribution requirements for the exact Core revision and build. |
| Qt used by the OsmAnd helper | LGPL terms for Qt; OsmAnd describes its Qt integration as dynamic linking | Include the applicable Qt notices and verify the exact Qt modules and redistribution obligations for the shipped DLLs. |
| OsmAnd resources | Mainly GPL-3.0, with resource-specific exceptions and third-party assets | The license is not changed by copying the resources into an application package. Check individual artwork, fonts and other assets before redistribution. |
| OpenStreetMap-derived map/routing data | ODbL and attribution requirements may apply to the data, independently of the engine license | Engine licensing does not grant rights to redistribute third-party map datasets. Keep data attribution and source notices with any distributed datasets. |

Official upstream references:

- [Light Matter license](https://github.com/Auxx/light-matter/blob/master/LICENSE.md)
- [Valhalla license](https://github.com/valhalla/valhalla)
- [Mapsforge license](https://github.com/mapsforge/mapsforge)
- [OsmAnd project license](https://github.com/osmandapp/Osmand/blob/master/LICENSE)
- [OsmAnd-resources license](https://github.com/osmandapp/OsmAnd-resources/blob/master/LICENSE)
- [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)
- [GNU LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html)
- [OpenStreetMap copyright and license](https://www.openstreetmap.org/copyright)

## 3. OsmAnd Core is not the same thing as OsmAnd resources

These are separate components and must not be treated as having one interchangeable license:

### OsmAnd Core

LumaScope's native OBF renderer and Atlas helper use the upstream OsmAnd Core C++ libraries. The current OsmAnd project license identifies the Core source as GPLv3, with exceptions for certain third-party components. Qt is separately identified as LGPL when dynamically linked.

The helper executables are distributed as part of the LumaScope Windows package. **The current `stage-helpers.ps1` copies the helper EXEs and runtime DLLs, but does not itself copy the GPL/Qt license notices or the corresponding OsmAnd Core source into the release package.** The presence of license texts in the repository (including `tools/osmand-runtime/licenses/GPL-3.0.txt`) is not the same as including the required materials with a binary distribution.

Before publishing a release, verify the exact OsmAnd Core revision, the way its libraries are linked, the Qt DLLs included, and the corresponding source and notices that must accompany the distributed helper. Do not assume that the MIT license on LumaScope's own code overrides the licenses of these native components. Also do not assume, without a legal review of the combined distribution, that the presence of a separate helper process automatically changes the license of every other LumaScope component.

### OsmAnd resources

The resources repository contains several kinds of files. Its top-level license says the repository is mainly GPLv3, except for some resources. The OsmAnd project's license further distinguishes, among other things:

- Text files and rendering-style definitions: the OsmAnd maintainer has confirmed that text/style files are GPLv3.
- Artwork such as SVG and PNG graphics: may be covered by CC-BY-NC-ND 4.0; this is not a blanket permission for commercial redistribution or modification.
- Fonts: the upstream license identifies Google Fonts under Apache License 2.0.
- Some icons and generated voice files: may carry separate or proprietary terms.
- Other third-party resources: must be checked individually.

Useful upstream references:

- [OsmAnd-resources LICENSE](https://github.com/osmandapp/OsmAnd-resources/blob/master/LICENSE)
- [OsmAnd LICENSE and exceptions](https://github.com/osmandapp/Osmand/blob/master/LICENSE)
- [OsmAnd maintainer clarification about text/styles and graphics](https://github.com/osmandapp/Osmand/issues/25685)

Do not label the complete resources tree simply as MIT, simply as CC-BY-NC-ND, or as having a new LumaScope-specific license. Its upstream and file-specific terms remain applicable.

## 4. Are OsmAnd resources included in LumaScope release packages?

**No, not in the current standard Windows production build.** The current `npm run make:prod` sequence and root `build.ps1` stage the OsmAnd helper executables and their runtime dependencies. They do not invoke `tools/osmand-runtime/stage-resources.ps1`. The application uses a separately downloaded resources folder selected by the user; it stores the folder path rather than copying that tree into the normal application package.

Therefore, the current release package does not assign a different license to OsmAnd resources: the resources remain external and are governed by the upstream terms when the user obtains and uses them.

There is a separate `tools/osmand-runtime/stage-resources.ps1` script. If it is run manually, it copies selected resource directories (`rendering_styles`, `poi`, `routing` and `misc`) into `tools/osmand-runtime/stage/resources/` and copies the upstream OsmAnd resources LICENSE, GPL-3.0 text, ICU data license and a notice. That is a staging operation, not a license conversion. If this staged content is ever added to a release package, perform a file-level license audit first; the copied top-level notices alone do not make every asset freely redistributable.

See [OsmAnd resource notice](../tools/osmand-runtime/OSMAND-RESOURCES-NOTICE.md) and [build-from-source](build-from-source.md).

## 5. Release checklist

Before publishing each release:

1. Keep the original Light Matter MIT copyright and permission notice in `LICENSE.md`.
2. Generate or update a complete third-party dependency inventory for the exact npm, Maven, Qt, native and Electron binaries shipped.
3. Include the required license texts, copyright notices and attribution files for every redistributed component.
4. For the OsmAnd Core helper, review GPLv3 obligations for the exact source revision and provide the corresponding source and build modifications where required.
5. Include Qt's LGPL notices and satisfy the applicable dynamic-linking and redistribution conditions.
6. For Mapsforge, include LGPLv3 notices and the licenses of all dependencies embedded in the shaded JAR.
7. Do not include OsmAnd artwork, icons, voices or other resources in a release unless their individual terms permit the intended distribution and use.
8. If distributing OpenStreetMap-derived data, include the required attribution and ODbL information for the data source.
9. Recheck the upstream license files whenever a dependency or source revision is updated.

This list is a starting point, not a substitute for a release-specific software bill of materials (SBOM) and legal review.
