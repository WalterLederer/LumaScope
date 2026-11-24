#include "osmand_search_service.h"

#include "osmand_core_runtime.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <utility>
#include <vector>

#include <QFileInfo>
#include <QHash>
#include <QPoint>
#include <QPointF>
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
#include <OsmAndCore/Data/Road.h>
#include <OsmAndCore/Data/ObfMapSectionInfo.h>
#include <OsmAndCore/Data/ObfAddressSectionInfo.h>
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
#include <OsmAndCore/Data/Building.h>
#include <OsmAndCore/Data/Street.h>
#include <OsmAndCore/Data/Amenity.h>
#include <OsmAndCore/Data/StreetGroup.h>

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

QString administrativeObjectKey(const OsmAnd::ObfObjectId& objectId)
{
    if (!objectId.isOsmId())
        return {};

    // Address and map indexes may encode the same OSM object differently
    // (notably when map objects carry the split-ID flag). Compare the
    // normalized OSM ID and relation/way kind, not the packed OBF ID.
    return QStringLiteral("%1:%2")
        .arg(objectId.isIdFromRelation() ? QStringLiteral("relation") : QStringLiteral("way"))
        .arg(objectId.getOsmId());
}

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

double nearestLineDistanceMeters(
    const QVector<OsmAnd::PointI>& points,
    const QPoint& point,
    double latitude,
    int* nearestSegmentIndex)
{
    if (nearestSegmentIndex)
        *nearestSegmentIndex = -1;
    if (points.size() < 2)
        return std::numeric_limits<double>::infinity();

    double nearestDistanceSquared = std::numeric_limits<double>::infinity();
    int nearestIndex = -1;
    for (int index = 1; index < points.size(); ++index)
    {
        const auto& first = points.at(index - 1);
        const auto& second = points.at(index);
        const double dx = static_cast<double>(second.x) - first.x;
        const double dy = static_cast<double>(second.y) - first.y;
        const double lengthSquared = dx * dx + dy * dy;
        const double projection = lengthSquared > 0.0
            ? std::clamp(((point.x() - first.x) * dx + (point.y() - first.y) * dy) / lengthSquared, 0.0, 1.0)
            : 0.0;
        const double closestX = first.x + projection * dx;
        const double closestY = first.y + projection * dy;
        const double offsetX = point.x() - closestX;
        const double offsetY = point.y() - closestY;
        const double distanceSquared = offsetX * offsetX + offsetY * offsetY;
        if (distanceSquared < nearestDistanceSquared)
        {
            nearestDistanceSquared = distanceSquared;
            nearestIndex = index - 1;
        }
    }

    if (nearestSegmentIndex)
        *nearestSegmentIndex = nearestIndex;
    constexpr double earthCircumferenceMeters = 40075016.686;
    const double metersPer31Unit = earthCircumferenceMeters
        * std::max(0.01, std::cos(latitude * M_PI / 180.0)) / 2147483648.0;
    return std::sqrt(nearestDistanceSquared) * metersPer31Unit;
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
    QHash<QString, int> administrativeLevelsByObjectId;
    int loadedMapObjectCount = 0;
    int administrativeBoundaryObjectCount = 0;
    int loadedAddressBoundaryGroupCount = 0;
    int loadedAddressStreetGroupCount = 0;
    int addressBoundaryBlockCount = 0;
    QJsonObject addressBlockTypeCounts;
    QJsonObject addressStreetGroupSubtypeCounts;
    QJsonArray mapBoundaryStreetGroupMatches;
    int matchingAddressBoundaryGroupCount = 0;
    int matchedAddressBoundaryObjectIdCount = 0;
    QJsonArray mapBoundaryObjectIds;
    QSet<QString> targetBoundaryRelationKeys;
    // Fall back to the bounding boxes of map boundary objects that contain the
    // requested coordinate. The address index may not expose Boundary groups
    // for every OBF, but these map objects still provide a usable scan extent.
    OsmAnd::AreaI boundarySearchArea;
    bool hasBoundarySearchArea = false;
    QJsonArray addressBoundaryObjectIds;
    QJsonArray addressBoundaryCandidateDetails;
    QJsonArray matchedBoundaryObjectIds;
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

            // Administrative boundaries may be encoded only in a more detailed
            // or generalized map level. Inspect every level instead of relying
            // on the first level, while de-duplicating matching areas below.
            for (const auto& mapLevel : mapSection->levels)
            {
                if (!mapLevel)
                    continue;

                QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> mapObjects;
                OsmAnd::ObfMapSectionReader::loadMapObjects(
                    reader,
                    mapSection,
                    nullptr,
                    mapLevel->minZoom,
                    &queryArea,
                    &mapObjects);

                loadedMapObjectCount += mapObjects.size();
                for (const auto& mapObject : mapObjects)
                {
                    if (!mapObject)
                        continue;

                    const auto attributes = mapObject->getResolvedAttributes();
                    const auto boundaryType = attributes.value(QStringLiteral("boundary"));
                    const auto adminLevelText = attributes.value(QStringLiteral("admin_level"));
                    bool adminLevelOk = false;
                    const int adminLevel = adminLevelText.toInt(&adminLevelOk);
                    const bool isAdministrativeBoundary = boundaryType == QStringLiteral("administrative")
                        && adminLevelOk && adminLevel > 0;
                    if (isAdministrativeBoundary)
                    {
                        ++administrativeBoundaryObjectCount;
                        if (mapObject->id.isOsmId())
                        {
                            const auto objectKey = administrativeObjectKey(mapObject->id);
                            if (!objectKey.isEmpty())
                            {
                                administrativeLevelsByObjectId.insert(objectKey, adminLevel);
                                const bool bboxContainsPoint = mapObject->bbox31.left() <= point31.x
                                    && mapObject->bbox31.right() >= point31.x
                                    && mapObject->bbox31.top() <= point31.y
                                    && mapObject->bbox31.bottom() >= point31.y;
                                if (bboxContainsPoint)
                                {
                                    targetBoundaryRelationKeys.insert(QStringLiteral("%1|%2").arg(adminLevel).arg(objectKey));
                                    if (!hasBoundarySearchArea)
                                    {
                                        boundarySearchArea = mapObject->bbox31;
                                        hasBoundarySearchArea = true;
                                    }
                                    else
                                    {
                                        boundarySearchArea.left() = std::min(boundarySearchArea.left(), mapObject->bbox31.left());
                                        boundarySearchArea.top() = std::min(boundarySearchArea.top(), mapObject->bbox31.top());
                                        boundarySearchArea.right() = std::max(boundarySearchArea.right(), mapObject->bbox31.right());
                                        boundarySearchArea.bottom() = std::max(boundarySearchArea.bottom(), mapObject->bbox31.bottom());
                                    }
                                }
                            }
                            if (mapBoundaryObjectIds.size() < 20)
                            {
                                const auto mapName = mapObject->getName(locale, false).trimmed();
                                const auto displayName = mapName.isEmpty()
                                    ? mapObject->getCaptionInNativeLanguage().trimmed()
                                    : mapName;
                                const bool bboxContainsPoint = mapObject->bbox31.left() <= point31.x
                                    && mapObject->bbox31.right() >= point31.x
                                    && mapObject->bbox31.top() <= point31.y
                                    && mapObject->bbox31.bottom() >= point31.y;
                                mapBoundaryObjectIds.push_back(QStringLiteral("id=%1 osmId=%2 relation=%3 split=%4 level=%5 area=%6 bbox=%7 contains=%8 name=%9")
                                    .arg(mapObject->id.id)
                                    .arg(mapObject->id.getOsmId())
                                    .arg(mapObject->id.isIdFromRelation() ? 1 : 0)
                                    .arg(mapObject->id.isIdFromSplit() ? 1 : 0)
                                    .arg(adminLevel)
                                    .arg(mapObject->isArea ? 1 : 0)
                                    .arg(bboxContainsPoint ? 1 : 0)
                                    .arg(mapObjectContainsPoint(*mapObject, point) ? 1 : 0)
                                    .arg(displayName));
                            }
                        }
                    }

                    // Keep the exact-polygon test for normal candidates. The
                    // address index may still reference the same OSM boundary
                    // when a generalized map-level polygon no longer covers
                    // this precise coordinate; its OSM ID lets us recover the
                    // correct admin_level without guessing from its bbox.
                    if (!mapObjectContainsPoint(*mapObject, point))
                        continue;

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
    }
    // Reuse the proven v0.4 Boundary-only loading path. The full block-type
    // mask returned 22,193 groups but no decoded Boundary subtype for this
    // OBF, whereas this filter previously returned 5,408 groups and five
    // matches around the tested coordinate. Keep this separate from normal
    // address, street, building, and house-number resolution.
    const auto boundaryOnlyMask = OsmAnd::ObfAddressStreetGroupTypesMask()
        .set(OsmAnd::ObfAddressStreetGroupType::Boundary);
    QList<std::shared_ptr<const OsmAnd::StreetGroup>> addressBoundaryGroups;
    dataInterface->loadStreetGroups(
        &addressBoundaryGroups,
        nullptr,
        boundaryOnlyMask);
    loadedAddressStreetGroupCount = addressBoundaryGroups.size();
    // Probe the separate AddressNameIndexData path. Boundary atoms are indexed
    // by name, so query the known local hierarchy names and inspect their
    // resolved StreetGroup references and bounding boxes. This is diagnostic
    // only; it does not affect the reverse-geocoding result.
    QJsonArray nameIndexBoundaryQueryResults;
    QJsonArray poiNameIndexQueryResults;
    const bool nameIndexDiagnosticsEnabled =
        qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_NAMEINDEX_DIAGNOSTICS");
    QJsonArray mapPlaceObjectDiagnostics;
    int nearbyMapObjectCount = 0;
    int nearbyNamedPlaceObjectCount = 0;
    int nearbyNamedAdministrativeBoundaryObjectCount = 0;
    // These diagnostic values are emitted below even when diagnostics are off.
    // Keep them in the function scope; populate them only inside the opt-in probe.
    int administrativeProbeMapObjectCount = 0;
    int administrativeProbeNamedBoundaryCount = 0;
    QJsonArray administrativeProbeBoundaries;
    if (nameIndexDiagnosticsEnabled)
    {
        const QStringList boundaryNameQueries{
            QStringLiteral("Stockerau"),
            QStringLiteral("Spillern"),
            QStringLiteral("Korneuburg"),
            QStringLiteral("Niederösterreich"),
            QStringLiteral("Lower Austria"),
            QStringLiteral("Austria")
        };
        for (const auto& query : boundaryNameQueries)
        {
            QList<std::shared_ptr<const OsmAnd::Address>> foundAddresses;
            const bool completed = dataInterface->scanAddressesByName(
                query,
                OsmAnd::StringMatcherMode::CHECK_EQUALS_FROM_SPACE,
                &foundAddresses,
                nullptr,
                boundaryOnlyMask,
                false,
                true);
            for (const auto& address : foundAddresses)
            {
                if (!address || address->addressType != OsmAnd::AddressType::StreetGroup)
                    continue;
                const auto streetGroup = std::static_pointer_cast<const OsmAnd::StreetGroup>(address);
                const auto groupName = streetGroup->getName(locale, false).trimmed();
                const auto displayName = groupName.isEmpty()
                    ? streetGroup->nativeName.trimmed() : groupName;
                const auto bbox = streetGroup->bbox31;
                const bool bboxContainsPoint = bbox.size() >= 4
                    && point31.x >= bbox[0] && point31.x <= bbox[2]
                    && point31.y >= bbox[1] && point31.y <= bbox[3];
                nameIndexBoundaryQueryResults.push_back(QJsonObject{
                    {QStringLiteral("query"), query},
                    {QStringLiteral("completed"), completed},
                    {QStringLiteral("name"), displayName},
                    {QStringLiteral("osm_id"), streetGroup->id.isOsmId()
                        ? QString::number(streetGroup->id.getOsmId()) : QString()},
                    {QStringLiteral("raw_id"), QString::number(streetGroup->id.id)},
                    {QStringLiteral("is_relation"), streetGroup->id.isIdFromRelation()},
                    {QStringLiteral("group_type"), static_cast<int>(streetGroup->type)},
                    {QStringLiteral("position31"), QJsonArray{streetGroup->position31.x, streetGroup->position31.y}},
                    {QStringLiteral("bbox31"), bbox.size() >= 4
                        ? QJsonArray{bbox[0], bbox[1], bbox[2], bbox[3]} : QJsonArray{}},
                    {QStringLiteral("bbox_contains_point"), bboxContainsPoint}
                });
            }
            if (foundAddresses.isEmpty())
            {
                nameIndexBoundaryQueryResults.push_back(QJsonObject{
                    {QStringLiteral("query"), query},
                    {QStringLiteral("completed"), completed},
                    {QStringLiteral("matches"), 0}
                });
            }
        }

        // Inspect only nearby POI records. A name-index query such as
        // "Stockerau" also returns unrelated businesses whose names contain
        // the query (for example bank branches), so it is not suitable for
        // discovering administrative place names.
        constexpr double poiProbeLatitudeRadius = 0.01;  // approximately 1.1 km
        constexpr double poiProbeLongitudeRadius = 0.015; // approximately 1.1 km here
        const auto poiTopLeft = OsmAnd::Utilities::convertLatLonTo31(
            OsmAnd::LatLon(latitude + poiProbeLatitudeRadius, longitude - poiProbeLongitudeRadius));
        const auto poiBottomRight = OsmAnd::Utilities::convertLatLonTo31(
            OsmAnd::LatLon(latitude - poiProbeLatitudeRadius, longitude + poiProbeLongitudeRadius));
        OsmAnd::AreaI poiProbeArea;
        poiProbeArea.left() = std::min(poiTopLeft.x, poiBottomRight.x);
        poiProbeArea.top() = std::min(poiTopLeft.y, poiBottomRight.y);
        poiProbeArea.right() = std::max(poiTopLeft.x, poiBottomRight.x);
        poiProbeArea.bottom() = std::max(poiTopLeft.y, poiBottomRight.y);

        QList<std::shared_ptr<const OsmAnd::Amenity>> nearbyAmenities;
        const bool nearbyAmenitiesCompleted = dataInterface->loadAmenities(
            &nearbyAmenities,
            &poiProbeArea);
        int nearbyPlaceAmenityCount = 0;
        for (const auto& amenity : nearbyAmenities)
        {
            if (!amenity)
                continue;
            const auto decodedValues = amenity->getDecodedValuesHash();
            const auto placeValue = decodedValues.value(QStringLiteral("place")).trimmed().toLower();
            const bool isPlaceAmenity = placeValue == QStringLiteral("city")
                || placeValue == QStringLiteral("town")
                || placeValue == QStringLiteral("village")
                || placeValue == QStringLiteral("hamlet")
                || placeValue == QStringLiteral("municipality")
                || placeValue == QStringLiteral("suburb")
                || placeValue == QStringLiteral("quarter")
                || placeValue == QStringLiteral("neighbourhood")
                || placeValue == QStringLiteral("locality");
            if (!isPlaceAmenity)
                continue;

            ++nearbyPlaceAmenityCount;
            if (poiNameIndexQueryResults.size() >= 50)
                continue;

            QJsonObject values;
            for (auto it = decodedValues.cbegin(); it != decodedValues.cend(); ++it)
                values.insert(it.key(), it.value());
            QJsonArray categories;
            for (const auto& category : amenity->getDecodedCategories())
                categories.push_back(QJsonObject{
                    {QStringLiteral("category"), category.category},
                    {QStringLiteral("subcategory"), category.subcategory}
                });
            const auto dx = static_cast<double>(amenity->position31.x) - point31.x;
            const auto dy = static_cast<double>(amenity->position31.y) - point31.y;
            const auto distanceMeters = std::hypot(dx, dy) * 40075016.686 / 2147483648.0;
            const auto amenityName = amenity->getName(locale, false).trimmed();
            poiNameIndexQueryResults.push_back(QJsonObject{
                {QStringLiteral("name"), amenityName.isEmpty() ? amenity->nativeName : amenityName},
                {QStringLiteral("native_name"), amenity->nativeName},
                {QStringLiteral("osm_id"), amenity->id.isOsmId()
                    ? QString::number(amenity->id.getOsmId()) : QString()},
                {QStringLiteral("type"), amenity->type},
                {QStringLiteral("subtype"), amenity->subType},
                {QStringLiteral("categories"), categories},
                {QStringLiteral("values"), values},
                {QStringLiteral("city_from_tags"), amenity->getCityFromTagGroups(locale)},
                {QStringLiteral("distance_m"), distanceMeters}
            });
        }
        // Inspect the nearby map index for place=* objects. Unlike the POI
        // index, named place nodes can be represented as map objects.
        QSet<QString> seenMapPlaceObjects;
        for (const auto& reader : dataInterface->obfReaders)
        {
            if (!reader)
                continue;
            const auto info = reader->obtainInfo();
            if (!info)
                continue;
            for (const auto& mapSection : info->mapSections)
            {
                if (!mapSection)
                    continue;
                for (const auto& mapLevel : mapSection->levels)
                {
                    if (!mapLevel)
                        continue;
                    QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> nearbyMapObjects;
                    OsmAnd::ObfMapSectionReader::loadMapObjects(
                        reader, mapSection, nullptr, mapLevel->minZoom,
                        &poiProbeArea, &nearbyMapObjects);
                    nearbyMapObjectCount += nearbyMapObjects.size();
                    for (const auto& mapObject : nearbyMapObjects)
                    {
                        if (!mapObject)
                            continue;
                        const auto attributes = mapObject->getResolvedAttributes();
                        const auto placeValue = attributes.value(QStringLiteral("place")).trimmed().toLower();
                        const auto boundaryValue = attributes.value(QStringLiteral("boundary")).trimmed().toLower();
                        const auto adminLevelText = attributes.value(QStringLiteral("admin_level")).trimmed();
                        bool adminLevelOk = false;
                        const int adminLevel = adminLevelText.toInt(&adminLevelOk);
                        const bool isPlaceObject = placeValue == QStringLiteral("city")
                            || placeValue == QStringLiteral("town")
                            || placeValue == QStringLiteral("village")
                            || placeValue == QStringLiteral("hamlet")
                            || placeValue == QStringLiteral("municipality")
                            || placeValue == QStringLiteral("suburb")
                            || placeValue == QStringLiteral("quarter")
                            || placeValue == QStringLiteral("neighbourhood")
                            || placeValue == QStringLiteral("locality");
                        const bool isAdministrativeBoundary = boundaryValue == QStringLiteral("administrative")
                            && adminLevelOk && adminLevel > 0;
                        if (!isPlaceObject && !isAdministrativeBoundary)
                            continue;
                        const auto name = mapObject->getName(locale, false).trimmed();
                        const auto displayName = name.isEmpty()
                            ? mapObject->getCaptionInNativeLanguage().trimmed() : name;
                        if (displayName.isEmpty())
                            continue;
                        if (isPlaceObject)
                            ++nearbyNamedPlaceObjectCount;
                        if (isAdministrativeBoundary)
                            ++nearbyNamedAdministrativeBoundaryObjectCount;
                        const auto key = mapObject->id.isOsmId()
                            ? administrativeObjectKey(mapObject->id)
                            : QString::number(mapObject->id.id);
                        if (seenMapPlaceObjects.contains(key))
                            continue;
                        seenMapPlaceObjects.insert(key);
                        if (mapPlaceObjectDiagnostics.size() >= 100)
                            continue;
                        const double dx = (static_cast<double>(mapObject->points31.isEmpty()
                            ? (mapObject->bbox31.left() + mapObject->bbox31.right()) / 2 : mapObject->points31.first().x) - point31.x);
                        const double dy = (static_cast<double>(mapObject->points31.isEmpty()
                            ? (mapObject->bbox31.top() + mapObject->bbox31.bottom()) / 2 : mapObject->points31.first().y) - point31.y);
                        const double distanceMeters = std::hypot(dx, dy)
                            * 40075016.686 / 2147483648.0;
                        QJsonObject encodedAttributes;
                        for (auto it = attributes.cbegin(); it != attributes.cend(); ++it)
                            encodedAttributes.insert(it.key(), it.value());
                        mapPlaceObjectDiagnostics.push_back(QJsonObject{
                            {QStringLiteral("name"), displayName},
                            {QStringLiteral("place"), placeValue},
                            {QStringLiteral("boundary"), boundaryValue},
                            {QStringLiteral("admin_level"), adminLevelOk ? adminLevel : -1},
                            {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                ? QString::number(mapObject->id.getOsmId()) : QString()},
                            {QStringLiteral("is_relation"), mapObject->id.isIdFromRelation()},
                            {QStringLiteral("is_area"), mapObject->isArea},
                            {QStringLiteral("distance_m"), distanceMeters},
                            {QStringLiteral("attributes"), encodedAttributes}
                        });
                    }
                }
            }
        }
        // A second, bounded map-index probe checks for larger named
        // administrative objects whose representative geometry may be several
        // kilometres from the requested coordinate. This reads indexed map
        // objects only; it does not reconstruct boundary line segments.
        constexpr double administrativeProbeLatitudeRadius = 0.045; // approximately 5 km
        constexpr double administrativeProbeLongitudeRadius = 0.067;
        const auto administrativeTopLeft = OsmAnd::Utilities::convertLatLonTo31(
            OsmAnd::LatLon(latitude + administrativeProbeLatitudeRadius, longitude - administrativeProbeLongitudeRadius));
        const auto administrativeBottomRight = OsmAnd::Utilities::convertLatLonTo31(
            OsmAnd::LatLon(latitude - administrativeProbeLatitudeRadius, longitude + administrativeProbeLongitudeRadius));
        OsmAnd::AreaI administrativeProbeArea;
        administrativeProbeArea.left() = std::min(administrativeTopLeft.x, administrativeBottomRight.x);
        administrativeProbeArea.top() = std::min(administrativeTopLeft.y, administrativeBottomRight.y);
        administrativeProbeArea.right() = std::max(administrativeTopLeft.x, administrativeBottomRight.x);
        administrativeProbeArea.bottom() = std::max(administrativeTopLeft.y, administrativeBottomRight.y);

        QSet<QString> seenAdministrativeProbeObjects;
        for (const auto& reader : dataInterface->obfReaders)
        {
            if (!reader)
                continue;
            const auto info = reader->obtainInfo();
            if (!info)
                continue;
            for (const auto& mapSection : info->mapSections)
            {
                if (!mapSection)
                    continue;
                for (const auto& mapLevel : mapSection->levels)
                {
                    if (!mapLevel)
                        continue;
                    QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> probeObjects;
                    OsmAnd::ObfMapSectionReader::loadMapObjects(
                        reader, mapSection, nullptr, mapLevel->minZoom,
                        &administrativeProbeArea, &probeObjects);
                    administrativeProbeMapObjectCount += probeObjects.size();
                    for (const auto& mapObject : probeObjects)
                    {
                        if (!mapObject)
                            continue;
                        const auto attributes = mapObject->getResolvedAttributes();
                        if (attributes.value(QStringLiteral("boundary")).trimmed().compare(
                                QStringLiteral("administrative"), Qt::CaseInsensitive) != 0)
                            continue;
                        bool levelOk = false;
                        const int adminLevel = attributes.value(QStringLiteral("admin_level")).toInt(&levelOk);
                        if (!levelOk || adminLevel <= 0)
                            continue;
                        const auto name = mapObject->getName(locale, false).trimmed();
                        const auto displayName = name.isEmpty()
                            ? mapObject->getCaptionInNativeLanguage().trimmed() : name;
                        if (displayName.isEmpty())
                            continue;
                        const auto key = mapObject->id.isOsmId()
                            ? administrativeObjectKey(mapObject->id)
                            : QString::number(mapObject->id.id);
                        if (seenAdministrativeProbeObjects.contains(key))
                            continue;
                        seenAdministrativeProbeObjects.insert(key);
                        ++administrativeProbeNamedBoundaryCount;
                        if (administrativeProbeBoundaries.size() >= 100)
                            continue;
                        const double centerX = mapObject->bbox31.left()
                            + (static_cast<double>(mapObject->bbox31.right()) - mapObject->bbox31.left()) / 2.0;
                        const double centerY = mapObject->bbox31.top()
                            + (static_cast<double>(mapObject->bbox31.bottom()) - mapObject->bbox31.top()) / 2.0;
                        const double distanceMeters = std::hypot(
                            centerX - point31.x, centerY - point31.y)
                            * 40075016.686 / 2147483648.0;
                        administrativeProbeBoundaries.push_back(QJsonObject{
                            {QStringLiteral("name"), displayName},
                            {QStringLiteral("admin_level"), adminLevel},
                            {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                ? QString::number(mapObject->id.getOsmId()) : QString()},
                            {QStringLiteral("is_relation"), mapObject->id.isIdFromRelation()},
                            {QStringLiteral("is_area"), mapObject->isArea},
                            {QStringLiteral("distance_m"), distanceMeters}
                        });
                    }
                }
            }
        }
        // Preserve index order; QJsonArray iterators expose proxy references
        // and are not sortable with std::sort on all supported Qt versions.

        // Keep a compact summary alongside the small, filtered place list.
        poiNameIndexQueryResults.prepend(QJsonObject{
            {QStringLiteral("query_mode"), QStringLiteral("spatial_place_only")},
            {QStringLiteral("completed"), nearbyAmenitiesCompleted},
            {QStringLiteral("loaded_amenities"), nearbyAmenities.size()},
            {QStringLiteral("matching_place_amenities"), nearbyPlaceAmenityCount},
            {QStringLiteral("returned_place_amenities"), std::min(nearbyPlaceAmenityCount, 50)},
            {QStringLiteral("named_place_map_objects"), nearbyNamedPlaceObjectCount},
            {QStringLiteral("named_administrative_boundary_map_objects"), nearbyNamedAdministrativeBoundaryObjectCount},
            {QStringLiteral("radius_m_approx"), 1100}
        });
    }

    for (const auto& streetGroup : addressBoundaryGroups)
    {
        if (!streetGroup)
            continue;

        const auto subtypeKey = QString::number(static_cast<int>(streetGroup->type));
        addressStreetGroupSubtypeCounts.insert(
            subtypeKey,
            addressStreetGroupSubtypeCounts.value(subtypeKey).toInt() + 1);

        const auto groupName = streetGroup->getName(locale, false).trimmed();
        const auto displayName = groupName.isEmpty()
            ? streetGroup->nativeName.trimmed()
            : groupName;
        const auto streetGroupObjectKey = administrativeObjectKey(streetGroup->id);
        if (!streetGroupObjectKey.isEmpty() && administrativeLevelsByObjectId.contains(streetGroupObjectKey)
            && mapBoundaryStreetGroupMatches.size() < 30)
        {
            const auto bbox = streetGroup->bbox31;
            const bool bboxContainsPoint = bbox.size() >= 4
                && point31.x >= bbox[0] && point31.x <= bbox[2]
                && point31.y >= bbox[1] && point31.y <= bbox[3];
            mapBoundaryStreetGroupMatches.push_back(QJsonObject{
                {QStringLiteral("id"), QString::number(streetGroup->id.id)},
                {QStringLiteral("osm_id"), QString::number(streetGroup->id.getOsmId())},
                {QStringLiteral("is_relation"), streetGroup->id.isIdFromRelation()},
                {QStringLiteral("subtype"), static_cast<int>(streetGroup->type)},
                {QStringLiteral("name"), displayName},
                {QStringLiteral("bbox_contains_point"), bboxContainsPoint}
            });
        }

        if (streetGroup->type != OsmAnd::ObfAddressStreetGroupSubtype::Boundary)
            continue;
        ++loadedAddressBoundaryGroupCount;
        if (streetGroup->bbox31.size() < 4)
            continue;

        const auto left = streetGroup->bbox31[0];
        const auto top = streetGroup->bbox31[1];
        const auto right = streetGroup->bbox31[2];
        const auto bottom = streetGroup->bbox31[3];
        if (point31.x < left || point31.x > right || point31.y < top || point31.y > bottom)
            continue;

        ++matchingAddressBoundaryGroupCount;
        if (addressBoundaryCandidateDetails.size() < 30)
        {
            const auto width = static_cast<qint64>(right) - left;
            const auto height = static_cast<qint64>(bottom) - top;
            addressBoundaryCandidateDetails.push_back(QJsonObject{
                {QStringLiteral("name"), displayName},
                {QStringLiteral("osm_id"), streetGroup->id.isOsmId()
                    ? QString::number(streetGroup->id.getOsmId()) : QString()},
                {QStringLiteral("raw_id"), QString::number(streetGroup->id.id)},
                {QStringLiteral("is_relation"), streetGroup->id.isIdFromRelation()},
                {QStringLiteral("bbox31"), QJsonArray{left, top, right, bottom}},
                {QStringLiteral("position31"), QJsonArray{
                    streetGroup->position31.x, streetGroup->position31.y}},
                {QStringLiteral("bbox_width"), width},
                {QStringLiteral("bbox_height"), height},
                {QStringLiteral("bbox_area"), std::max<qint64>(0, width) * std::max<qint64>(0, height)}
            });
        }
        if (addressBoundaryObjectIds.size() < 20)
        {
            const auto groupName = streetGroup->getName(locale, false).trimmed();
            const auto displayName = groupName.isEmpty() ? streetGroup->nativeName.trimmed() : groupName;
            addressBoundaryObjectIds.push_back(QStringLiteral("id=%1 osmId=%2 relation=%3 split=%4 name=%5")
                .arg(streetGroup->id.id)
                .arg(streetGroup->id.getOsmId())
                .arg(streetGroup->id.isIdFromRelation() ? 1 : 0)
                .arg(streetGroup->id.isIdFromSplit() ? 1 : 0)
                .arg(displayName));
        }
        const auto addressObjectKey = administrativeObjectKey(streetGroup->id);
        const auto levelIt = addressObjectKey.isEmpty()
            ? administrativeLevelsByObjectId.cend()
            : administrativeLevelsByObjectId.constFind(addressObjectKey);
        const bool hasResolvedAdminLevel = levelIt != administrativeLevelsByObjectId.cend();
        if (hasResolvedAdminLevel)
        {
            ++matchedAddressBoundaryObjectIdCount;
            if (matchedBoundaryObjectIds.size() < 20)
                matchedBoundaryObjectIds.push_back(QString::number(streetGroup->id.id));
        }

        const auto localizedName = streetGroup->getName(locale, false).trimmed();
        const auto objectName = localizedName.isEmpty()
            ? streetGroup->nativeName.trimmed()
            : localizedName;
        if (objectName.isEmpty())
            continue;

        // Address-index Boundary groups often have no corresponding map object
        // (or their OSM IDs differ between the two indexes). Keep those useful
        // name/bounding-box candidates instead of discarding them. Their exact
        // admin_level is unknown, so mark them as 99 and leave them selectable
        // alongside the classified map-polygon results.
        const int candidateAdminLevel = hasResolvedAdminLevel ? levelIt.value() : 99;
        const auto normalizedName = OsmAnd::CollatorStringMatcher::lowercaseAndAlignChars(objectName).trimmed();
        const auto objectKey = QStringLiteral("%1|%2").arg(candidateAdminLevel).arg(normalizedName);
        if (seenAreas.contains(objectKey))
            continue;

        seenAreas.insert(objectKey);
        const auto width = static_cast<qint64>(right) - left;
        const auto height = static_cast<qint64>(bottom) - top;
        candidates.push_back({
            candidateAdminLevel,
            objectName,
            std::max<qint64>(0, width) * std::max<qint64>(0, height)
        });
    }

    QJsonArray addressBoundaryBboxMapSearches;
    int addressBoundaryBboxMapSearchObjectCount = 0;
    int addressBoundaryBboxMapSearchSkippedCount = 0;
    // Diagnostic-only search: use each matching address-index Boundary
    // group's complete bbox as a map-object query. This checks whether its
    // corresponding administrative geometry exists elsewhere in the map index,
    // rather than only in the tiny coordinate query used above. Very large
    // country/region bboxes are skipped to keep this opt-in probe bounded.
    if (qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_BOUNDARY_DIAGNOSTICS"))
    {
        constexpr qint64 maxAddressBoundaryBboxDimension31 = 5000000;
        for (const auto& streetGroup : addressBoundaryGroups)
        {
            if (!streetGroup
                || streetGroup->type != OsmAnd::ObfAddressStreetGroupSubtype::Boundary
                || streetGroup->bbox31.size() < 4)
                continue;

            const auto left = streetGroup->bbox31[0];
            const auto top = streetGroup->bbox31[1];
            const auto right = streetGroup->bbox31[2];
            const auto bottom = streetGroup->bbox31[3];
            if (point31.x < left || point31.x > right || point31.y < top || point31.y > bottom)
                continue;

            const auto width = static_cast<qint64>(right) - left;
            const auto height = static_cast<qint64>(bottom) - top;
            const auto groupName = streetGroup->getName(locale, false).trimmed();
            const auto displayName = groupName.isEmpty()
                ? streetGroup->nativeName.trimmed() : groupName;
            const auto addressObjectKey = administrativeObjectKey(streetGroup->id);
            const auto normalizedAddressName =
                OsmAnd::CollatorStringMatcher::lowercaseAndAlignChars(displayName).trimmed();

            QJsonObject searchResult{
                {QStringLiteral("address_name"), displayName},
                {QStringLiteral("address_osm_id"), streetGroup->id.isOsmId()
                    ? QString::number(streetGroup->id.getOsmId()) : QString()},
                {QStringLiteral("address_is_relation"), streetGroup->id.isIdFromRelation()},
                {QStringLiteral("address_is_split"), streetGroup->id.isIdFromSplit()},
                {QStringLiteral("bbox31"), QJsonArray{left, top, right, bottom}},
                {QStringLiteral("bbox_width"), width},
                {QStringLiteral("bbox_height"), height}
            };

            if (width <= 0 || height <= 0
                || width > maxAddressBoundaryBboxDimension31
                || height > maxAddressBoundaryBboxDimension31)
            {
                searchResult.insert(QStringLiteral("skipped"), true);
                searchResult.insert(QStringLiteral("skip_reason"), QStringLiteral("bbox_too_large"));
                ++addressBoundaryBboxMapSearchSkippedCount;
                addressBoundaryBboxMapSearches.push_back(searchResult);
                continue;
            }

            OsmAnd::AreaI addressBboxQuery;
            addressBboxQuery.left() = left;
            addressBboxQuery.top() = top;
            addressBboxQuery.right() = right;
            addressBboxQuery.bottom() = bottom;

            QJsonArray levelResults;
            int totalLoadedObjects = 0;
            int totalAdministrativeObjects = 0;
            int totalSameIdObjects = 0;
            int totalSameNameObjects = 0;

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

                    for (const auto& mapLevel : mapSection->levels)
                    {
                        if (!mapLevel)
                            continue;

                        QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> bboxMapObjects;
                        OsmAnd::ObfMapSectionReader::loadMapObjects(
                            reader,
                            mapSection,
                            nullptr,
                            mapLevel->minZoom,
                            &addressBboxQuery,
                            &bboxMapObjects);

                        int levelAdministrativeObjects = 0;
                        int levelAdministrativeAreaObjects = 0;
                        int levelAdministrativeLineObjects = 0;
                        int levelAdministrativeClosedObjects = 0;
                        int levelAdministrativeBboxContainsPoint = 0;
                        int levelSameIdObjects = 0;
                        int levelSameNameObjects = 0;
                        QJsonArray matchingObjects;
                        std::vector<QPair<qint64, QJsonObject>> administrativeGeometrySamples;
                        for (const auto& mapObject : bboxMapObjects)
                        {
                            if (!mapObject)
                                continue;

                            const auto attributes = mapObject->getResolvedAttributes();
                            const auto boundaryType = attributes.value(QStringLiteral("boundary")).trimmed();
                            const auto adminLevelText = attributes.value(QStringLiteral("admin_level")).trimmed();
                            bool adminLevelOk = false;
                            const int adminLevel = adminLevelText.toInt(&adminLevelOk);
                            const bool isAdministrative = boundaryType.compare(
                                QStringLiteral("administrative"), Qt::CaseInsensitive) == 0
                                && adminLevelOk && adminLevel > 0;
                            if (isAdministrative)
                            {
                                ++levelAdministrativeObjects;
                                if (mapObject->isArea)
                                    ++levelAdministrativeAreaObjects;
                                else
                                    ++levelAdministrativeLineObjects;
                                if (mapObject->isClosedFigure())
                                    ++levelAdministrativeClosedObjects;
                                const auto& geometryBbox = mapObject->bbox31;
                                const bool geometryBboxContainsPoint =
                                    geometryBbox.left() <= point31.x && geometryBbox.right() >= point31.x
                                    && geometryBbox.top() <= point31.y && geometryBbox.bottom() >= point31.y;
                                if (geometryBboxContainsPoint)
                                    ++levelAdministrativeBboxContainsPoint;

                                const auto geometryName = mapObject->getName(locale, false).trimmed();
                                const auto geometryDisplayName = geometryName.isEmpty()
                                    ? mapObject->getCaptionInNativeLanguage().trimmed() : geometryName;
                                const qint64 geometryWidth = std::max<qint64>(0,
                                    static_cast<qint64>(geometryBbox.right()) - geometryBbox.left());
                                const qint64 geometryHeight = std::max<qint64>(0,
                                    static_cast<qint64>(geometryBbox.bottom()) - geometryBbox.top());
                                const qint64 geometryArea = geometryWidth * geometryHeight;
                                const bool isClosedFigure = mapObject->isClosedFigure();
                                const bool closedGeometryContainsQueryPoint =
                                    !mapObject->isArea && isClosedFigure
                                    && polygonContainsPoint(mapObject->points31, point);
                                int nearestLineSegmentIndex = -1;
                                const double nearestLineDistance = !mapObject->isArea
                                    ? nearestLineDistanceMeters(
                                        mapObject->points31, point, latitude, &nearestLineSegmentIndex)
                                    : std::numeric_limits<double>::infinity();
                                QJsonObject geometrySample{
                                    {QStringLiteral("name"), geometryDisplayName},
                                    {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                        ? QString::number(mapObject->id.getOsmId()) : QString()},
                                    {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                                    {QStringLiteral("is_relation"), mapObject->id.isIdFromRelation()},
                                    {QStringLiteral("is_split"), mapObject->id.isIdFromSplit()},
                                    {QStringLiteral("is_area"), mapObject->isArea},
                                    {QStringLiteral("is_closed_figure"), isClosedFigure},
                                    {QStringLiteral("closed_geometry_contains_query_point"), closedGeometryContainsQueryPoint},
                                    {QStringLiteral("nearest_line_distance_m"), std::isfinite(nearestLineDistance)
                                        ? QJsonValue(nearestLineDistance) : QJsonValue()},
                                    {QStringLiteral("nearest_line_segment_index"), nearestLineSegmentIndex},
                                    {QStringLiteral("outer_point_count"), mapObject->points31.size()},
                                    {QStringLiteral("inner_ring_count"), mapObject->innerPolygonsPoints31.size()},
                                    {QStringLiteral("bbox_contains_query_point"), geometryBboxContainsPoint},
                                    {QStringLiteral("bbox31"), QJsonArray{
                                        geometryBbox.left(), geometryBbox.top(),
                                        geometryBbox.right(), geometryBbox.bottom()}}
                                };
                                administrativeGeometrySamples.push_back(qMakePair(geometryArea, geometrySample));
                            }

                            const auto mapObjectKey = administrativeObjectKey(mapObject->id);
                            const bool sameOsmId = !addressObjectKey.isEmpty()
                                && mapObjectKey == addressObjectKey;
                            const auto mapName = mapObject->getName(locale, false).trimmed();
                            const auto objectName = mapName.isEmpty()
                                ? mapObject->getCaptionInNativeLanguage().trimmed() : mapName;
                            const auto normalizedMapName =
                                OsmAnd::CollatorStringMatcher::lowercaseAndAlignChars(objectName).trimmed();
                            const bool sameName = !normalizedAddressName.isEmpty()
                                && normalizedMapName == normalizedAddressName;

                            if (sameOsmId)
                                ++levelSameIdObjects;
                            if (sameName)
                                ++levelSameNameObjects;

                            if ((sameOsmId || sameName) && matchingObjects.size() < 12)
                            {
                                const auto objectBbox = mapObject->bbox31;
                                matchingObjects.push_back(QJsonObject{
                                    {QStringLiteral("name"), objectName},
                                    {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                        ? QString::number(mapObject->id.getOsmId()) : QString()},
                                    {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                                    {QStringLiteral("is_relation"), mapObject->id.isIdFromRelation()},
                                    {QStringLiteral("is_split"), mapObject->id.isIdFromSplit()},
                                    {QStringLiteral("same_osm_id"), sameOsmId},
                                    {QStringLiteral("same_name"), sameName},
                                    {QStringLiteral("boundary"), boundaryType},
                                    {QStringLiteral("admin_level"), adminLevelOk ? adminLevel : -1},
                                    {QStringLiteral("is_area"), mapObject->isArea},
                                    {QStringLiteral("is_closed_figure"), mapObject->isClosedFigure()},
                                    {QStringLiteral("outer_point_count"), mapObject->points31.size()},
                                    {QStringLiteral("inner_ring_count"), mapObject->innerPolygonsPoints31.size()},
                                    {QStringLiteral("bbox31"), QJsonArray{
                                        objectBbox.left(), objectBbox.top(),
                                        objectBbox.right(), objectBbox.bottom()}}
                                });
                            }
                        }

                        std::sort(administrativeGeometrySamples.begin(), administrativeGeometrySamples.end(),
                            [](const auto& leftSample, const auto& rightSample)
                            {
                                return leftSample.first > rightSample.first;
                            });
                        QJsonArray administrativeGeometrySampleJson;
                        const int geometrySampleLimit = std::min(30,
                            static_cast<int>(administrativeGeometrySamples.size()));
                        for (int sampleIndex = 0; sampleIndex < geometrySampleLimit; ++sampleIndex)
                            administrativeGeometrySampleJson.push_back(
                                administrativeGeometrySamples.at(sampleIndex).second);

                        totalLoadedObjects += bboxMapObjects.size();
                        totalAdministrativeObjects += levelAdministrativeObjects;
                        totalSameIdObjects += levelSameIdObjects;
                        totalSameNameObjects += levelSameNameObjects;
                        levelResults.push_back(QJsonObject{
                            {QStringLiteral("min_zoom"), mapLevel->minZoom},
                            {QStringLiteral("loaded_objects"), bboxMapObjects.size()},
                            {QStringLiteral("administrative_objects"), levelAdministrativeObjects},
                            {QStringLiteral("administrative_area_objects"), levelAdministrativeAreaObjects},
                            {QStringLiteral("administrative_line_objects"), levelAdministrativeLineObjects},
                            {QStringLiteral("administrative_closed_objects"), levelAdministrativeClosedObjects},
                            {QStringLiteral("administrative_bbox_contains_query_point"), levelAdministrativeBboxContainsPoint},
                            {QStringLiteral("same_osm_id_objects"), levelSameIdObjects},
                            {QStringLiteral("same_name_objects"), levelSameNameObjects},
                            {QStringLiteral("matching_objects"), matchingObjects},
                            {QStringLiteral("largest_administrative_geometries"), administrativeGeometrySampleJson}
                        });
                    }
                }
            }

            searchResult.insert(QStringLiteral("skipped"), false);
            searchResult.insert(QStringLiteral("loaded_objects"), totalLoadedObjects);
            searchResult.insert(QStringLiteral("administrative_objects"), totalAdministrativeObjects);
            searchResult.insert(QStringLiteral("same_osm_id_objects"), totalSameIdObjects);
            searchResult.insert(QStringLiteral("same_name_objects"), totalSameNameObjects);
            searchResult.insert(QStringLiteral("levels"), levelResults);
            addressBoundaryBboxMapSearchObjectCount += totalLoadedObjects;
            addressBoundaryBboxMapSearches.push_back(searchResult);
        }
    }

    // Diagnostic reconstruction probe: scan only the combined bounding area
    // of the administrative boundary objects that intersect the coordinate.
    // Keep the scan spatially bounded: loading every map object from every zoom
    // level of a country-sized OBF can take an excessive amount of time and RAM.
    // Within this area, retain only fragments belonging to the target relation IDs.
    // This intentionally does not change address resolution yet.
    for (const auto& streetGroup : addressBoundaryGroups)
    {
        if (!streetGroup || streetGroup->type != OsmAnd::ObfAddressStreetGroupSubtype::Boundary
            || streetGroup->bbox31.size() < 4)
            continue;
        const auto left = streetGroup->bbox31[0];
        const auto top = streetGroup->bbox31[1];
        const auto right = streetGroup->bbox31[2];
        const auto bottom = streetGroup->bbox31[3];
        if (point31.x < left || point31.x > right || point31.y < top || point31.y > bottom)
            continue;
        if (!hasBoundarySearchArea)
        {
            boundarySearchArea.left() = left;
            boundarySearchArea.top() = top;
            boundarySearchArea.right() = right;
            boundarySearchArea.bottom() = bottom;
            hasBoundarySearchArea = true;
        }
        else
        {
            boundarySearchArea.left() = std::min(boundarySearchArea.left(), left);
            boundarySearchArea.top() = std::min(boundarySearchArea.top(), top);
            boundarySearchArea.right() = std::max(boundarySearchArea.right(), right);
            boundarySearchArea.bottom() = std::max(boundarySearchArea.bottom(), bottom);
        }
    }

    QHash<int, QHash<QString, int>> boundaryEndpointDegrees;
    QHash<int, int> boundaryLineCounts;
    QHash<QString, QHash<QString, int>> boundaryRelationEndpointDegrees;
    QHash<QString, int> boundaryRelationLineCounts;
    QHash<QString, QString> boundaryRelationOsmIds;
    QHash<QString, QString> boundaryRelationNames;
    QHash<QString, int> boundaryRelationLevels;
    QHash<QString, bool> boundaryRelationIsRelations;
    QHash<QString, bool> boundaryRelationHasSplitIds;
    QJsonArray boundaryLineSamples;
    QJsonArray targetBoundaryLineSegments;
    QJsonArray targetBoundaryAreaObjects;
    int boundaryAreaObjectCount = 0;
    int boundaryGeometryPointCount = 0;
    // This broad scan is diagnostic-only and can be expensive on large OBF
    // files. Keep it opt-in so normal reverse geocoding does not repeatedly
    // traverse every map section and zoom level.
    const bool boundaryLineDiagnosticsEnabled =
        qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_BOUNDARY_DIAGNOSTICS");
    if (!targetBoundaryRelationKeys.isEmpty() && boundaryLineDiagnosticsEnabled)
    {
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
                for (const auto& mapLevel : mapSection->levels)
                {
                    if (!mapLevel)
                        continue;
                    QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> mapObjects;
                    OsmAnd::ObfMapSectionReader::loadMapObjects(
                        reader, mapSection, nullptr, mapLevel->minZoom,
                        &boundarySearchArea, &mapObjects);
                    for (const auto& mapObject : mapObjects)
                    {
                        if (!mapObject)
                            continue;
                        const auto attributes = mapObject->getResolvedAttributes();
                        if (attributes.value(QStringLiteral("boundary")) != QStringLiteral("administrative"))
                            continue;
                        bool levelOk = false;
                        const int level = attributes.value(QStringLiteral("admin_level")).toInt(&levelOk);
                        if (!levelOk || level <= 0 || mapObject->points31.size() < 2)
                            continue;
                        // Normalize the object ID before separating polygon areas
                        // from line fragments. This lets the diagnostic identify
                        // multiple area pieces belonging to the same source OSM object.
                        const auto normalizedObjectId = administrativeObjectKey(mapObject->id);
                        const auto relationObjectKey = QStringLiteral("%1|%2")
                            .arg(level)
                            .arg(normalizedObjectId.isEmpty()
                                ? QStringLiteral("obf:%1").arg(mapObject->id.id)
                                : normalizedObjectId);
                        if (mapObject->isArea)
                        {
                            ++boundaryAreaObjectCount;
                            if (targetBoundaryRelationKeys.contains(relationObjectKey)
                                && targetBoundaryAreaObjects.size() < 100)
                            {
                                QJsonArray innerRingPointCounts;
                                for (const auto& innerRing : mapObject->innerPolygonsPoints31)
                                    innerRingPointCounts.push_back(innerRing.size());
                                targetBoundaryAreaObjects.push_back(QJsonObject{
                                    {QStringLiteral("admin_level"), level},
                                    {QStringLiteral("min_zoom"), mapLevel->minZoom},
                                    {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                        ? QString::number(mapObject->id.getOsmId()) : QString()},
                                    {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                                    {QStringLiteral("is_relation"), mapObject->id.isIdFromRelation()},
                                    {QStringLiteral("is_split"), mapObject->id.isIdFromSplit()},
                                    {QStringLiteral("is_area"), mapObject->isArea},
                                    {QStringLiteral("is_closed_figure"), mapObject->isClosedFigure()},
                                    {QStringLiteral("outer_point_count"), mapObject->points31.size()},
                                    {QStringLiteral("inner_ring_count"), mapObject->innerPolygonsPoints31.size()},
                                    {QStringLiteral("inner_ring_point_counts"), innerRingPointCounts},
                                    {QStringLiteral("bbox"), QJsonArray{
                                        mapObject->bbox31.left(), mapObject->bbox31.top(),
                                        mapObject->bbox31.right(), mapObject->bbox31.bottom()}},
                                    {QStringLiteral("name"), mapObject->getName(locale, false).trimmed()}
                                });
                            }
                            continue;
                        }
                        ++boundaryLineCounts[level];
                        boundaryGeometryPointCount += mapObject->points31.size();
                        const auto first = mapObject->points31.first();
                        const auto last = mapObject->points31.last();
                        const auto firstKey = QStringLiteral("%1,%2").arg(first.x).arg(first.y);
                        const auto lastKey = QStringLiteral("%1,%2").arg(last.x).arg(last.y);
                        ++boundaryEndpointDegrees[level][firstKey];
                        ++boundaryEndpointDegrees[level][lastKey];
                        if (targetBoundaryRelationKeys.contains(relationObjectKey)
                            && targetBoundaryLineSegments.size() < 100)
                        {
                            const auto firstPoint = mapObject->points31.first();
                            const auto lastPoint = mapObject->points31.last();
                            targetBoundaryLineSegments.push_back(QJsonObject{
                                {QStringLiteral("admin_level"), level},
                                {QStringLiteral("min_zoom"), mapLevel->minZoom},
                                {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                    ? QString::number(mapObject->id.getOsmId()) : QString()},
                                {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                                {QStringLiteral("is_area"), mapObject->isArea},
                                {QStringLiteral("point_count"), mapObject->points31.size()},
                                {QStringLiteral("first"), QStringLiteral("%1,%2").arg(firstPoint.x).arg(firstPoint.y)},
                                {QStringLiteral("last"), QStringLiteral("%1,%2").arg(lastPoint.x).arg(lastPoint.y)},
                                {QStringLiteral("bbox"), QStringLiteral("%1,%2,%3,%4")
                                    .arg(mapObject->bbox31.left()).arg(mapObject->bbox31.top())
                                    .arg(mapObject->bbox31.right()).arg(mapObject->bbox31.bottom())},
                                {QStringLiteral("name"), mapObject->getName(locale, false).trimmed()}
                            });
                        }
                        ++boundaryRelationLineCounts[relationObjectKey];
                        ++boundaryRelationEndpointDegrees[relationObjectKey][firstKey];
                        ++boundaryRelationEndpointDegrees[relationObjectKey][lastKey];
                        boundaryRelationOsmIds.insert(relationObjectKey,
                            mapObject->id.isOsmId()
                                ? QString::number(mapObject->id.getOsmId())
                                : QString());
                        boundaryRelationLevels.insert(relationObjectKey, level);
                        boundaryRelationIsRelations.insert(relationObjectKey, mapObject->id.isIdFromRelation());
                        boundaryRelationHasSplitIds.insert(relationObjectKey, mapObject->id.isIdFromSplit());
                        const auto lineName = mapObject->getName(locale, false).trimmed();
                        if (!lineName.isEmpty() && !boundaryRelationNames.contains(relationObjectKey))
                            boundaryRelationNames.insert(relationObjectKey, lineName);

                        if (boundaryLineSamples.size() < 40)
                        {
                            const auto name = lineName;
                            boundaryLineSamples.push_back(QJsonObject{
                                {QStringLiteral("id"), QString::number(mapObject->id.id)},
                                {QStringLiteral("osm_id"), QString::number(mapObject->id.getOsmId())},
                                {QStringLiteral("admin_level"), level},
                                {QStringLiteral("is_area"), mapObject->isArea},
                                {QStringLiteral("point_count"), mapObject->points31.size()},
                                {QStringLiteral("first"), firstKey},
                                {QStringLiteral("last"), lastKey},
                                {QStringLiteral("name"), name}
                            });
                        }
                    }
                }
            }
        }
    }

    QJsonArray boundaryConnectivity;
    for (auto it = boundaryLineCounts.constBegin(); it != boundaryLineCounts.constEnd(); ++it)
    {
        const auto degrees = boundaryEndpointDegrees.value(it.key());
        int danglingEndpoints = 0;
        int joinedEndpoints = 0;
        int highDegreeEndpoints = 0;
        for (auto degreeIt = degrees.constBegin(); degreeIt != degrees.constEnd(); ++degreeIt)
        {
            if (degreeIt.value() == 1)
                ++danglingEndpoints;
            else if (degreeIt.value() == 2)
                ++joinedEndpoints;
            else
                ++highDegreeEndpoints;
        }
        boundaryConnectivity.push_back(QJsonObject{
            {QStringLiteral("admin_level"), it.key()},
            {QStringLiteral("line_segments"), it.value()},
            {QStringLiteral("unique_endpoints"), degrees.size()},
            {QStringLiteral("dangling_endpoints"), danglingEndpoints},
            {QStringLiteral("degree_two_endpoints"), joinedEndpoints},
            {QStringLiteral("branch_or_duplicate_endpoints"), highDegreeEndpoints}
        });
    }

    QList<QJsonObject> relationGroupObjects;
    for (auto it = boundaryRelationLineCounts.constBegin(); it != boundaryRelationLineCounts.constEnd(); ++it)
    {
        const auto degrees = boundaryRelationEndpointDegrees.value(it.key());
        int danglingEndpoints = 0;
        int joinedEndpoints = 0;
        int highDegreeEndpoints = 0;        for (auto degreeIt = degrees.constBegin(); degreeIt != degrees.constEnd(); ++degreeIt)        {
            if (degreeIt.value() == 1)
                ++danglingEndpoints;
            else if (degreeIt.value() == 2)
                ++joinedEndpoints;
            else
                ++highDegreeEndpoints;
        }
        relationGroupObjects.push_back(QJsonObject{
            {QStringLiteral("admin_level"), boundaryRelationLevels.value(it.key())},
            {QStringLiteral("osm_id"), boundaryRelationOsmIds.value(it.key())},
            {QStringLiteral("is_relation"), boundaryRelationIsRelations.value(it.key())},
            {QStringLiteral("has_split_ids"), boundaryRelationHasSplitIds.value(it.key())},
            {QStringLiteral("name"), boundaryRelationNames.value(it.key())},
            {QStringLiteral("line_segments"), it.value()},
            {QStringLiteral("unique_endpoints"), degrees.size()},
            {QStringLiteral("dangling_endpoints"), danglingEndpoints},
            {QStringLiteral("degree_two_endpoints"), joinedEndpoints},
            {QStringLiteral("branch_or_duplicate_endpoints"), highDegreeEndpoints}
        });
    }
    std::sort(relationGroupObjects.begin(), relationGroupObjects.end(),
        [](const QJsonObject& left, const QJsonObject& right)
        {
            const int leftCount = left.value(QStringLiteral("line_segments")).toInt();
            const int rightCount = right.value(QStringLiteral("line_segments")).toInt();
            if (leftCount != rightCount)
                return leftCount > rightCount;
            if (left.value(QStringLiteral("admin_level")).toInt()
                != right.value(QStringLiteral("admin_level")).toInt())
                return left.value(QStringLiteral("admin_level")).toInt()
                    < right.value(QStringLiteral("admin_level")).toInt();
            return left.value(QStringLiteral("osm_id")).toString()
                < right.value(QStringLiteral("osm_id")).toString();
        });
    QJsonArray boundaryRelationGroups;
    QJsonArray targetBoundaryRelationGroups;
    for (const auto& relationGroup : relationGroupObjects)
    {
        const auto relationKey = QStringLiteral("%1|relation:%2")
            .arg(relationGroup.value(QStringLiteral("admin_level")).toInt())
            .arg(relationGroup.value(QStringLiteral("osm_id")).toString());
        if (targetBoundaryRelationKeys.contains(relationKey))
            targetBoundaryRelationGroups.push_back(relationGroup);
    }
    for (int index = 0; index < std::min(40, static_cast<int>(relationGroupObjects.size())); ++index)
        boundaryRelationGroups.push_back(relationGroupObjects.at(index));

    std::sort(candidates.begin(), candidates.end(),
        [](const AdministrativeAreaCandidate& left, const AdministrativeAreaCandidate& right)
        {
            if (left.adminLevel != right.adminLevel)
                return left.adminLevel < right.adminLevel;
            if (left.bboxArea != right.bboxArea)
                return left.bboxArea < right.bboxArea;
            return QString::compare(left.name, right.name, Qt::CaseInsensitive) < 0;
        });

    // For classified map polygons, keep only the smallest exact match at
    // each administrative level. Address-index-only candidates (level 99)
    // have no reliable hierarchy level; retain all distinct names so the
    // caller can choose the appropriate district/region from the OBF index.
    QSet<int> emittedAdminLevels;
    for (const auto& candidate : candidates)
    {
        if (candidate.adminLevel != 99)
        {
            if (emittedAdminLevels.contains(candidate.adminLevel))
                continue;
            emittedAdminLevels.insert(candidate.adminLevel);
        }
        areas.push_back(QJsonObject{
            {QStringLiteral("admin_level"), candidate.adminLevel},
            {QStringLiteral("name"), candidate.name}
        });
    }
    result.insert(QStringLiteral("administrative_areas"), areas);
    result.insert(QStringLiteral("diagnostics"), QJsonObject{
        {QStringLiteral("loaded_map_objects"), loadedMapObjectCount},
        {QStringLiteral("administrative_boundary_objects"), administrativeBoundaryObjectCount},
        {QStringLiteral("loaded_address_boundary_groups"), loadedAddressBoundaryGroupCount},
        {QStringLiteral("loaded_address_street_groups"), loadedAddressStreetGroupCount},
        {QStringLiteral("address_street_group_subtype_counts"), addressStreetGroupSubtypeCounts},
        {QStringLiteral("map_boundary_street_group_matches"), mapBoundaryStreetGroupMatches},
        {QStringLiteral("name_index_diagnostics_enabled"), nameIndexDiagnosticsEnabled},
        {QStringLiteral("name_index_boundary_query_results"), nameIndexBoundaryQueryResults},
        {QStringLiteral("poi_name_index_query_results"), poiNameIndexQueryResults},
        {QStringLiteral("map_place_object_diagnostics"), mapPlaceObjectDiagnostics},
        {QStringLiteral("nearby_map_object_count"), nearbyMapObjectCount},
        {QStringLiteral("nearby_named_place_object_count"), nearbyNamedPlaceObjectCount},
        {QStringLiteral("nearby_named_administrative_boundary_object_count"), nearbyNamedAdministrativeBoundaryObjectCount},
        {QStringLiteral("administrative_probe_radius_m_approx"), 5000},
        {QStringLiteral("administrative_probe_map_object_count"), administrativeProbeMapObjectCount},
        {QStringLiteral("administrative_probe_named_boundary_count"), administrativeProbeNamedBoundaryCount},
        {QStringLiteral("administrative_probe_boundaries"), administrativeProbeBoundaries},
        {QStringLiteral("address_boundary_blocks"), addressBoundaryBlockCount},
        {QStringLiteral("address_block_type_counts"), addressBlockTypeCounts},
        {QStringLiteral("matching_address_boundary_groups"), matchingAddressBoundaryGroupCount},
        {QStringLiteral("matched_address_boundary_object_ids"), matchedAddressBoundaryObjectIdCount},
        {QStringLiteral("map_boundary_object_ids"), mapBoundaryObjectIds},
        {QStringLiteral("address_boundary_object_ids"), addressBoundaryObjectIds},
        {QStringLiteral("address_boundary_candidate_details"), addressBoundaryCandidateDetails},
        {QStringLiteral("address_boundary_bbox_map_searches"), addressBoundaryBboxMapSearches},
        {QStringLiteral("address_boundary_bbox_map_search_loaded_objects"), addressBoundaryBboxMapSearchObjectCount},
        {QStringLiteral("address_boundary_bbox_map_search_skipped_count"), addressBoundaryBboxMapSearchSkippedCount},
        {QStringLiteral("matched_boundary_object_ids"), matchedBoundaryObjectIds},
        {QStringLiteral("resolved_administrative_areas"), areas.size()},
        {QStringLiteral("boundary_search_area_available"), hasBoundarySearchArea},
        {QStringLiteral("boundary_line_diagnostics_enabled"), boundaryLineDiagnosticsEnabled},
        {QStringLiteral("boundary_line_counts"), boundaryConnectivity},
        {QStringLiteral("boundary_line_relation_groups"), boundaryRelationGroups},
        {QStringLiteral("boundary_line_relation_group_count"), relationGroupObjects.size()},
        {QStringLiteral("target_boundary_line_relation_groups"), targetBoundaryRelationGroups},
        {QStringLiteral("target_boundary_line_segments"), targetBoundaryLineSegments},
        {QStringLiteral("target_boundary_area_objects"), targetBoundaryAreaObjects},
        {QStringLiteral("target_boundary_line_relation_group_count"), targetBoundaryRelationGroups.size()},
        {QStringLiteral("boundary_geometry_points"), boundaryGeometryPointCount},
        {QStringLiteral("boundary_area_objects"), boundaryAreaObjectCount},
        {QStringLiteral("boundary_line_samples"), boundaryLineSamples}
    });
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
    candidate.displayName = bestDisplayName(query, names, preferredName);    candidate.secondaryText = secondaryTextFor(candidate.displayName, names, descriptor);

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

    QJsonArray roadLocatorDiagnostics;
    QJsonArray roadMapObjectDiagnostics;
    if (qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_ROAD_DIAGNOSTICS"))
    {
        const auto point31 = OsmAnd::Utilities::convertLatLonTo31(OsmAnd::LatLon(latitude, longitude));

        // Compare RoadLocator's routing geometry with map-index geometry for
        // the same OSM relation. This is diagnostic only and does not affect
        // the native reverse-geocoding result.
        constexpr int mapGeometrySearchRadius31 = 100000;
        OsmAnd::AreaI mapGeometryQueryArea;
        mapGeometryQueryArea.left() = point31.x - mapGeometrySearchRadius31;
        mapGeometryQueryArea.right() = point31.x + mapGeometrySearchRadius31;
        mapGeometryQueryArea.top() = point31.y - mapGeometrySearchRadius31;
        mapGeometryQueryArea.bottom() = point31.y + mapGeometrySearchRadius31;
        constexpr quint64 targetRoadOsmId = 957880;
        for (const auto& reader : _dataInterface->obfReaders)
        {
            if (!reader)
                continue;
            const auto info = reader->obtainInfo();
            if (!info)
                continue;
            for (const auto& mapSection : info->mapSections)
            {
                if (!mapSection)
                    continue;
                for (const auto& mapLevel : mapSection->levels)
                {
                    if (!mapLevel)
                        continue;
                    QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> mapObjects;
                    OsmAnd::ObfMapSectionReader::loadMapObjects(
                        reader, mapSection, nullptr, mapLevel->minZoom,
                        &mapGeometryQueryArea, &mapObjects);
                    for (const auto& mapObject : mapObjects)
                    {
                        if (!mapObject || !mapObject->id.isOsmId()
                            || mapObject->id.getOsmId() != targetRoadOsmId
                            || !mapObject->id.isIdFromRelation())
                            continue;
                        QJsonArray geometryPoints;
                        for (const auto& mapPoint : mapObject->points31)
                        {
                            if (mapPoint.x == 0 && mapPoint.y == 0)
                            {
                                geometryPoints.push_back(QJsonValue(QJsonValue::Null));
                                continue;
                            }
                            geometryPoints.push_back(QJsonArray{
                                OsmAnd::Utilities::get31LatitudeY(mapPoint.y),
                                OsmAnd::Utilities::get31LongitudeX(mapPoint.x)
                            });
                        }
                        const auto mapName = mapObject->getName(effectiveLocale, false).trimmed();
                        const auto mapCaption = mapName.isEmpty()
                            ? mapObject->getCaptionInNativeLanguage().trimmed()
                            : mapName;
                        roadMapObjectDiagnostics.push_back(QJsonObject{
                            {QStringLiteral("name"), mapCaption},
                            {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                            {QStringLiteral("is_split"), mapObject->id.isIdFromSplit()},
                            {QStringLiteral("is_area"), mapObject->isArea},
                            {QStringLiteral("min_zoom"), mapLevel->minZoom},
                            {QStringLiteral("geometry_point_count"), mapObject->points31.size()},
                            {QStringLiteral("geometry_points"), geometryPoints},
                            {QStringLiteral("geometry_bbox31"), QJsonArray{
                                mapObject->bbox31.left(), mapObject->bbox31.top(),
                                mapObject->bbox31.right(), mapObject->bbox31.bottom()}}
                        });
                    }
                }
            }
        }
        const auto roadFilter =
            [](const std::shared_ptr<const OsmAnd::Road>& road) -> bool
            {
                const bool isTransportStop =
                    road->containsAttribute(QStringLiteral("railway"), QStringLiteral("platform")) ||
                    road->containsAttribute(QStringLiteral("public_transport"), QStringLiteral("platform"));
                return !road->captions.isEmpty() && !isTransportStop;
            };

        auto nearestRoads = roadLocator->findNearestRoads(
            point31, 800.0, OsmAnd::RoutingDataLevel::Detailed, roadFilter);
        if (nearestRoads.isEmpty())
        {
            nearestRoads = roadLocator->findNearestRoads(
                point31, 4000.0, OsmAnd::RoutingDataLevel::Detailed, roadFilter);
        }

        // Keep every RoadLocator geometry segment in this diagnostic.
        // Multiple OBF road objects can share the same displayed name/ref;
        // de-duplicating by name here would hide precisely the split segments
        // that need to be inspected.
        for (const auto& candidate : nearestRoads)
        {
            const auto& road = candidate.first;
            const auto& roadInfo = candidate.second;
            if (!road || !roadInfo)
                continue;

            QString roadName = road->getCaptionInNativeLanguage();
            QString roadRef;
            if (roadName.isEmpty() && road->attributeMapping)
                roadRef = road->captions.value(road->attributeMapping->refAttributeId);
            if (roadName.isEmpty())
                roadName = roadRef;
            if (roadName.isEmpty())
                continue;

            const OsmAnd::LatLon roadPoint(
                OsmAnd::Utilities::get31LatitudeY(roadInfo->preciseY),
                OsmAnd::Utilities::get31LongitudeX(roadInfo->preciseX));
            const auto roadId = road->id;
            const auto& roadPoints = road->points31;
            const auto roadStart = roadPoints.isEmpty()
                ? OsmAnd::LatLon()
                : OsmAnd::LatLon(
                    OsmAnd::Utilities::get31LatitudeY(roadPoints.first().y),
                    OsmAnd::Utilities::get31LongitudeX(roadPoints.first().x));
            const auto roadEnd = roadPoints.isEmpty()
                ? OsmAnd::LatLon()
                : OsmAnd::LatLon(
                    OsmAnd::Utilities::get31LatitudeY(roadPoints.last().y),
                    OsmAnd::Utilities::get31LongitudeX(roadPoints.last().x));

            // RoadLocator's distSquare can point to a shared connection node.
            // Independently measure the query point against every actual
            // geometry segment so touching roads are not mistaken for equally
            // close roads merely because they share that endpoint.
            const double latitudeRadians = latitude * 3.14159265358979323846 / 180.0;
            const double metersPerDegreeLatitude = 111132.92;
            const double metersPerDegreeLongitude = 111412.84 * std::cos(latitudeRadians)
                - 93.5 * std::cos(3.0 * latitudeRadians);
            double nearestGeometryDistance = std::numeric_limits<double>::max();
            OsmAnd::LatLon nearestGeometryPoint;
            int nearestGeometrySegment = -1;
            const auto toLocalMeters = [&](const OsmAnd::LatLon& location) -> QPointF
            {
                return QPointF(
                    (location.longitude - longitude) * metersPerDegreeLongitude,
                    (location.latitude - latitude) * metersPerDegreeLatitude);
            };
            const QPointF queryLocal(0.0, 0.0);
            for (int pointIndex = 0; pointIndex < roadPoints.size(); ++pointIndex)
            {
                const auto& point31 = roadPoints.at(pointIndex);
                // A zero/zero coordinate separates split geometry parts.
                if (point31.x == 0 && point31.y == 0)
                    continue;
                const OsmAnd::LatLon currentPoint(
                    OsmAnd::Utilities::get31LatitudeY(point31.y),
                    OsmAnd::Utilities::get31LongitudeX(point31.x));
                const QPointF currentLocal = toLocalMeters(currentPoint);
                const double pointDistance = std::hypot(currentLocal.x(), currentLocal.y());
                if (pointDistance < nearestGeometryDistance)
                {
                    nearestGeometryDistance = pointDistance;
                    nearestGeometryPoint = currentPoint;
                    nearestGeometrySegment = pointIndex;
                }

                if (pointIndex == 0)
                    continue;
                const auto& previous31 = roadPoints.at(pointIndex - 1);
                if (previous31.x == 0 && previous31.y == 0)
                    continue;
                const OsmAnd::LatLon previousPoint(
                    OsmAnd::Utilities::get31LatitudeY(previous31.y),
                    OsmAnd::Utilities::get31LongitudeX(previous31.x));
                const QPointF previousLocal = toLocalMeters(previousPoint);
                const QPointF segment = currentLocal - previousLocal;
                const double segmentLengthSquared =
                    segment.x() * segment.x() + segment.y() * segment.y();
                if (segmentLengthSquared <= 0.0)
                    continue;
                const QPointF fromStart = queryLocal - previousLocal;
                const double projection = std::clamp(
                    (fromStart.x() * segment.x() + fromStart.y() * segment.y())
                        / segmentLengthSquared,
                    0.0, 1.0);
                const QPointF projected = previousLocal + segment * projection;
                const double distance = std::hypot(projected.x(), projected.y());
                if (distance < nearestGeometryDistance)
                {
                    nearestGeometryDistance = distance;
                    nearestGeometryPoint = OsmAnd::LatLon(
                        previousPoint.latitude + (currentPoint.latitude - previousPoint.latitude) * projection,
                        previousPoint.longitude + (currentPoint.longitude - previousPoint.longitude) * projection);
                    nearestGeometrySegment = pointIndex - 1;
                }
            }
            QJsonArray geometryPoints;
            for (const auto& geometryPoint31 : roadPoints)
            {
                if (geometryPoint31.x == 0 && geometryPoint31.y == 0)
                {
                    geometryPoints.push_back(QJsonValue(QJsonValue::Null));
                    continue;
                }
                geometryPoints.push_back(QJsonArray{
                    OsmAnd::Utilities::get31LatitudeY(geometryPoint31.y),
                    OsmAnd::Utilities::get31LongitudeX(geometryPoint31.x)
                });
            }
            roadLocatorDiagnostics.push_back(QJsonObject{
                {QStringLiteral("name"), roadName},
                {QStringLiteral("ref"), roadRef},
                {QStringLiteral("distance_m"), std::sqrt(roadInfo->distSquare)},
                {QStringLiteral("geometry_distance_m"), nearestGeometryDistance < std::numeric_limits<double>::max()
                    ? nearestGeometryDistance : -1.0},
                {QStringLiteral("geometry_nearest_point"), nearestGeometrySegment >= 0
                    ? QJsonArray{nearestGeometryPoint.latitude, nearestGeometryPoint.longitude} : QJsonArray{}},
                {QStringLiteral("geometry_nearest_segment_index"), nearestGeometrySegment},
                {QStringLiteral("connection_point"), QJsonArray{roadPoint.latitude, roadPoint.longitude}},
                {QStringLiteral("candidate_index"), roadLocatorDiagnostics.size()},
                {QStringLiteral("osm_id"), roadId.isOsmId()
                    ? QString::number(roadId.getOsmId()) : QString()},
                {QStringLiteral("raw_id"), QString::number(roadId.id)},
                {QStringLiteral("is_relation"), roadId.isIdFromRelation()},
                {QStringLiteral("is_split"), roadId.isIdFromSplit()},
                {QStringLiteral("geometry_point_count"), roadPoints.size()},
                {QStringLiteral("geometry_points"), geometryPoints},
                {QStringLiteral("geometry_bbox31"), QJsonArray{
                    road->bbox31.left(), road->bbox31.top(),
                    road->bbox31.right(), road->bbox31.bottom()}},
                {QStringLiteral("geometry_start"), roadPoints.isEmpty()
                    ? QJsonArray{} : QJsonArray{roadStart.latitude, roadStart.longitude}},
                {QStringLiteral("geometry_end"), roadPoints.isEmpty()
                    ? QJsonArray{} : QJsonArray{roadEnd.latitude, roadEnd.longitude}}
            });
            if (roadLocatorDiagnostics.size() >= 200)
                break;
        }
    }

    const auto result = reverseGeocoder.performSearch(criteria);
    std::fprintf(stderr, "[reverse-geocode] performSearch returned: %s\\n", result ? "result" : "no result");
    QJsonObject payload{
        {QStringLiteral("found"), static_cast<bool>(result)},
        {QStringLiteral("latitude"), latitude},
        {QStringLiteral("longitude"), longitude},
        {QStringLiteral("source"), QStringLiteral("OsmAnd")},
        {QStringLiteral("helper_version"), QStringLiteral("0.22")},
    };

    // Administrative areas are resolved independently from the address
    // reverse-geocoder result, so they remain available without a building.
    const auto administrativeData = administrativeAreasForCoordinate(
        _dataInterface, latitude, longitude, effectiveLocale);
    for (auto it = administrativeData.constBegin(); it != administrativeData.constEnd(); ++it)
        payload.insert(it.key(), it.value());

    // A coordinate can be inside a mapped administrative boundary even when
    // OsmAnd's address reverse-geocoder finds no building or street group.
    // Treat that as a successful reverse-geocoding result as well.
    const bool hasAdministrativeData =        !administrativeData.value(QStringLiteral("administrative_areas")).toArray().isEmpty()
        || !administrativeData.value(QStringLiteral("postcode")).toString().trimmed().isEmpty();
    payload.insert(QStringLiteral("found"), static_cast<bool>(result) || hasAdministrativeData);
    if (qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_ROAD_DIAGNOSTICS"))
    {
        payload.insert(QStringLiteral("road_locator_candidates"), roadLocatorDiagnostics);
        payload.insert(QStringLiteral("road_map_object_matches"), roadMapObjectDiagnostics);
    }

    if (result)
    {
        const bool resultDiagnosticsEnabled =
            qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_RESULT_DIAGNOSTICS");
        QList<std::shared_ptr<const OsmAnd::Building>> streetBuildings;
        if (result->street && _dataInterface
            && (!result->building || resultDiagnosticsEnabled))
        {
            QHash<std::shared_ptr<const OsmAnd::Street>,
                QList<std::shared_ptr<const OsmAnd::Building>>> buildingsByStreet;
            _dataInterface->loadBuildingsFromStreets(
                { result->street }, &buildingsByStreet, nullptr, nullptr, nullptr);
            streetBuildings = buildingsByStreet.value(result->street);
        }

        QString buildingName = result->building
            ? result->building->getName(effectiveLocale, false)
            : QString();
        QString buildingPostcode = result->building
            ? result->building->postcode.trimmed()
            : QString();
        QString buildingInterpolation = result->buildingInterpolation;

        // OsmAnd may prefer the nearest street segment over a nearby building.
        // Keep its native result and hierarchy, but enrich a street-only result
        // with the nearest named building on that same street when it is within
        // the same 100 m proximity limit used by OsmAnd's native building search.
        if (!result->building && result->street && !streetBuildings.isEmpty())
        {
            const OsmAnd::LatLon searchLocation(latitude, longitude);
            double nearestBuildingDistance = 100.0;
            QString nearestBuildingName;
            QString nearestBuildingPostcode;
            QString nearestBuildingInterpolation;
            bool ambiguousNearestBuilding = false;

            for (const auto& building : streetBuildings)
            {
                if (!building)
                    continue;

                const auto buildingLocation =
                    OsmAnd::Utilities::convert31ToLatLon(building->position31);
                double distance = 0.0;
                QString candidateName;

                if (building->interpolation != OsmAnd::Building::Interpolation::Disabled)
                {
                    const auto interpolationEnd =
                        OsmAnd::Utilities::convert31ToLatLon(building->interpolationPosition31);
                    const double coefficient = OsmAnd::Utilities::projectionCoeff31(
                        OsmAnd::Utilities::convertLatLonTo31(searchLocation),
                        building->position31,
                        building->interpolationPosition31);
                    const double projectedLatitude = buildingLocation.latitude
                        + (interpolationEnd.latitude - buildingLocation.latitude) * coefficient;
                    const double projectedLongitude = buildingLocation.longitude
                        + (interpolationEnd.longitude - buildingLocation.longitude) * coefficient;
                    distance = OsmAnd::Utilities::distance(
                        searchLocation, OsmAnd::LatLon(projectedLatitude, projectedLongitude));
                    candidateName = building->getInterpolationName(coefficient).trimmed();
                }
                else
                {
                    distance = OsmAnd::Utilities::distance(searchLocation, buildingLocation);
                    candidateName = building->getName(effectiveLocale, false).trimmed();
                }

                if (candidateName.isEmpty() || distance >= 100.0)
                    continue;

                if (nearestBuildingName.isEmpty()
                    || distance < nearestBuildingDistance - 1.0)
                {
                    nearestBuildingDistance = distance;
                    nearestBuildingName = candidateName;
                    nearestBuildingPostcode = building->postcode.trimmed();
                    nearestBuildingInterpolation =
                        building->interpolation != OsmAnd::Building::Interpolation::Disabled
                            ? candidateName : QString();
                    ambiguousNearestBuilding = false;
                }
                else if (std::abs(distance - nearestBuildingDistance) <= 1.0
                    && candidateName != nearestBuildingName)
                {
                    ambiguousNearestBuilding = true;
                }
            }

            // Do not invent a house number when two different numbers are
            // effectively equally close to the requested coordinate.
            if (!ambiguousNearestBuilding && !nearestBuildingName.isEmpty())
            {
                buildingName = nearestBuildingName;
                buildingPostcode = nearestBuildingPostcode;
                if (!nearestBuildingInterpolation.isEmpty())
                    buildingInterpolation = nearestBuildingInterpolation;
            }
        }

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
        if (!buildingPostcode.isEmpty()
            && payload.value(QStringLiteral("postcode")).toString().isEmpty())
            payload.insert(QStringLiteral("postcode"), buildingPostcode);
        payload.insert(QStringLiteral("distance_m"), result->getDistance());
        payload.insert(QStringLiteral("result_text"), result->toString());
        if (!buildingInterpolation.isEmpty())
            payload.insert(QStringLiteral("building_interpolation"), buildingInterpolation);

        // Optional diagnostics for the exact Address objects selected by the
        // native reverse geocoder. This exposes the source of the displayed
        // municipality/region names without changing geocoding behavior.
        if (resultDiagnosticsEnabled)
        {
            const auto serializeAddress = [&effectiveLocale](
                const std::shared_ptr<const OsmAnd::Address>& address) -> QJsonObject
            {
                if (!address)
                    return QJsonObject();

                QJsonObject localizedNames;
                for (auto it = address->localizedNames.constBegin();
                    it != address->localizedNames.constEnd(); ++it)
                    localizedNames.insert(it.key(), it.value());

                QJsonObject object{
                    {QStringLiteral("address_type"), OsmAnd::ADDRESS_TYPE_NAMES.value(address->addressType)},
                    {QStringLiteral("name"), address->getName(effectiveLocale, false)},
                    {QStringLiteral("native_name"), address->nativeName},
                    {QStringLiteral("localized_names"), localizedNames},
                    {QStringLiteral("osm_id"), address->id.isOsmId()
                        ? QString::number(address->id.getOsmId()) : QString()},
                    {QStringLiteral("raw_id"), QString::number(address->id.id)},
                    {QStringLiteral("is_relation"), address->id.isIdFromRelation()},
                    {QStringLiteral("position31"), QJsonArray{
                        address->position31.x, address->position31.y
                    }}
                };

                // Temporary runtime diagnostics for the Address::id decoding
                // discrepancy. Keep this limited to street groups to avoid
                // enlarging the nearest-building diagnostic array.
                if (address->addressType == OsmAnd::AddressType::StreetGroup)
                {
                    const auto rawId = static_cast<qulonglong>(address->id.id);
                    QJsonObject idDiagnostics{
                        {QStringLiteral("raw_id_unsigned"), QString::number(rawId)},
                        {QStringLiteral("raw_id_hex"),
                            QStringLiteral("0x") + QString::number(rawId, 16).toUpper()},
                        {QStringLiteral("is_osm_id"), address->id.isOsmId()},
                        {QStringLiteral("is_relation"), address->id.isIdFromRelation()},
                        {QStringLiteral("is_split"), address->id.isIdFromSplit()},
                        {QStringLiteral("is_shifted"), address->id.isShiftedID()},
                        {QStringLiteral("get_osm_id"),
                            QString::number(address->id.getOsmId())}
                    };
                    object.insert(QStringLiteral("id_diagnostics"), idDiagnostics);
                }

                return object;
            };

            QJsonObject addressDiagnostics{
                {QStringLiteral("result_text"), result->toString()},
                {QStringLiteral("building"), serializeAddress(result->building)},
                {QStringLiteral("street"), serializeAddress(result->street)},
                {QStringLiteral("street_group"), serializeAddress(result->streetGroup)},
                {QStringLiteral("street_group_type"), result->streetGroup
                    ? static_cast<int>(result->streetGroup->type) : -1}
            };

            if (result->streetGroup)
            {
                QJsonArray groupBbox;
                for (const auto coordinate : result->streetGroup->bbox31)
                    groupBbox.push_back(coordinate);
                addressDiagnostics.insert(QStringLiteral("street_group_bbox31"), groupBbox);
            }
                // Diagnostic only: query the map index at the resolved place
                // StreetGroup position. This is a tiny spatial lookup, not a
                // scan of administrative boundary line segments.
                if (_dataInterface && result->streetGroup->position31.x > 0
                    && result->streetGroup->position31.y > 0)
                {
                    const auto placePoint31 = result->streetGroup->position31;
                    OsmAnd::AreaI placeQueryArea;
                    placeQueryArea.left() = placePoint31.x - 2;
                    placeQueryArea.right() = placePoint31.x + 2;
                    placeQueryArea.top() = placePoint31.y - 2;
                    placeQueryArea.bottom() = placePoint31.y + 2;

                    QJsonArray placePositionMapObjects;
                    QSet<QString> seenPlaceMapObjects;
                    for (const auto& reader : _dataInterface->obfReaders)
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
                            for (const auto& mapLevel : mapSection->levels)
                            {
                                if (!mapLevel)
                                    continue;
                                QList<std::shared_ptr<const OsmAnd::BinaryMapObject>> mapObjects;
                                OsmAnd::ObfMapSectionReader::loadMapObjects(
                                    reader, mapSection, nullptr, mapLevel->minZoom,
                                    &placeQueryArea, &mapObjects);
                                for (const auto& mapObject : mapObjects)
                                {
                                    if (!mapObject)
                                        continue;
                                    const auto objectKey = administrativeObjectKey(mapObject->id);
                                    const auto uniqueKey = objectKey.isEmpty()
                                        ? QString::number(mapObject->id.id)
                                        : objectKey;
                                    if (seenPlaceMapObjects.contains(uniqueKey))
                                        continue;
                                    seenPlaceMapObjects.insert(uniqueKey);

                                    const auto attributes = mapObject->getResolvedAttributes();
                                    QJsonObject resolvedAttributes;
                                    for (auto attributeIt = attributes.constBegin();
                                        attributeIt != attributes.constEnd(); ++attributeIt)
                                        resolvedAttributes.insert(attributeIt.key(), attributeIt.value());

                                    QJsonObject captionsByLanguage;
                                    const auto allCaptions = mapObject->getCaptionsInAllLanguages();
                                    for (auto captionIt = allCaptions.constBegin();
                                        captionIt != allCaptions.constEnd(); ++captionIt)
                                        captionsByLanguage.insert(captionIt.key(), captionIt.value());

                                    QJsonArray rawCaptions;
                                    for (auto captionIt = mapObject->captions.constBegin();
                                        captionIt != mapObject->captions.constEnd(); ++captionIt)
                                    {
                                        const auto captionTag = mapObject->attributeMapping
                                            && mapObject->attributeMapping->decodeMap.size() > captionIt.key()
                                            ? mapObject->attributeMapping->decodeMap[captionIt.key()].tag
                                            : QString();
                                        rawCaptions.push_back(QJsonObject{
                                            {QStringLiteral("attribute_id"), static_cast<int>(captionIt.key())},
                                            {QStringLiteral("tag"), captionTag},
                                            {QStringLiteral("value"), captionIt.value()}
                                        });
                                    }

                                    bool hasNameCaption = false;
                                    if (mapObject->attributeMapping)
                                    {
                                        hasNameCaption = mapObject->captions.contains(
                                            mapObject->attributeMapping->nativeNameAttributeId);
                                        if (!hasNameCaption)
                                        {
                                            for (auto nameAttributeIt =
                                                mapObject->attributeMapping->localizedNameAttributeIds.constBegin();
                                                nameAttributeIt != mapObject->attributeMapping->localizedNameAttributeIds.constEnd();
                                                ++nameAttributeIt)
                                            {
                                                if (mapObject->captions.contains(nameAttributeIt.key()))
                                                {
                                                    hasNameCaption = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }

                                    const auto mapName = mapObject->getName(effectiveLocale, false).trimmed();
                                    const auto nativeName = mapObject->getCaptionInNativeLanguage().trimmed();
                                    placePositionMapObjects.push_back(QJsonObject{
                                        {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                            ? QString::number(mapObject->id.getOsmId()) : QString()},
                                        {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                                        {QStringLiteral("is_relation"), mapObject->id.isIdFromRelation()},
                                        {QStringLiteral("is_split"), mapObject->id.isIdFromSplit()},
                                        {QStringLiteral("is_area"), mapObject->isArea},
                                        {QStringLiteral("name"), mapName},
                                        {QStringLiteral("native_name"), nativeName},
                                        {QStringLiteral("boundary"), attributes.value(QStringLiteral("boundary"))},
                                        {QStringLiteral("admin_level"), attributes.value(QStringLiteral("admin_level"))},
                                        {QStringLiteral("place"), attributes.value(QStringLiteral("place"))},
                                        {QStringLiteral("type"), attributes.value(QStringLiteral("type"))},
                                        {QStringLiteral("resolved_attributes"), resolvedAttributes},
                                        {QStringLiteral("captions_by_language"), captionsByLanguage},
                                        {QStringLiteral("raw_captions"), rawCaptions},
                                        {QStringLiteral("has_name_caption"), hasNameCaption},
                                        {QStringLiteral("geometry_point_count"), mapObject->points31.size()},
                                        {QStringLiteral("bbox31"), QJsonArray{
                                            mapObject->bbox31.left(), mapObject->bbox31.top(),
                                            mapObject->bbox31.right(), mapObject->bbox31.bottom()}}
                                    });
                                    if (placePositionMapObjects.size() >= 100)
                                        break;
                                }
                                if (placePositionMapObjects.size() >= 100)
                                    break;
                            }
                            if (placePositionMapObjects.size() >= 100)
                                break;
                        }
                        if (placePositionMapObjects.size() >= 100)
                            break;
                    }
                    addressDiagnostics.insert(
                        QStringLiteral("street_group_position31"),
                        QJsonArray{placePoint31.x, placePoint31.y});
                    addressDiagnostics.insert(
                        QStringLiteral("street_group_position_map_objects"),
                        placePositionMapObjects);
                }

            if (result->street)
            {
                addressDiagnostics.insert(QStringLiteral("street_parent_group"),
                    serializeAddress(result->street->streetGroup));
                addressDiagnostics.insert(QStringLiteral("street_offset"),
                    static_cast<qint64>(result->street->offset));
                addressDiagnostics.insert(QStringLiteral("street_first_building_inner_offset"),
                    static_cast<qint64>(result->street->firstBuildingInnerOffset));

                // Reuse the same street-building records used by the normal
                // address enrichment above, so diagnostics reflect production data.
                if (_dataInterface && result->street)
                {
                    const auto& buildings = streetBuildings;
                    QVector<QPair<double, QJsonObject>> sortedBuildings;
                    int within50m = 0;
                    int within100m = 0;
                    const OsmAnd::LatLon searchLocation(latitude, longitude);
                    const bool hasNativeSearchPoint = result->searchPoint.isSet();
                    const bool hasNativeConnectionPoint = result->connectionPoint.isSet();
                    const OsmAnd::LatLon nativeSearchPoint = hasNativeSearchPoint
                        ? *result->searchPoint : searchLocation;
                    const OsmAnd::LatLon nativeConnectionPoint = hasNativeConnectionPoint
                        ? *result->connectionPoint : searchLocation;
                    int nativeSearchPointWithin100m = 0;
                    int nativeConnectionPointWithin100m = 0;
                    addressDiagnostics.insert(QStringLiteral("native_search_point"), QJsonArray{
                        nativeSearchPoint.latitude, nativeSearchPoint.longitude
                    });
                    addressDiagnostics.insert(QStringLiteral("native_connection_point"), QJsonArray{
                        nativeConnectionPoint.latitude, nativeConnectionPoint.longitude
                    });
                    addressDiagnostics.insert(QStringLiteral("has_native_search_point"), hasNativeSearchPoint);
                    addressDiagnostics.insert(QStringLiteral("has_native_connection_point"), hasNativeConnectionPoint);
                    for (const auto& building : buildings)
                    {
                        if (!building)
                            continue;
                        const auto buildingLocation =
                            OsmAnd::Utilities::convert31ToLatLon(building->position31);
                        const double distance = OsmAnd::Utilities::distance(
                            searchLocation, buildingLocation);
                        const double nativeSearchDistance = OsmAnd::Utilities::distance(
                            nativeSearchPoint, buildingLocation);
                        const double nativeConnectionDistance = OsmAnd::Utilities::distance(
                            nativeConnectionPoint, buildingLocation);
                        if (distance <= 50.0)
                            ++within50m;
                        if (distance <= 100.0)
                            ++within100m;
                        if (nativeSearchDistance < 100.0)
                            ++nativeSearchPointWithin100m;
                        if (nativeConnectionDistance < 100.0)
                            ++nativeConnectionPointWithin100m;

                        QJsonObject buildingObject = serializeAddress(building);
                        buildingObject.insert(QStringLiteral("postcode"), building->postcode);
                        buildingObject.insert(QStringLiteral("distance_m"), distance);
                        buildingObject.insert(QStringLiteral("native_search_distance_m"), nativeSearchDistance);
                        buildingObject.insert(QStringLiteral("native_connection_distance_m"), nativeConnectionDistance);
                        buildingObject.insert(QStringLiteral("interpolation"),
                            static_cast<int>(building->interpolation));
                        buildingObject.insert(QStringLiteral("interpolation_interval"),
                            building->interpolationInterval);
                        buildingObject.insert(QStringLiteral("interpolation_native_name"),
                            building->interpolationNativeName);
                        buildingObject.insert(QStringLiteral("interpolation_position31"),
                            QJsonArray{
                                building->interpolationPosition31.x,
                                building->interpolationPosition31.y
                            });
                        sortedBuildings.append(qMakePair(distance, buildingObject));
                    }
                    std::sort(sortedBuildings.begin(), sortedBuildings.end(),
                        [](const auto& left, const auto& right)
                        {
                            return left.first < right.first;
                        });

                    QJsonArray nearestBuildings;
                    const int diagnosticLimit = static_cast<int>(std::min<qsizetype>(100, sortedBuildings.size()));
                    for (int index = 0; index < diagnosticLimit; ++index)
                        nearestBuildings.push_back(sortedBuildings.at(index).second);

                    addressDiagnostics.insert(QStringLiteral("loaded_building_count"),
                        buildings.size());
                    addressDiagnostics.insert(QStringLiteral("buildings_within_50m"), within50m);
                    addressDiagnostics.insert(QStringLiteral("buildings_within_100m"), within100m);
                    addressDiagnostics.insert(QStringLiteral("buildings_within_100m_of_native_search_point"),
                        nativeSearchPointWithin100m);
                    addressDiagnostics.insert(QStringLiteral("buildings_within_100m_of_native_connection_point"),
                        nativeConnectionPointWithin100m);
                    addressDiagnostics.insert(QStringLiteral("nearest_buildings"), nearestBuildings);
                }
            }
            if (result->building)
            {
                addressDiagnostics.insert(QStringLiteral("building_postcode"), result->building->postcode);
                addressDiagnostics.insert(QStringLiteral("building_parent_group"),
                    serializeAddress(result->building->streetGroup));
            }
            payload.insert(QStringLiteral("address_diagnostics"), addressDiagnostics);
        }
    }

    return QString::fromUtf8(QJsonDocument(payload).toJson(QJsonDocument::Compact));
}