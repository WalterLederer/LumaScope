#include <windows.h>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <cwctype>
#include <vector>

namespace fs = std::filesystem;
using boost::property_tree::ptree;

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
    ptree config;
    std::ifstream input(configPath, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open configuration file: " + configPath.string());
    boost::property_tree::read_json(input, config);
    const auto gallery = config.get_child_optional("gallery");
    if (!gallery) throw std::runtime_error("The configuration does not contain gallery.locations.");
    const auto locations = gallery->get_child_optional("locations");
    if (!locations) throw std::runtime_error("The configuration does not contain gallery.locations.");

    std::vector<fs::path> favorites;
    for (const auto& entry : *locations) {
        const auto rawPath = entry.second.data();
        if (!rawPath.empty()) {
            const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, rawPath.data(),
                static_cast<int>(rawPath.size()), nullptr, 0);
            if (required <= 0) throw std::runtime_error("A gallery favorite contains an invalid UTF-8 path.");
            std::wstring widePath(static_cast<std::size_t>(required), L'\\0');
            if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, rawPath.data(),
                static_cast<int>(rawPath.size()), widePath.data(), required) <= 0) {
                throw std::runtime_error("Could not decode a gallery favorite path.");
            }
            favorites.emplace_back(widePath);
        }
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
        << L"Initial diagnostic mode: compares filesystem metadata with SQLite only.\n"
        << L"No database changes or EXIF reads are performed yet.\n";
}

void scanDirectory(const fs::path& directory, const std::wstring& drive,
                   SqliteDatabase* database, DatabaseCounts& counts, std::uint64_t& scanned,
                   bool verbose, std::set<std::wstring>& visitedFiles) {
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
            if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
            const auto directoryName = lower(std::wstring(name));
            if (directoryName == L".cache" || directoryName == L".thumbnails") continue;
            scanDirectory(child, drive, database, counts, scanned, verbose, visitedFiles);
            continue;
        }

        const auto normalizedPath = lower(absoluteNormalized(child).wstring());
        if (!visitedFiles.insert(normalizedPath).second) continue;

        const auto size = (static_cast<std::uint64_t>(entry.nFileSizeHigh) << 32) | entry.nFileSizeLow;
        const auto modifiedAtMs = fileTimeToUnixMilliseconds(entry.ftLastWriteTime);
        ++scanned;

        if (!database) {
            ++counts.newFiles;
        } else {
            switch (database->compare(relativeFolderForDrive(directory, drive), child.filename().wstring(), size, modifiedAtMs)) {
                case SqliteDatabase::Match::Missing: ++counts.newFiles; break;
                case SqliteDatabase::Match::Changed: ++counts.changedFiles; break;
                case SqliteDatabase::Match::Unchanged: ++counts.unchangedFiles; break;
            }
        }

        if (verbose && scanned % 1000 == 0) {
            std::wcout << L"Scanned " << scanned << L" files under " << root.wstring() << L"\n";
        }
    } while (FindNextFileW(handle, &entry));

    const DWORD lastError = GetLastError();
    FindClose(handle);
    if (lastError != ERROR_NO_MORE_FILES) {
        throw std::runtime_error("Directory enumeration failed for '" + directory.string()
            + "' (Windows error " + std::to_string(lastError) + ").");
    }
}

fs::path defaultDatabasePath(const std::wstring& drive) {
    return fs::path(drive + L"\\") / L".cache" / L"LumaScope.cache.sqlite";
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
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

        std::set<std::wstring> drives;
        for (const auto& favorite : selectedFavorites) drives.insert(lower(driveRoot(favorite)));
        if (options.databasePath && drives.size() != 1) {
            throw std::runtime_error("--db requires the selected favorites to be on exactly one drive.");
        }

        std::map<std::wstring, std::unique_ptr<SqliteDatabase>> databases;
        DatabaseCounts totalCounts;
        std::uint64_t totalScanned = 0;
        std::set<std::wstring> visitedFiles;

        for (const auto& favorite : selectedFavorites) {
            const auto drive = driveRoot(favorite);
            const auto key = lower(drive);
            if (options.verbose) std::wcout << L"Scanning favorite: " << favorite.wstring() << L"\n";

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

            scanDirectory(favorite, favorite, drive, found->second.get(), totalCounts,
                totalScanned, options.verbose, visitedFiles);
        }

        std::wcout << L"\nPhoto database scan complete\n"
                   << L"Favorites:       " << selectedFavorites.size() << L"\n"
                   << L"Files scanned:   " << totalScanned << L"\n"
                   << L"Missing in DB:   " << totalCounts.newFiles << L"\n"
                   << L"Changed:         " << totalCounts.changedFiles << L"\n"
                   << L"Unchanged:       " << totalCounts.unchangedFiles << L"\n"
                   << L"Mode:            read-only diagnostic (no database changes)\n";
        return 0;
    }
    catch (const std::exception& error) {
        std::cerr << "[photo-db-update] ERROR: " << error.what() << "\n";
        return 1;
    }
}
