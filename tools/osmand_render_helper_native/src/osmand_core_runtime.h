#pragma once

#include <OsmAndCore/QtExtensions.h>

#include <QString>

class OsmAndCoreRuntime
{
public:
    static OsmAndCoreRuntime& instance();

    bool acquire(const QString& resourcesRoot, QString& errorMessage);
    void release();

private:
    OsmAndCoreRuntime() = default;
    ~OsmAndCoreRuntime() = default;
    OsmAndCoreRuntime(const OsmAndCoreRuntime&) = delete;
    OsmAndCoreRuntime& operator=(const OsmAndCoreRuntime&) = delete;
};
