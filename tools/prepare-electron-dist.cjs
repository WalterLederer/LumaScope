const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getElectronCacheRoot() {
  if (process.env.ELECTRON_CACHE) return process.env.ELECTRON_CACHE;

  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "electron",
      "Cache",
    );
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "electron");
  }

  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "electron",
  );
}

function main() {
  const version = require("../package.json").devDependencies.electron;
  const platform = process.platform;
  const arch = process.arch;
  const archiveName = `electron-v${version}-${platform}-${arch}.zip`;
  const cacheRoot = getElectronCacheRoot();
  const candidates = [];

  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(cacheRoot, entry.name, archiveName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        candidates.push(candidate);
      }
    }

    const rootCandidate = path.join(cacheRoot, archiveName);
    if (fs.existsSync(rootCandidate) && fs.statSync(rootCandidate).isFile()) {
      candidates.push(rootCandidate);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Electron ${version} (${platform}-${arch}) is not present in the local cache: ${cacheRoot}. Run npm install or populate the Electron cache before packaging.`,
    );
  }

  const source = candidates[0];
  const destinationDirectory = path.resolve(".electron-dist");
  const destination = path.join(destinationDirectory, archiveName);
  fs.mkdirSync(destinationDirectory, { recursive: true });

  if (
    !fs.existsSync(destination) ||
    fs.statSync(source).size !== fs.statSync(destination).size ||
    fs.statSync(source).mtimeMs > fs.statSync(destination).mtimeMs
  ) {
    fs.copyFileSync(source, destination);
  }

  console.log(`[Electron cache] Using local archive: ${source}`);
  console.log(`[Electron cache] Staged for electron-builder: ${destination}`);
}

main();
