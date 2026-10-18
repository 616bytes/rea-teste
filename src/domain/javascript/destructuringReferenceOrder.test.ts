import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const changingPatterns = [
  [
    "earlier getter",
    "const {trigger,x:target=DEFAULT}={get trigger(){this.x=undefined},x:{}};",
  ],
  [
    "nested earlier getter",
    "const {nested:{trigger,x:target=DEFAULT}}={nested:{get trigger(){this.x=undefined},x:{}}};",
  ],
  [
    "earlier default",
    "const {x:saved,t:unused=(saved.v=undefined),x:{v:target=DEFAULT}}={x:{v:{}}};",
  ],
  [
    "earlier computed key",
    'const {x:saved,[(saved.v=undefined,"t")]:unused,x:{v:target=DEFAULT}}={x:{v:{}}};',
  ],
  [
    "replaced array iterator",
    "Array.prototype[Symbol.iterator]=function*(){yield undefined};const [target=DEFAULT]=[{}];",
  ],
  [
    "inherited earlier getter",
    "Object.defineProperty(Object.prototype,'trigger',{get(){this.x=undefined}});const {trigger,x:target=DEFAULT}={x:{}};",
  ],
  [
    "member-target computed key",
    "let saved;const holder={};({x:saved,x:{v:holder[(saved.v=undefined,'target')]=DEFAULT}}={x:{v:{}}});const target=holder.target;",
  ],
] as const;

const stablePatterns = [
  "const {x:target=DEFAULT}={x:{}};",
  "const {nested:{x:target=DEFAULT}}={nested:{x:{}}};",
  "const [target=DEFAULT]=[{}];",
  "const {t:unused=1,x:target=DEFAULT}={x:{}};",
  "const {x:saved,x:{v:target=DEFAULT},t:unused=(saved.v=undefined)}={x:{v:{}}};",
  'const {x:saved,x:{v:target=DEFAULT},[(saved.v=undefined,"t")]:unused}={x:{v:{}}};',
  "Object.defineProperty(Object.prototype,'trigger',{get(){this.x=undefined}});const {trigger,x:target=DEFAULT}={trigger:1,x:{}};",
  "const {x:target=DEFAULT}={x:{},method:()=>{},pattern:/x/};",
] as const;

describe("destructuring reference selection order", () => {
  it.each(
    changingPatterns.flatMap(([name, setup]) => [
      [name, setup, "require"],
      [name, setup, "Q"],
    ]),
  )(
    "retains the module fallback after %s with %s via %s",
    (_name, setup, loader) => {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${setup.replaceAll("DEFAULT", "module")}target.require=other;new (${loader}("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
    },
  );

  it.each(changingPatterns)(
    "retains the ambient fallback after %s",
    (_name, setup) => {
      const result = analyzeJavaScriptStaticSource(
        `${setup.replaceAll("DEFAULT", "globalThis")}target.fetch=other;fetch('/local');`,
      );
      expect(
        result.endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
      ).toEqual([]);
    },
  );

  it.each(changingPatterns)(
    "retains fallback effects after %s",
    (_name, setup) => {
      const result = onlyCallable(
        analyzeJavaScriptSemantics(`
        export function result(){
          const fallback={value:1};
          ${setup.replaceAll("DEFAULT", "fallback")}
          target.value=2;
          return fallback.value;
        }
      `),
        "result",
      ).returnSites[0]?.value;
      expect(result?.status).toBe("unknown");
    },
  );

  it.each(stablePatterns)(
    "keeps a defined literal source slot distinct: %s",
    (setup) => {
      expect(
        analyzeJavaScriptStaticSource(
          `${setup.replaceAll("DEFAULT", "module")}target.require=other;new (require("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toHaveLength(1);
      expect(
        analyzeJavaScriptStaticSource(
          `${setup.replaceAll("DEFAULT", "globalThis")}target.fetch=other;fetch('/local');`,
        ).endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
      ).toHaveLength(1);
    },
  );

  it.each(stablePatterns)(
    "keeps a captured fallback excluded from later effects: %s",
    (setup) => {
      const result = onlyCallable(
        analyzeJavaScriptSemantics(`
      export function result(){
        const fallback={value:1};
        ${setup.replaceAll("DEFAULT", "fallback")}
        target.value=2;
        return fallback.value;
      }
    `),
        "result",
      ).returnSites[0]?.value;
      expect(result).toEqual({ status: "literal", value: 1 });
    },
  );

  it("observes RHS effects before selecting a default", () => {
    const result = onlyCallable(
      analyzeJavaScriptSemantics(`
      export function result(){
        const fallback={value:1};
        const source={x:{}};
        const {x:target=fallback}=(source.x=undefined,source);
        target.value=2;
        return fallback.value;
      }
    `),
      "result",
    ).returnSites[0]?.value;
    expect(result?.status).toBe("unknown");
  });
});
