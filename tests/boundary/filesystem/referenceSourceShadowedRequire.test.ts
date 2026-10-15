import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("resolves require calls by lexical binding and source mode", async () => {
  const root = await createTestTempDirectory("rea-reference-require-scope-");
  const sources: Record<string, string> = {
    "parameter.cjs": [
      "function load(require) { return require('./throwing.cjs'); }",
      "console.log(load(() => 'local'));",
    ].join("\n"),
    "destructured.cjs": [
      "function load({ require }) { return require('./throwing.cjs'); }",
      "console.log(load({ require: () => 'local' }));",
    ].join("\n"),
    "hoisted.cjs": [
      "function load() {",
      "  console.log(require('./throwing.cjs'));",
      "  function require() { return 'local'; }",
      "}",
      "load();",
    ].join("\n"),
    "catch.cjs": [
      "try { throw () => 'local'; }",
      "catch (require) { console.log(require('./throwing.cjs')); }",
    ].join("\n"),
    "nested.cjs": [
      "console.log(require('./loaded.cjs'));",
      "function load(require) { return require('./throwing.cjs'); }",
      "console.log(load(() => 'local'));",
    ].join("\n"),
    "dynamic-with.cjs": [
      "with ({ require: () => 'local' }) {",
      "  console.log(require('./throwing.cjs'));",
      "}",
    ].join("\n"),
    "top-level-var.cjs": [
      "var require;",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "for-of-var.cjs": [
      "for (var require of [() => 'local']) {}",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "for-in-var.cjs": [
      "for (var require in ['local']) {}",
      "try { require('./throwing.cjs'); } catch { console.log('shadowed'); }",
    ].join("\n"),
    "with-write.cjs": [
      "with ({}) { require = () => 'local'; }",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "default-param-var.cjs": [
      "function patch(x = (() => { with ({}) { require = () => 'local'; } })()) { var require; }",
      "patch();",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "computed-key.cjs": [
      "const o = { [(() => { with ({}) { require = () => 'local'; } })()](require) {} };",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "default-fn-decl.cjs": [
      "function patch(x = (() => { with ({}) { require = () => 'local'; } })()) { function require() { return 'real'; } }",
      "patch();",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "initialized-var.cjs": [
      "var require = () => 'local';",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "assigned-var.cjs": [
      "require = () => 'local';",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "unbound-esm.mjs": [
      "try { require('./throwing.cjs'); }",
      "catch (error) {",
      "  if (!(error instanceof ReferenceError)) throw error;",
      "  console.log('no-global-require');",
      "}",
    ].join("\n"),
    "shadowed-esm.mjs": [
      "const require = () => 'local';",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "create-require-esm.mjs": [
      "import { createRequire as makeRequire } from 'node:module';",
      "const require = makeRequire(import.meta.url);",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "loaded.cjs": "console.log('loaded');\nmodule.exports = 'real';\n",
    "throwing.cjs": "throw new Error('A shadowed require must not load me');\n",
  };

  await Promise.all(
    Object.entries(sources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );

  const runNode = promisify(execFile);
  for (const [path, stdout] of [
    ["parameter.cjs", "local\n"],
    ["destructured.cjs", "local\n"],
    ["hoisted.cjs", "local\n"],
    ["catch.cjs", "local\n"],
    ["nested.cjs", "loaded\nreal\nlocal\n"],
    ["dynamic-with.cjs", "local\n"],
    ["top-level-var.cjs", "loaded\nreal\n"],
    ["for-of-var.cjs", "local\n"],
    ["for-in-var.cjs", "shadowed\n"],
    ["with-write.cjs", "local\n"],
    ["default-param-var.cjs", "local\n"],
    ["computed-key.cjs", "local\n"],
    ["default-fn-decl.cjs", "local\n"],
    ["initialized-var.cjs", "local\n"],
    ["assigned-var.cjs", "local\n"],
    ["unbound-esm.mjs", "no-global-require\n"],
    ["shadowed-esm.mjs", "local\n"],
    ["create-require-esm.mjs", "loaded\nreal\n"],
  ] as const) {
    const executed = await runNode(process.execPath, [join(root, path)], {
      cwd: root,
      timeout: 5_000,
    });
    expect(executed.stdout).toBe(stdout);
    expect(executed.stderr).toBe("");
  }

  const result = await importReferenceSource({
    root,
    caller: "reference-shadowed-require-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;

  expect(
    result.value.relationships
      .filter(({ kind }) => kind === "requires")
      .map(({ from_path, to }) => [from_path, to])
      .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
  ).toEqual([
    ["create-require-esm.mjs", "loaded.cjs"],
    ["nested.cjs", "loaded.cjs"],
    ["top-level-var.cjs", "loaded.cjs"],
  ]);
});

it("evaluates empty loop heads and polluted prototypes by semantics, not syntax", async () => {
  const root = await createTestTempDirectory("rea-reference-require-empty-");
  // for-in skips array holes (loader intact); for-of yields them (loader
  // gone). Prototype writes anywhere in the file disable the emptiness
  // exemption: polluted iteration replaces the loader either way.
  const sources: Record<string, string> = {
    "sparse-forin-holes.cjs": [
      "for (var require in [,]) {}",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "forof-hole.cjs": [
      "for (var require of [,]) {}",
      "try { require('./throwing.cjs'); } catch { console.log('shadowed'); }",
    ].join("\n"),
    "proto-forin-pollution.cjs": [
      "Object.prototype.loopKey = true;",
      "for (var require in {}) {}",
      "try { require('./throwing.cjs'); } catch { console.log('shadowed'); }",
    ].join("\n"),
    "proto-forof-pollution.cjs": [
      "Array.prototype[Symbol.iterator] = function* () { yield 1; };",
      "for (var require of []) {}",
      "try { require('./throwing.cjs'); } catch { console.log('shadowed'); }",
    ].join("\n"),
    "loaded.cjs": "console.log('loaded');\nmodule.exports = 'real';\n",
    "throwing.cjs": "throw new Error('A shadowed require must not load me');\n",
  };

  await Promise.all(
    Object.entries(sources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );

  const runNode = promisify(execFile);
  for (const [path, stdout] of [
    ["sparse-forin-holes.cjs", "loaded\nreal\n"],
    ["forof-hole.cjs", "shadowed\n"],
    ["proto-forin-pollution.cjs", "shadowed\n"],
    ["proto-forof-pollution.cjs", "shadowed\n"],
  ] as const) {
    const executed = await runNode(process.execPath, [join(root, path)], {
      cwd: root,
      timeout: 5_000,
    });
    expect(executed.stdout).toBe(stdout);
    expect(executed.stderr).toBe("");
  }

  const result = await importReferenceSource({
    root,
    caller: "reference-empty-iterable-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(
    result.value.relationships
      .filter(({ kind }) => kind === "requires")
      .map(({ from_path, to }) => [from_path, to])
      .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
  ).toEqual([["sparse-forin-holes.cjs", "loaded.cjs"]]);
});

it("keeps loader edges when a local binding shields a dynamic write", async () => {
  const root = await createTestTempDirectory("rea-reference-require-shield-");
  const sources: Record<string, string> = {
    "local-param.cjs": [
      "function patch(require) { with ({}) { require = () => 'local'; } }",
      "patch(null);",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "local-fn-var.cjs": [
      "function patch() {",
      "  var require;",
      "  with ({}) { require = () => 'local'; }",
      "}",
      "patch();",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "local-fn-var-init.cjs": [
      "function patch() {",
      "  var require = () => 'a';",
      "  with ({}) { require = () => 'local'; }",
      "}",
      "patch();",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "local-fn-let.cjs": [
      "function patch() {",
      "  let require;",
      "  with ({}) { require = () => 'local'; }",
      "}",
      "patch();",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "nested-fn-var.cjs": [
      "function patch() {",
      "  if (false) { var require; }",
      "  with ({}) { require = () => 'local'; }",
      "}",
      "patch();",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "switch-let.cjs": [
      "function patch() {",
      "  switch (0) { case 0: let require;",
      "    with ({}) { require = () => 'local'; } }",
      "}",
      "patch();",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "empty-loop-var.cjs": [
      "for (var require of []) {}",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "loaded.cjs": "console.log('loaded');\nmodule.exports = 'real';\n",
  };

  await Promise.all(
    Object.entries(sources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );

  const runNode = promisify(execFile);
  for (const path of Object.keys(sources)) {
    if (path === "loaded.cjs") continue;
    const executed = await runNode(process.execPath, [join(root, path)], {
      cwd: root,
      timeout: 5_000,
    });
    expect(executed.stdout).toBe("loaded\nreal\n");
    expect(executed.stderr).toBe("");
  }

  const result = await importReferenceSource({
    root,
    caller: "reference-shielded-require-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(
    result.value.relationships
      .filter(({ kind }) => kind === "requires")
      .map(({ from_path, to }) => [from_path, to])
      .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
  ).toEqual([
    ["empty-loop-var.cjs", "loaded.cjs"],
    ["local-fn-let.cjs", "loaded.cjs"],
    ["local-fn-var-init.cjs", "loaded.cjs"],
    ["local-fn-var.cjs", "loaded.cjs"],
    ["local-param.cjs", "loaded.cjs"],
    ["nested-fn-var.cjs", "loaded.cjs"],
    ["switch-let.cjs", "loaded.cjs"],
  ]);
});

it("does not attribute overwritten require members to Node's resolver", async () => {
  const root = await createTestTempDirectory("rea-reference-require-member-");
  const sources: Record<string, string> = {
    "assigned.cjs":
      "require.resolve = () => 'custom';\nconsole.log(require.resolve('./loaded.cjs'));",
    "defined.cjs":
      "Object.defineProperty(require, 'resolve', { value: () => 'custom' });\nconsole.log(require.resolve('./loaded.cjs'));",
    "computed.cjs":
      "const key = 'resolve';\nrequire[key] = () => 'custom';\nconsole.log(require.resolve('./loaded.cjs'));",
    "control.cjs": "console.log(typeof require.resolve('./loaded.cjs'));",
    // A member overwrite does not change bare loader calls.
    "bare-after-overwrite.cjs":
      "require.resolve = () => 'custom';\nconsole.log(require('./loaded.cjs'));",
    // A local loader's member write does not touch Node's loader.
    "local-loader.cjs":
      "function patch(require) { require.resolve = () => 'custom'; }\npatch({});\nconsole.log(typeof require.resolve('./loaded.cjs'));",
    // Optional calls and inert wrappers do not let the loader escape.
    "optional-call.cjs":
      "require?.('./loaded.cjs');\nconsole.log(typeof (require).resolve('./loaded.cjs'));",
    "loaded.cjs": "module.exports = 'real';\n",
  };
  await Promise.all(
    Object.entries(sources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );
  const runNode = promisify(execFile);
  for (const [path, stdout] of [
    ["assigned.cjs", "custom\n"],
    ["defined.cjs", "custom\n"],
    ["computed.cjs", "custom\n"],
    ["control.cjs", "string\n"],
    ["bare-after-overwrite.cjs", "real\n"],
    ["local-loader.cjs", "string\n"],
    ["optional-call.cjs", "string\n"],
  ] as const)
    expect(
      (
        await runNode(process.execPath, [join(root, path)], {
          cwd: root,
          timeout: 5_000,
        })
      ).stdout,
    ).toBe(stdout);

  const result = await importReferenceSource({
    root,
    caller: "reference-require-member-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(
    result.value.relationships
      .filter(({ kind }) => kind === "requires")
      .map(({ from_path, to }) => [from_path, to])
      .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
  ).toEqual([
    ["bare-after-overwrite.cjs", "loaded.cjs"],
    ["control.cjs", "loaded.cjs"],
    ["local-loader.cjs", "loaded.cjs"],
    ["optional-call.cjs", "loaded.cjs"],
  ]);
});
