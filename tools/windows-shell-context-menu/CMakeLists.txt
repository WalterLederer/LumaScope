cmake_minimum_required(VERSION 3.24)
project(lumascope_windows_shell_context_menu LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The Windows Shell context-menu helper can only be built on Windows.")
endif()

if(NOT DEFINED LUMASCOPE_CONTEXT_MENU_OUTPUT_DIRECTORY)
  set(LUMASCOPE_CONTEXT_MENU_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/stage")
endif()
file(MAKE_DIRECTORY "${LUMASCOPE_CONTEXT_MENU_OUTPUT_DIRECTORY}")

add_executable(lumascope_windows_shell_context_menu WIN32 src/main.cpp)
target_compile_features(lumascope_windows_shell_context_menu PRIVATE cxx_std_17)
set_property(TARGET lumascope_windows_shell_context_menu PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
target_compile_definitions(lumascope_windows_shell_context_menu PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0A00 WINVER=0x0A00)
target_link_libraries(lumascope_windows_shell_context_menu PRIVATE ole32 shell32 user32)
set_target_properties(lumascope_windows_shell_context_menu PROPERTIES
  OUTPUT_NAME "lumascope_windows_shell_context_menu"
  RUNTIME_OUTPUT_DIRECTORY "${LUMASCOPE_CONTEXT_MENU_OUTPUT_DIRECTORY}"
)
foreach(config Debug Release RelWithDebInfo MinSizeRel)
  set_target_properties(lumascope_windows_shell_context_menu PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_${config} "${LUMASCOPE_CONTEXT_MENU_OUTPUT_DIRECTORY}"
  )
endforeach()
