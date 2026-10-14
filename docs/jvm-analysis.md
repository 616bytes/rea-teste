# JVM decompilation with Vineflower

- Decompile a local `.class`, `.jar`, or `.zip` into durable Java source files through the same CLI and MCP workflow.
- Use a caller-installed [Vineflower](https://github.com/Vineflower/vineflower) launcher and its Java runtime. Vineflower is Apache-2.0 licensed; this workflow has no evaluation-license method cap.
- REA never installs or upgrades Java or Vineflower, and never executes the supplied bytecode or derived sources.
- Derived Java is analysis evidence. It is not the original Java or Scala source, a verified build, or proof of equivalent runtime behavior.

## Configure the launcher

| Selection           | Value                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit executable | `REA_VINEFLOWER_COMMAND=/absolute/path/to/vineflower`                                                                                                 |
| PATH discovery      | An executable named `vineflower` on `PATH`                                                                                                            |
| Java runtime        | Configured by the caller's launcher; Vineflower 1.12 requires Java 17+ ([upstream runtime requirement](https://github.com/Vineflower/vineflower#use)) |

- `REA_VINEFLOWER_COMMAND` selects one absolute executable path, not a shell command or a JAR path.
- If using an upstream release JAR, create an executable launcher that forwards every argument. See [Vineflower usage](https://vineflower.org/usage/) for its native command line.

```sh
#!/bin/sh
exec "/absolute/path/to/jdk/bin/java" -jar "/absolute/path/to/vineflower.jar" "$@"
```

```sh
chmod +x /absolute/path/to/vineflower
export REA_VINEFLOWER_COMMAND=/absolute/path/to/vineflower
rea inspect-jvm-decompiler --json
```

## Public operations

| MCP tool                 | CLI command                                    | Result                                                                                              |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `inspect_jvm_decompiler` | `inspect-jvm-decompiler`                       | Resolved launcher, selection source, and observed version                                           |
| `decompile_jvm_artifact` | `decompile-jvm-artifact PATH OUTPUT_DIRECTORY` | Input and dependency identity, emitted Java sources, durable manifest, diagnostics, and limitations |

```sh
rea decompile-jvm-artifact /work/Example.class /work/example-sources --json
rea decompile-jvm-artifact /work/application.jar /work/application-sources \
  --classpath /work/lib/dependency.jar \
  --classpath /work/lib/another-dependency.jar \
  --class-prefix org/example/Feature --json
```

Equivalent MCP input:

```json
{
  "path": "/work/application.jar",
  "output_directory": "/work/application-sources",
  "classpath": ["/work/lib/dependency.jar", "/work/lib/another-dependency.jar"],
  "class_prefix": "org/example/Feature"
}
```

- Inputs and dependencies are absolute paths to regular local files.
- The output directory must be absolute and absent; its parent must already exist. Existing destinations are rejected without overwriting caller files.
- `classpath` supplies regular `.jar` or `.class` dependency files to Vineflower for type resolution. Dependencies are not selected for decompilation.
- `class_prefix` selects JVM member paths beginning with the supplied slash-separated prefix; omit it to process the whole input. Use `org/example/Feature`, not a dotted Java class name.
- If distinct emitted names collide on the destination filesystem, such as `Foo.java` and `foo.java`, publication fails and removes its owned partial output. Select a filesystem that can preserve those names.
- No active native target or disassembler session is required.
- `binary_session` checks executable presence without launching Vineflower. `inspect_jvm_decompiler` remains discoverable when it is missing; decompilation is marked unavailable with the selected-command diagnostic. Explicit inspection checks the actual version.

## Evidence and durable outputs

| Field                       | Meaning                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `client`                    | Executable, `environment` or `path` selection, and engine version                          |
| `target`, `dependencies`    | Caller-selected paths, byte counts, and SHA-256 digests                                    |
| `sources`                   | Every inventoried emitted Java file: absolute path, relative path, byte count, and SHA-256 |
| `manifest`                  | Durable JSON manifest path, byte count, and SHA-256                                        |
| `diagnostics`               | Provider stdout/stderr, exit code, and truncation status                                   |
| `source_inventory_complete` | Completeness of the emitted-source inventory, not input-class or method coverage           |
| `compilation_status`        | `not_attempted`                                                                            |
| `runtime_equivalence`       | `unknown`                                                                                  |

- Java files live under `OUTPUT_DIRECTORY/sources/`; `OUTPUT_DIRECTORY/manifest.json` contains the decompilation facts except its own digest descriptor. Both remain after the command or MCP session ends.
- MCP retains the complete Evidence in the session bundle; use `get_evidence_bundle` or `export_evidence_bundle` to preserve it separately.
- A successful process exit and source inventory do not establish that every input method was recovered. Keep provider diagnostics and limitations with the source.
- Scala bytecode can yield Java representations of compiler-generated structures. Original Scala syntax, types, implicit resolution, and build configuration are not recovered by this workflow.
- Recompilation and application behavior need their own requested, independently verified workflow.
- Resource limits remain explicit: launcher inspection has a 20-second deadline, decompilation a 10-minute deadline, diagnostics a 4 MiB retention budget, and metadata a budget derived from the Node heap. These are execution limits, not license limits.

## Verification

```sh
npm run test:focused -- tests/acceptance/jvmCli.test.ts
npm run verify:jvm
```

| Lane                     | Evidence                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic acceptance | Compiled CLI and actual stdio MCP preserve unavailable-provider diagnostics and refuse existing outputs without changing caller files; no installed Vineflower required                                                              |
| `verify:jvm`             | Real launcher inspection; authored Java compiled with `javac --release 17`; `.class`, JAR, two dependency JARs, and prefix selection through CLI and actual stdio MCP                                                                |
| Verifier assertions      | Advertised schemas and session availability; CLI/MCP source parity; case-distinct output preservation or refusal; input, source, and manifest hashes; unchanged inputs; output conflict; retained/exported Evidence; awaited cleanup |

- The real lane requires a full JDK (`JAVA_HOME` or `javac` and `jar` on `PATH`) plus the selected Vineflower launcher. Missing prerequisites fail with setup guidance.
- The fixture includes branches, a nested class, a lambda, and an unrelated class excluded by the prefix case. Neither fixture bytecode nor derived source is executed.
- Verified through CLI and actual stdio MCP on macOS arm64 with Vineflower 1.12.0 and fixture compiler `javac 26.0.2.1` targeting Java 17: one standalone source, three full-JAR sources, and two prefix-selected sources.
- On the tested case-insensitive filesystem, colliding source names were refused through both interfaces and no partial output remained. Sources from successful calls survived MCP session closure; all fixture inputs retained their original hashes.
- [UNVERIFIED] Linux and Windows hosts, publication to case-sensitive filesystems, Scala/Kotlin recovery, obfuscated bytecode, source recompilation, and runtime equivalence are not established by this run.
- See [testing](testing.md) for the distinction between public workflow evidence and simulated provider coverage.
