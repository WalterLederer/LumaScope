package org.lumascope.mapsforge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import org.mapsforge.core.graphics.TileBitmap;
import org.mapsforge.core.model.Tile;
import org.mapsforge.map.awt.graphics.AwtGraphicFactory;
import org.mapsforge.map.datastore.MapDataStore;
import org.mapsforge.map.datastore.MultiMapDataStore;
import org.mapsforge.map.layer.cache.InMemoryTileCache;
import org.mapsforge.map.layer.renderer.DatabaseRenderer;
import org.mapsforge.map.layer.renderer.RendererJob;
import org.mapsforge.map.model.DisplayModel;
import org.mapsforge.map.reader.MapFile;
import org.mapsforge.map.rendertheme.ExternalRenderTheme;
import org.mapsforge.map.rendertheme.XmlRenderTheme;
import org.mapsforge.map.rendertheme.internal.MapsforgeThemes;
import org.mapsforge.map.rendertheme.rule.RenderThemeFuture;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

/**
 * Persistent, single-threaded Mapsforge worker.
 *
 * Protocol: one JSON request per stdin line and one JSON response per stdout line.
 * Commands: ping, open, render, close, quit.
 * Render responses contain a base64-encoded PNG. Diagnostics go to stderr only.
 */
public final class MapsforgeWorker {
    private static final Gson GSON = new Gson();
    private static final int TILE_SIZE = 256;
    private static final int TILE_CACHE_CAPACITY = 64;

    private MapDataStore mapDataStore;
    private InMemoryTileCache tileCache;
    private DisplayModel displayModel;
    private RenderThemeFuture renderThemeFuture;
    private DatabaseRenderer renderer;
    private String activeMapPath = "";
    private final java.util.List<String> activeMapPaths = new java.util.ArrayList<>();

    private MapsforgeWorker() {}

    public static void run() throws Exception {
        MapsforgeWorker worker = new MapsforgeWorker();
        try (BufferedReader input = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                if (line.isBlank()) continue;
                boolean quit = false;
                try {
                    JsonObject request = JsonParser.parseString(line).getAsJsonObject();
                    String command = requiredString(request, "command");
                    JsonObject response = worker.handle(command, request);
                    System.out.println(GSON.toJson(response));
                    System.out.flush();
                    quit = "quit".equals(command);
                } catch (Exception error) {
                    JsonObject response = new JsonObject();
                    response.addProperty("status", "error");
                    response.addProperty("message", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
                    System.out.println(GSON.toJson(response));
                    System.out.flush();
                    System.err.println("[Mapsforge] " + error);
                }
                if (quit) break;
            }
        } finally {
            worker.closeMap();
        }
    }

    private JsonObject handle(String command, JsonObject request) throws Exception {
        switch (command) {
            case "ping": {
                JsonObject response = ok(command);
                response.addProperty("opened", mapDataStore != null);
                response.addProperty("map_path", activeMapPath);
                JsonArray paths = new JsonArray();
                activeMapPaths.forEach(paths::add);
                response.add("map_paths", paths);
                return response;
            }
            case "open":
                java.util.List<String> paths = readMapPaths(request);
                openMaps(paths, optionalString(request, "theme_path"));
                JsonObject opened = ok(command);
                opened.addProperty("map_path", activeMapPath);
                JsonArray openedPaths = new JsonArray();
                activeMapPaths.forEach(openedPaths::add);
                opened.add("map_paths", openedPaths);
                opened.addProperty("map_count", activeMapPaths.size());
                opened.addProperty("tile_size", TILE_SIZE);
                return opened;
            case "render":
                return render(request);
            case "close":
                closeMap();
                return ok(command);
            case "quit":
                closeMap();
                return ok(command);
            default:
                throw new IllegalArgumentException("Unknown command: " + command);
        }
    }

    private void openMaps(java.util.List<String> mapPathValues, String themePathValue) throws Exception {
        if (mapPathValues.isEmpty()) {
            throw new IllegalArgumentException("At least one Mapsforge map path is required.");
        }

        closeMap();
        java.util.List<MapDataStore> openedStores = new java.util.ArrayList<>();
        MultiMapDataStore combinedStore = null;
        InMemoryTileCache newTileCache = null;
        try {
            for (String mapPathValue : mapPathValues) {
                Path mapPath = Path.of(mapPathValue).toAbsolutePath().normalize();
                if (!Files.isRegularFile(mapPath)) {
                    throw new IllegalArgumentException("Mapsforge map file not found: " + mapPath);
                }
                openedStores.add(new MapFile(mapPath.toFile()));
            }
            combinedStore = new MultiMapDataStore(MultiMapDataStore.DataPolicy.DEDUPLICATE);
            for (MapDataStore store : openedStores) {
                combinedStore.addMapDataStore(store, false, false);
            }
            newTileCache = new InMemoryTileCache(TILE_CACHE_CAPACITY);

            DisplayModel newDisplayModel = new DisplayModel();
            newDisplayModel.setFixedTileSize(TILE_SIZE);

            XmlRenderTheme theme;
            if (themePathValue == null || themePathValue.isBlank()) {
                theme = MapsforgeThemes.DEFAULT;
            } else {
                Path themePath = Path.of(themePathValue).toAbsolutePath().normalize();
                if (!Files.isRegularFile(themePath)) {
                    throw new IllegalArgumentException("Mapsforge XML render theme not found: " + themePath);
                }
                theme = new ExternalRenderTheme(themePath.toFile());
            }

            RenderThemeFuture newThemeFuture =
                new RenderThemeFuture(AwtGraphicFactory.INSTANCE, theme, newDisplayModel);
            newThemeFuture.run();

            DatabaseRenderer newRenderer = new DatabaseRenderer(
                combinedStore,
                AwtGraphicFactory.INSTANCE,
                newTileCache,
                null,
                true,
                false,
                null
            );

            this.mapDataStore = combinedStore;
            this.tileCache = newTileCache;
            this.displayModel = newDisplayModel;
            this.renderThemeFuture = newThemeFuture;
            this.renderer = newRenderer;
            this.activeMapPaths.clear();
            for (String value : mapPathValues) {
                this.activeMapPaths.add(Path.of(value).toAbsolutePath().normalize().toString());
            }
            this.activeMapPath = String.join(";", this.activeMapPaths);
        } catch (Exception error) {
            if (newTileCache != null) newTileCache.destroy();
            if (combinedStore != null) combinedStore.close();
            else for (MapDataStore store : openedStores) store.close();
            throw error;
        }
    }

    private JsonObject render(JsonObject request) throws Exception {
        if (renderer == null || mapDataStore == null) {
            throw new IllegalStateException("No Mapsforge map is open. Send an open command first.");
        }
        long requestId = request.has("request_id") ? request.get("request_id").getAsLong() : 0L;
        int zoom = requiredInt(request, "z");
        int x = requiredInt(request, "x");
        int y = requiredInt(request, "y");
        if (zoom < 0 || zoom > 22) throw new IllegalArgumentException("Zoom must be between 0 and 22.");
        int tileCount = 1 << zoom;
        if (x < 0 || x >= tileCount || y < 0 || y >= tileCount) {
            throw new IllegalArgumentException("XYZ tile coordinates are outside the selected zoom level.");
        }

        Tile tile = new Tile(x, y, (byte) zoom, TILE_SIZE);
        RendererJob job = new RendererJob(
            tile, mapDataStore, renderThemeFuture, displayModel, 1.0f, false, false
        );
        if (!mapDataStore.supportsTile(tile)) {
            throw new IllegalArgumentException("No loaded Mapsforge map covers tile z=" + zoom + " x=" + x + " y=" + y);
        }
        TileBitmap bitmap = renderer.executeJob(job);
        if (bitmap == null) {
            throw new IllegalStateException("Mapsforge returned no bitmap for z=" + zoom + " x=" + x + " y=" + y);
        }

        ByteArrayOutputStream output = new ByteArrayOutputStream(32 * 1024);
        bitmap.compress(output);
        JsonObject response = ok("render");
        response.addProperty("request_id", requestId);
        response.addProperty("z", zoom);
        response.addProperty("x", x);
        response.addProperty("y", y);
        response.addProperty("width", TILE_SIZE);
        response.addProperty("height", TILE_SIZE);
        response.addProperty("format", "png");
        response.addProperty("png_base64", Base64.getEncoder().encodeToString(output.toByteArray()));
        return response;
    }

    private void closeMap() {
        renderer = null;
        renderThemeFuture = null;
        displayModel = null;
        if (tileCache != null) {
            tileCache.destroy();
            tileCache = null;
        }
        if (mapDataStore != null) {
            mapDataStore.close();
            mapDataStore = null;
        }
        activeMapPath = "";
        activeMapPaths.clear();
    }

    private static JsonObject ok(String command) {
        JsonObject response = new JsonObject();
        response.addProperty("status", "ok");
        response.addProperty("command", command);
        return response;
    }

    private static java.util.List<String> readMapPaths(JsonObject request) {
        java.util.List<String> paths = new java.util.ArrayList<>();
        if (request.has("map_paths") && request.get("map_paths").isJsonArray()) {
            for (com.google.gson.JsonElement element : request.getAsJsonArray("map_paths")) {
                String value = element.getAsString();
                if (!value.isBlank() && !paths.contains(value)) paths.add(value);
            }
        } else if (request.has("map_path")) {
            paths.add(requiredString(request, "map_path"));
        }
        if (paths.isEmpty()) {
            throw new IllegalArgumentException("Missing map_path or non-empty map_paths array.");
        }
        return paths;
    }

    private static String requiredString(JsonObject object, String name) {
        if (!object.has(name) || object.get(name).isJsonNull()) {
            throw new IllegalArgumentException("Missing required field: " + name);
        }
        String value = object.get(name).getAsString();
        if (value.isBlank()) throw new IllegalArgumentException("Field must not be empty: " + name);
        return value;
    }

    private static String optionalString(JsonObject object, String name) {
        if (!object.has(name) || object.get(name).isJsonNull()) return null;
        return object.get(name).getAsString();
    }

    private static int requiredInt(JsonObject object, String name) {
        if (!object.has(name) || object.get(name).isJsonNull()) {
            throw new IllegalArgumentException("Missing required field: " + name);
        }
        return object.get(name).getAsInt();
    }
}
