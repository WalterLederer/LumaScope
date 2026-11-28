# Inject the LumaScope-owned helper into the existing Valhalla build.
# Load immediately after project(valhalla), then defer target setup until the
# top-level Valhalla directory has defined its libraries.

if(NOT DEFINED LUMASCOPE_VALHALLA_HELPER_SOURCE OR
   NOT EXISTS "${LUMASCOPE_VALHALLA_HELPER_SOURCE}")
  message(FATAL_ERROR "LumaScope helper source not found: ${LUMASCOPE_VALHALLA_HELPER_SOURCE}")
endif()

function(lumascope_add_valhalla_helper)
  if(TARGET valhalla_route_helper)
    # Replace any legacy local source with the source tracked in LumaScope.
    set_property(TARGET valhalla_route_helper PROPERTY SOURCES
      "${LUMASCOPE_VALHALLA_HELPER_SOURCE}")
  else()
    add_executable(valhalla_route_helper "${LUMASCOPE_VALHALLA_HELPER_SOURCE}")
  endif()

  target_link_libraries(valhalla_route_helper PRIVATE valhalla)

  # Link the same SpatiaLite/SQLite build used to create Valhalla's admin.sqlite.
  if(VCPKG_TARGET_TRIPLET)
    set(_lumascope_vcpkg_triplet "${VCPKG_TARGET_TRIPLET}")
  else()
    set(_lumascope_vcpkg_triplet "x64-windows-release")
  endif()
  set(_lumascope_vcpkg_root "${CMAKE_BINARY_DIR}/vcpkg_installed/${_lumascope_vcpkg_triplet}")
  find_path(LUMASCOPE_SPATIALITE_INCLUDE_DIR spatialite.h
    HINTS "${_lumascope_vcpkg_root}/include" REQUIRED)
  find_library(LUMASCOPE_SPATIALITE_LIBRARY NAMES spatialite
    HINTS "${_lumascope_vcpkg_root}/lib" REQUIRED)
  find_library(LUMASCOPE_SQLITE_LIBRARY NAMES sqlite3
    HINTS "${_lumascope_vcpkg_root}/lib" REQUIRED)
  target_include_directories(valhalla_route_helper PRIVATE "${LUMASCOPE_SPATIALITE_INCLUDE_DIR}")
  target_link_libraries(valhalla_route_helper PRIVATE
    "${LUMASCOPE_SPATIALITE_LIBRARY}"
    "${LUMASCOPE_SQLITE_LIBRARY}")
  set_target_properties(valhalla_route_helper PROPERTIES
    OUTPUT_NAME "valhalla_route_helper"
    FOLDER "LumaScope")
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL lumascope_add_valhalla_helper)
