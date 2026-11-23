#include "osmand_search_service.h"

#include "osmand_core_runtime.h"

#include <algorithm>
#include <cstdio>
#include <limits>
#include <utility>
#include <vector>

#include <QFileInfo>
#include <QHash>
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

    // The address index stores boundary groups with their OSM object IDs
    // and bounding boxes, but no admin_level. Resolve the level through the
    // map object with the same OSM ID. This also recovers boundaries whose
    // generalized polygon does not quite contain the coordinate.
    QList<std::shared_ptr<const OsmAnd::StreetGroup>> addressBoundaryGroups;
    dataInterface->loadStreetGroups(
        &addressBoundaryGroups,
        nullptr,
        OsmAnd::ObfAddressStreetGroupTypesMask().set(OsmAnd::ObfAddressStreetGroupType::Boundary));
    loadedAddressBoundaryGroupCount = addressBoundaryGroups.size();

    for (const auto& streetGroup : addressBoundaryGroups)
    {
        if (!streetGroup || streetGroup->type != OsmAnd::ObfAddressStreetGroupSubtype::Boundary
            || streetGroup->bbox31.size() < 4 || !streetGroup->id.isOsmId())
            continue;

        const auto left = streetGroup->bbox31[0];
        const auto top = streetGroup->bbox31[1];
        const auto right = streetGroup->bbox31[2];
        const auto bottom = streetGroup->bbox31[3];
        if (point31.x < left || point31.x > right || point31.y < top || point31.y > bottom)
            continue;

        ++matchingAddressBoundaryGroupCount;
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
        if (addressObjectKey.isEmpty())
            continue;
        const auto levelIt = administrativeLevelsByObjectId.constFind(addressObjectKey);
        if (levelIt == administrativeLevelsByObjectId.cend())
            continue;
        ++matchedAddressBoundaryObjectIdCount;
        if (matchedBoundaryObjectIds.size() < 20)
            matchedBoundaryObjectIds.push_back(QString::number(streetGroup->id.id));

        const auto localizedName = streetGroup->getName(locale, false).trimmed();
        const auto objectName = localizedName.isEmpty()
            ? streetGroup->nativeName.trimmed()
            : localizedName;
        if (objectName.isEmpty())
            continue;

        const auto normalizedName = OsmAnd::CollatorStringMatcher::lowercaseAndAlignChars(objectName).trimmed();
        const auto objectKey = QStringLiteral("%1|%2").arg(levelIt.value()).arg(normalizedName);
        if (seenAreas.contains(objectKey))
            continue;

        seenAreas.insert(objectKey);
        const auto width = static_cast<qint64>(right) - left;
        const auto height = static_cast<qint64>(bottom) - top;
        candidates.push_back({
            levelIt.value(),
            objectName,
            std::max<qint64>(0, width) * std::max<qint64>(0, height)
        });
    }

    // Diagnostic reconstruction probe: load map geometry across the union of
    // address-index boundary bounding boxes that contain the requested point.
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
    int boundaryAreaObjectCount = 0;
    int boundaryGeometryPointCount = 0;
    // This broad scan is diagnostic-only and can be expensive on large OBF
    // files. Keep it opt-in so normal reverse geocoding does not repeatedly
    // traverse every map section and zoom level.
    const bool boundaryLineDiagnosticsEnabled =
        qEnvironmentVariableIsSet("LUMASCOPE_OSMAND_BOUNDARY_DIAGNOSTICS");
    if (hasBoundarySearchArea && boundaryLineDiagnosticsEnabled)
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
                        if (mapObject->isArea)
                        {
                            ++boundaryAreaObjectCount;
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

                        // A multipolygon relation may be emitted as several
                        // split map objects. Aggregate endpoints only after
                        // normalizing each object ID back to its source OSM ID.
                        const auto normalizedObjectId = administrativeObjectKey(mapObject->id);
                        const auto relationObjectKey = QStringLiteral("%1|%2")
                            .arg(level)
                            .arg(normalizedObjectId.isEmpty()
                                ? QStringLiteral("obf:%1").arg(mapObject->id.id)
                                : normalizedObjectId);
                        if (targetBoundaryRelationKeys.contains(relationObjectKey)
                            && targetBoundaryLineSegments.size() < 100)
                        {
                            const auto firstPoint = mapObject->points31.first();
                            const auto lastPoint = mapObject->points31.last();
                            QJsonArray points31;
                            for (const auto& point31 : mapObject->points31)
                            {
                                points31.push_back(QJsonArray{
                                    point31.x,
                                    point31.y
                                });
                            }
                            targetBoundaryLineSegments.push_back(QJsonObject{
                                {QStringLiteral("admin_level"), level},
                                {QStringLiteral("min_zoom"), mapLevel->minZoom},
                                {QStringLiteral("osm_id"), mapObject->id.isOsmId()
                                    ? QString::number(mapObject->id.getOsmId()) : QString()},
                                {QStringLiteral("raw_id"), QString::number(mapObject->id.id)},
                                {QStringLiteral("is_area"), mapObject->isArea},
                                {QStringLiteral("point_count"), mapObject->points31.size()},
                                {QStringLiteral("points31"), points31},
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

    // One coordinate can belong to only one matching area at each
    // administrative level. Generalized OBF levels can return overlapping
    // alternatives; the smallest exact containing polygon is the local match.
    QSet<int> emittedAdminLevels;
    for (const auto& candidate : candidates)
    {
        if (emittedAdminLevels.contains(candidate.adminLevel))
            continue;
        emittedAdminLevels.insert(candidate.adminLevel);
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
        {QStringLiteral("matching_address_boundary_groups"), matchingAddressBoundaryGroupCount},
        {QStringLiteral("matched_address_boundary_object_ids"), matchedAddressBoundaryObjectIdCount},
        {QStringLiteral("map_boundary_object_ids"), mapBoundaryObjectIds},
        {QStringLiteral("address_boundary_object_ids"), addressBoundaryObjectIds},
        {QStringLiteral("matched_boundary_object_ids"), matchedBoundaryObjectIds},
        {QStringLiteral("resolved_administrative_areas"), areas.size()},
        {QStringLiteral("boundary_search_area_available"), hasBoundarySearchArea},
        {QStringLiteral("boundary_line_diagnostics_enabled"), boundaryLineDiagnosticsEnabled},
        {QStringLiteral("boundary_line_counts"), boundaryConnectivity},
        {QStringLiteral("boundary_line_relation_groups"), boundaryRelationGroups},
        {QStringLiteral("boundary_line_relation_group_count"), relationGroupObjects.size()},
        {QStringLiteral("target_boundary_line_relation_groups"), targetBoundaryRelationGroups},
        {QStringLiteral("target_boundary_line_segments"), targetBoundaryLineSegments},
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
        {QStringLiteral("helper_version"), QStringLiteral("0.7")},
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
    const bool hasAdministrativeData =
        !administrativeData.value(QStringLiteral("administrative_areas")).toArray().isEmpty()
        || !administrativeData.value(QStringLiteral("postcode")).toString().trimmed().isEmpty();
    payload.insert(QStringLiteral("found"), static_cast<bool>(result) || hasAdministrativeData);

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
