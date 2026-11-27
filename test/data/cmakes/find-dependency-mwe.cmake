cmake_minimum_required(VERSION 3.16)
project(KokkosKernelsDemo LANGUAGES CXX)

# A configured find_dependency() call whose quoted search path is empty.
find_dependency(KokkosKernels PATHS "")
