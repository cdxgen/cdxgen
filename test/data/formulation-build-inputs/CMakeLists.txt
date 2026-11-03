cmake_minimum_required(VERSION 3.16)
project(demo LANGUAGES C CXX)

add_executable(demo main.c util.c)
add_library(util STATIC util.c)

target_link_libraries(demo PRIVATE util)
