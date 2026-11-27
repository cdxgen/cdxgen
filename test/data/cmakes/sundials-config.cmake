# Modelled on a configured SUNDIALSConfig.cmake: the template writes
# find_dependency() lines whose PATHS values are CMake variables, and several
# resolve to empty strings once configured.
include(CMakeFindDependencyMacro)

find_dependency(Kokkos 4.1 PATHS "${CMAKE_PREFIX_PATH}" NO_DEFAULT_PATH)
find_dependency(KokkosKernels 4.1 PATHS "kk_dir" NO_DEFAULT_PATH)
find_dependency(Caliper PATHS "")
find_dependency(Adiak PATHS '')
find_dependency(MPI COMPONENTS CXX)
find_dependency(PkgConfig QUIET)
find_dependency(SuiteSparse PATHS "some/dir")
