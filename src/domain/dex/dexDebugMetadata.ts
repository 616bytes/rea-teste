/**
 * Assemble debugging-readiness facts from a framed DEX file: a whole-file
 * summary (tallies + a conservative readiness label) and, for one selected
 * class, full per-method detail with names/types/scopes resolved from the string
 * and type pools.
 *
 * Every decode is charged to one call-wide {@link DexWorkBudget} and polls a
 * cancellation callback, so neither many methods nor many DEX members can
 * multiply the per-method guard. The summary only counts (no per-position or
 * per-local allocation) and decodes each distinct debug stream + parameter
 * layout once. The class detail projects its serialized size from memoised
 * per-string bounds while it decodes, and refuses before materialising a report
 * past the caller's output limit.
 */
import {
  type DexClassDef,
  type DexEncodedMethod,
  type DexFile,
  parseClassData,
  parseCodeItem,
} from "./dexFile.js";
import {
  absentMethodDebug,
  decodeDebugInfo,
  type DexDecodeOptions,
  DEX_THIS_NAME,
  type DexMethodDebug,
  type DexWorkBudget,
} from "./dexDebugInfo.js";
import { type Result, err, ok } from "../result.js";
import { DexStringResolver } from "./dexStrings.js";

export type DexMethodState =
  | "present" // positions and locals both decoded
  | "partial" // one present, the other absent
  | "stripped" // code exists but carries no debug_info
  | "malformed" // a present debug_info failed to decode fully
  | "not-applicable"; // abstract/native: no code_item

export interface DexLocalResolved {
  readonly register: number;
  readonly name: string | null;
  readonly type: string | null;
  readonly signature: string | null;
  readonly startAddress: number;
  readonly endAddress: number;
  readonly outOfRange: boolean;
}

export interface DexMethodDetail {
  readonly name: string | null;
  readonly descriptor: string | null;
  readonly state: DexMethodState;
  readonly hasCode: boolean;
  readonly lineCount: number;
  readonly parameterNames: readonly (string | null)[];
  readonly locals: readonly DexLocalResolved[];
  readonly setFileEvents: number;
}

export interface DexClassDetail {
  readonly descriptor: string | null;
  readonly sourceFile: string | null;
  readonly methods: readonly DexMethodDetail[];
}

export type DexReadiness = "present" | "partial" | "stripped";

export interface DexSummary {
  readonly dexVersion: string;
  readonly classCount: number;
  readonly methodsWithCode: number;
  readonly methodsWithDebugInfo: number;
  readonly methodsWithParameterNames: number;
  readonly linePositions: number;
  /** Every local dexdump lists, including implicit `this`/parameter locals. */
  readonly localDeclarations: number;
  /** Locals the debug streams declare themselves (DBG_START_LOCAL*). */
  readonly explicitLocalDeclarations: number;
  readonly setFileEvents: number;
  readonly sourceFilePresent: number;
  readonly distinctSourceFiles: {
    readonly count: number;
    readonly sample: readonly string[];
  };
  readonly readiness: DexReadiness;
}

const SOURCE_FILE_SAMPLE_CAP = 16;

/** Why a summary or detail was refused before completing. */
export type DexWorkError =
  | { readonly kind: "work-budget-exceeded"; readonly limit: number }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "output-budget-exceeded";
      readonly projectedBytes: number;
      readonly limit: number;
    };

/** Call-wide work accounting shared by every member of one inspection. */
export interface DexWork {
  readonly budget: DexWorkBudget;
  readonly cancelled: () => boolean;
}

const methodState = (
  hasCode: boolean,
  debug: DexMethodDebug,
): DexMethodState => {
  if (!hasCode) return "not-applicable";
  if (debug.malformed) return "malformed";
  const hasLines = debug.positionCount > 0;
  // Implicit `this`/parameter locals are synthesised from the method layout
  // whenever a stream exists (an R8 release keeps streams for lines); only
  // declared locals or named parameters show local debug info survived.
  const hasLocals =
    debug.explicitLocalCount > 0 ||
    debug.parameterNames.some((idx) => idx >= 0);
  if (!debug.present || (!hasLines && !hasLocals)) return "stripped";
  return hasLines && hasLocals ? "present" : "partial";
};

interface MethodDecodeInput {
  readonly debugInfoOff: number;
  readonly insnsSize: number;
  readonly firstRegister: number;
  readonly paramTypes: readonly {
    readonly typeIdx: number;
    readonly wide: boolean;
  }[];
}

/**
 * Resolve what decoding a method needs: its code_item's debug_info offset and
 * register layout plus its proto parameters. Null for a method with no code or
 * no debug_info.
 */
const methodDecodeInput = (
  bytes: Uint8Array,
  method: DexEncodedMethod,
  resolver: DexStringResolver,
): MethodDecodeInput | null => {
  if (method.codeOff === 0) return null;
  const code = parseCodeItem(bytes, method.codeOff);
  if (!code.ok || code.value.debugInfoOff === 0) return null;
  return {
    debugInfoOff: code.value.debugInfoOff,
    insnsSize: code.value.insnsSize,
    firstRegister: code.value.registersSize - code.value.insSize,
    paramTypes: resolver.methodParameters(method.methodIdx) ?? [],
  };
};

/**
 * Decode a method's debug_info with its implicit parameter locals (and `this`)
 * seeded at address 0 from the code_item register layout and the proto, as the
 * DEX format and dexdump/ART do.
 */
const decodeMethodDebug = (
  bytes: Uint8Array,
  method: DexEncodedMethod,
  input: MethodDecodeInput | null,
  classTypeIdx: number,
  options: DexDecodeOptions,
): DexMethodDebug =>
  input === null
    ? absentMethodDebug()
    : decodeDebugInfo(
        bytes,
        input.debugInfoOff,
        input.insnsSize,
        {
          firstRegister: input.firstRegister,
          accessFlags: method.accessFlags,
          thisTypeIdx: classTypeIdx,
          paramTypes: input.paramTypes,
        },
        options,
      );

const methodsOf = (
  bytes: Uint8Array,
  classDef: DexClassDef,
): readonly DexEncodedMethod[] => {
  if (classDef.classDataOff === 0) return [];
  const data = parseClassData(bytes, classDef.classDataOff);
  return data.ok
    ? [...data.value.directMethods, ...data.value.virtualMethods]
    : [];
};

const outOfWork = (work: DexWork): DexWorkError | null =>
  work.cancelled()
    ? { kind: "cancelled" }
    : work.budget.remaining <= 0
      ? { kind: "work-budget-exceeded", limit: work.budget.limit }
      : null;

/** Serialized overhead per projected object (keys, numbers, punctuation). */
const METHOD_OVERHEAD = 320;
const LOCAL_OVERHEAD = 192;

/**
 * Full per-method detail for the one class whose descriptor matches (`null`
 * when absent). Locals are collected under a cap derived from the output limit
 * (each serialises to at least {@link LOCAL_OVERHEAD} bytes) and every emitted
 * string is charged its memoised JSON bound, so an oversized class is refused
 * before its report is built.
 */
export const assembleClassDetail = (
  dex: DexFile,
  bytes: Uint8Array,
  classDescriptor: string,
  work: DexWork,
  outputLimit: number,
): Result<DexClassDetail | null, DexWorkError> => {
  const resolver = new DexStringResolver(bytes, dex.header);
  const classDef = dex.classDefs.find(
    (def) => resolver.typeDescriptor(def.classIdx) === classDescriptor,
  );
  if (classDef === undefined) return ok(null);
  let projected =
    1024 +
    resolver.typeJsonBound(classDef.classIdx) +
    resolver.jsonBound(classDef.sourceFileIdx);
  const overBudget = (): Result<never, DexWorkError> =>
    err({
      kind: "output-budget-exceeded",
      projectedBytes: projected,
      limit: outputLimit,
    });
  const methods: DexMethodDetail[] = [];
  for (const method of methodsOf(bytes, classDef)) {
    const stop = outOfWork(work);
    if (stop !== null) return err(stop);
    const input = methodDecodeInput(bytes, method, resolver);
    const debug = decodeMethodDebug(bytes, method, input, classDef.classIdx, {
      budget: work.budget,
      cancelled: work.cancelled,
      collectPositions: false,
      collectLocals: true,
      maxLocals: Math.max(
        0,
        Math.floor((outputLimit - projected) / LOCAL_OVERHEAD),
      ),
    });
    const after = outOfWork(work);
    if (after !== null) return err(after);
    const name = resolver.methodName(method.methodIdx);
    const descriptor = resolver.methodDescriptor(method.methodIdx);
    projected +=
      METHOD_OVERHEAD +
      Buffer.byteLength(JSON.stringify(name)) +
      Buffer.byteLength(JSON.stringify(descriptor));
    // Each name plus its array separator.
    for (const idx of debug.parameterNames)
      projected += resolver.jsonBound(idx) + 1;
    if (debug.localLimitExceeded) {
      projected += (debug.localCount - debug.locals.length) * LOCAL_OVERHEAD;
      return overBudget();
    }
    for (const local of debug.locals)
      projected +=
        LOCAL_OVERHEAD +
        (local.nameIdx === DEX_THIS_NAME
          ? 6
          : resolver.jsonBound(local.nameIdx)) +
        resolver.typeJsonBound(local.typeIdx) +
        resolver.jsonBound(local.signatureIdx);
    if (projected > outputLimit) return overBudget();
    const hasCode = method.codeOff !== 0;
    methods.push({
      name,
      descriptor,
      state: methodState(hasCode, debug),
      hasCode,
      lineCount: debug.positionCount,
      parameterNames: debug.parameterNames.map((idx) => resolver.string(idx)),
      locals: debug.locals.map((local) => ({
        register: local.register,
        name:
          local.nameIdx === DEX_THIS_NAME
            ? "this"
            : resolver.string(local.nameIdx),
        type: resolver.typeDescriptor(local.typeIdx),
        signature: resolver.string(local.signatureIdx),
        startAddress: local.startAddress,
        endAddress: local.endAddress,
        outOfRange: local.outOfRange,
      })),
      setFileEvents: debug.setFileEvents,
    });
  }
  return ok({
    descriptor: resolver.typeDescriptor(classDef.classIdx),
    sourceFile: resolver.string(classDef.sourceFileIdx),
    methods,
  });
};

/**
 * Conservative readiness from what the streams themselves carry: declared
 * locals or named parameters are local-variable evidence (implicit `this` and
 * unnamed parameter locals are synthesised from the layout, so they are not).
 */
const classifyReadiness = (
  explicitLocalDeclarations: number,
  methodsWithParameterNames: number,
  linePositions: number,
): DexReadiness => {
  const hasLocals =
    explicitLocalDeclarations > 0 || methodsWithParameterNames > 0;
  if (!hasLocals) return "stripped";
  return linePositions > 0 ? "present" : "partial";
};

/** What the summary keeps from one decoded method. */
interface MethodTally {
  readonly present: boolean;
  readonly positions: number;
  readonly locals: number;
  readonly explicitLocals: number;
  readonly setFileEvents: number;
  readonly hasParameterNames: boolean;
}

/**
 * Whole-file tally and a conservative readiness label. Methods are decoded in
 * counts-only mode, and methods that share a debug stream and the same implicit
 * parameter layout (d8/R8 share streams) reuse one decode: the result depends
 * only on that key.
 */
export const summarizeDex = (
  dex: DexFile,
  bytes: Uint8Array,
  work: DexWork,
): Result<DexSummary, DexWorkError> => {
  const resolver = new DexStringResolver(bytes, dex.header);
  const tallies = new Map<string, MethodTally>();
  let methodsWithCode = 0;
  let methodsWithDebugInfo = 0;
  let methodsWithParameterNames = 0;
  let linePositions = 0;
  let localDeclarations = 0;
  let explicitLocalDeclarations = 0;
  let setFileEvents = 0;
  let sourceFilePresent = 0;
  const sources = new Set<string>();

  for (const classDef of dex.classDefs) {
    const stop = outOfWork(work);
    if (stop !== null) return err(stop);
    const source = resolver.string(classDef.sourceFileIdx);
    if (source !== null) {
      sourceFilePresent += 1;
      sources.add(source); // distinct count; a single value signals -renamesourcefileattribute
    }
    for (const method of methodsOf(bytes, classDef)) {
      if (method.codeOff === 0) continue;
      methodsWithCode += 1;
      const input = methodDecodeInput(bytes, method, resolver);
      if (input === null) continue;
      const isStatic = (method.accessFlags & 0x8) !== 0;
      const key = [
        input.debugInfoOff,
        input.insnsSize,
        input.firstRegister,
        isStatic ? "s" : `i${String(classDef.classIdx)}`,
        input.paramTypes
          .map((p) => `${String(p.typeIdx)}${p.wide ? "w" : ""}`)
          .join(","),
      ].join(":");
      let tally = tallies.get(key);
      if (tally === undefined) {
        const debug = decodeMethodDebug(
          bytes,
          method,
          input,
          classDef.classIdx,
          {
            budget: work.budget,
            cancelled: work.cancelled,
            collectPositions: false,
            collectLocals: false,
          },
        );
        const after = outOfWork(work);
        if (after !== null) return err(after);
        tally = {
          present: debug.present,
          positions: debug.positionCount,
          locals: debug.localCount,
          explicitLocals: debug.explicitLocalCount,
          setFileEvents: debug.setFileEvents,
          hasParameterNames: debug.parameterNames.some((idx) => idx >= 0),
        };
        tallies.set(key, tally);
      }
      if (!tally.present) continue;
      methodsWithDebugInfo += 1;
      linePositions += tally.positions;
      localDeclarations += tally.locals;
      explicitLocalDeclarations += tally.explicitLocals;
      setFileEvents += tally.setFileEvents;
      if (tally.hasParameterNames) methodsWithParameterNames += 1;
    }
  }

  return ok({
    dexVersion: dex.header.version,
    classCount: dex.classDefs.length,
    methodsWithCode,
    methodsWithDebugInfo,
    methodsWithParameterNames,
    linePositions,
    localDeclarations,
    explicitLocalDeclarations,
    setFileEvents,
    sourceFilePresent,
    distinctSourceFiles: {
      count: sources.size,
      sample: [...sources].slice(0, SOURCE_FILE_SAMPLE_CAP),
    },
    readiness: classifyReadiness(
      explicitLocalDeclarations,
      methodsWithParameterNames,
      linePositions,
    ),
  });
};
