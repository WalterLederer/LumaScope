const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getElectronCacheRoot() {
  if (process.env.ELECTRON_CACHE) {
    return process.env.ELECTRON_CACHE;
  }

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "electron", "Cache");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "electron");
  }

  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "electron",
  );
}

module.exports = function resolveElectronDist({ version, platformName, arch }) {
  const cacheRoot = getElectronCacheRoot();
  const archiveName = `electron-v${version}-${platformName}-${arch}.zip`;

  // @electron/get stores each release in a URL-hash subdirectory. Search
  // those directories so this works with the default cache and mirrors.
  const candidates = [path.join(cacheRoot, archiveName)];

  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(cacheRoot, entry.name, archiveName));
      }
    }
  }

  const archivePath = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

  // Return the expected path even when absent: electron-builder then fails
  // explicitly instead of silently falling back to a network download.
  return archivePath || path.join(cacheRoot, archiveName);
};
