package org.lumascope.mapsforge;

import org.mapsforge.core.graphics.TileBitmap;
import org.mapsforge.core.model.Tile;
import org.mapsforge.map.awt.AwtGraphicFactory;
import org.mapsforge.map.datastore.MapDataStore;
import org.mapsforge.map.layer.renderer.DatabaseRenderer;
import org.mapsforge.map.layer.renderer.RendererJob;
import org.mapsforge.map.model.DisplayModel;
import org.mapsforge.map.reader.MapFile;
import org.mapsforge.map.rendertheme.XmlRenderTheme;
import org.mapsforge.map.rendertheme.ExternalRenderTheme;
import org.mapsforge.map.rendertheme.internal.MapsforgeThemes;
import org.mapsforge.map.rendertheme.rule.RenderThemeFuture;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Path;

/**
 * Minimal desktop proof of concept: render one XYZ tile from one Mapsforge .map file.
 * This executable is intentionally isolated from the Electron/OsmAnd processes.
 */
public final class MapsforgeTilePoc {
    private MapsforgeTilePoc() {}

    public static void main(String[] args) {
        if (args.length < 5 || args.length > 6) {
            System.err.println("Usage: java -jar mapsforge-renderer.jar <map.map> <zoom> <x> <y> <output.png> [theme.xml]");
            System.exit(2);
        }

        Path mapPath = Path.of(args[0]).toAbsolutePath().normalize();
        int zoom = Integer.parseInt(args[1]);
        int x = Integer.parseInt(args[2]);
        int y = Integer.parseInt(args[3]);
        Path outputPath = Path.of(args[4]).toAbsolutePath().normalize();
        Path themePath = args.length == 6 ? Path.of(args[5]).toAbsolutePath().normalize() : null;

        if (!mapPath.toFile().isFile()) {
            throw new IllegalArgumentException("Mapsforge map file does not exist: " + mapPath);
        }
        if (zoom < 0 || zoom > 22) {
            throw new IllegalArgumentException("Zoom must be between 0 and 22.");
        }
        int tileCount = 1 << zoom;
        if (x < 0 || x >= tileCount || y < 0 || y >= tileCount) {
            throw new IllegalArgumentException("XYZ tile coordinates are outside the selected zoom level.");
        }

        MapDataStore mapDataStore = null;
        try {
            mapDataStore = new MapFile(mapPath.toFile());

            DisplayModel displayModel = new DisplayModel();
            displayModel.setFixedTileSize(256);

            XmlRenderTheme renderTheme = themePath == null
                ? MapsforgeThemes.DEFAULT
                : new ExternalRenderTheme(themePath.toFile());

            RenderThemeFuture renderThemeFuture =
                new RenderThemeFuture(AwtGraphicFactory.INSTANCE, renderTheme, displayModel);
            renderThemeFuture.run();

            DatabaseRenderer renderer = new DatabaseRenderer(
                mapDataStore,
                AwtGraphicFactory.INSTANCE,
                null,
                null,
                true,
                false,
                null
            );

            Tile tile = new Tile(x, y, (byte) zoom, 256);
            RendererJob job = new RendererJob(
                tile,
                mapDataStore,
                renderThemeFuture,
                displayModel,
                1.0f,
                false,
                false
            );

            TileBitmap bitmap = renderer.executeJob(job);
            if (bitmap == null) {
                throw new IllegalStateException("Mapsforge returned no bitmap for z=" + zoom + " x=" + x + " y=" + y);
            }

            File parent = outputPath.getParent().toFile();
            if (!parent.exists() && !parent.mkdirs()) {
                throw new IllegalStateException("Could not create output directory: " + parent);
            }
            try (FileOutputStream output = new FileOutputStream(outputPath.toFile())) {
                bitmap.compress(output);
            }

            System.out.println("OK " + outputPath);
        } catch (Exception error) {
            System.err.println("MAPSFORGE_ERROR " + error.getClass().getSimpleName() + ": " + error.getMessage());
            error.printStackTrace(System.err);
            System.exit(1);
        } finally {
            if (mapDataStore != null) {
                mapDataStore.close();
            }
        }
    }
}
