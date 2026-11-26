cmake_minimum_required(VERSION 3.24)
project(photo_db_update_helper LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "photo_db_update_helper currently supports Windows only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(unofficial-sqlite3 CONFIG REQUIRED)
find_package(Boost REQUIRED)

add_executable(photo_db_update_helper
  src/photo_db_update_helper.cpp
)

target_include_directories(photo_db_update_helper PRIVATE \${Boost_INCLUDE_DIRS})
target_link_libraries(photo_db_update_helper PRIVATE unofficial::sqlite3::sqlite3)
target_compile_definitions(photo_db_update_helper PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

if(MSVC)
  target_compile_options(photo_db_update_helper PRIVATE /W4 /permissive- /EHsc)
endif()
