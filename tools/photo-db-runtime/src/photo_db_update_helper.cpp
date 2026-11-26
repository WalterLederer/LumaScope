#include <windows.h>

#include <exiv2/exiv2.hpp>

#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <limits>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <cwctype>
#include <vector>

namespace fs = std::filesystem;

namespace {
constexpr std::uint64_t kWindowsToUnixEpochMilliseconds = 11644473600000ULL;

struct Options {
    fs::path configPath;
    std::optional<std::wstring> drive;
    std::optional<fs::path> favorite;
    std::optional<fs::path> databasePath;
    bool verbose = false;
    bool help = false;
};

struct DatabaseCounts {
    std::uint64_t newFiles = 0;
    std::uint64_t changedFiles = 0;
    std::uint64_t unchangedFiles = 0;
};

struct ExtensionCounts {
    std::uint64_t missing = 0;
    std::uint64_t changed = 0;
    std::uint64_t unchanged = 0;
};

struct FolderMissingCounts {
    std::uint64_t files = 0;
    std::uint64_t jpgFiles = 0;
};

struct ScanStats {
    std::uint64_t filesScanned = 0;
    std::uint64_t imageFiles = 0;
    std::uint64_t gpsFound = 0;
    std::uint64_t withoutGps = 0;
    std::uint64_t metadataErrors = 0;
    std::uint64_t cacheDirectoriesSkipped = 0;
    std::uint64_t filesInsideSkippedDirectories = 0;
    std::uint64_t reparseDirectoriesSkipped = 0;
};

std::string toUtf8(std::wstring_view value) {
    if (value.empty()) return {};
    const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0) throw std::runtime_error("Could not convert a Windows path to UTF-8.");
    std::string result(static_cast<std::size_t>(required), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), required, nullptr, nullptr) <= 0) {
        throw std::runtime_error("Could not convert a Windows path to UTF-8.");
    }
    return result;
}

std::wstring lower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
    return value;
}

fs::path absoluteNormalized(const fs::path& path) {
    std::error_code error;
    auto absolute = fs::absolute(path, error);
    if (error) throw std::runtime_error("Cannot resolve path '" + path.string() + "': " + error.message());
    return absolute.lexically_normal();
}

std::wstring driveRoot(const fs::path& path) {
    const auto value = absoluteNormalized(path).wstring();
    if (value.size() < 2 || value[1] != L':') {
        throw std::runtime_error("Photo favorites must use local drive paths: " + path.string());
    }
    return value.substr(0, 2);
}

std::wstring relativeFolderForDrive(const fs::path& folder, const std::wstring& drive) {
    const fs::path root(drive + L"\\");
    const auto relative = absoluteNormalized(folder).lexically_relative(root);
    if (relative.empty() || relative == L".") return {};
    const auto value = relative.wstring();
    if (value == L".." || value.starts_with(L"..\\")) {
        throw std::runtime_error("Folder is outside its cache database drive: " + folder.string());
    }
    return value;
}

double fileTimeToUnixMilliseconds(const FILETIME& value) {
    ULARGE_INTEGER ticks{};
    ticks.LowPart = value.dwLowDateTime;
    ticks.HighPart = value.dwHighDateTime;
    const double milliseconds = static_cast<double>(ticks.QuadPart) / 10000.0;
    return milliseconds - static_cast<double>(kWindowsToUnixEpochMilliseconds);
}

class SqliteDatabase {
public:
    explicit SqliteDatabase(const fs::path& path) {
        const auto utf8Path = toUtf8(path.wstring());
        const int result = sqlite3_open_v2(utf8Path.c_str(), &database_,
            SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nullptr);
        if (result != SQLITE_OK) {
            const std::string message = database_ ? sqlite3_errmsg(database_) : "could not allocate SQLite handle";
            if (database_) sqlite3_close(database_);
            database_ = nullptr;
            throw std::runtime_error("Cannot open photo database '" + path.string() + "': " + message);
        }
        sqlite3_busy_timeout(database_, 10000);
        const char* sql =
            "SELECT photos.file_size, photos.modified_at "
            "FROM photos JOIN paths ON paths.id = photos.path_id "
            "WHERE paths.relative_folder_path = ?1 COLLATE NOCASE "
            "AND photos.file_name = ?2 COLLATE NOCASE";
        if (sqlite3_prepare_v2(database_, sql, -1, &lookup_, nullptr) != SQLITE_OK) {
            const std::string message = sqlite3_errmsg(database_);
            sqlite3_close(database_);
            database_ = nullptr;
            throw std::runtime_error("Photo database schema is not compatible: " + message);
        }
    }

    ~SqliteDatabase() {
        if (lookup_) sqlite3_finalize(lookup_);
        if (database_) sqlite3_close(database_);
    }

    SqliteDatabase(const SqliteDatabase&) = delete;
    SqliteDatabase& operator=(const SqliteDatabase&) = delete;

    enum class Match { Missing, Changed, Unchanged };

    Match compare(const std::wstring& relativeFolder, const std::wstring& fileName,
                  std::uint64_t size, double modifiedAtMs) {
        sqlite3_reset(lookup_);
        sqlite3_clear_bindings(lookup_);
        const auto folderUtf8 = toUtf8(relativeFolder);
        const auto fileUtf8 = toUtf8(fileName);
        sqlite3_bind_text(lookup_, 1, folderUtf8.c_str(), static_cast<int>(folderUtf8.size()), SQLITE_TRANSIENT);
        sqlite3_bind_text(lookup_, 2, fileUtf8.c_str(), static_cast<int>(fileUtf8.size()), SQLITE_TRANSIENT);

        const int result = sqlite3_step(lookup_);
        if (result == SQLITE_DONE) return Match::Missing;
        if (result != SQLITE_ROW) throw std::runtime_error("SQLite lookup failed: " + std::string(sqlite3_errmsg(database_)));

        const auto databaseSize = static_cast<std::uint64_t>(sqlite3_column_int64(lookup_, 0));
        const double databaseModifiedAt = sqlite3_column_double(lookup_, 1);
        return databaseSize != size || std::abs(databaseModifiedAt - modifiedAtMs) > 0.01
            ? Match::Changed : Match::Unchanged;
    }

private:
    sqlite3* database_ = nullptr;
    sqlite3_stmt* lookup_ = nullptr;
};

std::vector<fs::path> readFavorites(const fs::path& configPath) {
    std::ifstream input(configPath, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open configuration file: " + configPath.string());

    nlohmann::json config;
    try {
        input >> config;
    } catch (const nlohmann::json::exception& error) {
        throw std::runtime_error("Cannot parse LumaScope.config.json: " + std::string(error.what()));
    }

    const auto gallery = config.find("gallery");
    if (gallery == config.end() || !gallery->is_object()) {
        throw std::runtime_error("The configuration does not contain gallery.locations.");
    }
    const auto locations = gallery->find("locations");
    if (locations == gallery->end() || !locations->is_array()) {
        throw std::runtime_error("gallery.locations must be an array.");
    }

    std::vector<fs::path> favorites;
    for (const auto& entry : *locations) {
        if (!entry.is_string()) {
            throw std::runtime_error("Every gallery.locations entry must be a folder path string.");
        }
        const auto rawPath = entry.get<std::string>();
        if (rawPath.empty()) continue;

        const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, rawPath.data(),
            static_cast<int>(rawPath.size()), nullptr, 0);
        if (required <= 0) throw std::runtime_error("A gallery favorite contains an invalid UTF-8 path.");
        std::wstring widePath(static_cast<std::size_t>(required), static_cast<wchar_t>(0));
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, rawPath.data(),
            static_cast<int>(rawPath.size()), widePath.data(), required) <= 0) {
            throw std::runtime_error("Could not decode a gallery favorite path.");
        }
        favorites.emplace_back(widePath);
    }
    return favorites;
}

Options parseArguments(int argc, wchar_t** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::wstring argument = argv[index];
        auto nextValue = [&]() -> std::wstring {
            if (index + 1 >= argc) throw std::runtime_error("Missing command-line option value.");
            return argv[++index];
        };
        if (argument == L"--config") options.configPath = nextValue();
        else if (argument == L"--drive") options.drive = nextValue();
        else if (argument == L"--favorite") options.favorite = fs::path(nextValue());
        else if (argument == L"--db") options.databasePath = fs::path(nextValue());
        else if (argument == L"--verbose") options.verbose = true;
        else if (argument == L"--help" || argument == L"-h" || argument == L"/?") options.help = true;
        else throw std::runtime_error("Unknown command-line option: " + fs::path(argument).string());
    }
    if (!options.help && options.configPath.empty()) {
        throw std::runtime_error("--config is required. Pass the user's LumaScope.config.json path.");
    }
    return options;
}

void printUsage() {
    std::wcout
        << L"photo_db_update_helper.exe --config <LumaScope.config.json> [options]\n\n"
        << L"  --drive <D:>       Scan favorites on one local drive only.\n"
        << L"  --favorite <path>  Scan one exact favorite folder only.\n"
        << L"  --db <path>        Override the drive-local database (single drive only).\n"
        << L"  --verbose          Print each favorite and periodic scan details.\n"
        << L"  --help             Show this help.\n\n"
        << L"Read-only diagnostic: compares filesystem metadata with SQLite and reads GPS metadata for missing image records.\n"
        << L"No database changes are performed.\n";
}

std::uint64_t countFilesInTree(const fs::path& directory) {
    const fs::path pattern = directory / L"*";
    WIN32_FIND_DATAW entry{};
    HANDLE handle = FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &entry,
        FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
    if (handle == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND) return 0;
        throw std::runtime_error("Cannot inspect excluded directory (Windows error "
            + std::to_string(error) + ").");
    }

    std::uint64_t count = 0;
    do {
        const std::wstring_view name(entry.cFileName);
        if (name == L"." || name == L"..") continue;
        if ((entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
            count += countFilesInTree(directory / entry.cFileName);
        } else {
            ++count;
        }
    } while (FindNextFileW(handle, &entry));

    const DWORD lastError = GetLastError();
    FindClose(handle);
    if (lastError != ERROR_NO_MORE_FILES) {
        throw std::runtime_error("Enumeration of excluded directory failed (Windows error "
            + std::to_string(lastError) + ").");
    }
    return count;
}


bool isSupportedImageExtension(const std::wstring& extension) {
    // Keep this list aligned with supportedFileFormats in
    // libs/internal-api/src/lib/desktop.ts. Some formats do not carry EXIF GPS,
    // but they are still supported image files and must be counted as such.
    static const std::set<std::wstring> supported = {
        L".avif", L".bmp", L".gif", L".heic", L".heif", L".jpg", L".jpeg",
        L".jxl", L".jxr", L".exr", L".ohsp", L".png", L".dng", L".rw2",
        L".raw", L".hdr", L".svg", L".tif", L".tiff", L".webp"
    };
    return supported.contains(extension);
}

std::string exifText(const Exiv2::ExifData& data, const char* key) {
    const auto item = data.findKey(Exiv2::ExifKey(key));
    return item == data.end() ? std::string{} : item->toString();
}

std::optional<double> parseXmpCoordinate(const std::string& raw) {
    try {
        std::string text = raw;
        text.erase(std::remove_if(text.begin(), text.end(),
            [](unsigned char ch) { return std::isspace(ch) != 0; }), text.end());
        if (text.empty()) return std::nullopt;
        const char direction = static_cast<char>(std::toupper(static_cast<unsigned char>(text.back())));
        if (direction == 'N' || direction == 'S' || direction == 'E' || direction == 'W') text.pop_back();

        std::vector<double> parts;
        std::size_t start = 0;
        while (start <= text.size()) {
            const auto comma = text.find(',', start);
            const auto token = text.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
            std::size_t consumed = 0;
            const double value = std::stod(token, &consumed);
            if (consumed != token.size() || !std::isfinite(value)) return std::nullopt;
            parts.push_back(value);
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
        if (parts.empty() || parts.size() > 3) return std::nullopt;
        double result = parts[0];
        if (parts.size() > 1) result = std::abs(parts[0]) + std::abs(parts[1]) / 60.0;
        if (parts.size() > 2) result += std::abs(parts[2]) / 3600.0;
        if (direction == 'N' || direction == 'E') result = std::abs(result);
        else if (direction == 'S' || direction == 'W') result = -std::abs(result);
        return result;
    } catch (...) {
        return std::nullopt;
    }
}

std::optional<double> xmpNumber(const Exiv2::XmpData& data, const char* key) {
    const auto item = data.findKey(Exiv2::XmpKey(key));
    return item == data.end() ? std::nullopt : parseXmpCoordinate(item->toString());
}

std::string xmpText(const Exiv2::XmpData& data, const char* key) {
    const auto item = data.findKey(Exiv2::XmpKey(key));
    return item == data.end() ? std::string{} : item->toString();
}

std::optional<double> gpsCoordinate(const Exiv2::ExifData& exif, const Exiv2::XmpData& xmp,
                                    const char* exifKey, const char* xmpKey,
                                    const char* refKey, const char* xmpRefKey,
                                    bool latitude) {
    std::optional<double> coordinate;
    const auto item = exif.findKey(Exiv2::ExifKey(exifKey));
    if (item != exif.end() && item->count() >= 3) {
        try {
            coordinate = std::abs(item->toFloat(0))
                + std::abs(item->toFloat(1)) / 60.0
                + std::abs(item->toFloat(2)) / 3600.0;
        } catch (...) {}
    }
    if (!coordinate) coordinate = xmpNumber(xmp, xmpKey);
    if (!coordinate) return std::nullopt;

    std::string reference = exifText(exif, refKey);
    if (reference.empty()) reference = xmpText(xmp, xmpRefKey);
    std::transform(reference.begin(), reference.end(), reference.begin(),
        [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });
    if ((latitude && reference == "S") || (!latitude && reference == "W")) *coordinate = -std::abs(*coordinate);
    else if ((latitude && reference == "N") || (!latitude && reference == "E")) *coordinate = std::abs(*coordinate);

    const double limit = latitude ? 90.0 : 180.0;
    if (!std::isfinite(*coordinate) || *coordinate < -limit || *coordinate > limit) return std::nullopt;
    return coordinate;
}

bool readGpsCoordinates(const fs::path& path) {
    try {
        // Exiv2 0.28's narrow-path API uses the Windows ANSI code page on
        // Windows. Read via std::filesystem's wide-path support, then inspect
        // the bytes in memory so non-ASCII filenames work reliably.
        std::ifstream input(path, std::ios::binary | std::ios::ate);
        if (!input) throw std::runtime_error("Could not open image file.");
        const auto end = input.tellg();
        if (end <= 0) throw std::runtime_error("Image file is empty or unreadable.");
        const auto length = static_cast<std::uint64_t>(end);
        if (length > static_cast<std::uint64_t>(std::numeric_limits<std::streamsize>::max())) {
            throw std::runtime_error("Image file is too large to read in one operation.");
        }
        if (length > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            throw std::runtime_error("Image file is too large to inspect.");
        }
        std::vector<Exiv2::byte> bytes(static_cast<std::size_t>(length));
        input.seekg(0, std::ios::beg);
        if (!input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()))) {
            throw std::runtime_error("Could not read complete image file.");
        }
        auto image = Exiv2::ImageFactory::open(bytes.data(), bytes.size());
        if (!image.get()) throw std::runtime_error("Exiv2 does not recognize this image format.");
        image->readMetadata();
        const auto& exif = image->exifData();
        const auto& xmp = image->xmpData();

        const auto latitude = gpsCoordinate(exif, xmp,
            "Exif.GPSInfo.GPSLatitude", "Xmp.exif.GPSLatitude",
            "Exif.GPSInfo.GPSLatitudeRef", "Xmp.exif.GPSLatitudeRef", true);
        const auto longitude = gpsCoordinate(exif, xmp,
            "Exif.GPSInfo.GPSLongitude", "Xmp.exif.GPSLongitude",
            "Exif.GPSInfo.GPSLongitudeRef", "Xmp.exif.GPSLongitudeRef", false);
        return latitude.has_value() && longitude.has_value();
    } catch (const Exiv2::Error& error) {
        throw std::runtime_error("Exiv2: " + std::string(error.what()));
    }
}

void countMissingImageMetadata(const fs::path& file, const std::wstring& extension,
                                ScanStats& stats) {
    if (!isSupportedImageExtension(extension)) return;
    ++stats.imageFiles;
    try {
        if (readGpsCoordinates(file)) ++stats.gpsFound;
        else ++stats.withoutGps;
    } catch (const std::exception&) {
        ++stats.metadataErrors;
        // Per-file diagnostics are intentionally suppressed: console I/O for every
        // metadata failure dominates scan time on large photo collections.
        // The aggregate error count is reported in the final summary.
    }
}

void scanDirectory(const fs::path& directory, const std::wstring& drive,
                   SqliteDatabase* database, DatabaseCounts& counts, std::map<std::wstring, ExtensionCounts>& extensionCounts,
                   std::map<std::wstring, ExtensionCounts>& rootExtensionCounts,
                   std::map<std::wstring, FolderMissingCounts>& missingByFolder,
                   ScanStats& stats, std::uint64_t& scanned, bool verbose, std::set<std::wstring>& visitedFiles) {
    const fs::path pattern = directory / L"*";
    WIN32_FIND_DATAW entry{};
    HANDLE handle = FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &entry,
        FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
    if (handle == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND) return;
        throw std::runtime_error("Cannot enumerate directory '" + directory.string()
            + "' (Windows error " + std::to_string(error) + ").");
    }

    do {
        const std::wstring_view name(entry.cFileName);
        if (name == L"." || name == L"..") continue;
        const fs::path child = directory / entry.cFileName;

        if ((entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                ++stats.reparseDirectoriesSkipped;
                continue;
            }
            const auto directoryName = lower(std::wstring(name));
            if (directoryName == L".cache" || directoryName == L".thumbnails") {
                ++stats.cacheDirectoriesSkipped;
                stats.filesInsideSkippedDirectories += countFilesInTree(child);
                continue;
            }
            scanDirectory(child, drive, database, counts, extensionCounts, rootExtensionCounts, missingByFolder, stats, scanned, verbose, visitedFiles);
            continue;
        }

        const auto normalizedPath = lower(absoluteNormalized(child).wstring());
        if (!visitedFiles.insert(normalizedPath).second) continue;

        const auto size = (static_cast<std::uint64_t>(entry.nFileSizeHigh) << 32) | entry.nFileSizeLow;
        const auto modifiedAtMs = fileTimeToUnixMilliseconds(entry.ftLastWriteTime);
        ++scanned;
        ++stats.filesScanned;

        const auto extension = lower(child.extension().wstring());
        const auto extensionKey = extension.empty() ? L"(no extension)" : extension;
        auto& extensionCount = extensionCounts[extensionKey];
        auto& rootExtensionCount = rootExtensionCounts[extensionKey];
        if (!database) {
            ++counts.newFiles;
            ++extensionCount.missing;
            ++rootExtensionCount.missing;
            auto& folderMissing = missingByFolder[absoluteNormalized(directory).wstring()];
            ++folderMissing.files;
            if (extension == L".jpg") ++folderMissing.jpgFiles;
            countMissingImageMetadata(child, extension, stats);
        } else {
            switch (database->compare(relativeFolderForDrive(directory, drive), child.filename().wstring(), size, modifiedAtMs)) {
                case SqliteDatabase::Match::Missing:
                    ++counts.newFiles;
                    ++extensionCount.missing;
                    ++rootExtensionCount.missing;
                    {
                        auto& folderMissing = missingByFolder[absoluteNormalized(directory).wstring()];
                        ++folderMissing.files;
                        if (extension == L".jpg") ++folderMissing.jpgFiles;
                    }
                    countMissingImageMetadata(child, extension, stats);
                    break;
                case SqliteDatabase::Match::Changed:
                    ++counts.changedFiles;
                    ++extensionCount.changed;
                    ++rootExtensionCount.changed;
                    break;
                case SqliteDatabase::Match::Unchanged:
                    ++counts.unchangedFiles;
                    ++extensionCount.unchanged;
                    ++rootExtensionCount.unchanged;
                    break;
            }
        }

        // Keep progress output sparse; console writes are expensive on Windows.
        if (verbose && scanned % 10000 == 0) {
            std::wcout << L"Scanned " << scanned << L" files\n";
        }
    } while (FindNextFileW(handle, &entry));

    const DWORD lastError = GetLastError();
    FindClose(handle);
    if (lastError != ERROR_NO_MORE_FILES) {
        throw std::runtime_error("Directory enumeration failed for '" + directory.string()
            + "' (Windows error " + std::to_string(lastError) + ").");
    }
}

bool isSameOrDescendantPath(const fs::path& candidate, const fs::path& parent) {
    auto candidateText = lower(candidate.lexically_normal().wstring());
    auto parentText = lower(parent.lexically_normal().wstring());
    while (parentText.size() > 3 && (parentText.back() == L'\\' || parentText.back() == L'/')) {
        parentText.pop_back();
    }
    if (candidateText == parentText) return true;
    if (candidateText.size() <= parentText.size() || candidateText.compare(0, parentText.size(), parentText) != 0) {
        return false;
    }
    return candidateText[parentText.size()] == L'\\' || candidateText[parentText.size()] == L'/';
}

fs::path defaultDatabasePath(const std::wstring& drive) {
    return fs::path(drive + L"\\") / L".cache" / L"LumaScope.cache.sqlite";
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        // Suppress low-level vendor MakerNote parser diagnostics; explicit
        // metadata read failures are counted and reported separately.
        Exiv2::LogMsg::setLevel(Exiv2::LogMsg::mute);
        const auto options = parseArguments(argc, argv);
        if (options.help) {
            printUsage();
            return 0;
        }

        const auto favorites = readFavorites(options.configPath);
        std::vector<fs::path> selectedFavorites;
        for (const auto& favorite : favorites) {
            const auto normalized = absoluteNormalized(favorite);
            if (options.favorite && lower(normalized.wstring()) != lower(absoluteNormalized(*options.favorite).wstring())) continue;
            if (options.drive && lower(driveRoot(normalized)) != lower(*options.drive)) continue;
            selectedFavorites.push_back(normalized);
        }
        if (selectedFavorites.empty()) throw std::runtime_error("No matching folders were found in gallery.locations.");

        // A parent favorite already covers every nested favorite. Remove those
        // descendants so each physical tree is enumerated exactly once.
        std::sort(selectedFavorites.begin(), selectedFavorites.end(),
            [](const fs::path& left, const fs::path& right) {
                return left.native().size() < right.native().size();
            });
        std::vector<fs::path> scanRoots;
        for (const auto& favorite : selectedFavorites) {
            const bool covered = std::any_of(scanRoots.begin(), scanRoots.end(),
                [&](const fs::path& root) { return isSameOrDescendantPath(favorite, root); });
            if (!covered) scanRoots.push_back(favorite);
        }
        selectedFavorites = std::move(scanRoots);

        std::set<std::wstring> drives;
        for (const auto& favorite : selectedFavorites) drives.insert(lower(driveRoot(favorite)));
        if (options.databasePath && drives.size() != 1) {
            throw std::runtime_error("--db requires the selected favorites to be on exactly one drive.");
        }

        const auto scanStartedAt = std::chrono::steady_clock::now();
        std::map<std::wstring, std::unique_ptr<SqliteDatabase>> databases;
        DatabaseCounts totalCounts;
        std::map<std::wstring, ExtensionCounts> extensionCounts;
        std::uint64_t totalScanned = 0;
        std::set<std::wstring> visitedFiles;
        std::vector<ScanStats> perRootStats(selectedFavorites.size());
        std::vector<std::map<std::wstring, ExtensionCounts>> perRootExtensionCounts(selectedFavorites.size());
        std::vector<std::map<std::wstring, FolderMissingCounts>> perRootMissingByFolder(selectedFavorites.size());

        for (std::size_t selectedFavoritesIndex = 0; selectedFavoritesIndex < selectedFavorites.size(); ++selectedFavoritesIndex) {
            const auto& favorite = selectedFavorites[selectedFavoritesIndex];
            const auto drive = driveRoot(favorite);
            const auto key = lower(drive);
            if (options.verbose) std::wcout << L"Scanning favorite " << (selectedFavoritesIndex + 1) << L" of " << selectedFavorites.size() << L"\n";

            auto found = databases.find(key);
            if (found == databases.end()) {
                const auto path = options.databasePath.value_or(defaultDatabasePath(drive));
                if (fs::exists(path)) {
                    found = databases.emplace(key, std::make_unique<SqliteDatabase>(path)).first;
                } else {
                    std::wcout << L"Database not found; files will be counted as new: " << path.wstring() << L"\n";
                    found = databases.emplace(key, nullptr).first;
                }
            }

            scanDirectory(favorite, drive, found->second.get(), totalCounts, extensionCounts, perRootExtensionCounts[selectedFavoritesIndex], perRootMissingByFolder[selectedFavoritesIndex], perRootStats[selectedFavoritesIndex],
                totalScanned, options.verbose, visitedFiles);
        }

        std::wcout << L"\nPhoto database scan complete\n"
                   << L"Scan roots:      " << selectedFavorites.size() << L"\n";
        for (std::size_t index = 0; index < selectedFavorites.size(); ++index) {
            const auto& stats = perRootStats[index];
            std::wcout << L"Root " << (index + 1) << L": files=" << stats.filesScanned
                       << L", cache/thumbnails directories skipped=" << stats.cacheDirectoriesSkipped
                       << L", files inside those directories=" << stats.filesInsideSkippedDirectories
                       << L", reparse directories skipped=" << stats.reparseDirectoriesSkipped << L"\n";
        }
        std::uint64_t excludedFiles = 0;
        std::uint64_t totalImageFiles = 0;
        std::uint64_t totalGpsFound = 0;
        std::uint64_t totalWithoutGps = 0;
        std::uint64_t totalMetadataErrors = 0;
        for (const auto& stats : perRootStats) {
            excludedFiles += stats.filesInsideSkippedDirectories;
            totalImageFiles += stats.imageFiles;
            totalGpsFound += stats.gpsFound;
            totalWithoutGps += stats.withoutGps;
            totalMetadataErrors += stats.metadataErrors;
        }
        const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - scanStartedAt).count();
        const auto filesPerSecond = elapsed > 0.0 ? static_cast<double>(totalScanned) / elapsed : 0.0;
        std::wcout << L"Files scanned:   " << totalScanned << L"\n"
                   << L"Excluded files:  " << excludedFiles << L"\n"
                   << L"Files accounted: " << (totalScanned + excludedFiles) << L"\n"
                   << L"Missing in DB:   " << totalCounts.newFiles << L"\n"
                   << L"Changed:         " << totalCounts.changedFiles << L"\n"
                   << L"Unchanged:       " << totalCounts.unchangedFiles << L"\n"
                   << L"Image files (missing records): " << totalImageFiles << L"\n"
                   << L"GPS found:       " << totalGpsFound << L"\n"
                   << L"Without GPS:     " << totalWithoutGps << L"\n"
                   << L"EXIF errors:     " << totalMetadataErrors << L"\n"
                   << L"Elapsed seconds: " << elapsed << L"\n"
                   << L"Files/second:    " << filesPerSecond << L"\n";
        std::wcout << L"\nMissing files by scan root (top 12 extensions):\n";
        for (std::size_t index = 0; index < selectedFavorites.size(); ++index) {
            std::vector<std::pair<std::wstring, std::uint64_t>> missingByExtension;
            for (const auto& [extension, values] : perRootExtensionCounts[index]) {
                if (values.missing > 0) missingByExtension.emplace_back(extension, values.missing);
            }
            std::sort(missingByExtension.begin(), missingByExtension.end(),
                [](const auto& left, const auto& right) { return left.second > right.second; });
            std::wcout << L"  Root " << (index + 1) << L" (" << selectedFavorites[index].wstring() << L"):\n";
            const auto limit = std::min<std::size_t>(12, missingByExtension.size());
            for (std::size_t item = 0; item < limit; ++item) {
                std::wcout << L"    " << missingByExtension[item].first << L": "
                           << missingByExtension[item].second << L"\n";
            }
        }
        std::wcout << L"\nMissing files by folder (top 20 per scan root):\n";
        for (std::size_t index = 0; index < selectedFavorites.size(); ++index) {
            std::vector<std::pair<std::wstring, FolderMissingCounts>> folders(
                perRootMissingByFolder[index].begin(), perRootMissingByFolder[index].end());
            std::sort(folders.begin(), folders.end(), [](const auto& left, const auto& right) {
                return left.second.files > right.second.files;
            });
            std::wcout << L"  Root " << (index + 1) << L" (" << selectedFavorites[index].wstring() << L"):\n";
            const auto limit = std::min<std::size_t>(20, folders.size());
            for (std::size_t item = 0; item < limit; ++item) {
                std::wcout << L"    " << folders[item].first << L": " << folders[item].second.files
                           << L" missing (JPG: " << folders[item].second.jpgFiles << L")\n";
            }
        }
        std::wcout << L"\nFile extensions (missing / changed / unchanged):\n";
        for (const auto& [extension, values] : extensionCounts) {
            if (values.missing == 0 && values.changed == 0 && values.unchanged == 0) continue;
            std::wcout << L"  " << extension << L": " << values.missing << L" / "
                       << values.changed << L" / " << values.unchanged << L"\n";
        }
        std::wcout << L"Mode:            read-only diagnostic (no database changes)\n";
        return 0;
    }
    catch (const std::exception& error) {
        std::cerr << "[photo-db-update] ERROR: " << error.what() << "\n";
        return 1;
    }
}
