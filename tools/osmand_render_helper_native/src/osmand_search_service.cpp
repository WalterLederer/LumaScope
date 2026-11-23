#include "osmand_search_service.h"

#include "osmand_core_runtime.h"

#include <algorithm>
#include <cstdio>
#include <limits>
#include <utility>
#include <vector>

#include <QFileInfo>
#include <QPoint>
#include <QPolygon>
#include <QSet>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocale>
#include <QStringList>

#include <OsmAndCore/CollatorStringMatcher.h>
#include <OsmAndCore/CommonTypes.h>
#include <OsmAndCore/ObfDataInterface.h>
#include <OsmAndCore/Data/ObfMapSectionInfo.h>
#include <OsmAndCore/Data/ObfMapSectionReader.h>
#include <OsmAndCore/Data/BinaryMapObject.h>
#include <OsmAndCore/Data/ObfReader.h>
#include <OsmAndCore/Data/ObfInfo.h>
#include <OsmAndCore/ObfsCollection.h>
#include <OsmAndCore/RoadLocator.h>
#include <OsmAndCore/Search/ReverseGeocoder.h>
#include <OsmAndCore/SimpleQueryController.h>
#include <OsmAndCore/Utilities.h>
#include <OsmAndCore/Data/Address.h>
#include <OsmAndCore/Data/Amenity.h>

namespace
{

OsmAnd::ObfAddressStreetGroupTypesMask placeAddressStreetGroupTypesMask()
{
    return OsmAnd::ObfAddressStreetGroupTypesMask()
        .set(OsmAnd::ObfAddressStreetGroupType::Boundary)
        .set(OsmAnd::ObfAddressStreetGroupType::CityOrTown)
        .set(OsmAnd::ObfAddressStreetGroupType::Village);
}

struct SearchCandidate
{
    QString displayName;
    QString secondaryText;
    double longitude = 0.0;
    double latitude = 0.0;
    QString sourceKind;
    QString matchKind;
    int matchRank = 99;
    int typeRank = 99;
    QString dedupeKey;
};

struct AdministrativeAreaCandidate
{
    int adminLevel = 99;
    QString name;
    qint64 bboxArea = 0;
};

bool polygonContainsPoint(
    const QVector<OsmAnd::PointI>& points,
    const QPoint& point)
{
    if (points.size() < 4)
        return false;

    QPolygon polygon;
    polygon.reserve(points.size());
    for (const auto& coordinate : points)
        polygon.push_back(QPoint(coordinate.x, coordinate.y));
    return polygon.containsPoint(point, Qt::OddEvenFill);
}

bool mapObjectContainsPoint(
    const OsmAnd::BinaryMapObject& mapObject,
    const QPoint& point)
{
    if (!mapObject.isArea || !polygonContainsPoint(mapObject.points31, point))
        return false;

    for (const auto& innerPolygon : mapObject.innerPolygonsPoints31)
    {
        if (polygonContainsPoint(innerPolygon, point))
            return false;
    }
    return true;
}

QJsonObject administrativeAreasForCoordinate(
    const std::shared_ptr<OsmAnd::ObfDataInterface>& dataInterface,
    double latitude,
    double longitude,
    const QString& locale)
{
    QJsonObject result;
    QJsonArray areas;
    QString postcode;
    if (!dataInterface)
    {
        result.insert(QStringLiteral("administrative_areas"), areas);
        return result;
    }

    const auto point31 = OsmAnd::Utilities::convertLatLonTo31(OsmAnd::LatLon(latitude, longitude));
    const QPoint point(point31.x, point31.y);
    OsmAnd::AreaI queryArea;
    queryArea.left() = point31.x - 2;
    queryArea.right() = point31.x + 2;
    queryArea.top() = point31.y - 2;
    queryArea.bottom() = point31.y + 2;

    QList<AdministrativeAreaCandidate> candidates;
    QSet<QString> seenAreas;
    for (const auto& reader : dataInterface->obfReaders)
    {
        if (!reader)
            continue;
        const auto info = reader->obtainInfo();
        if (!info)
            continue;

        for (const auto& mapSection : info->mapSections)
        {
            if (!mapSection || mapSection->levels.isEmpty())
                continue;

            QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> mapObjects;
            OsmAnd::ObfMapSectionReader::loadMapObjects(
                reader,
                mapSection,
                nullptr,
                mapSection->levels.first()->minZoom,
                &queryArea,
                &mapObjects);

            for (const auto& mapObject : mapObjects)
            {
                if (!mapObject || !mapObjectContainsPoint(*mapObject, point))
                    continue;

                const auto attributes = mapObject->getResolvedAttributes();
                for (const auto& postcodeKey : {
                    QStringLiteral("postal_code"),
                    QStringLiteral("addr:postcode"),
                    QStringLiteral("postcode")
                })
                {
                    const auto value = attributes.value(postcodeKey).trimmed();
                    if (postcode.isEmpty() && !value.isEmpty())
                        postcode = value;
                }

                const auto boundaryType = attributes.value(QStringLiteral("boundary"));
                const auto adminLevelText = attributes.value(QStringLiteral("admin_level"));
                bool adminLevelOk = false;
                const int adminLevel = adminLevelText.toInt(&adminLevelOk);
                const bool isAdministrativeBoundary = boundaryType == QStringLiteral("administrative")
                    && adminLevelOk && adminLevel > 0;
                if (!isAdministrativeBoundary)
                    continue;

                const auto localizedName = mapObject->getName(locale, false).trimmed();
                const auto objectName = localizedName.isEmpty()
                    ? mapObject->getCaptionInNativeLanguage().trimmed()
                    : localizedName;
                if (objectName.isEmpty())
                    continue;

                const auto objectKey = QStringLiteral("%1|%2")
                    .arg(adminLevel)
                    .arg(OsmAnd::CollatorStringMatcher::lowercaseAndAlignChars(objectName).trimmed());
                if (!seenAreas.contains(objectKey))
                {
                    seenAreas.insert(objectKey);
                    const auto width = static_cast<qint64>(mapObject->bbox31.right()) - mapObject->bbox31.left();
                    const auto height = static_cast<qint64>(mapObject->bbox31.bottom()) - mapObject->bbox31.top();
                    candidates.push_back({
                        adminLevel,
                        objectName,
                        std::max<qint64>(0, width) * std::max<qint64>(0, height)
                    });
                }
            }
        }
    }

    std::sort(candidates.begin(), candidates.end(),
        [](const AdministrativeAreaCandidate& left, const AdministrativeAreaCandidate& right)
        {
            if (left.adminLevel != right.adminLevel)
                return left.adminLevel < right.adminLevel;
            if (left.bboxArea != right.bboxArea)
                return left.bboxArea < right.bboxArea;
            return QString::compare(left.name, right.name, Qt::CaseInsensitive) < 0;
        });

    for (const auto& candidate : candidates)
    {
        areas.push_back(QJsonObject{
            {QStringLiteral("admin_level"), candidate.adminLevel},
            {QStringLiteral("name"), candidate.name}
        });
    }
    result.insert(QStringLiteral("administrative_areas"), areas);
    if (!postcode.isEmpty())
        result.insert(QStringLiteral("postcode"), postcode);
    return result;
}

QString normalizeForMatch(const QString& value)
{
    return OsmAnd::CollatorStringMatcher::lowercaseAndAlignChars(value).trimmed();
}

bool containsFromTokenBoundary(const QString& haystack, const QString& needle)
{
    if (haystack.isEmpty() || needle.isEmpty())
        return false;

    auto index = haystack.indexOf(needle);
    while (index >= 0)
    {
        if (index == 0 || !haystack.at(index - 1).isLetterOrNumber())
            return true;
        index = haystack.indexOf(needle, index + 1);
    }
    return false;
}

std::pair<int, QString> computeMatchRank(const QString& query, const QStringList& candidates)
{
    const auto normalizedQuery = normalizeForMatch(query);
    if (normalizedQuery.isEmpty())
        return {99, QStringLiteral("none")};

    int bestRank = 99;
    QString bestKind = QStringLiteral("other");
    for (const auto& candidate : candidates)
    {
        const auto normalizedCandidate = normalizeForMatch(candidate);
        if (normalizedCandidate.isEmpty())
            continue;

        if (normalizedCandidate.startsWith(normalizedQuery))
        {
            bestRank = std::min(bestRank, 0);
            bestKind = QStringLiteral("prefix");
            continue;
        }
        if (containsFromTokenBoundary(normalizedCandidate, normalizedQuery))
        {
            if (bestRank > 1)
            {
                bestRank = 1;
                bestKind = QStringLiteral("token");
            }
            continue;
        }
        if (normalizedCandidate.contains(normalizedQuery))
        {
            if (bestRank > 2)
            {
                bestRank = 2;
                bestKind = QStringLiteral("contains");
            }
            continue;
        }
    }

    return {bestRank, bestKind};
}

QStringList uniqueNames(const QStringList& rawNames)
{
    QStringList unique;
    for (const auto& name : rawNames)
    {
        const auto trimmed = name.trimmed();
        if (trimmed.isEmpty() || unique.contains(trimmed))
            continue;
        unique.push_back(trimmed);
    }
    return unique;
}

QString bestDisplayName(const QString& query, const QStringList& candidates, const QString& fallback)
{
    const auto unique = uniqueNames(candidates);
    if (unique.isEmpty())
        return fallback.trimmed();

    QString bestName = unique.constFirst();
    auto bestRank = computeMatchRank(query, {bestName});
    for (int index = 1; index < unique.size(); ++index)
    {
        const auto current = unique.at(index);
        const auto currentRank = computeMatchRank(query, {current});
        if (currentRank.first < bestRank.first
            || (currentRank.first == bestRank.first
                && QString::compare(current, bestName, Qt::CaseInsensitive) < 0))
        {
            bestName = current;
            bestRank = currentRank;
        }
    }
    return bestName;
}

QString secondaryTextFor(
    const QString& displayName,
    const QStringList& candidates,
    const QString& descriptor)
{
    for (const auto& candidate : uniqueNames(candidates))
    {
        if (candidate != displayName)
        {
            if (descriptor.isEmpty())
                return candidate;
            return QStringLiteral("%1 • %2").arg(candidate, descriptor);
        }
    }
    return descriptor;
}

int addressTypeRank(const std::shared_ptr<const OsmAnd::Address>& address)
{
    if (!address)
        return 99;

    switch (address->addressType)
    {
        case OsmAnd::AddressType::StreetGroup:
            return 0;
        case OsmAnd::AddressType::Street:
            return 1;
        case OsmAnd::AddressType::Building:
            return 2;
        case OsmAnd::AddressType::StreetIntersection:
            return 3;
    }
    return 99;
}

SearchCandidate makeAddressCandidate(
    const std::shared_ptr<const OsmAnd::Address>& address,
    const QString& query,
    const QString& locale)
{
    SearchCandidate candidate;
    if (!address)
        return candidate;

    const auto transliteratedName = address->getName(locale, true);
    const auto preferredName = address->getName(locale, false);
    const auto englishName = address->localizedNames.value(QStringLiteral("en"));
    const auto descriptor = address->toString();
    const auto names = uniqueNames({
        preferredName,
        englishName,
        address->nativeName,
        transliteratedName,
    });

    candidate.displayName = bestDisplayName(query, names, preferredName);
    candidate.secondaryText = secondaryTextFor(candidate.displayName, names, descriptor);

    const auto latLon = OsmAnd::Utilities::convert31ToLatLon(address->position31);
    candidate.latitude = latLon.latitude;
    candidate.longitude = latLon.longitude;
    candidate.sourceKind = QStringLiteral("address");
    candidate.typeRank = addressTypeRank(address);
    const auto rank = computeMatchRank(query, names);
    candidate.matchRank = rank.first;
    candidate.matchKind = rank.second;
    candidate.dedupeKey = QStringLiteral(
        "address|%1|%2|%3")
            .arg(normalizeForMatch(candidate.displayName))
            .arg(QString::number(candidate.latitude, 'f', 6))
            .arg(QString::number(candidate.longitude, 'f', 6));
    return candidate;
}

SearchCandidate makeAmenityCandidate(
    const std::shared_ptr<const OsmAnd::Amenity>& amenity,
    const QString& query,
    const QString& locale)
{
    SearchCandidate candidate;
    if (!amenity)
        return candidate;

    const auto transliteratedName = amenity->getName(locale, true);
    const auto preferredName = amenity->getName(locale, false);
    const auto englishName = amenity->localizedNames.value(QStringLiteral("en"));
    QString descriptor = amenity->type;
    if (!amenity->subType.isEmpty())
        descriptor = descriptor.isEmpty() ? amenity->subType : QStringLiteral("%1 • %2").arg(descriptor, amenity->subType);

    const auto names = uniqueNames({
        preferredName,
        englishName,
        amenity->nativeName,
        transliteratedName,
    });

    candidate.displayName = bestDisplayName(query, names, preferredName);
    candidate.secondaryText = secondaryTextFor(candidate.displayName, names, descriptor);

    const auto latLon = OsmAnd::Utilities::convert31ToLatLon(amenity->position31);
    candidate.latitude = latLon.latitude;
    candidate.longitude = latLon.longitude;
    candidate.sourceKind = QStringLiteral("poi");
    candidate.typeRank = 10;
    const auto rank = computeMatchRank(query, names);
    candidate.matchRank = rank.first;
    candidate.matchKind = rank.second;
    candidate.dedupeKey = QStringLiteral(
        "poi|%1|%2|%3")
            .arg(normalizeForMatch(candidate.displayName))
            .arg(QString::number(candidate.latitude, 'f', 6))
            .arg(QString::number(candidate.longitude, 'f', 6));
    return candidate;
}

void sortCandidates(std::vector<SearchCandidate>& candidates)
{
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const SearchCandidate& left, const SearchCandidate& right)
        {
            if (left.matchRank != right.matchRank)
                return left.matchRank < right.matchRank;
            if (left.typeRank != right.typeRank)
                return left.typeRank < right.typeRank;
            return QString::compare(left.displayName, right.displayName, Qt::CaseInsensitive) < 0;
        });
}

QJsonObject candidateToJson(const SearchCandidate& candidate)
{
    return QJsonObject{
        {QStringLiteral("display_name"), candidate.displayName},
        {QStringLiteral("secondary_text"), candidate.secondaryText},
        {QStringLiteral("longitude"), candidate.longitude},
        {QStringLiteral("latitude"), candidate.latitude},
        {QStringLiteral("source_kind"), candidate.sourceKind},
        {QStringLiteral("match_kind"), candidate.matchKind},
    };
}

template <typename Candidate>
bool appendCandidateWithAbort(
    std::vector<SearchCandidate>& results,
    Candidate&& candidate,
    const std::shared_ptr<OsmAnd::SimpleQueryController>& queryController,
    int targetCount)
{
    if (candidate.displayName.isEmpty())
        return true;

    // Return every matching record from all selected OBF files. Do not
    // abort the OsmAnd scan after an arbitrary small candidate count.
    results.push_back(std::forward<Candidate>(candidate));
    return true;
}
}

OsmAndSearchService::OsmAndSearchService(Configuration configuration)
    : _configuration(std::move(configuration))
{
}

OsmAndSearchService::~OsmAndSearchService()
{
    _dataInterface.reset();
    _obfsCollection.reset();
    if (_initialized)
        OsmAndCoreRuntime::instance().release();
}

bool OsmAndSearchService::initialize(QString& errorMessage)
{
    if (_configuration.obfPaths.isEmpty())
    {
        errorMessage = QStringLiteral("No active OBF files were supplied to the address search.");
        return false;
    }
    for (const auto& obfPath : _configuration.obfPaths)
    {
        if (obfPath.trimmed().isEmpty() || !QFileInfo::exists(obfPath))
        {
            errorMessage = QStringLiteral("OBF file does not exist: %1").arg(obfPath);
            return false;
        }
    }
    if (!QFileInfo(_configuration.resourcesRoot).isDir())
    {
        errorMessage = QStringLiteral("OsmAnd resources directory does not exist: %1").arg(_configuration.resourcesRoot);
        return false;
    }
    if (!OsmAndCoreRuntime::instance().acquire(_configuration.resourcesRoot, errorMessage))
        return false;

    _obfsCollection = std::make_shared<OsmAnd::ObfsCollection>();
    for (const auto& obfPath : _configuration.obfPaths)
        _obfsCollection->addFile(obfPath);
    _dataInterface = _obfsCollection->obtainDataInterface();
    if (!_dataInterface)
    {
        OsmAndCoreRuntime::instance().release();
        errorMessage = QStringLiteral("Failed to create OBF data interface");
        return false;
    }

    _defaultLocale = QLocale::system().name().section(QLatin1Char('_'), 0, 0).toLower();
    if (_defaultLocale.isEmpty())
        _defaultLocale = QStringLiteral("en");

    _initialized = true;
    return true;
}

void OsmAndSearchService::abort() const
{
    std::lock_guard<std::mutex> lock(_queryMutex);
    if (_activeQueryController)
        _activeQueryController->abort();
}

QString OsmAndSearchService::search(
    const QString& query,
    int limit,
    const QString& locale,
    bool includePoiFallback,
    QString& errorMessage) const
{
    if (!_initialized || !_dataInterface)
    {
        errorMessage = QStringLiteral("search service was not initialized");
        return QString();
    }

    const auto trimmedQuery = query.trimmed();
    if (trimmedQuery.isEmpty())
        return QStringLiteral("[]");

    const auto effectiveLimit = limit <= 0 ? std::numeric_limits<int>::max() : limit;
    const auto effectiveLocale = locale.trimmed().isEmpty() ? _defaultLocale : locale.trimmed().toLower();
    const auto queryController = std::make_shared<OsmAnd::SimpleQueryController>();
    {
        std::lock_guard<std::mutex> lock(_queryMutex);
        _activeQueryController = queryController;
    }

    std::vector<SearchCandidate> candidates;
    const auto addressVisitor =
        [&, effectiveLocale, trimmedQuery](const std::shared_ptr<const OsmAnd::Address>& address) -> bool
        {
            return appendCandidateWithAbort(
                candidates,
                makeAddressCandidate(address, trimmedQuery, effectiveLocale),
                queryController,
                std::numeric_limits<int>::max());
        };

    const auto addressesCompleted = _dataInterface->scanAddressesByName(
            trimmedQuery,
            OsmAnd::StringMatcherMode::CHECK_STARTS_FROM_SPACE,
            nullptr,
            nullptr,
            placeAddressStreetGroupTypesMask(),
            false,
            false,
            addressVisitor,
            queryController);
    const auto addressSearchAborted = queryController->isAborted();
    if (!addressesCompleted && !addressSearchAborted)
    {
        std::lock_guard<std::mutex> lock(_queryMutex);
        _activeQueryController.reset();
        errorMessage = QStringLiteral("Address search failed");
        return QString();
    }

    sortCandidates(candidates);

    std::vector<SearchCandidate> merged;
    merged.reserve(candidates.size());
    QStringList seenKeys;
    for (const auto& candidate : candidates)
    {
        if (seenKeys.contains(candidate.dedupeKey))
            continue;
        seenKeys.push_back(candidate.dedupeKey);
        merged.push_back(candidate);
        if (static_cast<int>(merged.size()) >= effectiveLimit)
            break;
    }

    if (includePoiFallback && static_cast<int>(merged.size()) < effectiveLimit && !addressSearchAborted)
    {
        std::vector<SearchCandidate> poiCandidates;
        const auto amenityVisitor =
            [&, effectiveLocale, trimmedQuery](const std::shared_ptr<const OsmAnd::Amenity>& amenity) -> bool
            {
                return appendCandidateWithAbort(
                    poiCandidates,
                    makeAmenityCandidate(amenity, trimmedQuery, effectiveLocale),
                    queryController,
                    std::numeric_limits<int>::max());
            };

        const auto amenitiesCompleted = _dataInterface->scanAmenitiesByName(
                trimmedQuery,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                amenityVisitor,
                queryController,
                false);
        const auto poiSearchAborted = queryController->isAborted();
        if (!amenitiesCompleted && !poiSearchAborted)
        {
            std::lock_guard<std::mutex> lock(_queryMutex);
            _activeQueryController.reset();
            errorMessage = QStringLiteral("POI search failed");
            return QString();
        }

        sortCandidates(poiCandidates);

        for (const auto& candidate : poiCandidates)
        {
            if (seenKeys.contains(candidate.dedupeKey))
                continue;
            seenKeys.push_back(candidate.dedupeKey);
            merged.push_back(candidate);
            if (static_cast<int>(merged.size()) >= effectiveLimit)
                break;
        }
    }

    QJsonArray payload;
    for (const auto& candidate : merged)
        payload.push_back(candidateToJson(candidate));
    {
        std::lock_guard<std::mutex> lock(_queryMutex);
        _activeQueryController.reset();
    }
    return QString::fromUtf8(QJsonDocument(payload).toJson(QJsonDocument::Compact));
}


QString OsmAndSearchService::reverseGeocode(
    double latitude,
    double longitude,
    const QString& locale,
    QString& errorMessage) const
{
    if (!_initialized || !_obfsCollection)
    {
        errorMessage = QStringLiteral("reverse geocoding service was not initialized");
        return QString();
    }

    if (latitude < -90.0 || latitude > 90.0 || longitude < -180.0 || longitude > 180.0)
    {
        errorMessage = QStringLiteral("Reverse geocoding coordinates are outside the valid latitude/longitude range.");
        return QString();
    }

    const auto effectiveLocale = locale.trimmed().isEmpty() ? _defaultLocale : locale.trimmed().toLower();
    std::fprintf(stderr, "[reverse-geocode] Creating RoadLocator\\n");
    const auto roadLocator = std::make_shared<OsmAnd::RoadLocator>(_obfsCollection);
    std::fprintf(stderr, "[reverse-geocode] RoadLocator created\\n");
    const OsmAnd::ReverseGeocoder reverseGeocoder(_obfsCollection, roadLocator);
    std::fprintf(stderr, "[reverse-geocode] ReverseGeocoder created\\n");
    OsmAnd::ReverseGeocoder::Criteria criteria;
    criteria.latLon = OsmAnd::LatLon(latitude, longitude);
    std::fprintf(stderr, "[reverse-geocode] Calling performSearch at %.7f, %.7f\\n", latitude, longitude);

    const auto result = reverseGeocoder.performSearch(criteria);
    std::fprintf(stderr, "[reverse-geocode] performSearch returned: %s\\n", result ? "result" : "no result");
    QJsonObject payload{
        {QStringLiteral("found"), static_cast<bool>(result)},
        {QStringLiteral("latitude"), latitude},
        {QStringLiteral("longitude"), longitude},
        {QStringLiteral("source"), QStringLiteral("OsmAnd")},
    };

    // Administrative areas are resolved independently from the address
    // reverse-geocoder result, so they remain available without a building.
    const auto administrativeData = administrativeAreasForCoordinate(
        _dataInterface, latitude, longitude, effectiveLocale);
    for (auto it = administrativeData.constBegin(); it != administrativeData.constEnd(); ++it)
        payload.insert(it.key(), it.value());

    if (result)
    {
        const auto buildingName = result->building
            ? result->building->getName(effectiveLocale, false)
            : QString();
        const auto streetName = result->street
            ? result->street->getName(effectiveLocale, false)
            : result->streetName;
        const auto placeName = result->streetGroup
            ? result->streetGroup->getName(effectiveLocale, false)
            : QString();

        payload.insert(QStringLiteral("building"), buildingName);
        payload.insert(QStringLiteral("street"), streetName);
        payload.insert(QStringLiteral("place"), placeName);
        // OsmAnd stores the postcode on the resolved building. Keep it as a
        // separate field so callers can compose a structured address instead
        // of having to parse the localized result string.
        if (result->building && !result->building->postcode.trimmed().isEmpty()
            && payload.value(QStringLiteral("postcode")).toString().isEmpty())
            payload.insert(QStringLiteral("postcode"), result->building->postcode.trimmed());
        payload.insert(QStringLiteral("distance_m"), result->getDistance());
        payload.insert(QStringLiteral("result_text"), result->toString());
        if (!result->buildingInterpolation.isEmpty())
            payload.insert(QStringLiteral("building_interpolation"), result->buildingInterpolation);
    }

    return QString::fromUtf8(QJsonDocument(payload).toJson(QJsonDocument::Compact));
}
