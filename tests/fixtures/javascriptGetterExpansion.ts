/** Dynamic receiver keys enumerate permutations of these getter names. */
export const getterExpansionSource = (count = 10): string => `
  const shared = { value: 1 };
  class Request {
    ${Array.from(
      { length: count },
      (_, index) => `get field${index}() { return this[key].field${index}; }`,
    ).join("\n")}
    get state() { return shared; }
  }
  consume(new Request().field0);
  const result = shared.value;
`;

export const plainGetterSource = (
  count: number,
  object = false,
  fields = false,
): string => {
  const getters = Array.from(
    { length: count },
    (_, index) => `get g${index}() { return this._g${index}; }`,
  ).join(object ? ",\n" : "\n");
  const receiver = object
    ? `const receiver = { ${getters} }; consume(receiver[key]);`
    : `class C { ${
        fields
          ? Array.from(
              { length: count },
              (_, index) => `_g${index} = { value: ${index} };`,
            ).join("\n")
          : ""
      }
        ${getters} } consume(new C()[key]);`;
  return `import imported from "dep"; ${receiver} const unrelated = 42;`;
};

export const bundledGetterSource = (classes = 20): string => `
  import imported from "dep";
  ${Array.from(
    { length: classes },
    (_, index) => `
    class C${index} {
      ${Array.from(
        { length: 10 },
        (_, field) => `get f${field}() { return this[M].f${field}; }`,
      ).join("\n")}
    }
    consume(new C${index}()[key]);
  `,
  ).join("\n")}
  const unrelated = 42;
`;
