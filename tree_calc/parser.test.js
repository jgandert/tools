import assert from "node:assert/strict";
import { evaluate, parseExpression, removeAnnotations } from "./parser.js";

function assertParsesAndEvaluates(expression, expectedTree, expectedValue) {
    const tree = parseExpression(expression);
    assert.deepEqual(tree, expectedTree);
    assert.equal(evaluate(tree), expectedValue);
}

const expected = {
    op: "+",
    p: [
        { op: "*", p: [{ v: 3 }, { v: 4 }] },
        { v: 5 },
    ],
};

for (const expression of [
    "3*4+5",
    "(3*4)+5",
]) {
    assert.deepEqual(parseExpression(expression), expected);
}

const taggedExpected = {
    op: "+",
    p: [
        {
            op: "*",
            p: [
                { v: 3, tag: "a" },
                { v: 4, tag: "b" },
            ],
            tag: "ab",
        },
        { v: 5, tag: "c" },
    ],
};

for (const expression of [
    "(3#a*4#b)#ab+5#c",
    "(3@a*4@b)@ab+5@c",
]) {
    assert.deepEqual(parseExpression(expression), taggedExpected);
}

assert.deepEqual(
    parseExpression("(3*4)#`this is a weird test, isn't it? \"no.\" she said.`"),
    {
        op: "*",
        p: [{ v: 3 }, { v: 4 }],
        tag: "this is a weird test, isn't it? \"no.\" she said.",
    },
);
assert.deepEqual(parseExpression("12@``"), { v: 12, tag: "" });

assertParsesAndEvaluates(
    "a = 2.2; (a + 4) * (a - 3)",
    {
        op: "*",
        p: [
            { op: "+", p: [{ v: 2.2, tag: "a" }, { v: 4 }] },
            { op: "-", p: [{ v: 2.2, tag: "a" }, { v: 3 }] },
        ],
    },
    (2.2 + 4) * (2.2 - 3),
);

assertParsesAndEvaluates(
    "a = 2; b = a + 3; b * a",
    {
        op: "*",
        p: [{ v: 5, tag: "b" }, { v: 2, tag: "a" }],
    },
    10,
);

for (const expression of [
    "ar#annual_rate = 3; ar + ar",
    "ar@annual_rate = 3; ar + ar",
]) {
    assertParsesAndEvaluates(
        expression,
        {
            op: "+",
            p: [
                { v: 3, tag: "annual_rate" },
                { v: 3, tag: "annual_rate" },
            ],
        },
        6,
    );
}

for (const expression of [
    "ar#`annual rate in €` = 3; ar",
    "ar@`annual rate in €` = 3; ar",
]) {
    assertParsesAndEvaluates(
        expression,
        { v: 3, tag: "annual rate in €" },
        3,
    );
}
assertParsesAndEvaluates(
    "ar = 3@`annual rate in €`; ar",
    { v: 3, tag: "annual rate in €" },
    3,
);
assertParsesAndEvaluates(
    "ar#declaration_label = 3@value_label; ar",
    { v: 3, tag: "declaration_label" },
    3,
);
assertParsesAndEvaluates(
    "annual_rate = 3; annual_rate",
    { v: 3, tag: "annual_rate" },
    3,
);
assertParsesAndEvaluates(
    "ar#annual_rate = 3; ar#`rate for this row`",
    { v: 3, tag: "rate for this row" },
    3,
);
assertParsesAndEvaluates(
    "ar#annual_rate = 3; doubled = ar * 2; ar + doubled",
    {
        op: "+",
        p: [
            { v: 3, tag: "annual_rate" },
            { v: 6, tag: "doubled" },
        ],
    },
    9,
);

assert.equal(
    removeAnnotations("ar#annual_rate = 3; ar * 2"),
    "ar = 3; ar * 2",
);
assert.equal(
    evaluate(parseExpression(removeAnnotations("ar#annual_rate = 3; ar * 2"))),
    6,
);
assert.equal(
    removeAnnotations("ar#`annual rate in €` = 3; ar@`row rate` * 2#factor"),
    "ar = 3; ar * 2",
);

assert.deepEqual(
    parseExpression("2 + 3 * (4 + 1)"),
    {
        op: "+",
        p: [
            { v: 2 },
            {
                op: "*",
                p: [
                    { v: 3 },
                    { op: "+", p: [{ v: 4 }, { v: 1 }] },
                ],
            },
        ],
    },
);

assert.deepEqual(
    parseExpression("2 + 3 * 4 ** 2"),
    {
        op: "+",
        p: [
            { v: 2 },
            {
                op: "*",
                p: [
                    { v: 3 },
                    { op: "pow", p: [{ v: 4 }, { v: 2 }] },
                ],
            },
        ],
    },
);

assert.deepEqual(
    parseExpression("2 + 3 * (8 - 2 ** 2) / 2 % 5 - 1"),
    {
        op: "-",
        p: [
            {
                op: "+",
                p: [
                    { v: 2 },
                    {
                        op: "%",
                        p: [
                            {
                                op: "/",
                                p: [
                                    {
                                        op: "*",
                                        p: [
                                            { v: 3 },
                                            {
                                                op: "-",
                                                p: [
                                                    { v: 8 },
                                                    { op: "pow", p: [{ v: 2 }, { v: 2 }] },
                                                ],
                                            },
                                        ],
                                    },
                                    { v: 2 },
                                ],
                            },
                            { v: 5 },
                        ],
                    },
                ],
            },
            { v: 1 },
        ],
    },
);

assertParsesAndEvaluates(
    "5 + sqrt(144) / 2 ** 3 * (3! - 2) % 4 - floor(7.8)",
    {
        op: "-",
        p: [
            {
                op: "+",
                p: [
                    { v: 5 },
                    {
                        op: "%",
                        p: [
                            {
                                op: "*",
                                p: [
                                    {
                                        op: "/",
                                        p: [
                                            { op: "sqrt", p: [{ v: 144 }] },
                                            { op: "pow", p: [{ v: 2 }, { v: 3 }] },
                                        ],
                                    },
                                    {
                                        op: "-",
                                        p: [
                                            { op: "!", p: [{ v: 3 }] },
                                            { v: 2 },
                                        ],
                                    },
                                ],
                            },
                            { v: 4 },
                        ],
                    },
                ],
            },
            { op: "floor", p: [{ v: 7.8 }] },
        ],
    },
    0,
);

const absoluteLogTree = {
    op: "-",
    p: [
        {
            op: "+",
            p: [
                { op: "abs", p: [{ op: "-", p: [{ v: 8 }] }] },
                {
                    op: "/",
                    p: [
                        {
                            op: "*",
                            p: [
                                { op: "log", p: [{ v: 32 }, { v: 2 }] },
                                { op: "pow", p: [{ v: 3 }, { v: 2 }] },
                            ],
                        },
                        { op: "sqrt", p: [{ v: 9 }] },
                    ],
                },
            ],
        },
        {
            op: "%",
            p: [
                {
                    op: "*",
                    p: [
                        {
                            op: "sin",
                            p: [{ op: "/", p: [{ v: Math.PI }, { v: 2 }] }],
                        },
                        { v: 5 },
                    ],
                },
                { v: 3 },
            ],
        },
    ],
};

for (const expression of [
    "|-8| + log2(32) * 3 ** 2 / sqrt(9) - sin(π / 2) * 5 % 3",
    "|-8| + log2(32) * 3 ** 2 / sqrt(9) - sin(pi / 2) * 5 % 3",
]) {
    assertParsesAndEvaluates(expression, absoluteLogTree, 21);
}

assertParsesAndEvaluates(
    "~5 + sqrt(64) << 2 ** 2 // 4 & 15 ^ 3",
    {
        op: "^",
        p: [
            {
                op: "&",
                p: [
                    {
                        op: "<<",
                        p: [
                            {
                                op: "+",
                                p: [
                                    { op: "~", p: [{ v: 5 }] },
                                    { op: "sqrt", p: [{ v: 64 }] },
                                ],
                            },
                            {
                                op: "//",
                                p: [
                                    { op: "pow", p: [{ v: 2 }, { v: 2 }] },
                                    { v: 4 },
                                ],
                            },
                        ],
                    },
                    { v: 15 },
                ],
            },
            { v: 3 },
        ],
    },
    7,
);

for (const [constant, value] of [
    ["pi", Math.PI],
    ["π", Math.PI],
    ["tau", 2 * Math.PI],
    ["τ", 2 * Math.PI],
    ["e", Math.E],
    ["phi", (1 + Math.sqrt(5)) / 2],
    ["φ", (1 + Math.sqrt(5)) / 2],
    ["ln2", Math.LN2],
    ["ln10", Math.LN10],
    ["log2e", Math.LOG2E],
    ["log10e", Math.LOG10E],
    ["sqrt1_2", Math.SQRT1_2],
    ["sqrt2", Math.SQRT2],
    ["infinity", Infinity],
]) {
    assertParsesAndEvaluates(constant, { v: value }, value);
}

assert.deepEqual(
    parseExpression("2 ** 3 ** 4"),
    {
        op: "pow",
        p: [
            { v: 2 },
            { op: "pow", p: [{ v: 3 }, { v: 4 }] },
        ],
    },
);

assert.deepEqual(
    parseExpression("-2 ** 2"),
    {
        op: "-",
        p: [
            { op: "pow", p: [{ v: 2 }, { v: 2 }] },
        ],
    },
);

assert.deepEqual(
    parseExpression("2 ** -3"),
    {
        op: "pow",
        p: [
            { v: 2 },
            { op: "-", p: [{ v: 3 }] },
        ],
    },
);

assert.deepEqual(
    parseExpression("max(1, sqrt(4), pow(2, 3))"),
    {
        op: "max",
        p: [
            { v: 1 },
            { op: "sqrt", p: [{ v: 4 }] },
            { op: "pow", p: [{ v: 2 }, { v: 3 }] },
        ],
    },
);

assert.deepEqual(
    parseExpression("a#first % 4@second / 2"),
    {
        op: "/",
        p: [
            {
                op: "%",
                p: [
                    { v: "a", tag: "first" },
                    { v: 4, tag: "second" },
                ],
            },
            { v: 2 },
        ],
    },
);

assert.deepEqual(parseExpression("5"), { v: 5 });

const evaluationTree = parseExpression("3+4*5");
assert.equal(evaluate(evaluationTree.p[1]), 20);
assert.deepEqual(
    evaluationTree,
    {
        op: "+",
        p: [
            { v: 3 },
            { op: "*", p: [{ v: 4 }, { v: 5 }], v: 20 },
        ],
    },
);
assert.equal(evaluate(evaluationTree), 23);
assert.deepEqual(
    evaluationTree,
    {
        op: "+",
        p: [
            { v: 3 },
            { op: "*", p: [{ v: 4 }, { v: 5 }], v: 20 },
        ],
        v: 23,
    },
);

const functionTree = parseExpression("sqrt(9) + pow(2, 3)");
assert.equal(evaluate(functionTree), 11);
assert.equal(functionTree.p[0].v, 3);
assert.equal(functionTree.p[1].v, 8);

const baseThreeLogTree = {
    op: "log",
    p: [{ v: 729 }, { v: 3 }],
};
assertParsesAndEvaluates("log3(729)", baseThreeLogTree, 6);
assertParsesAndEvaluates("log(729, 3)", baseThreeLogTree, 6);
assertParsesAndEvaluates(
    "log(729, 3.2)",
    { op: "log", p: [{ v: 729 }, { v: 3.2 }] },
    Math.log(729) / Math.log(3.2),
);
assertParsesAndEvaluates(
    "log(729)",
    { op: "log", p: [{ v: 729 }] },
    Math.log(729),
);

const taggedEvaluationTree = parseExpression("(3#a*4#b)#ab+5#c");
assert.equal(evaluate(taggedEvaluationTree), 17);
assert.equal(taggedEvaluationTree.p[0].v, 12);
assert.equal(taggedEvaluationTree.p[0].tag, "ab");
assert.equal(taggedEvaluationTree.p[1].tag, "c");

assert.equal(evaluate({ v: 4 }), 4);
assert.throws(() => evaluate({ op: "unknown", p: [{ v: 1 }] }), RangeError);
assert.throws(() => evaluate({ op: "+", p: [{ v: "a" }, { v: 1 }] }), TypeError);
assert.throws(() => evaluate(parseExpression("171!")), RangeError);
assert.throws(() => evaluate(parseExpression("sqrt(4, 9)")), TypeError);
assert.throws(() => evaluate(parseExpression("sin()")), TypeError);
assert.throws(() => evaluate(parseExpression("pow(2)")), TypeError);
assert.throws(() => evaluate(parseExpression("max()")), TypeError);
assert.equal(evaluate(parseExpression("max(4)")), 4);
assert.equal(evaluate(parseExpression("hypot(3, 4, 12)")), 13);

assert.throws(() => parseExpression("3+"), SyntaxError);
assert.throws(() => parseExpression("3 nope"), SyntaxError);
assert.throws(() => parseExpression("pow(2 3)"), SyntaxError);
assert.throws(() => parseExpression("3#`unfinished"), SyntaxError);
assert.throws(
    () => parseExpression("ar#`unfinished = 3; ar"),
    { name: "SyntaxError", message: "Expected \"`\" at position 22" },
);
assert.throws(
    () => parseExpression("ar# = 3; ar"),
    { name: "SyntaxError", message: "Unexpected \"#\" at position 2" },
);
assert.throws(
    () => parseExpression("ar@ = 3; ar"),
    { name: "SyntaxError", message: "Unexpected \"@\" at position 2" },
);
assert.throws(
    () => parseExpression("ar#annual_rate 3; ar"),
    { name: "SyntaxError", message: "Expected \"=\" at position 15" },
);
assert.throws(() => parseExpression("a = 2 a + 1"), SyntaxError);
assert.throws(() => parseExpression(""), SyntaxError);
assert.throws(() => parseExpression(null), TypeError);
