#include "osmand_search_service.h"

#include <iostream>
#include <cstdio>

#include <QByteArray>
#include <QCoreApplication>
#include <QString>
#include <QStringList>

#include <OsmAndCore/Logging.h>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>

namespace
{
QString decodeArgument(const char* argument)
{
    const auto value = QString::fromLatin1(argument ? argument : "");
    if (value.startsWith(QStringLiteral("utf8hex:")))
    {
        const auto hex = value.mid(8).toLatin1();
        if (hex.isEmpty() || (hex.size() % 2) != 0) return {};
        const auto utf8 = QByteArray::fromHex(hex);
        if (utf8.isEmpty() || utf8.size() * 2 != hex.size()) return {};
        const auto decoded = QString::fromUtf8(utf8);
        return decoded.toUtf8() == utf8 ? decoded : QString();
    }
    return QString::fromLocal8Bit(argument ? argument : "");
}

void printUsage()
{
    std::cerr
        << "Usage:\n"
        << "  osmand_search_helper --search <obf-paths-json> <resources-root> <query> [locale] [limit]\n"
        << "  osmand_search_helper --reverse-geocode <obf-paths-json> <resources-root> <latitude> <longitude> [locale]\n"
        << "  osmand_search_helper --reverse-geocode-worker <obf-paths-json> <resources-root> [locale]\n"
        << "  osmand_search_helper --export-admin-boundaries <obf-paths-json> <resources-root> <output.gpx> <latitude> <longitude> <radius-km> [locale]"
        << std::endl;
}

bool parseCoordinates(const char* latitudeArg, const char* longitudeArg, double& latitude, double& longitude)
{
    bool latitudeOk = false;
    bool longitudeOk = false;
    latitude = QString::fromLatin1(latitudeArg ? latitudeArg : "").toDouble(&latitudeOk);
    longitude = QString::fromLatin1(longitudeArg ? longitudeArg : "").toDouble(&longitudeOk);
    return latitudeOk && longitudeOk
        && latitude >= -90.0 && latitude <= 90.0
        && longitude >= -180.0 && longitude <= 180.0;
}
}

int main(int argc, char* argv[])
{
    QCoreApplication application(argc, argv);
    OsmAnd::Logger::get()->setSeverityLevelThreshold(static_cast<OsmAnd::LogSeverityLevel>(999));

    const auto mode = argc > 1 ? QString::fromLatin1(argv[1]) : QString();
    const bool reverseGeocodeMode = mode == QStringLiteral("--reverse-geocode");
    const bool reverseGeocodeWorkerMode = mode == QStringLiteral("--reverse-geocode-worker");
    const bool searchMode = mode == QStringLiteral("--search");
    const bool exportBoundaryMode = mode == QStringLiteral("--export-admin-boundaries");
    if ((!reverseGeocodeMode && !reverseGeocodeWorkerMode && !searchMode && !exportBoundaryMode)
        || argc < (exportBoundaryMode ? 8 : (reverseGeocodeMode ? 6 : (reverseGeocodeWorkerMode ? 4 : 5))))
    {
        printUsage();
        return 2;
    }

    const auto pathsJson = QJsonDocument::fromJson(decodeArgument(argv[2]).toUtf8());
    if (!pathsJson.isArray() || pathsJson.array().isEmpty())
    {
        std::cerr << "The OBF path list must be a non-empty JSON array." << std::endl;
        return 2;
    }

    QStringList obfPaths;
    for (const auto& value : pathsJson.array())
    {
        if (!value.isString() || value.toString().trimmed().isEmpty())
        {
            std::cerr << "The OBF path list contains an invalid entry." << std::endl;
            return 2;
        }
        obfPaths.append(value.toString());
    }

    const auto resourcesRoot = decodeArgument(argv[3]);
    OsmAndSearchService service({obfPaths, resourcesRoot});
    QString errorMessage;
    std::fprintf(stderr, "[osmand-search] Initializing service with %d OBF file(s)\\n", obfPaths.size());
    if (!service.initialize(errorMessage))
    {
        std::cerr << errorMessage.toUtf8().constData() << std::endl;
        return 1;
    }
    std::fprintf(stderr, "[osmand-search] Service initialized\\n");

    if (reverseGeocodeWorkerMode)
    {
        const auto defaultLocale = argc > 4 ? decodeArgument(argv[4]) : QString();
        std::cout << QJsonDocument(QJsonObject{
            {QStringLiteral("worker_ready"), true}
        }).toJson(QJsonDocument::Compact).constData() << std::endl;

        std::string requestLine;
        while (std::getline(std::cin, requestLine))
        {
            const auto request = QJsonDocument::fromJson(QByteArray::fromStdString(requestLine));
            if (!request.isObject())
            {
                std::cout << QJsonDocument(QJsonObject{
                    {QStringLiteral("error"), QStringLiteral("Invalid reverse-geocoding worker request")}
                }).toJson(QJsonDocument::Compact).constData() << std::endl;
                continue;
            }

            const auto object = request.object();
            const auto latitudeValue = object.value(QStringLiteral("latitude"));
            const auto longitudeValue = object.value(QStringLiteral("longitude"));
            const auto latitude = latitudeValue.toDouble();
            const auto longitude = longitudeValue.toDouble();
            const auto locale = object.value(QStringLiteral("locale")).toString(defaultLocale);
            if (!latitudeValue.isDouble() || !longitudeValue.isDouble()
                || latitude < -90.0 || latitude > 90.0
                || longitude < -180.0 || longitude > 180.0)
            {
                std::cout << QJsonDocument(QJsonObject{
                    {QStringLiteral("error"), QStringLiteral("Invalid reverse-geocoding coordinates")}
                }).toJson(QJsonDocument::Compact).constData() << std::endl;
                continue;
            }

            QString requestError;
            const auto response = service.reverseGeocode(latitude, longitude, locale, requestError);
            if (!requestError.isEmpty())
            {
                std::cout << QJsonDocument(QJsonObject{
                    {QStringLiteral("error"), requestError}
                }).toJson(QJsonDocument::Compact).constData() << std::endl;
                continue;
            }
            std::cout << response.toUtf8().constData() << std::endl;
        }
        return 0;
    }

    QString result;
    if (exportBoundaryMode)
    {
        double latitude = 0.0;
        double longitude = 0.0;
        bool radiusOk = false;
        const double radiusKm = QString::fromLatin1(argv[7]).toDouble(&radiusOk);
        if (!parseCoordinates(argv[5], argv[6], latitude, longitude) || !radiusOk || radiusKm <= 0.0 || radiusKm > 100.0)
        {
            std::cerr << "Invalid GPX export coordinates or radius." << std::endl;
            return 2;
        }
        const auto locale = argc > 8 ? decodeArgument(argv[8]) : QString();
        result = service.exportAdministrativeBoundaryCandidatesGpx(decodeArgument(argv[4]), latitude, longitude, radiusKm, locale, errorMessage);
    }
    else if (reverseGeocodeMode)
    {
        double latitude = 0.0;
        double longitude = 0.0;
        if (!parseCoordinates(argv[4], argv[5], latitude, longitude))
        {
            std::cerr << "Latitude or longitude is invalid or outside its valid range." << std::endl;
            return 2;
        }
        const auto locale = argc > 6 ? decodeArgument(argv[6]) : QString();
        std::fprintf(stderr, "[osmand-search] Calling reverseGeocode\\n");
        result = service.reverseGeocode(latitude, longitude, locale, errorMessage);
        std::fprintf(stderr, "[osmand-search] reverseGeocode returned\\n");
    }
    else
    {
        const auto query = decodeArgument(argv[4]);
        const auto locale = argc > 5 ? decodeArgument(argv[5]) : QString();
        bool limitOk = true;
        const auto limit = argc > 6 ? QString::fromLatin1(argv[6]).toInt(&limitOk) : 0;
        if (!limitOk || limit < 0 || limit > 1000000)
        {
            std::cerr << "Search result limit must be zero (unlimited) or between 1 and 1000000." << std::endl;
            return 2;
        }
        result = service.search(query, limit, locale, false, errorMessage);
    }

    if (!errorMessage.isEmpty())
    {
        std::cerr << errorMessage.toUtf8().constData() << std::endl;
        return 1;
    }
    std::cout << result.toUtf8().constData() << std::endl;
    return 0;
}
