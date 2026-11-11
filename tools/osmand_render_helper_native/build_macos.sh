#!/bin/bash

# Build script for osmand_render_helper_native on macOS.
# Produces both the helper used by the Python tile backend and the native Qt
# widget dylib used by NativeOsmAndWidget. Building C++ code requires a Qt SDK
# with headers and CMake package files. When PySide6 is installed, its Qt
# runtime frameworks are preferred for the final Mach-O load paths so the
# Python process and native widget use the same Qt libraries.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VENDOR_ROOT="${REPO_ROOT}/vendor/osmand"
BUILD_ROOT="${SCRIPT_DIR}/build-macosx"
DIST_DIR="${SCRIPT_DIR}/dist-macosx"

BUILD_TYPE="${BUILD_TYPE:-Release}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
CMAKE_GENERATOR="${CMAKE_GENERATOR:-Unix Makefiles}"
MACOS_ARCH="${MACOS_ARCH:-$(uname -m)}"
MACOS_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET:-12.1}"
PYTHON_BIN="${PYTHON:-}"
PYSIDE6_QT=""
QT_RUNTIME_LIB_DIR="${QT_RUNTIME_LIB_DIR:-}"

detect_pyside6_runtime() {
    PYSIDE6_QT="$("${PYTHON_BIN}" -c 'import pathlib, sys
try:
    import PySide6
except ImportError:
    sys.exit(1)
print(pathlib.Path(PySide6.__file__).resolve().parent / "Qt")' 2>/dev/null || true)"

    if [ -n "${PYSIDE6_QT}" ] && [ -d "${PYSIDE6_QT}/lib" ]; then
        QT_RUNTIME_LIB_DIR="${QT_RUNTIME_LIB_DIR:-${PYSIDE6_QT}/lib}"
    fi
}

detect_python() {
    if [ -n "${PYTHON_BIN}" ] && command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
        return 0
    fi

    if [ -x "${REPO_ROOT}/.venv/bin/python" ]; then
        PYTHON_BIN="${REPO_ROOT}/.venv/bin/python"
        return 0
    fi

    for python_cmd in python3 python; do
        if command -v "${python_cmd}" >/dev/null 2>&1; then
            PYTHON_BIN="${python_cmd}"
            return 0
        fi
    done

    echo "ERROR: Python was not found. Activate a Python 3.12+ environment or set PYTHON=/path/to/python."
    exit 1
}

detect_qt() {
    detect_pyside6_runtime

    if [ -n "${QT_ROOT}" ]; then
        if [ -d "${QT_ROOT}/lib/cmake/Qt6" ] || [ -d "${QT_ROOT}/lib/QtCore.framework" ]; then
            echo "Using Qt from QT_ROOT: ${QT_ROOT}"
            return 0
        fi
        echo "WARNING: QT_ROOT is set but does not appear to be a valid Qt installation: ${QT_ROOT}"
    fi

    if [ -n "${PYSIDE6_QT}" ] && [ -d "${PYSIDE6_QT}/lib/cmake/Qt6" ]; then
        QT_ROOT="${PYSIDE6_QT}"
        QT_RUNTIME_LIB_DIR="${QT_RUNTIME_LIB_DIR:-${PYSIDE6_QT}/lib}"
        echo "Found Qt from PySide6: ${QT_ROOT}"
        return 0
    elif [ -n "${PYSIDE6_QT}" ] && [ -d "${PYSIDE6_QT}" ]; then
        echo "Found PySide6 runtime at ${PYSIDE6_QT}, but it does not include Qt CMake development files."
        QT_RUNTIME_LIB_DIR="${QT_RUNTIME_LIB_DIR:-${PYSIDE6_QT}/lib}"
    fi

    if command -v qmake6 >/dev/null 2>&1; then
        QT_ROOT="$(qmake6 -query QT_INSTALL_PREFIX)"
        echo "Found system Qt6: ${QT_ROOT}"
        return 0
    fi

    if command -v qmake >/dev/null 2>&1; then
        QT_VERSION="$(qmake --version | sed -n 's/.*Qt version \([0-9][0-9]*\).*/\1/p' | head -1)"
        if [ "${QT_VERSION}" = "6" ]; then
            QT_ROOT="$(qmake -query QT_INSTALL_PREFIX)"
            echo "Found system Qt6: ${QT_ROOT}"
            return 0
        fi
    fi

    for path in "$HOME"/Qt/6.*/macos /opt/homebrew/opt/qt /usr/local/opt/qt /usr/local/Qt-6; do
        if [ -d "${path}/lib/cmake/Qt6" ]; then
            QT_ROOT="${path}"
            echo "Found Qt at: ${QT_ROOT}"
            return 0
        fi
    done

    echo "ERROR: Could not find a Qt6 SDK with CMake development files."
    echo "Install Qt6, for example: brew install qt cmake"
    echo "Then set QT_ROOT if needed, for example: export QT_ROOT=/opt/homebrew/opt/qt"
    exit 1
}

fix_macos_runtime_paths() {
    if [ -z "${QT_RUNTIME_LIB_DIR}" ]; then
        QT_RUNTIME_LIB_DIR="${QT_ROOT}/lib"
    fi

    echo "Qt runtime library dir: ${QT_RUNTIME_LIB_DIR}"

    local binaries=()
    [ -f "${DIST_DIR}/osmand_render_helper" ] && binaries+=("${DIST_DIR}/osmand_render_helper")
    [ -f "${DIST_DIR}/osmand_native_widget.dylib" ] && binaries+=("${DIST_DIR}/osmand_native_widget.dylib")

    for binary in "${binaries[@]}"; do
        for rpath in "@loader_path" "@executable_path" "${QT_RUNTIME_LIB_DIR}" "${QT_ROOT}/lib"; do
            if ! otool -l "${binary}" | grep -F "path ${rpath} " >/dev/null 2>&1; then
                install_name_tool -add_rpath "${rpath}" "${binary}" 2>/dev/null || true
            fi
        done

        for framework in QtCore QtNetwork QtGui QtWidgets QtOpenGL QtOpenGLWidgets; do
            while IFS= read -r dependency; do
                [ -z "${dependency}" ] && continue
                install_name_tool \
                    -change "${dependency}" "@rpath/${framework}.framework/Versions/A/${framework}" \
                    "${binary}" 2>/dev/null || true
            done < <(otool -L "${binary}" | sed -n "s|^[[:space:]]*\\(/.*${framework}\\.framework/Versions/A/${framework}\\).*|\\1|p")
        done
    done
}

check_prerequisites() {
    echo "Checking prerequisites..."

    if ! command -v cmake >/dev/null 2>&1; then
        echo "ERROR: cmake not found. Install CMake, for example: brew install cmake"
        exit 1
    fi

    if ! command -v clang++ >/dev/null 2>&1; then
        echo "ERROR: clang++ not found. Install Xcode Command Line Tools: xcode-select --install"
        exit 1
    fi

    if [ ! -d "${VENDOR_ROOT}/core" ]; then
        echo "ERROR: OsmAnd vendor sources not found at ${VENDOR_ROOT}/core"
        exit 1
    fi

    if [ ! -d "${VENDOR_ROOT}/core-legacy" ]; then
        echo "ERROR: OsmAnd legacy vendor sources not found at ${VENDOR_ROOT}/core-legacy"
        exit 1
    fi

    echo "Prerequisites OK"
}

build() {
    echo "Building osmand_render_helper_native for macOS..."
    echo "Build type: ${BUILD_TYPE}"
    echo "Parallel jobs: ${JOBS}"
    echo "Architecture: ${MACOS_ARCH}"
    echo "macOS deployment target: ${MACOS_DEPLOYMENT_TARGET}"
    echo "Qt root: ${QT_ROOT}"
    echo "Vendor root: ${VENDOR_ROOT}"

    mkdir -p "${BUILD_ROOT}" "${DIST_DIR}"

    cmake \
        -S "${SCRIPT_DIR}" \
        -B "${BUILD_ROOT}" \
        -G "${CMAKE_GENERATOR}" \
        -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
        -DCMAKE_PREFIX_PATH="${QT_ROOT}" \
        -DQT_ROOT="${QT_ROOT}" \
        -DOSMAND_VENDOR_ROOT="${VENDOR_ROOT}" \
        -DDIST_DIR="${DIST_DIR}" \
        -DCMAKE_TARGET_OS=macosx \
        -DCMAKE_TARGET_CPU_ARCH="${MACOS_ARCH}" \
        -DCMAKE_OSX_ARCHITECTURES="${MACOS_ARCH}" \
        -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET}"

    cmake --build "${BUILD_ROOT}" --config "${BUILD_TYPE}" --parallel "${JOBS}"
    fix_macos_runtime_paths

    echo ""
    echo "Build complete!"
    echo "Output directory: ${DIST_DIR}"

    if [ -f "${DIST_DIR}/osmand_render_helper" ]; then
        echo "Helper binary: ${DIST_DIR}/osmand_render_helper"
    fi

    if [ -f "${DIST_DIR}/osmand_native_widget.dylib" ]; then
        echo "Native widget: ${DIST_DIR}/osmand_native_widget.dylib"
    fi
}

main() {
    detect_python
    detect_qt
    check_prerequisites
    build
}

main "$@"
