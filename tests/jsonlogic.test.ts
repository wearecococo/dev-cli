import { describe, expect, test } from "bun:test";
import {
  defineNode,
  jl,
  type JSONLogicExpression,
} from "../src/define.ts";

/**
 * Two kinds of coverage:
 *  - runtime: `jl.*` helpers produce the exact JSONLogic shapes a
 *    server would evaluate.
 *  - compile-time: literal object expressions type-check; malformed
 *    expressions don't (`@ts-expect-error` markers).
 */

describe("jl helpers — runtime shape", () => {
  test("var: with and without fallback", () => {
    expect(jl.var("input.kind")).toEqual({ var: "input.kind" });
    expect(jl.var("input.kind", "default")).toEqual({
      var: ["input.kind", "default"],
    });
  });

  test("eq / neq / strict variants", () => {
    expect(jl.eq("a", "b")).toEqual({ "==": ["a", "b"] });
    expect(jl.strictEq("a", "b")).toEqual({ "===": ["a", "b"] });
    expect(jl.neq("a", "b")).toEqual({ "!=": ["a", "b"] });
    expect(jl.strictNeq("a", "b")).toEqual({ "!==": ["a", "b"] });
  });

  test("logical operators compose naturally", () => {
    const expr = jl.and(
      jl.gt(jl.var("input.qty"), 0),
      jl.eq(jl.var("input.status"), "ok"),
    );
    expect(expr).toEqual({
      and: [
        { ">": [{ var: "input.qty" }, 0] },
        { "==": [{ var: "input.status" }, "ok"] },
      ],
    });
  });

  test("if produces the multi-arg form", () => {
    expect(jl.if(jl.var("x"), "yes", "no")).toEqual({
      if: [{ var: "x" }, "yes", "no"],
    });
  });

  test("between / betweenInclusive emit chained comparisons", () => {
    expect(jl.between(0, jl.var("x"), 10)).toEqual({
      "<": [0, { var: "x" }, 10],
    });
    expect(jl.betweenInclusive(0, jl.var("x"), 10)).toEqual({
      "<=": [0, { var: "x" }, 10],
    });
  });

  test("array iteration: map, filter, reduce", () => {
    expect(jl.map(jl.var("xs"), jl.add(jl.var(""), 1))).toEqual({
      map: [{ var: "xs" }, { "+": [{ var: "" }, 1] }],
    });
    expect(jl.filter(jl.var("xs"), jl.gt(jl.var(""), 0))).toEqual({
      filter: [{ var: "xs" }, { ">": [{ var: "" }, 0] }],
    });
    expect(jl.reduce(jl.var("xs"), jl.add(jl.var("current"), jl.var("accumulator")), 0))
      .toEqual({
        reduce: [
          { var: "xs" },
          { "+": [{ var: "current" }, { var: "accumulator" }] },
          0,
        ],
      });
  });

  test("substr: with and without length", () => {
    expect(jl.substr("hello", 0)).toEqual({ substr: ["hello", 0] });
    expect(jl.substr("hello", 0, 3)).toEqual({ substr: ["hello", 0, 3] });
  });

  test("missing / missingSome", () => {
    expect(jl.missing("a", "b")).toEqual({ missing: ["a", "b"] });
    expect(jl.missingSome(2, ["a", "b", "c"])).toEqual({
      missing_some: [2, ["a", "b", "c"]],
    });
  });
});

describe("JSONLogicExpression — compile-time", () => {
  test("literal object form: well-formed expressions type-check", () => {
    const expressions: JSONLogicExpression[] = [
      { "==": [{ var: "input.kind" }, "press"] },
      { and: [{ ">": [{ var: "x" }, 0] }, { "<": [{ var: "x" }, 100] }] },
      { if: [{ var: "x" }, "yes", "no"] },
      { var: "input.kind" },
      { var: ["input.kind", "default"] },
      { map: [{ var: "xs" }, { "+": [{ var: "" }, 1] }] },
      { "!": { var: "input.flag" } },
    ];
    // Runtime sanity: every element is a non-null object.
    for (const e of expressions) expect(typeof e).toBe("object");
  });

  test("compile-time: defineNode on `condition` accepts JSONLogic-shaped config", () => {
    const node = defineNode({
      id: "n",
      name: "If qty positive",
      type: "condition",
      config: { expression: { ">": [{ var: "input.qty" }, 0] } },
    });
    expect(node.type).toBe("condition");
  });

  test("compile-time: defineNode accepts jl-built expressions", () => {
    const node = defineNode({
      id: "n",
      name: "If qty positive",
      type: "condition",
      config: { expression: jl.gt(jl.var("input.qty"), 0) },
    });
    expect(node.type).toBe("condition");
  });

  test("compile-time: assert accepts a JSONLogic condition", () => {
    const node = defineNode({
      id: "guard",
      name: "Guard",
      type: "assert",
      config: {
        condition: jl.and(
          jl.truthy(jl.var("input.user")),
          jl.gt(jl.var("input.qty"), 0),
        ),
        message: "Invalid input",
      },
    });
    expect(node.type).toBe("assert");
  });

  test("compile-time: switch.cases entries accept JSONLogic expressions", () => {
    const node = defineNode({
      id: "sw",
      name: "Switch",
      type: "switch",
      config: {
        cases: [
          { name: "low", expression: jl.lt(jl.var("input.qty"), 10) },
          { name: "high", expression: jl.gte(jl.var("input.qty"), 10) },
        ],
        default: "low",
      },
    });
    expect(node.type).toBe("switch");
  });

  test("compile-time: unknown operator key is rejected", () => {
    // @ts-expect-error — 'bogus' is not a recognised JSONLogic operator
    const bad: JSONLogicExpression = { bogus: [1, 2] };
    void bad;
    expect(true).toBe(true);
  });

  test("compile-time: wrong arity is rejected (== requires exactly 2 operands)", () => {
    // @ts-expect-error — "==" needs a 2-tuple
    const bad: JSONLogicExpression = { "==": [1, 2, 3] };
    void bad;
    expect(true).toBe(true);
  });
});
