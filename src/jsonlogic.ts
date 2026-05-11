/**
 * Author-side types and helpers for JSONLogic expressions
 * (https://jsonlogic.com). Workflow node configs use JSONLogic in a
 * few places — `condition.expression`, `assert.condition`,
 * `switch.cases[].expression`. Codegen wires those fields to
 * `JSONLogicExpression` so authors get compile-time validation on
 * operator shapes; the runtime form is the same plain object the
 * server expects.
 *
 * Two ways to write expressions:
 *
 *   // 1. Literal object form — TS validates the operator shape:
 *   { "==": [{ var: "input.kind" }, "press"] }
 *
 *   // 2. Helper functions — useful for nested expressions and for
 *   //    operators whose key isn't a valid TS identifier:
 *   jl.eq(jl.var("input.kind"), "press")
 *
 * Both round-trip to the same wire shape.
 */

// ── value space ───────────────────────────────────────────────────────

/**
 * Anything that can appear as a leaf or operand in a JSONLogic
 * expression: primitives, arrays of values, or a sub-expression.
 */
export type JSONLogicValue =
  | string
  | number
  | boolean
  | null
  | JSONLogicExpression
  | JSONLogicValue[];

// ── expression union ──────────────────────────────────────────────────

/**
 * Tagged union covering the 27 standard JSONLogic operators. Each
 * variant has exactly one key; the server evaluates an expression by
 * looking at that key. Adding a custom operator on the server side
 * doesn't break this — TS will simply reject it at the type level
 * (use `as JSONLogicExpression` to escape if you really need to).
 */
export type JSONLogicExpression =
  // Accessing data
  | { var: string | [string] | [string, JSONLogicValue] }
  | { missing: (string | number)[] }
  | { missing_some: [number, string[]] }
  // Logic and control flow
  | { if: JSONLogicValue[] }
  | { "==": [JSONLogicValue, JSONLogicValue] }
  | { "===": [JSONLogicValue, JSONLogicValue] }
  | { "!=": [JSONLogicValue, JSONLogicValue] }
  | { "!==": [JSONLogicValue, JSONLogicValue] }
  | { "!": JSONLogicValue }
  | { "!!": JSONLogicValue }
  | { or: JSONLogicValue[] }
  | { and: JSONLogicValue[] }
  // Numeric comparison (chained <, <= variants allowed: [a, b, c] = a < b < c).
  | { ">": [JSONLogicValue, JSONLogicValue] }
  | { ">=": [JSONLogicValue, JSONLogicValue] }
  | { "<": [JSONLogicValue, JSONLogicValue] | [JSONLogicValue, JSONLogicValue, JSONLogicValue] }
  | { "<=": [JSONLogicValue, JSONLogicValue] | [JSONLogicValue, JSONLogicValue, JSONLogicValue] }
  | { max: JSONLogicValue[] }
  | { min: JSONLogicValue[] }
  // Arithmetic
  | { "+": JSONLogicValue[] }
  | { "-": JSONLogicValue[] }
  | { "*": JSONLogicValue[] }
  | { "/": [JSONLogicValue, JSONLogicValue] }
  | { "%": [JSONLogicValue, JSONLogicValue] }
  // Array iteration
  | { map: [JSONLogicValue, JSONLogicValue] }
  | { reduce: [JSONLogicValue, JSONLogicValue, JSONLogicValue] }
  | { filter: [JSONLogicValue, JSONLogicValue] }
  | { all: [JSONLogicValue, JSONLogicValue] }
  | { none: [JSONLogicValue, JSONLogicValue] }
  | { some: [JSONLogicValue, JSONLogicValue] }
  | { merge: JSONLogicValue[] }
  // Membership / strings
  | { in: [JSONLogicValue, JSONLogicValue] }
  | { cat: JSONLogicValue[] }
  | { substr: [JSONLogicValue, JSONLogicValue] | [JSONLogicValue, JSONLogicValue, JSONLogicValue] }
  // Debug
  | { log: JSONLogicValue };

// ── helpers ───────────────────────────────────────────────────────────

/**
 * Helpers that build JSONLogicExpression nodes. Cover the same 27
 * operators as the type union; renames apply for operators whose
 * server-side key isn't a valid TS identifier (`eq` → `==`,
 * `strictEq` → `===`, `add` → `+`, etc.). Composes naturally:
 *
 *   jl.and(jl.gt(jl.var("input.qty"), 0), jl.eq(jl.var("input.status"), "ok"))
 */
export const jl = {
  // accessing data
  var: (path: string, fallback?: JSONLogicValue): JSONLogicExpression =>
    fallback === undefined ? { var: path } : { var: [path, fallback] },
  missing: (...paths: (string | number)[]): JSONLogicExpression => ({ missing: paths }),
  missingSome: (min: number, paths: string[]): JSONLogicExpression => ({ missing_some: [min, paths] }),

  // logic
  if: (...args: JSONLogicValue[]): JSONLogicExpression => ({ if: args }),
  eq: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "==": [a, b] }),
  strictEq: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "===": [a, b] }),
  neq: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "!=": [a, b] }),
  strictNeq: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "!==": [a, b] }),
  not: (a: JSONLogicValue): JSONLogicExpression => ({ "!": a }),
  truthy: (a: JSONLogicValue): JSONLogicExpression => ({ "!!": a }),
  and: (...args: JSONLogicValue[]): JSONLogicExpression => ({ and: args }),
  or: (...args: JSONLogicValue[]): JSONLogicExpression => ({ or: args }),

  // numeric comparison
  gt: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ ">": [a, b] }),
  gte: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ ">=": [a, b] }),
  lt: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "<": [a, b] }),
  lte: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "<=": [a, b] }),
  /** Chained `a < b < c` shorthand. */
  between: (a: JSONLogicValue, b: JSONLogicValue, c: JSONLogicValue): JSONLogicExpression => ({
    "<": [a, b, c],
  }),
  /** Chained `a <= b <= c` shorthand. */
  betweenInclusive: (
    a: JSONLogicValue,
    b: JSONLogicValue,
    c: JSONLogicValue,
  ): JSONLogicExpression => ({ "<=": [a, b, c] }),
  max: (...args: JSONLogicValue[]): JSONLogicExpression => ({ max: args }),
  min: (...args: JSONLogicValue[]): JSONLogicExpression => ({ min: args }),

  // arithmetic
  add: (...args: JSONLogicValue[]): JSONLogicExpression => ({ "+": args }),
  sub: (...args: JSONLogicValue[]): JSONLogicExpression => ({ "-": args }),
  mul: (...args: JSONLogicValue[]): JSONLogicExpression => ({ "*": args }),
  div: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "/": [a, b] }),
  mod: (a: JSONLogicValue, b: JSONLogicValue): JSONLogicExpression => ({ "%": [a, b] }),

  // array iteration
  map: (arr: JSONLogicValue, body: JSONLogicValue): JSONLogicExpression => ({ map: [arr, body] }),
  reduce: (arr: JSONLogicValue, body: JSONLogicValue, seed: JSONLogicValue): JSONLogicExpression => ({
    reduce: [arr, body, seed],
  }),
  filter: (arr: JSONLogicValue, body: JSONLogicValue): JSONLogicExpression => ({ filter: [arr, body] }),
  all: (arr: JSONLogicValue, body: JSONLogicValue): JSONLogicExpression => ({ all: [arr, body] }),
  none: (arr: JSONLogicValue, body: JSONLogicValue): JSONLogicExpression => ({ none: [arr, body] }),
  some: (arr: JSONLogicValue, body: JSONLogicValue): JSONLogicExpression => ({ some: [arr, body] }),
  merge: (...args: JSONLogicValue[]): JSONLogicExpression => ({ merge: args }),

  // strings / membership
  in: (needle: JSONLogicValue, haystack: JSONLogicValue): JSONLogicExpression => ({
    in: [needle, haystack],
  }),
  cat: (...args: JSONLogicValue[]): JSONLogicExpression => ({ cat: args }),
  substr: (
    s: JSONLogicValue,
    start: JSONLogicValue,
    length?: JSONLogicValue,
  ): JSONLogicExpression =>
    length === undefined ? { substr: [s, start] } : { substr: [s, start, length] },

  // debug
  log: (v: JSONLogicValue): JSONLogicExpression => ({ log: v }),
} as const;
