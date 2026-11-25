#include "osmand_native_map_widget.h"
#include "file_system_core_resources_provider.h"

#include <QApplication>
#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QJsonArray>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaObject>
#include <QTimer>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QHash>

#include <OsmAndCore/ObfsCollection.h>
#include <OsmAndCore/Data/ObfFile.h>
#include <OsmAndCore/Data/ObfInfo.h>
#include <OsmAndCore/Data/ObfMapSectionInfo.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <iostream>
#include <limits>
#include <string>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <io.h>
#endif

namespace
{
#ifdef _WIN32
volatile LONG g_diagnosticRequestId = 0;
volatile LONG g_diagnosticStage = 0;
char g_diagnosticRequestContext[512] = "no render request active";

LONG WINAPI atlasUnhandledExceptionFilter(EXCEPTION_POINTERS* exceptionInfo)
{
    char message[1024]{};
    const auto* record = exceptionInfo && exceptionInfo->ExceptionRecord
        ? exceptionInfo->ExceptionRecord : nullptr;
    const auto exceptionCode = record ? record->ExceptionCode : 0u;
    const auto exceptionAddress = record ? record->ExceptionAddress : nullptr;
    const auto stage = InterlockedCompareExchange(&g_diagnosticStage, 0, 0);
    const auto requestId = InterlockedCompareExchange(&g_diagnosticRequestId, 0, 0);
    const auto length = std::snprintf(
        message, sizeof(message),
        "[atlas-helper][FATAL] pid=%lu exception=0x%08lX address=%p request=%ld stage=%ld context=%s\\r\\n",
        static_cast<unsigned long>(GetCurrentProcessId()),
        static_cast<unsigned long>(exceptionCode),
        exceptionAddress,
        static_cast<long>(requestId),
        static_cast<long>(stage),
        g_diagnosticRequestContext);
    const HANDLE errorHandle = GetStdHandle(STD_ERROR_HANDLE);
    if (errorHandle != nullptr && errorHandle != INVALID_HANDLE_VALUE && length > 0)
    {
        DWORD written = 0;
        WriteFile(errorHandle, message,
            static_cast<DWORD>(std::min<int>(length, static_cast<int>(sizeof(message) - 1))),
            &written, nullptr);
    }
    return EXCEPTION_EXECUTE_HANDLER;
}
#endif

constexpr int kFramePollIntervalMs = 100;
constexpr int kFrameTimeoutMs = 30000;
constexpr int kMaximumDimension = 8192;
// Render beyond the requested 256px tile and crop the centre. Keep a 192px
// base margin (scaled for display DPI) so labels have sufficient placement
// context around the visible tile.
constexpr int kLabelOverscanPixels = 192;
constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint16_t kHeaderSize = 40;
constexpr std::uint32_t kPixelFormatRgba8 = 1;

QString decodePathArgument(const char* argument)
{
    const auto value = QString::fromLatin1(argument);
    if (value.startsWith(QStringLiteral("utf8hex:")))
    {
        const auto hex = value.mid(8).toLatin1();
        if (hex.isEmpty() || (hex.size() % 2) != 0)
            return {};
        const auto utf8 = QByteArray::fromHex(hex);
        if (utf8.isEmpty() || utf8.size() * 2 != hex.size())
            return {};
        const auto path = QString::fromUtf8(utf8);
        return path.toUtf8() == utf8 ? path : QString();
    }
    // Backward compatibility for existing helper invocations.
    return QString::fromLocal8Bit(argument);
}

#ifdef _WIN32
HANDLE g_protocolOutputHandle = INVALID_HANDLE_VALUE;

bool initializeOutputChannels()
{
    std::fflush(stdout);
    std::cout.flush();

    const HANDLE originalOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    const HANDLE errorOutput = GetStdHandle(STD_ERROR_HANDLE);
    if (originalOutput == nullptr || originalOutput == INVALID_HANDLE_VALUE
        || errorOutput == nullptr || errorOutput == INVALID_HANDLE_VALUE)
        return false;

    if (!DuplicateHandle(
            GetCurrentProcess(), originalOutput,
            GetCurrentProcess(), &g_protocolOutputHandle,
            0, FALSE, DUPLICATE_SAME_ACCESS))
        return false;

    if (!SetStdHandle(STD_OUTPUT_HANDLE, errorOutput)
        || _dup2(_fileno(stderr), _fileno(stdout)) != 0)
    {
        CloseHandle(g_protocolOutputHandle);
        g_protocolOutputHandle = INVALID_HANDLE_VALUE;
        return false;
    }

    std::cout.rdbuf(std::cerr.rdbuf());
    return true;
}

bool writeProtocolBytes(const void* data, std::size_t length)
{
    const auto* bytes = static_cast<const unsigned char*>(data);
    while (length > 0)
    {
        const DWORD chunk = static_cast<DWORD>(
            length > static_cast<std::size_t>(std::numeric_limits<DWORD>::max())
                ? std::numeric_limits<DWORD>::max() : length);
        DWORD written = 0;
        if (!WriteFile(g_protocolOutputHandle, bytes, chunk, &written, nullptr) || written == 0)
            return false;
        bytes += written;
        length -= written;
    }
    return true;
}
#else
bool initializeOutputChannels() { return true; }
bool writeProtocolBytes(const void* data, std::size_t length)
{
    return std::fwrite(data, 1, length, stdout) == length;
}
#endif

void writeU16(std::array<unsigned char, kHeaderSize>& header, std::size_t offset, std::uint16_t value)
{
    header[offset] = static_cast<unsigned char>(value & 0xff);
    header[offset + 1] = static_cast<unsigned char>((value >> 8) & 0xff);
}

void writeU32(std::array<unsigned char, kHeaderSize>& header, std::size_t offset, std::uint32_t value)
{
    for (int i = 0; i < 4; ++i)
        header[offset + static_cast<std::size_t>(i)] = static_cast<unsigned char>((value >> (i * 8)) & 0xff);
}

void writeU64(std::array<unsigned char, kHeaderSize>& header, std::size_t offset, std::uint64_t value)
{
    for (int i = 0; i < 8; ++i)
        header[offset + static_cast<std::size_t>(i)] = static_cast<unsigned char>((value >> (i * 8)) & 0xff);
}

void writeFrameHeader(
    std::uint32_t status,
    std::uint32_t requestId,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t stride,
    std::uint32_t pixelFormat,
    std::uint64_t payloadLength)
{
    std::array<unsigned char, kHeaderSize> header{};
    header[0] = 'O';
    header[1] = 'S';
    header[2] = 'M';
    header[3] = 'A';
    writeU16(header, 4, kProtocolVersion);
    writeU16(header, 6, kHeaderSize);
    writeU32(header, 8, status);
    writeU32(header, 12, requestId);
    writeU32(header, 16, width);
    writeU32(header, 20, height);
    writeU32(header, 24, stride);
    writeU32(header, 28, pixelFormat);
    writeU64(header, 32, payloadLength);

    writeProtocolBytes(header.data(), header.size());
}

void writeError(std::uint32_t requestId, const QString& message)
{
    const auto payload = message.toUtf8();
    std::cerr << "[atlas-helper] request " << requestId << ": "
              << message.toStdString() << std::endl;
    // Carry the native failure reason over the binary protocol as well.
    // stderr is asynchronous relative to stdout in the Electron parent, so
    // relying on log arrival can otherwise turn useful errors into a generic one.
    writeFrameHeader(1, requestId, 0, 0, 0, 0, static_cast<std::uint64_t>(payload.size()));
    if (!payload.isEmpty())
        writeProtocolBytes(payload.constData(), static_cast<std::size_t>(payload.size()));
}

void writeRgbaFrame(
    std::uint32_t requestId,
    const QByteArray& rgba,
    int width,
    int height,
    int stride)
{
    writeFrameHeader(
        0,
        requestId,
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height),
        static_cast<std::uint32_t>(stride),
        kPixelFormatRgba8,
        static_cast<std::uint64_t>(rgba.size()));

    if (!rgba.isEmpty())
        writeProtocolBytes(rgba.constData(), static_cast<std::size_t>(rgba.size()));
}

bool readHillshadeTilePng(
    const QString& databasePath, int z, int x, int y, int s,
    QByteArray& pngData, QString& errorMessage)
{
    if (!QFileInfo::exists(databasePath))
    {
        errorMessage = QStringLiteral("Hillshade database does not exist: %1").arg(databasePath);
        return false;
    }

    static quint64 connectionCounter = 0;
    const auto connectionName = QStringLiteral("atlas_hillshade_%1").arg(++connectionCounter);
    {
        auto database = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connectionName);
        database.setDatabaseName(databasePath);
        database.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (!database.open())
        {
            errorMessage = QStringLiteral("Unable to open Hillshade SQLite database read-only: %1")
                .arg(database.lastError().text());
            database.close();
        }
        else
        {
            QSqlQuery query(database);
            query.prepare(QStringLiteral(
                "SELECT image FROM tiles WHERE z = :z AND x = :x AND y = :y AND s = :s LIMIT 1"));
            query.bindValue(QStringLiteral(":z"), z);
            query.bindValue(QStringLiteral(":x"), x);
            query.bindValue(QStringLiteral(":y"), y);
            query.bindValue(QStringLiteral(":s"), s);
            if (!query.exec())
            {
                errorMessage = QStringLiteral("Hillshade tile query failed: %1").arg(query.lastError().text());
            }
            else if (!query.next())
            {
                errorMessage = QStringLiteral("Hillshade tile not found for z=%1, x=%2, y=%3, s=%4")
                    .arg(z).arg(x).arg(y).arg(s);
            }
            else
            {
                pngData = query.value(0).toByteArray();
                static const QByteArray pngSignature = QByteArray::fromHex("89504e470d0a1a0a");
                if (pngData.size() < 8 || pngData.left(8) != pngSignature)
                {
                    pngData.clear();
                    errorMessage = QStringLiteral("Hillshade tile payload is not a PNG image");
                }
            }
            query.finish();
            database.close();
        }
    }
    QSqlDatabase::removeDatabase(connectionName);
    return !pngData.isEmpty();
}

void writeHillshadeResponse(std::uint32_t requestId, std::uint32_t status, const QByteArray& payload)
{
    std::array<unsigned char, 24> header{};
    header[0] = 'O'; header[1] = 'S'; header[2] = 'M'; header[3] = 'H';
        // OSMH has a compact 24-byte header; encode all integers explicitly.
    header[4] = 1; header[5] = 0;
    header[6] = 24; header[7] = 0;
    for (int i = 0; i < 4; ++i)
    {
        header[8 + i] = static_cast<unsigned char>((status >> (i * 8)) & 0xff);
        header[12 + i] = static_cast<unsigned char>((requestId >> (i * 8)) & 0xff);
    }
    const auto length = static_cast<std::uint64_t>(payload.size());
    for (int i = 0; i < 8; ++i)
        header[16 + i] = static_cast<unsigned char>((length >> (i * 8)) & 0xff);
    writeProtocolBytes(header.data(), header.size());
    if (!payload.isEmpty())
        writeProtocolBytes(payload.constData(), static_cast<std::size_t>(payload.size()));
}

int runHillshadeWorker()
{
    std::string line;
    while (std::getline(std::cin, line))
    {
        const auto document = QJsonDocument::fromJson(QByteArray::fromStdString(line));
        if (!document.isObject())
        {
            writeHillshadeResponse(0, 1, QByteArrayLiteral("Invalid JSON request"));
            continue;
        }
        const auto command = document.object();
        const auto type = command.value(QStringLiteral("type")).toString();
        if (type == QLatin1String("quit"))
            return 0;
        if (type != QLatin1String("hillshade_tile"))
        {
            const auto message = QStringLiteral("Unsupported Hillshade command: %1").arg(type).toUtf8();
            writeHillshadeResponse(0, 1, message);
            continue;
        }

        const auto idValue = command.value(QStringLiteral("requestId"));
        const auto requestId = idValue.isDouble() && idValue.toDouble() >= 0
            && idValue.toDouble() <= std::numeric_limits<std::uint32_t>::max()
            ? static_cast<std::uint32_t>(idValue.toDouble()) : 0u;
        QByteArray pngData;
        QString errorMessage;
        const auto ok = readHillshadeTilePng(
            command.value(QStringLiteral("databasePath")).toString(),
            command.value(QStringLiteral("z")).toInt(-1),
            command.value(QStringLiteral("x")).toInt(-1),
            command.value(QStringLiteral("y")).toInt(-1),
            command.value(QStringLiteral("s")).toInt(0),
            pngData, errorMessage);
        writeHillshadeResponse(requestId, ok ? 0u : 1u, ok ? pngData : errorMessage.toUtf8());
    }
    return 0;
}



int runObfMetadataMode(int argc, char* argv[])
{
    if (argc != 4)
    {
        std::cerr << "[atlas-helper] --obf-metadata requires an OBF path JSON file and resources root" << std::endl;
        return 2;
    }

    const auto configurationPath = decodePathArgument(argv[2]);
    const auto resourcesRoot = decodePathArgument(argv[3]);
    if (configurationPath.isEmpty() || resourcesRoot.isEmpty())
    {
        std::cerr << "[atlas-helper] invalid OBF metadata path argument" << std::endl;
        return 2;
    }

    QApplication app(argc, argv);
    app.setQuitOnLastWindowClosed(false);
    QFile configurationFile(configurationPath);
    if (!configurationFile.open(QIODevice::ReadOnly))
    {
        std::cerr << "[atlas-helper] unable to read OBF metadata configuration: "
                  << configurationFile.errorString().toStdString() << std::endl;
        return 2;
    }

    const auto configurationDocument = QJsonDocument::fromJson(configurationFile.readAll());
    if (!configurationDocument.isArray() || configurationDocument.array().isEmpty())
    {
        std::cerr << "[atlas-helper] OBF metadata configuration must contain a non-empty path array" << std::endl;
        return 2;
    }

    QStringList obfPaths;
    for (const auto& value : configurationDocument.array())
    {
        if (!value.isString() || value.toString().trimmed().isEmpty())
        {
            std::cerr << "[atlas-helper] OBF metadata configuration contains an invalid path" << std::endl;
            return 2;
        }
        obfPaths.append(value.toString());
    }

    const auto provider = std::make_shared<FileSystemCoreResourcesProvider>(resourcesRoot);
    if (!provider->containsResource(QStringLiteral("map/styles/default.render.xml")))
    {
        std::cerr << "[atlas-helper] default.render.xml was not found in the configured OsmAnd resources" << std::endl;
        return 3;
    }

    const auto fontsRoot = QDir(resourcesRoot).filePath(QStringLiteral("rendering_styles/fonts"));
    const auto fontsRootUtf8 = QFile::encodeName(QDir::toNativeSeparators(fontsRoot));
    if (OsmAnd::InitializeCore(provider, fontsRootUtf8.constData()) == 0)
    {
        std::cerr << "[atlas-helper] OsmAnd::InitializeCore failed while reading OBF metadata" << std::endl;
        return 3;
    }

    QJsonArray metadataResults;
    {
        const auto collection = std::make_shared<OsmAnd::ObfsCollection>();
        for (const auto& obfPath : obfPaths)
            collection->addFile(obfPath);

        const auto obfFiles = collection->getObfFiles();
        QHash<QString, std::shared_ptr<const OsmAnd::ObfFile>> filesByPath;
        for (const auto& obfFile : obfFiles)
        {
            if (!obfFile)
                continue;
            const QFileInfo fileInfo(obfFile->filePath);
            const auto canonicalPath = fileInfo.canonicalFilePath().isEmpty()
                ? fileInfo.absoluteFilePath() : fileInfo.canonicalFilePath();
            filesByPath.insert(QDir::cleanPath(canonicalPath).toCaseFolded(), obfFile);
        }

        for (const auto& obfPath : obfPaths)
        {
            const QFileInfo requestedInfo(obfPath);
            const auto canonicalPath = requestedInfo.canonicalFilePath().isEmpty()
                ? requestedInfo.absoluteFilePath() : requestedInfo.canonicalFilePath();
            const auto key = QDir::cleanPath(canonicalPath).toCaseFolded();
            const auto found = filesByPath.constFind(key);
            if (found == filesByPath.cend() || !found.value()->obfInfo)
            {
                metadataResults.append(QJsonObject{
                    {QStringLiteral("filePath"), obfPath},
                    {QStringLiteral("metadataAvailable"), false},
                    {QStringLiteral("error"), QStringLiteral("OsmAnd Core could not read the OBF metadata")}
                });
                continue;
            }

            const auto& obfInfo = found.value()->obfInfo;
            int minimumZoom = std::numeric_limits<int>::max();
            int maximumZoom = std::numeric_limits<int>::min();
            int sectionCount = 0;
            double left = std::numeric_limits<double>::max();
            double top = std::numeric_limits<double>::max();
            double right = std::numeric_limits<double>::lowest();
            double bottom = std::numeric_limits<double>::lowest();

            const auto longitude = [](double x) {
                return x / 2147483648.0 * 360.0 - 180.0;
            };
            const auto latitude = [](double y) {
                constexpr double scale = 2147483648.0;
                constexpr double pi = 3.14159265358979323846;
                const auto mercator = pi * (1.0 - 2.0 * y / scale);
                return std::atan(std::sinh(mercator)) * 180.0 / pi;
            };
            const auto formatBounds = [&](const auto& area) {
                return QStringLiteral("%1, %2 – %3, %4")
                    .arg(longitude(static_cast<double>(area.left())), 0, 'f', 4)
                    .arg(latitude(static_cast<double>(area.bottom())), 0, 'f', 4)
                    .arg(longitude(static_cast<double>(area.right())), 0, 'f', 4)
                    .arg(latitude(static_cast<double>(area.top())), 0, 'f', 4);
            };

            QJsonArray sections;
            for (const auto& section : obfInfo->mapSections)
            {
                if (!section)
                    continue;
                ++sectionCount;
                QJsonArray rootLevels;
                int sectionMinZoom = std::numeric_limits<int>::max();
                int sectionMaxZoom = std::numeric_limits<int>::min();
                for (const auto& level : section->levels)
                {
                    if (!level)
                        continue;

                    const auto& area = level->area31;
                    const auto minZoom = static_cast<int>(level->minZoom);
                    const auto maxZoom = static_cast<int>(level->maxZoom);
                    minimumZoom = std::min(minimumZoom, minZoom);
                    maximumZoom = std::max(maximumZoom, maxZoom);
                    sectionMinZoom = std::min(sectionMinZoom, minZoom);
                    sectionMaxZoom = std::max(sectionMaxZoom, maxZoom);
                    left = std::min(left, static_cast<double>(area.left()));
                    top = std::min(top, static_cast<double>(area.top()));
                    right = std::max(right, static_cast<double>(area.right()));
                    bottom = std::max(bottom, static_cast<double>(area.bottom()));

                    rootLevels.append(QJsonObject{
                        {QStringLiteral("minZoom"), minZoom},
                        {QStringLiteral("maxZoom"), maxZoom},
                        {QStringLiteral("bounds"), formatBounds(area)}
                    });
                }
                if (!rootLevels.isEmpty())
                {
                    sections.append(QJsonObject{
                        {QStringLiteral("name"), section->name},
                        {QStringLiteral("minZoom"), sectionMinZoom},
                        {QStringLiteral("maxZoom"), sectionMaxZoom},
                        {QStringLiteral("levels"), rootLevels}
                    });
                }
            }

            QJsonObject result{
                {QStringLiteral("filePath"), obfPath},
                {QStringLiteral("metadataAvailable"), true},
                {QStringLiteral("sectionCount"), sectionCount},
                {QStringLiteral("isBasemap"), obfInfo->isBasemap || obfInfo->isBasemapWithCoastlines},
                {QStringLiteral("sections"), sections}
            };

            if (minimumZoom != std::numeric_limits<int>::max()
                && maximumZoom != std::numeric_limits<int>::min()
                && left <= right && top <= bottom)
            {
                const auto west = longitude(left);
                const auto east = longitude(right);
                const auto north = latitude(top);
                const auto south = latitude(bottom);
                const auto bounds = QStringLiteral("%1, %2 – %3, %4")
                    .arg(west, 0, 'f', 4)
                    .arg(south, 0, 'f', 4)
                    .arg(east, 0, 'f', 4)
                    .arg(north, 0, 'f', 4);
                result.insert(QStringLiteral("minZoom"), minimumZoom);
                result.insert(QStringLiteral("maxZoom"), maximumZoom);
                result.insert(QStringLiteral("bounds"), bounds);
            }
            else
            {
                result.insert(QStringLiteral("minZoom"), 0);
                result.insert(QStringLiteral("maxZoom"), 0);
                result.insert(QStringLiteral("bounds"), QJsonValue::Null);
            }
            metadataResults.append(result);
        }
    }

    OsmAnd::ReleaseCore();
    std::cout << "OBF_METADATA "
              << QJsonDocument(metadataResults).toJson(QJsonDocument::Compact).constData()
              << std::endl;
    return 0;
}

}

int main(int argc, char* argv[])
{
    if (argc >= 2 && std::string(argv[1]) == "--obf-metadata")
        return runObfMetadataMode(argc, argv);

    if (!initializeOutputChannels())
    {
        std::cerr << "[atlas-helper] failed to separate protocol output from log output" << std::endl;
        return 4;
    }

    if (argc == 2 && std::string(argv[1]) == "--hillshade-worker")
    {
        QCoreApplication app(argc, argv);
        return runHillshadeWorker();
    }

    const bool labelsOnly = argc == 6 && std::string(argv[5]) == "--labels-only";
    if (argc != 5 && !labelsOnly)
    {
        std::cerr
            << "Usage: osmand_atlas_render_helper.exe <obf-paths-json-file> <resources-root> <style-file> <display-scale>\n"
            << "stdin: one JSON render command per line\n"
            << "stdout: OSMA v1 header (40 bytes, little-endian) followed by RGBA8 bytes\n";
        return 2;
    }

    // The OBF list can contain hundreds of paths and exceed Windows' process
    // command-line length limit. The first argument is now a short JSON file path.
    // Retain inline JSON support for compatibility with existing helper callers.
    QByteArray obfPathsJson;
    const auto configurationArgument = decodePathArgument(argv[1]);
    if (configurationArgument.isEmpty())
    {
        std::cerr << "[atlas-helper] invalid OBF configuration argument" << std::endl;
        return 2;
    }
    QFile obfPathsFile(configurationArgument);
    if (obfPathsFile.exists())
    {
        if (!obfPathsFile.open(QIODevice::ReadOnly))
        {
            std::cerr << "[atlas-helper] could not read OBF path configuration: "
                      << obfPathsFile.errorString().toStdString() << std::endl;
            return 2;
        }
        obfPathsJson = obfPathsFile.readAll();
    }
    else
    {
        obfPathsJson = QString::fromLocal8Bit(argv[1]).toUtf8();
    }

    const auto obfPathsDocument = QJsonDocument::fromJson(obfPathsJson);
    if (!obfPathsDocument.isArray() || obfPathsDocument.array().isEmpty())
    {
        std::cerr << "[atlas-helper] first argument must be a readable JSON file containing a non-empty array of OBF paths"
                  << std::endl;
        return 2;
    }
    QStringList obfPaths;
    for (const auto& value : obfPathsDocument.array())
    {
        if (!value.isString() || value.toString().isEmpty())
        {
            std::cerr << "[atlas-helper] OBF path list contains an invalid entry" << std::endl;
            return 2;
        }
        obfPaths.append(value.toString());
    }

    bool displayScaleOk = false;
    const auto displayScale = QString::fromLocal8Bit(argv[4]).toDouble(&displayScaleOk);
    if (!displayScaleOk || !std::isfinite(displayScale) || displayScale < 1.0 || displayScale > 4.0)
    {
        std::cerr << "[atlas-helper] display-scale must be a finite number between 1.0 and 4.0" << std::endl;
        return 2;
    }

    qputenv("QT_ENABLE_HIGHDPI_SCALING", "0");

    QApplication app(argc, argv);
    app.setQuitOnLastWindowClosed(false);
#ifdef _WIN32
    SetUnhandledExceptionFilter(atlasUnhandledExceptionFilter);
    std::cerr << "[atlas-helper] process_started pid=" << GetCurrentProcessId()
              << " obf_count=" << obfPaths.size()
              << " display_scale=" << displayScale
              << " labels_only=" << (labelsOnly ? 1 : 0) << std::endl;
#else
    std::cerr << "[atlas-helper] process_started obf_count=" << obfPaths.size()
              << " display_scale=" << displayScale << std::endl;
#endif

    const OsmAndNativeMapWidget::Configuration configuration{
        obfPaths,
        decodePathArgument(argv[2]),
        decodePathArgument(argv[3]),
        false,
        displayScale,
        true,
        labelsOnly
    };

    QElapsedTimer widgetCreationTimer;
    widgetCreationTimer.start();
    QString errorMessage;
    auto* widget = OsmAndNativeMapWidget::create(configuration, nullptr, errorMessage);
    if (!widget)
    {
        std::cerr << "[atlas-helper] initialization failed: "
                  << errorMessage.toStdString() << std::endl;
        return 3;
    }

    widget->setAttribute(Qt::WA_DontShowOnScreen, true);
    widget->setMinimumSize(1, 1);
    widget->resize(1280, 960);
    widget->setWindowTitle(labelsOnly
        ? QStringLiteral("OsmAnd Labels Render Helper")
        : QStringLiteral("OsmAnd Atlas Render Helper"));
    widget->move(100, 100);
    widget->setZoomLevel(13.0);
    widget->setCenterLonLat(16.3738, 48.2082);
    widget->show();

    QTimer captureTimer;
    captureTimer.setInterval(kFramePollIntervalMs);

    bool requestActive = false;
    std::uint32_t activeRequestId = 0;
    QElapsedTimer requestTimer;
    bool initializationReported = false;
    int activeOutputWidth = 0;
    int activeOutputHeight = 0;
    int activeOverscanX = 0;
    int activeOverscanY = 0;

    QObject::connect(&captureTimer, &QTimer::timeout, &app,
        [&]() {
            if (!requestActive)
            {
                captureTimer.stop();
                return;
            }

            bool rendererIdle = false;
            bool frameInvalidated = true;
            QString captureError;
#ifdef _WIN32
            InterlockedExchange(&g_diagnosticStage, 5);
#endif
            const auto stateChecked = widget->isFrameReady(
                rendererIdle, frameInvalidated, captureError);

            if (stateChecked && !initializationReported)
            {
#ifdef _WIN32
                const auto helperPid = GetCurrentProcessId();
#else
                const auto helperPid = QCoreApplication::applicationPid();
#endif
                std::cerr << "[Atlas] pid=" << helperPid
                          << " init=ok obf=" << obfPaths.size()
                          << " widget_ms=" << widgetCreationTimer.elapsed()
                          << " gl_ms=" << widget->openGlInitializationMs()
                          << " first_frame_ms=" << widget->firstFrameMs()
                          << std::endl;
                initializationReported = true;
            }

            if (stateChecked && rendererIdle && !frameInvalidated)
            {
                QByteArray rgba;
                int width = 0;
                int height = 0;
                int stride = 0;

#ifdef _WIN32
                InterlockedExchange(&g_diagnosticStage, 6);
#endif
                const auto captured = widget->grabFrameRgba(
                    rgba, width, height, stride,
                    rendererIdle, frameInvalidated, captureError);
#ifdef _WIN32
                InterlockedExchange(&g_diagnosticStage, 7);
#endif

                if (captured && rendererIdle && !frameInvalidated)
                {
                    captureTimer.stop();
                    requestActive = false;

                    const auto expectedRenderWidth = activeOutputWidth + activeOverscanX * 2;
                    const auto expectedRenderHeight = activeOutputHeight + activeOverscanY * 2;
                    if (width != expectedRenderWidth || height != expectedRenderHeight
                        || stride < width * 4)
                    {
                        writeError(
                            activeRequestId,
                            QStringLiteral("Overscan framebuffer dimensions do not match: got %1x%2 stride=%3, expected %4x%5")
                                .arg(width).arg(height).arg(stride)
                                .arg(expectedRenderWidth).arg(expectedRenderHeight));
                        return;
                    }

                    QByteArray cropped;
                    const auto croppedStride = activeOutputWidth * 4;
                    cropped.resize(croppedStride * activeOutputHeight);
                    for (int row = 0; row < activeOutputHeight; ++row)
                    {
                        const auto* source = rgba.constData()
                            + static_cast<qsizetype>(row + activeOverscanY) * stride
                            + static_cast<qsizetype>(activeOverscanX) * 4;
                        auto* destination = cropped.data()
                            + static_cast<qsizetype>(row) * croppedStride;
                        std::memcpy(destination, source, static_cast<std::size_t>(croppedStride));
                    }

#ifdef _WIN32
                    const auto helperPid = GetCurrentProcessId();
#else
                    const auto helperPid = QCoreApplication::applicationPid();
#endif
                    std::cerr << "[Atlas] pid=" << helperPid
                              << " req=" << activeRequestId
                              << " result=ok elapsed=" << requestTimer.elapsed() << "ms"
                              << " frame=" << activeOutputWidth << "x" << activeOutputHeight
                              << std::endl;
                    writeRgbaFrame(
                        activeRequestId,
                        cropped,
                        activeOutputWidth,
                        activeOutputHeight,
                        croppedStride);
#ifdef _WIN32
                    InterlockedExchange(&g_diagnosticStage, 0);
                    InterlockedExchange(&g_diagnosticRequestId, 0);
                    std::snprintf(g_diagnosticRequestContext, sizeof(g_diagnosticRequestContext),
                        "no render request active");
#endif
                    return;
                }
            }

            if (requestTimer.elapsed() >= kFrameTimeoutMs)
            {
                captureTimer.stop();
                requestActive = false;
#ifdef _WIN32
                const auto helperPid = GetCurrentProcessId();
#else
                const auto helperPid = QCoreApplication::applicationPid();
#endif
                std::cerr << "[Atlas] pid=" << helperPid
                          << " req=" << activeRequestId
                          << " result=timeout elapsed=" << requestTimer.elapsed() << "ms"
                          << " idle=" << (rendererIdle ? 1 : 0)
                          << " invalidated=" << (frameInvalidated ? 1 : 0)
                          << " frame=" << widget->width() << "x" << widget->height()
                          << std::endl;
                writeError(
                    activeRequestId,
                    captureError.isEmpty()
                    ? QStringLiteral("Atlas did not settle within %1 ms (rendererIdle=%2, frameInvalidated=%3, widget=%4x%5)")
                        .arg(kFrameTimeoutMs).arg(rendererIdle ? 1 : 0).arg(frameInvalidated ? 1 : 0)
                        .arg(widget->width()).arg(widget->height())
                    : QStringLiteral("Frame readiness/capture failed: %1").arg(captureError));
            }
        });

    std::thread inputThread([&app, widget, displayScale, obfPaths, &captureTimer, &requestActive, &activeRequestId, &requestTimer, &activeOutputWidth, &activeOutputHeight, &activeOverscanX, &activeOverscanY]() {
        std::string line;
        while (std::getline(std::cin, line))
        {
            const auto commandLine = QString::fromUtf8(line.data(), static_cast<qsizetype>(line.size()));
            const auto parsedLine = QJsonDocument::fromJson(commandLine.toUtf8());
            const bool quitRequested = parsedLine.isObject()
                && parsedLine.object().value(QStringLiteral("type")).toString() == QStringLiteral("quit");
            QMetaObject::invokeMethod(&app, [&, commandLine, obfPaths]() {
                QJsonParseError parseError;
                const auto document = QJsonDocument::fromJson(commandLine.toUtf8(), &parseError);
                if (parseError.error != QJsonParseError::NoError || !document.isObject())
                {
                    writeError(0, QStringLiteral("Invalid JSON command: %1").arg(parseError.errorString()));
                    return;
                }

                const auto command = document.object();
                const auto type = command.value(QStringLiteral("type")).toString();
                if (type == QStringLiteral("quit"))
                {
                    app.quit();
                    return;
                }
                if (type != QStringLiteral("render"))
                {
                    writeError(0, QStringLiteral("Unsupported command type: %1").arg(type));
                    return;
                }

                const auto requestValue = command.value(QStringLiteral("requestId"));
                const auto widthValue = command.value(QStringLiteral("width"));
                const auto heightValue = command.value(QStringLiteral("height"));
                const auto longitudeValue = command.value(QStringLiteral("longitude"));
                const auto latitudeValue = command.value(QStringLiteral("latitude"));
                const auto zoomValue = command.value(QStringLiteral("zoom"));

                if (!requestValue.isDouble() || !widthValue.isDouble() || !heightValue.isDouble()
                    || !longitudeValue.isDouble() || !latitudeValue.isDouble() || !zoomValue.isDouble())
                {
                    writeError(0, QStringLiteral("render requires numeric requestId, width, height, longitude, latitude and zoom"));
                    return;
                }

                const auto requestNumber = requestValue.toDouble();
                const auto requestedWidth = widthValue.toInt(-1);
                const auto requestedHeight = heightValue.toInt(-1);
                const auto longitude = longitudeValue.toDouble();
                const auto latitude = latitudeValue.toDouble();
                const auto zoom = zoomValue.toDouble();

                // Text and symbol dimensions grow with presentation density.
                // Scale the overscan by the same factor so labels retain a
                // comparable logical safety margin at every display density.
                const auto requestedOverscan = static_cast<int>(
                    std::ceil(kLabelOverscanPixels * displayScale));

                if (requestNumber < 0.0 || requestNumber > std::numeric_limits<std::uint32_t>::max()
                    || requestedWidth < 1 || requestedWidth > kMaximumDimension - 2 * requestedOverscan
                    || requestedHeight < 1 || requestedHeight > kMaximumDimension - 2 * requestedOverscan
                    || longitude < -180.0 || longitude > 180.0
                    || latitude < -90.0 || latitude > 90.0
                    || zoom < 2.0 || zoom > 22.0)
                {
                    writeError(
                        requestNumber >= 0.0 && requestNumber <= std::numeric_limits<std::uint32_t>::max()
                            ? static_cast<std::uint32_t>(requestNumber) : 0,
                        QStringLiteral("render parameters are outside supported ranges"));
                    return;
                }

                const auto requestId = static_cast<std::uint32_t>(requestNumber);
                if (requestActive)
                {
                    writeError(requestId, QStringLiteral("A render request is already active; send one command at a time"));
                    return;
                }

                // Keep the requested XYZ tile's geographic extent unchanged.
                // The widget is larger only to provide label-placement context;
                // the centred requested-size rectangle is cropped after render.
                // Therefore zoom compensation is based on output dimensions,
                // not the overscan framebuffer dimensions.
                const auto pixelScaleX = static_cast<double>(requestedWidth) / 256.0;
                const auto pixelScaleY = static_cast<double>(requestedHeight) / 256.0;
                // The native widget keeps its GL viewport at the framebuffer
                // dimensions. Display density is applied to presentation
                // (symbol/text) sizing, not to the geographic viewport.
                const auto effectivePixelScaleX = pixelScaleX;
                const auto effectivePixelScaleY = pixelScaleY;
                const auto zoomCompensationX = std::log2(effectivePixelScaleX);
                const auto zoomCompensationY = std::log2(effectivePixelScaleY);
                const auto zoomCompensation = zoomCompensationX;
                const auto compensatedZoom = zoom + zoomCompensation;

                // OsmAnd wraps map content vertically when the overscan viewport
                // extends beyond the Mercator world. At low zoom this can put
                // repeated copies of Africa into otherwise unrelated XYZ tiles.
                // Keep the symmetric vertical overscan entirely inside [0, 1]
                // while retaining the full horizontal label margin.
                constexpr double mercatorLatitudeLimit = 85.05112878;
                const auto clampedLatitude = std::clamp(
                    latitude, -mercatorLatitudeLimit, mercatorLatitudeLimit);
                const auto sinLatitude = std::sin(clampedLatitude * 3.14159265358979323846 / 180.0);
                const auto centerY = 0.5
                    - std::log((1.0 + sinLatitude) / (1.0 - sinLatitude))
                        / (4.0 * 3.14159265358979323846);
                const auto worldPixelSize = 256.0 * std::pow(2.0, compensatedZoom);
                const auto halfOutputHeight = static_cast<double>(requestedHeight) / 2.0;
                const auto safeTopOverscan = std::max(0.0, centerY * worldPixelSize - halfOutputHeight);
                const auto safeBottomOverscan = std::max(
                    0.0, (1.0 - centerY) * worldPixelSize - halfOutputHeight);
                const auto safeVerticalOverscan = static_cast<int>(std::floor(
                    std::min(safeTopOverscan, safeBottomOverscan)));

                requestActive = true;
                activeRequestId = requestId;
                requestTimer.restart();
#ifdef _WIN32
                InterlockedExchange(&g_diagnosticRequestId, static_cast<LONG>(requestId));
                InterlockedExchange(&g_diagnosticStage, 1);
                std::snprintf(g_diagnosticRequestContext, sizeof(g_diagnosticRequestContext),
                    "request=%u lon=%.9f lat=%.9f zoom=%.6f size=%dx%d obf_count=%d",
                    requestId, longitude, latitude, zoom, requestedWidth, requestedHeight,
                    static_cast<int>(obfPaths.size()));
#endif

                activeOutputWidth = requestedWidth;
                activeOutputHeight = requestedHeight;
                activeOverscanX = requestedOverscan;
                activeOverscanY = std::min(requestedOverscan, safeVerticalOverscan);
                const auto renderWidth = requestedWidth + activeOverscanX * 2;
                const auto renderHeight = requestedHeight + activeOverscanY * 2;
#ifdef _WIN32
                InterlockedExchange(&g_diagnosticStage, 2);
#endif
                widget->resize(renderWidth, renderHeight);
#ifdef _WIN32
                InterlockedExchange(&g_diagnosticStage, 3);
#endif

                if (std::getenv("OSMAND_ATLAS_DEBUG_GEOMETRY") != nullptr)
                {
                    std::cerr
                        << "[OsmAnd Atlas][geometry] request=" << requestId
                        << " requested=" << requestedWidth << "x" << requestedHeight
                        << " render=" << renderWidth << "x" << renderHeight
                        << " overscan=" << activeOverscanX << "x" << activeOverscanY
                        << " requestedOverscan=" << requestedOverscan
                        << " safeVerticalOverscan=" << safeVerticalOverscan
                        << " centerNormalizedY=" << centerY
                        << " worldPixelSize=" << worldPixelSize
                        << " displayScale=" << displayScale
                        << " overscanScale=" << (static_cast<double>(activeOverscanX) / kLabelOverscanPixels)
                        << " pixelScaleXY=" << pixelScaleX << "x" << pixelScaleY
                        << " effectiveScaleXY=" << effectivePixelScaleX << "x" << effectivePixelScaleY
                        << " zoom=" << zoom
                        << " compensationXY=" << zoomCompensationX << "x" << zoomCompensationY
                        << " compensatedZoom=" << compensatedZoom
                        << " centerLonLat=" << longitude << "," << latitude
                        << std::endl;
                }

#ifdef _WIN32
                InterlockedExchange(&g_diagnosticStage, 4);
#endif
                widget->setZoomLevel(compensatedZoom);
                widget->setCenterLonLat(longitude, latitude);
                widget->update();
                captureTimer.start();
            }, Qt::QueuedConnection);
            if (quitRequested)
                break;
        }

        QMetaObject::invokeMethod(&app, [&app]() { app.quit(); }, Qt::QueuedConnection);
    });

    const auto exitCode = app.exec();
    if (inputThread.joinable())
        inputThread.join();

    delete widget;
#ifdef _WIN32
    if (g_protocolOutputHandle != INVALID_HANDLE_VALUE)
    {
        CloseHandle(g_protocolOutputHandle);
        g_protocolOutputHandle = INVALID_HANDLE_VALUE;
    }
#endif
    return exitCode;
}
