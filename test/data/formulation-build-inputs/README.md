# Build-input formulation fixtures

Small real build files for the ecosystem formulation parsers in
`lib/inventory/ecosystemFormulationParsers.js`, exercised by
`lib/inventory/ecosystemFormulationParsers.poku.js`.

Every file is a working example of its format, trimmed to the parts the
parsers read:

| File | What it exercises |
| --- | --- |
| `Makefile` | target discovery (including a `.PHONY` special target that must be skipped), include directives (with absolute and parent-relative includes that must be dropped), variable names, a docker-flavoured target. |
| `CMakeLists.txt` | `cmake_minimum_required`, `project` name and languages, `add_executable` / `add_library` counts. |
| `go.mod` | module, go and toolchain directives, requirement and indirect counts from a `require` block and a single-line `require`, and `replace`, `exclude` and `retract` directives that must not be counted. |
| `requirements.txt` | pip requirement pins, comments, an option line and a `--hash` pin, and a lower bound that is a requirement but not an exact pin. |
| `constraints.txt` | a pip constraints file with plain pins. |
| `Demo.csproj` | SDK-style project: `Sdk`, `TargetFramework`, `OutputType`, `Version`, `PackageReference` count. |
| `project.assets.json` | the restore output shape `dotnet restore` writes (version, targets, libraries, project.restore, frameworks, projectFileDependencyGroups). Replace this file only with the output of a real `dotnet restore` when the schema evolves. |
