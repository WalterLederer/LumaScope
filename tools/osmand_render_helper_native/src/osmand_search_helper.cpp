#include "osmand_search_service.h"

#include <iostream>

#include <QByteArray>
#include <QCoreApplication>
#include <QString>
#include <QStringList>

#include <OsmAndCore/Logging.h>
#include <QJsonArray>
#include <QJsonDocument>

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
    std::cerr << "Usage: osmand_search_helper --search <obf-paths-json> <resources-root> <query> [locale] [limit]" << std::endl;
}
}

int main(int argc, char* argv[])
{
    QCoreApplication application(argc, argv);
    OsmAnd::Logger::get()->setSeverityLevelThreshold(static_cast<OsmAnd::LogSeverityLevel>(999));
    if (argc < 5 || QString::fromLatin1(argv[1]) != QStringLiteral("--search"))
    {
        printUsage();
        return 2;
    }
    const auto pathsJson = QJsonDocument::fromJson(decodeArgument(argv[2]).toUtf8());
    if (!pathsJson.isArray() || pathsJson.array().isEmpty())
    {
        std::cerr << "Search requires a non-empty JSON array of active OBF paths." << std::endl;
        return 2;
    }
    QStringList obfPaths;
    for (const auto& value : pathsJson.array())
    {
        if (!value.isString() || value.toString().trimmed().isEmpty())
        {
            std::cerr << "The active OBF path list contains an invalid entry." << std::endl;
            return 2;
        }
        obfPaths.append(value.toString());
    }
    const auto resourcesRoot = decodeArgument(argv[3]);
    const auto query = decodeArgument(argv[4]);
    const auto locale = argc > 5 ? decodeArgument(argv[5]) : QString();
    bool limitOk = true;
    const auto limit = argc > 6 ? QString::fromLatin1(argv[6]).toInt(&limitOk) : 0;
    if (!limitOk || limit < 0 || limit > 1000000)
    {
        std::cerr << "Search result limit must be zero (unlimited) or between 1 and 1000000." << std::endl;
        return 2;
    }

    OsmAndSearchService service({obfPaths, resourcesRoot});
    QString errorMessage;
    if (!service.initialize(errorMessage))
    {
        std::cerr << errorMessage.toUtf8().constData() << std::endl;
        return 1;
    }
    const auto result = service.search(query, limit, locale, false, errorMessage);
    if (!errorMessage.isEmpty())
    {
        std::cerr << errorMessage.toUtf8().constData() << std::endl;
        return 1;
    }
    std::cout << result.toUtf8().constData() << std::endl;
    return 0;
}
