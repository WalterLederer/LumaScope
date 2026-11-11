#pragma once

#include <OsmAndCore/QtExtensions.h>

#include <memory>
#include <mutex>

#include <QString>

namespace OsmAnd
{
    class ObfDataInterface;
    class ObfsCollection;
    class SimpleQueryController;
}

class OsmAndSearchService
{
public:
    struct Configuration
    {
        QString obfPath;
        QString resourcesRoot;
    };

    explicit OsmAndSearchService(Configuration configuration);
    ~OsmAndSearchService();

    bool initialize(QString& errorMessage);
    void abort() const;
    QString search(
        const QString& query,
        int limit,
        const QString& locale,
        bool includePoiFallback,
        QString& errorMessage) const;

private:
    Configuration _configuration;
    QString _defaultLocale;
    bool _initialized = false;
    std::shared_ptr<OsmAnd::ObfsCollection> _obfsCollection;
    std::shared_ptr<OsmAnd::ObfDataInterface> _dataInterface;
    mutable std::mutex _queryMutex;
    mutable std::shared_ptr<OsmAnd::SimpleQueryController> _activeQueryController;
};
