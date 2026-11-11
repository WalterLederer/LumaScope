#include "osmand_core_runtime.h"

#include "file_system_core_resources_provider.h"

#include <mutex>

#include <QDir>
#include <QFile>

#include <OsmAndCore.h>

namespace
{
struct CoreRuntimeState
{
    std::mutex mutex;
    int refCount = 0;
    QString resourcesRoot;
    std::shared_ptr<const FileSystemCoreResourcesProvider> provider;
};

CoreRuntimeState& runtimeState()
{
    static CoreRuntimeState state;
    return state;
}
}

OsmAndCoreRuntime& OsmAndCoreRuntime::instance()
{
    static OsmAndCoreRuntime runtime;
    return runtime;
}

bool OsmAndCoreRuntime::acquire(const QString& resourcesRoot, QString& errorMessage)
{
    auto& state = runtimeState();
    std::lock_guard<std::mutex> lock(state.mutex);

    if (state.refCount > 0)
    {
        if (state.resourcesRoot != resourcesRoot)
        {
            errorMessage = QStringLiteral("OsmAnd core is already initialized with a different resources root");
            return false;
        }
        ++state.refCount;
        return true;
    }

    const auto provider = std::make_shared<FileSystemCoreResourcesProvider>(resourcesRoot);
    if (!provider->containsResource(QStringLiteral("map/styles/default.render.xml")))
    {
        errorMessage = QStringLiteral("default.render.xml was not found in the mapped OsmAnd resources");
        return false;
    }

    const auto fontsRoot = QDir(resourcesRoot).filePath(QStringLiteral("rendering_styles/fonts"));
    const auto fontsRootUtf8 = QFile::encodeName(QDir::toNativeSeparators(fontsRoot));
    const auto bitness = OsmAnd::InitializeCore(provider, fontsRootUtf8.constData());
    if (bitness == 0)
    {
        errorMessage = QStringLiteral("OsmAnd::InitializeCore failed");
        return false;
    }

    state.provider = provider;
    state.resourcesRoot = resourcesRoot;
    state.refCount = 1;
    return true;
}

void OsmAndCoreRuntime::release()
{
    auto& state = runtimeState();
    std::lock_guard<std::mutex> lock(state.mutex);

    if (state.refCount <= 0)
        return;

    --state.refCount;
    if (state.refCount == 0)
    {
        state.provider.reset();
        state.resourcesRoot.clear();
        OsmAnd::ReleaseCore();
    }
}
