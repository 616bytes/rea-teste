import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each([
  [
    "overwritten handle and stable control",
    `let handle = setTimeout(work, 100); handle = null; clearTimeout(handle);
     const stable = setTimeout(work, 100); clearTimeout(stable);`,
    [
      ["unresolved", null],
      ["complete", 1],
    ],
  ],
  [
    "new timer replaces an earlier timer",
    `let handle = setTimeout(work, 100); handle = setInterval(work, 200); clearInterval(handle);`,
    [["complete", 1]],
  ],
  [
    "later writes do not change earlier cancellations",
    `let handle = setTimeout(work, 100); clearTimeout(handle); handle = null; clearTimeout(handle);`,
    [
      ["complete", 0],
      ["unresolved", null],
    ],
  ],
  [
    "a future timer does not reach an earlier cancellation",
    `clearTimeout(handle); var handle = setTimeout(work, 100);`,
    [["unresolved", null]],
  ],
  [
    "assignment initializes an empty handle",
    `let handle = null; handle = setTimeout(work, 100); clearTimeout(handle);`,
    [["complete", 0]],
  ],
  [
    "two cancellations select their own preceding timer",
    `let handle = setTimeout(work, 100); clearTimeout(handle);
     handle = setTimeout(work, 200); clearTimeout(handle);`,
    [
      ["complete", 0],
      ["complete", 1],
    ],
  ],
  [
    "local callable handles retain exact ownership",
    `function run() { let handle = setTimeout(work, 100); clearTimeout(handle); handle = null; }`,
    [["complete", 0]],
  ],
  [
    "shadowed bindings keep independent timer identities",
    `let handle = setTimeout(work, 100);
     { const handle = setInterval(work, 200); clearInterval(handle); }
     clearTimeout(handle);`,
    [
      ["complete", 1],
      ["complete", 0],
    ],
  ],
  [
    "same-declaration reads follow earlier declarators",
    `const handle = setTimeout(work, 100), cancelled = clearTimeout(handle);`,
    [["complete", 0]],
  ],
  [
    "transparent TypeScript result wrappers preserve ownership",
    `const handle = setTimeout(work, 100) as unknown; clearTimeout(handle);`,
    [["complete", 0]],
  ],
  [
    "awaited timer handles preserve ownership",
    `async function run() { const handle = await setTimeout(work, 100); clearTimeout(handle); }`,
    [["complete", 0]],
  ],
  [
    "updates replace timer values",
    `let handle = setTimeout(work, 100); handle++; clearTimeout(handle);`,
    [["partial", 0]],
  ],
  [
    "compound assignments replace timer values",
    `let handle = setTimeout(work, 100); handle += 1; clearTimeout(handle);`,
    [["partial", 0]],
  ],
])(
  "resolves timer handles at their cancellation: %s",
  (_name, source, expected) => {
    const operations = analyzeJavaScriptSemantics(
      String(source),
    ).timerOperations;
    const schedules = operations.filter(({ kind }) => kind === "schedule");
    expect(
      operations
        .filter(({ kind }) => kind === "cancel")
        .map((operation) => [
          operation.resolution,
          operation.linkedTimerId === null
            ? null
            : schedules.findIndex(
                ({ timerId }) => timerId === operation.linkedTimerId,
              ),
        ]),
    ).toEqual(expected);
  },
);

it.each([
  `let handle = setTimeout(work, 100); function replace() { handle = null; } replace(); clearTimeout(handle);`,
  `let handle = setTimeout(work, 100); clearTimeout(handle); function replace() { handle = null; }`,
  `let handle; function start() { handle = setTimeout(work, 100); } clearTimeout(handle);`,
  `let handle = setTimeout(work, 100); function stop() { clearTimeout(handle); }`,
  `let handle = setTimeout(work, 100); if (flag) handle = null; clearTimeout(handle);`,
  `let handle = setTimeout(work, 100); while (flag) { clearTimeout(handle); handle = null; }`,
  `let handle = setTimeout(work, 100); [handle] = other; clearTimeout(handle);`,
  `let handle = setTimeout(work, 100); handle &&= null; clearTimeout(handle);`,
  `if (flag) { var handle = setTimeout(work, 100); } clearTimeout(handle);`,
  `let handle = setTimeout(work, 100); if (flag) handle = setInterval(work, 200); clearTimeout(handle);`,
  `const { handle } = setTimeout(work, 100); clearTimeout(handle);`,
  `let handle = setTimeout(work, 100); (handle = null, clearTimeout(handle));`,
])(
  "keeps uncertain timer writes or activation order explicit: %s",
  (source) => {
    const operations = analyzeJavaScriptSemantics(source).timerOperations;
    const cancellations = operations.filter(({ kind }) => kind === "cancel");
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.resolution).not.toBe("complete");
  },
);
