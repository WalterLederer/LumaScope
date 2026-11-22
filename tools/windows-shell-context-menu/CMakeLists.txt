cmake_minimum_required(VERSION 3.24)
project(lumascope_windows_shell_context_menu LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The Windows Shell context-menu helper can only be built on Windows.")
endif()

add_executable(lumascope_windows_shell_context_menu WIN32 src/main.cpp)
target_compile_features(lumascope_windows_shell_context_menu PRIVATE cxx_std_17)
target_compile_definitions(lumascope_windows_shell_context_menu PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(lumascope_windows_shell_context_menu PRIVATE ole32 shell32 user32)
set_target_properties(lumascope_windows_shell_context_menu PROPERTIES
  OUTPUT_NAME "lumascope_windows_shell_context_menu"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/stage"
)
foreach(config Debug Release RelWithDebInfo MinSizeRel)
  set_target_properties(lumascope_windows_shell_context_menu PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_CURRENT_SOURCE_DIR}/stage"
  )
endforeach()
