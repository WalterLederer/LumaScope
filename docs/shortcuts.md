# Key shortcuts

[Back to README](../README.md)

Global shortcuts are registered through Electron and remain available when LumaScope is not focused. Local shortcuts work while the application is active.

| Key shortcut | Function | Global |
| --- | --- | --- |
| `Ctrl + Win + PrtScn` | Copy the topmost visible application window to the clipboard. | Yes |
| `Ctrl + Shift + Win + PrtScn` | Select a screen rectangle and copy it to the clipboard. | Yes |
| `Space / → / Page Down` | Show the next image, unless the pointer is over the location map. | No |
| `← / Page Up` | Show the previous image, unless the pointer is over the location map. | No |
| `Esc` | Close the image view or dismiss the active dialog. | No |
| `+ / =` | Zoom in; in Browse, increase thumbnail size; over the location map, zoom the map in. | No |
| `- / _` | Zoom out; in Browse, decrease thumbnail size; over the location map, zoom the map out. | No |
| `V` | Cycle image comparison modes. | No |
| `L` | Open the Location window. | No |
| `C / F8` | Copy the current image to the clipboard. | No |
| `S` | Open the Screen Capture window. | No |
| `M` | Toggle the magnifier (loupe). | No |
| `H` | Toggle the histogram. | No |
| `Delete` | Delete the current image. | No |
| `F / F11` | Toggle fullscreen mode. | No |

## Runtime status

The Help panel checks whether each global shortcut was successfully registered. The status can be **Active**, **Unavailable** or an error message. The result depends on the current Windows session and whether another application has already registered the same key combination; it is not a static property of the shortcut.

When the pointer is over the Location map, the arrow keys pan the map rather than navigating between images.
