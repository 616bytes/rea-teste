import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import {
  hasOnlyInlineTypeExportSpecifiers,
  hasOnlyInlineTypeImportSpecifiers,
  isTypeOnlyExportDeclaration,
  isTypeOnlyImportDeclaration,
  isErasedJavaScriptDeclaration,
} from "./javascriptModuleDeclaration.js";

/** Babel AST produced by REA's inert JavaScript parser boundary. */
export type ParsedJavaScriptSource = ReturnType<typeof parse>;

// Babel's module classification includes erased TypeScript syntax. Keep the
// runtime proof separate, including explicit filename mode, for every parser entry.
const runtimeModuleByProgram = new WeakMap<t.Program, boolean>();

/** External/synthetic ASTs without parser-owned mode facts do not prove ESM isolation. */
export const hasProvenJavaScriptModuleContext = (program: t.Program): boolean =>
  runtimeModuleByProgram.get(program) === true;

const hasRuntimeModuleDeclaration = (program: t.Program): boolean =>
  program.body.some((node) => {
    if (t.isImportDeclaration(node))
      return (
        !isTypeOnlyImportDeclaration(node) &&
        !hasOnlyInlineTypeImportSpecifiers(node)
      );
    if (t.isExportNamedDeclaration(node) || t.isExportAllDeclaration(node))
      return (
        !isTypeOnlyExportDeclaration(node) &&
        (!t.isExportNamedDeclaration(node) ||
          !hasOnlyInlineTypeExportSpecifiers(node))
      );
    return (
      t.isExportDefaultDeclaration(node) &&
      !isErasedJavaScriptDeclaration(node.declaration)
    );
  });

const parseWithRuntimeContext = (
  source: string,
  sourcePath: string | undefined,
  options: ParserOptions,
): ParsedJavaScriptSource => {
  const file = parse(source, options);
  runtimeModuleByProgram.set(
    file.program,
    isExplicitModuleSourcePath(sourcePath) ||
      (!/\.c[jt]s$/iu.test(sourcePath ?? "") &&
        file.program.sourceType === "module" &&
        hasRuntimeModuleDeclaration(file.program)),
  );
  return file;
};

/**
 * Babel plugins for one source path. Single owner for TypeScript/JSX
 * mode selection (tsc + Babel `typescript` plugin semantics).
 *
 * - `dts:true` only for `.d.ts/.d.mts/.d.cts` ambient declarations;
 *   ordinary `.ts` keeps the missing-initializer diagnostic.
 * - `.js/.jsx/.mjs/.cjs` use JavaScript grammar with JSX. TypeScript reads
 *   some valid JavaScript differently (`c?x=>(a):y=>(b)` as a return type,
 *   `a<b>(c)` as a generic call), so it must not select their meaning.
 * - JSX enabled for `.tsx` and unknown paths; disabled for plain
 *   `.ts/.cts/.mts` (angle-bracket assertions, not JSX) and for all
 *   declaration files. `.mts` (including `.d.mts`) sets
 *   `disallowAmbiguousJSXLike`, matching tsc's `.mts` mode.
 * - `decorators-legacy` always present: without it decorated sources fail
 *   hard instead of reporting recovered syntax, losing every derived fact.
 * - Unknown paths retain the existing JSX- and TypeScript-capable contract
 *   (best-effort parse; failures surface via `errorRecovery`).
 */
export const parserPluginsForPath = (sourcePath?: string): ParserPlugin[] => {
  const path = sourcePath ?? "";
  if (/\.(?:js|jsx|mjs|cjs)$/iu.test(path)) return ["decorators-legacy", "jsx"];
  const dts = /\.d\.(?:ts|mts|cts)$/iu.test(path);
  const isTsLike = /\.(?:ts|cts|mts)$/iu.test(path);
  const isTsx = /\.tsx$/iu.test(path);
  const isMts = /\.mts$/iu.test(path);
  const typescript: ParserPlugin = [
    "typescript",
    {
      dts,
      ...(isMts ? { disallowAmbiguousJSXLike: true } : {}),
    },
  ];
  const jsxCapable = !dts && (isTsx || !isTsLike);
  return jsxCapable
    ? ["decorators-legacy", "jsx", typescript]
    : ["decorators-legacy", typescript];
};

/** `.mjs` and `.mts` explicitly select module mode. */
export const isExplicitModuleSourcePath = (path?: string): boolean =>
  /\.m[jt]s$/iu.test(path ?? "");

const runtimeSourceTypeForPath = (
  path?: string,
): "commonjs" | "module" | "unambiguous" =>
  /\.cjs$/iu.test(path ?? "")
    ? "commonjs"
    : isExplicitModuleSourcePath(path)
      ? "module"
      : "unambiguous";

export interface RecoveredJavaScriptParse {
  readonly file: ParsedJavaScriptSource;
  /** Errors that apply only if a source of unknown mode is an ES module. */
  readonly moduleOnlyErrors: readonly string[];
}

/**
 * Parse a module or script with recovery. Babel tries module mode first and
 * keeps its strict-mode errors after falling back to a script, so a script
 * with errors is parsed again as a script. Strict errors that only the module
 * parse reports stay visible because the source may still be a module.
 */
export const parseRecoveredJavaScript = (
  source: string,
  sourcePath: string | undefined,
  options: Omit<ParserOptions, "sourceType" | "errorRecovery">,
): RecoveredJavaScriptParse => {
  const sourceType = runtimeSourceTypeForPath(sourcePath);
  if (sourceType !== "unambiguous") {
    const normalizedOptions = { ...options };
    if (sourceType === "commonjs") {
      // Babel owns these wrapper semantics in CommonJS mode and rejects
      // explicit script overrides, including the reference-import options.
      delete normalizedOptions.allowAwaitOutsideFunction;
      delete normalizedOptions.allowReturnOutsideFunction;
      delete normalizedOptions.allowNewTargetOutsideFunction;
    }
    return {
      file: parseWithRuntimeContext(source, sourcePath, {
        ...normalizedOptions,
        sourceType,
        errorRecovery: true,
      }),
      moduleOnlyErrors: [],
    };
  }
  const file = parseWithRuntimeContext(source, sourcePath, {
    ...options,
    sourceType: "unambiguous",
    errorRecovery: true,
  });
  if (file.program.sourceType !== "script" || file.errors.length === 0)
    return { file, moduleOnlyErrors: [] };
  const script = parseWithRuntimeContext(source, sourcePath, {
    ...options,
    sourceType: "script",
    errorRecovery: true,
  });
  const scriptErrors = new Set(script.errors.map((error) => error.message));
  return {
    file: script,
    moduleOnlyErrors: file.errors
      .map((error) => error.message)
      .filter((message) => !scriptErrors.has(message)),
  };
};

/** Parse inert JavaScript or TypeScript facts without attaching comments to AST nodes. */
export const parseJavaScriptSource = (
  source: string,
  sourcePath?: string,
): ParsedJavaScriptSource | null => {
  try {
    const runtimeSourceType = runtimeSourceTypeForPath(sourcePath);
    const commonjs = runtimeSourceType === "commonjs";
    const options = {
      errorRecovery: true,
      attachComment: false,
      plugins: parserPluginsForPath(sourcePath),
    };
    const file = parseWithRuntimeContext(source, sourcePath, {
      ...options,
      // Inert artifact analysis retains module declarations even in .cjs assets.
      // Infer their syntax here; reference imports keep filename-mode diagnostics.
      sourceType: commonjs ? "unambiguous" : runtimeSourceType,
      allowReturnOutsideFunction: commonjs,
      allowNewTargetOutsideFunction: commonjs,
    });
    // Unambiguous mode retains module-only diagnostics after choosing a script.
    // The .cjs extension establishes wrapper mode, so obtain its own diagnostics.
    return commonjs &&
      file.program.sourceType === "script" &&
      file.errors.length > 0
      ? parseWithRuntimeContext(source, sourcePath, {
          ...options,
          sourceType: "commonjs",
        })
      : file;
  } catch (cause: unknown) {
    // Unparseable source is represented by the null return.
    void cause;
    return null;
  }
};
