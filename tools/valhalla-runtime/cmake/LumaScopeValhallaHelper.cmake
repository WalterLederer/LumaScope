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
  set_target_properties(valhalla_route_helper PROPERTIES
    OUTPUT_NAME "valhalla_route_helper"
    FOLDER "LumaScope")
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL lumascope_add_valhalla_helper)
