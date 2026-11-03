# Build-input formulation fixtures

Small real build files for the ecosystem formulation parsers in
`lib/inventory/ecosystemFormulationParsers.js`, exercised by
`lib/inventory/ecosystemFormulationParsers.poku.js`.

Every file is a working example of its format, trimmed to the parts the
parsers read:

| File | What it exercises |
| --- | --- |
| `Makefile` | target discovery (including a `.PHONY` special target that must be skipped), include directives, variable names, a docker-flavoured target. |
| `CMakeLists.txt` | `cmake_minimum_required`, `project` name and languages, `add_executable` / `add_library` counts. |
| `go.mod` | module, go and toolchain directives, requirement and indirect counts. |
| `requirements.txt` | pip requirement pins, comments, an option line and a `--hash` pin. |
| `constraints.txt` | a pip constraints file with plain pins. |
| `Demo.csproj` | SDK-style project: `Sdk`, `TargetFramework`, `OutputType`, `Version`, `PackageReference` count. |
| `project.assets.json` | the restore output shape `dotnet restore` writes (version, targets, libraries, project.restore, frameworks, projectFileDependencyGroups). Replace this file only with the output of a real `dotnet restore` when the schema evolves. |
