cmake_minimum_required(VERSION 3.24)
project(fgm_core LANGUAGES CXX)

find_package(nlohmann_json 3.12.0 EXACT CONFIG QUIET)
if(NOT nlohmann_json_FOUND)
  include(FetchContent)
  FetchContent_Declare(nlohmann_json
    URL https://codeload.github.com/nlohmann/json/tar.gz/refs/tags/v3.12.0
    URL_HASH SHA256=4b92eb0c06d10683f7447ce9406cb97cd4b453be18d7279320f7b2f025c10187
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  )
  FetchContent_MakeAvailable(nlohmann_json)
endif()

add_library(fgm_cpu src/evaluator.cpp)
add_library(fgm::cpu ALIAS fgm_cpu)
target_compile_features(fgm_cpu PUBLIC cxx_std_20)
target_include_directories(fgm_cpu PUBLIC include)
target_link_libraries(fgm_cpu PRIVATE nlohmann_json::nlohmann_json)
set_target_properties(fgm_cpu PROPERTIES CXX_EXTENSIONS OFF)

include(CTest)
if(BUILD_TESTING)
  add_executable(fgm_cpu_test tests/fgm-eval.test.cpp)
  target_link_libraries(fgm_cpu_test PRIVATE fgm::cpu nlohmann_json::nlohmann_json)
  add_test(NAME fgm_cpu COMMAND fgm_cpu_test "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/c04-panel.fgm.json")
  set_tests_properties(fgm_cpu PROPERTIES TIMEOUT 30)
endif()
