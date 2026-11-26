# Photo database update helper

Standalone Windows C++ helper for scanning the folders stored in the user's
`LumaScope.config.json` under `gallery.locations`.

## Build

Run from the repository root in PowerShell 7:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/photo-db-runtime/build.ps1
```

The build uses the `x64-windows-release` vcpkg triplet. Set `VCPKG_ROOT` or
pass `-VcpkgRoot` if the vcpkg checkout is not in the sibling
`Valhalla\vcpkg` directory.

## Diagnostic invocation

```powershell
.\tools\photo-db-runtime\build\Release\photo_db_update_helper.exe --config "C:\path\to\LumaScope.config.json" --drive "D:" --verbose
```

Optional filters:

- `--favorite "D:\Photos"`: scan one exact favorite.
- `--drive "D:"`: scan favorites on one drive.
- `--db "D:\test\LumaScope.cache.sqlite"`: use an alternate database (the selected favorites must belong to one drive).
- `--help`: print command-line usage.

## Current implementation stage

The first stage is intentionally read-only. It reads favorite paths from
`gallery.locations`, recursively enumerates files with
`FindFirstFileExW` / `FindNextFileW`, and compares file size and last-write
timestamp with `photos` and `paths.relative_folder_path` in the existing
drive-local SQLite database.

It skips `.cache`, `.thumbnails`, and directory reparse points. Overlapping
favorite folders are de-duplicated. No database rows are inserted, updated,
or deleted in this diagnostic stage, and EXIF/GPS metadata is not read yet.
