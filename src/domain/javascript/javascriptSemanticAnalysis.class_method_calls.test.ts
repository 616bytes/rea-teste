import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

// 4437 repro: exact this.sink at line 3, exact this.load at line 9,
// candidate outer plus inner exact at line 10, exact field load at line 13.
// Callers of load are lines 9, 10, 13; caller of sink is line 3.
const REPRO_4437 = [
  "class Backend {",
  "  load() { return 1; }",
  "  probe() { this.sink(); }",
  "  sink() { return 2; }",
  "  helper() { return new Backend(); }",
  "  store = new Backend();",
  "  fillerA() { return 0; }",
  "  fillerB() { return 0; }",
  "  runA() { this.load(); }",
  "  runB() { this.helper().load(); }",
  "  fillerC() { return 0; }",
  "  fillerD() { return 0; }",
  "  runC() { this.store.load(); }",
  "}",
].join("\n");

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "repro.js");
  if (parsed === null) throw new Error("Expected valid repro fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const bindingCache = new WeakMap<t.Identifier, LocalCallableResolution>();
  return {
    state,
    callableById,
    bindingCache,
    resolve: (node: t.Node) =>
      resolveLocalCallables({
        node,
        state,
        callableById,
        bindingCache,
        seenInitializers: new Set(),
      }),
  };
};

const callSitesOnLine = (
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
  line: number,
) =>
  ir.callSites.filter(
    ({ location, kind }) => location.start.line === line && kind === "call",
  );

const callersOf = (
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
  name: string,
) => {
  const target = onlyCallable(ir, name);
  return ir.callSites
    .filter(({ calleeCallableIds }) =>
      calleeCallableIds.includes(target.callableId),
    )
    .map(({ location }) => location.start.line)
    .sort((left, right) => left - right);
};

const CLASS_METHOD_NEGATIVES = [
  [
    "subclass override stays ambiguous",
    [
      "class Base { load() { return 1; } }",
      "class Derived extends Base { load() { return 2; } }",
      "const x = new Base();",
      "x.load();",
    ].join("\n"),
    /overrides or duplicate/iu,
    "ambiguous",
  ],
  [
    "second field write stays ambiguous",
    [
      "class A { load() { return 1; } }",
      "class B { load() { return 2; } }",
      "class Consumer {",
      "  constructor() { this.store = new A(); this.store = new B(); }",
      "  run() { this.store.load(); }",
      "}",
    ].join("\n"),
    /multiple field writes/iu,
    "ambiguous",
  ],
  [
    "prototype reassignment stays ambiguous",
    [
      "class Backend { load() { return 1; } }",
      "Backend.prototype.load = function() { return 2; };",
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
  ],
  [
    "instance reassignment stays ambiguous",
    [
      "class Backend { load() { return 1; } }",
      "const x = new Backend();",
      "x.load = function() { return 2; };",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
  ],
  [
    "computed method key stays ambiguous",
    [
      'const key = "load";',
      "class Backend { [key]() { return 1; } load() { return 2; } }",
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
  ],
  [
    "computed call key stays unresolved",
    [
      "class Backend { load() { return 1; } }",
      "const x = new Backend();",
      'const key = "load";',
      "x[key]();",
    ].join("\n"),
    /computed/iu,
    "unresolved",
  ],
  [
    "Object.assign mixin stays ambiguous",
    [
      "class Backend { load() { return 1; } }",
      "Object.assign(Backend.prototype, { extra() { return 2; } });",
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
  ],
  [
    "imported class receiver stays unresolved",
    [
      'import { Backend } from "./backend.js";',
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /no single local class/iu,
    "unresolved",
  ],
  [
    "parameter receiver stays unresolved",
    [
      "class Backend { load() { return 1; } }",
      "function run(item) { item.load(); }",
    ].join("\n"),
    /not a stable const/iu,
    "unresolved",
  ],
  [
    "let reassigned receiver stays unresolved",
    [
      "class Backend { load() { return 1; } }",
      "let x = new Backend();",
      "x.load();",
    ].join("\n"),
    /not a stable const/iu,
    "unresolved",
  ],
  [
    "getter returning two classes stays ambiguous",
    [
      "class A { load() { return 1; } }",
      "class B { load() { return 2; } }",
      "class Consumer {",
      "  helper(flag) { if (flag) { return new A(); } return new B(); }",
      "  run() { this.helper().load(); }",
      "}",
    ].join("\n"),
    /through a getter return/iu,
    "ambiguous",
  ],
  [
    "getter returning external value stays unresolved",
    [
      "class Consumer {",
      "  helper() { return external; }",
      "  run() { this.helper().load(); }",
      "}",
    ].join("\n"),
    /Unresolved member receiver external/iu,
    "unresolved",
  ],
  [
    "deep receiver chains stay unresolved",
    [
      "class Backend { load() { return 1; } }",
      "class Consumer {",
      "  constructor() { this.a = new Backend(); }",
      "  run() { this.a.b.load(); }",
      "}",
    ].join("\n"),
    /Unsupported/iu,
    "unresolved",
  ],
] as const;

const checkNegative = (
  source: string,
  reason: RegExp,
  resolution: "ambiguous" | "unresolved",
): void => {
  const ir = analyzeJavaScriptSemantics(source);
  const calls = ir.callSites.filter(({ kind }) => kind === "call");
  expect(calls.length).toBeGreaterThan(0);
  const loadIds = new Set(
    ir.callables
      .filter(({ name }) => name === "load" || name === "helper")
      .map(({ callableId }) => callableId),
  );
  const targets = calls.filter(
    ({ calleeCallableIds }) =>
      calleeCallableIds.some((id) => loadIds.has(id)) ||
      calleeCallableIds.length === 0,
  );
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    if (target.calleeCallableIds.length === 0) {
      expect(target.resolution).toBe("unresolved");
    } else if (
      target.calleeCallableIds.some((id) =>
        ir.callables.some(
          (callable) => callable.callableId === id && callable.name === "load",
        ),
      )
    ) {
      expect(target.resolution).not.toBe("exact");
      expect(target.resolution).toBe(resolution);
    }
  }
  expect(ir.frontiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(reason) }),
    ]),
  );
};

describe("JavaScript semantic analysis: class method calls for #4437", () => {
  it("resolves exact edges for lines 3, 9, 13", () => {
    const ir = analyzeJavaScriptSemantics(REPRO_4437);
    const sink = onlyCallable(ir, "sink");
    const load = onlyCallable(ir, "load");
    const line3 = callSitesOnLine(ir, 3);
    expect(line3).toHaveLength(1);
    expect(line3[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [sink.callableId],
    });
    const line9 = callSitesOnLine(ir, 9);
    expect(line9).toHaveLength(1);
    expect(line9[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [load.callableId],
    });
    const line13 = callSitesOnLine(ir, 13);
    expect(line13).toHaveLength(1);
    expect(line13[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [load.callableId],
    });
  });

  it("keeps line 10 as candidate plus inner exact", () => {
    const ir = analyzeJavaScriptSemantics(REPRO_4437);
    const load = onlyCallable(ir, "load");
    const helper = onlyCallable(ir, "helper");
    const line10 = callSitesOnLine(ir, 10);
    expect(line10).toHaveLength(2);
    const outer = line10.find(({ calleeCallableIds }) =>
      calleeCallableIds.includes(load.callableId),
    );
    const inner = line10.find(({ calleeCallableIds }) =>
      calleeCallableIds.includes(helper.callableId),
    );
    expect(outer).toMatchObject({
      resolution: "ambiguous",
      calleeCallableIds: [load.callableId],
    });
    expect(inner).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [helper.callableId],
    });
    expect(ir.frontiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({
            start: expect.objectContaining({ line: 10 }),
          }),
          reason: expect.stringMatching(/through a getter return/iu),
        }),
      ]),
    );
  });

  it("traces callers to load at lines 9, 10, 13 and sink at line 3", () => {
    const ir = analyzeJavaScriptSemantics(REPRO_4437);
    expect(callersOf(ir, "load")).toEqual([9, 10, 13]);
    expect(callersOf(ir, "sink")).toEqual([3]);
  });

  it("resolves member targets through the resolver for #4437", () => {
    const context = indexed(REPRO_4437);
    const members: t.MemberExpression[] = [];
    traverseJavaScriptAst(context.state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          (t.isMemberExpression(node.callee) ||
            t.isOptionalMemberExpression(node.callee))
        )
          members.push(node.callee as t.MemberExpression);
      },
    });
    const byCalleeLine = (line: number) =>
      members.filter(
        (member) =>
          context.state.parentsByNode.get(member)?.type === "CallExpression" &&
          member.loc?.start.line === line,
      );
    for (const line of [3, 9, 13]) {
      const found = byCalleeLine(line);
      expect(found).toHaveLength(1);
      const resolved = context.resolve(found[0] as t.Node);
      expect(resolved.callableIds).toHaveLength(1);
      expect(resolved.complete).toBe(true);
    }
    expect(byCalleeLine(10)).toHaveLength(2);
    const outer = context.resolve(
      members.find(
        (member) =>
          member.loc?.start.line === 10 &&
          member.loc.start.column === 11 &&
          (member.property as t.Identifier).name === "load",
      ) as t.Node,
    );
    expect(outer.callableIds).toHaveLength(1);
    expect(outer.complete).toBe(false);
  });
});

describe("JavaScript semantic analysis: class method call negatives", () => {
  it.each(CLASS_METHOD_NEGATIVES)(
    "never resolves exact for %s",
    (_name, source, reason, resolution) => {
      checkNegative(source, reason, resolution);
    },
  );
});
