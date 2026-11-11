# LumaScope Mapsforge renderer proof of concept

This is an isolated Java desktop renderer for Mapsforge `.map` files. It does not read or convert OsmAnd `.obf` files and is not connected to the existing OsmAnd helper process.

## Requirements

- JDK 17 or newer
- Apache Maven 3.9+
- One valid Mapsforge `.map` file

## Build

From the repository root:

```powershell
mvn -f tools/mapsforge-renderer/pom.xml clean package
```

The standalone jar is created at:

`tools/mapsforge-renderer/target/mapsforge-renderer.jar`

## Render one XYZ tile

```powershell
java -jar tools/mapsforge-renderer/target/mapsforge-renderer.jar "D:\Maps\region.map" 12 2140 1360 "D:\Temp\mapsforge-poc.png"
```

Optional custom XML render theme:

```powershell
java -jar tools/mapsforge-renderer/target/mapsforge-renderer.jar "D:\Maps\region.map" 12 2140 1360 "D:\Temp\mapsforge-custom.png" "D:\Maps\theme.xml"
```

The default theme is Mapsforge's built-in default theme. Output is one 256 x 256 PNG tile.

## Next integration steps

1. Verify a real `.map` file and render a known tile.
2. Replace the one-shot command with a persistent line-oriented worker protocol and binary tile responses.
3. Add Mapsforge map registration as its own map type in the offline map catalogue.
4. Add multiple-map coverage selection, runtime theme switching and Mapsforge hillshading.
5. Stage a dedicated runtime/helper beside the application package.

The Mapsforge renderer remains a separate process. It must never be folded into the OsmAnd OBF renderer.
