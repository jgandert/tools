const NUMBER_PATTERN = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/y;
const ANNOTATION_PATTERN = /[#@][A-Za-z_][A-Za-z0-9_]*/y;
const ANNOTATIONS_PATTERN = /[#@](?:[A-Za-z_][A-Za-z0-9_]*|`[^`]*`)/g;
const LOG_BASE_FUNCTION_PATTERN = /^log(\d+)$/i;
const MAX_FACTORIAL_INPUT = 170;
const VARIADIC_MATH_FUNCTIONS = new Set(["hypot", "max", "min"]);
const CONSTANT_VALUES = Object.freeze({
    e: Math.E,
    infinity: Infinity,
    ln2: Math.LN2,
    ln10: Math.LN10,
    log2e: Math.LOG2E,
    log10e: Math.LOG10E,
    phi: (1 + Math.sqrt(5)) / 2,
    pi: Math.PI,
    sqrt1_2: Math.SQRT1_2,
    sqrt2: Math.SQRT2,
    tau: 2 * Math.PI,
});
const SYMBOL_CONSTANT_VALUES = Object.freeze({
    "π": Math.PI,
    "τ": 2 * Math.PI,
    "φ": (1 + Math.sqrt(5)) / 2,
});

class ExpressionParser {
    constructor(source) {
        this.source = source;
        this.position = 0;
        this.variables = new Map();
    }

    parse() {
        this.skipWhitespace();
        if (this.position === this.source.length) {
            throw new SyntaxError("Expression is empty");
        }

        this.parseVariableDeclarations();
        const tree = this.parseBitwiseOr();
        this.skipWhitespace();
        if (this.position !== this.source.length) {
            throw this.unexpectedToken();
        }
        return tree;
    }

    parseVariableDeclarations() {
        while (true) {
            const declaration = this.readVariableDeclarationStart();
            if (declaration === null) {
                return;
            }

            const valueNode = this.parseBitwiseOr();
            const value = evaluate(valueNode);
            this.skipWhitespace();
            if (this.source[this.position] !== ";") {
                throw new SyntaxError(`Expected ";" at position ${this.position}`);
            }
            this.position++;
            this.variables.set(declaration.name, {
                tag: declaration.tag ?? valueNode.tag ?? declaration.name,
                value,
            });
            this.skipWhitespace();
        }
    }

    readVariableDeclarationStart() {
        const start = this.position;
        if (!this.isIdentifierStart()) {
            return null;
        }

        const name = this.readIdentifier();
        const tag = this.readAnnotation();
        this.skipWhitespace();
        if (this.source[this.position] !== "=") {
            const token = this.source[this.position];
            if (token === ";" || this.isIdentifierStart() || /[\d.]/.test(token ?? "")) {
                throw new SyntaxError(`Expected "=" at position ${this.position}`);
            }
            this.position = start;
            return null;
        }
        this.position++;
        return { name, tag };
    }

    parseBitwiseOr() {
        let left = this.parseBitwiseXor();

        while (this.readExactOperator(["|"])) {
            left = { op: "|", p: [left, this.parseBitwiseXor()] };
        }
        return left;
    }

    parseBitwiseXor() {
        let left = this.parseBitwiseAnd();

        while (this.readExactOperator(["^"])) {
            left = { op: "^", p: [left, this.parseBitwiseAnd()] };
        }
        return left;
    }

    parseBitwiseAnd() {
        let left = this.parseShift();

        while (this.readExactOperator(["&"])) {
            left = { op: "&", p: [left, this.parseShift()] };
        }
        return left;
    }

    parseShift() {
        let left = this.parseAdditive();

        while (true) {
            const operator = this.readExactOperator([">>>", "<<", ">>"]);
            if (!operator) {
                return left;
            }
            left = { op: operator, p: [left, this.parseAdditive()] };
        }
    }

    parseAdditive() {
        let left = this.parseMultiplicative();

        while (true) {
            const operator = this.readOperator("+-");
            if (!operator) {
                return left;
            }
            left = { op: operator, p: [left, this.parseMultiplicative()] };
        }
    }

    parseMultiplicative() {
        let left = this.parseUnary();

        while (true) {
            const operator = this.readMultiplicativeOperator();
            if (!operator) {
                return left;
            }
            left = { op: operator, p: [left, this.parseUnary()] };
        }
    }

    parseUnary() {
        const operator = this.readOperator("+-~");
        if (!operator) {
            return this.parsePower();
        }
        return { op: operator, p: [this.parseUnary()] };
    }

    parsePower() {
        const left = this.parsePostfix();
        this.skipWhitespace();
        if (!this.source.startsWith("**", this.position)) {
            return left;
        }
        this.position += 2;
        return { op: "pow", p: [left, this.parseUnary()] };
    }

    parsePostfix() {
        let value = this.parsePrimary();

        while (this.readExactOperator(["!"])) {
            value = { op: "!", p: [value] };
        }
        return value;
    }

    parsePrimary() {
        this.skipWhitespace();

        let value;
        if (this.source[this.position] === "(") {
            this.position++;
            value = this.parseBitwiseOr();
            this.skipWhitespace();
            if (this.source[this.position] !== ")") {
                throw new SyntaxError(`Expected ")" at position ${this.position}`);
            }
            this.position++;
        } else if (this.source[this.position] === "|") {
            this.position++;
            value = { op: "abs", p: [this.parseBitwiseXor()] };
            this.skipWhitespace();
            if (this.source[this.position] !== "|") {
                throw new SyntaxError(`Expected "|" at position ${this.position}`);
            }
            this.position++;
        } else if (Object.hasOwn(SYMBOL_CONSTANT_VALUES, this.source[this.position])) {
            value = { v: SYMBOL_CONSTANT_VALUES[this.source[this.position]] };
            this.position++;
        } else if (this.isIdentifierStart()) {
            value = this.readIdentifierOrFunction();
        } else {
            value = this.readNumber();
        }

        const tag = this.readAnnotation();
        if (tag === null) {
            return value;
        }
        return { ...value, tag };
    }

    readIdentifierOrFunction() {
        const name = this.readIdentifier();
        this.skipWhitespace();
        if (this.source[this.position] !== "(") {
            if (this.variables.has(name)) {
                const variable = this.variables.get(name);
                return { v: variable.value, tag: variable.tag };
            }
            const normalizedName = name.toLowerCase();
            if (Object.hasOwn(CONSTANT_VALUES, normalizedName)) {
                return { v: CONSTANT_VALUES[normalizedName] };
            }
            return { v: name };
        }

        this.position++;
        const parameters = [];
        this.skipWhitespace();
        if (this.source[this.position] === ")") {
            this.position++;
            return this.createFunctionNode(name, parameters);
        }

        while (true) {
            parameters.push(this.parseBitwiseOr());
            this.skipWhitespace();
            if (this.source[this.position] === ")") {
                this.position++;
                return this.createFunctionNode(name, parameters);
            }
            if (this.source[this.position] !== ",") {
                throw new SyntaxError(`Expected "," or ")" at position ${this.position}`);
            }
            this.position++;
        }
    }

    createFunctionNode(name, parameters) {
        const logBaseMatch = LOG_BASE_FUNCTION_PATTERN.exec(name);
        if (!logBaseMatch) {
            return { op: name, p: parameters };
        }
        if (parameters.length !== 1) {
            throw new SyntaxError(`${name} expects one parameter`);
        }
        return {
            op: "log",
            p: [parameters[0], { v: Number(logBaseMatch[1]) }],
        };
    }

    readIdentifier() {
        IDENTIFIER_PATTERN.lastIndex = this.position;
        const match = IDENTIFIER_PATTERN.exec(this.source);
        this.position = IDENTIFIER_PATTERN.lastIndex;
        return match[0];
    }

    readNumber() {
        NUMBER_PATTERN.lastIndex = this.position;
        const match = NUMBER_PATTERN.exec(this.source);
        if (!match) {
            throw this.unexpectedToken();
        }
        this.position = NUMBER_PATTERN.lastIndex;
        return { v: Number(match[0]) };
    }

    readAnnotation() {
        this.skipWhitespace();
        if (!["#", "@"].includes(this.source[this.position])) {
            return null;
        }
        if (this.source[this.position + 1] === "`") {
            return this.readQuotedAnnotation();
        }
        ANNOTATION_PATTERN.lastIndex = this.position;
        const match = ANNOTATION_PATTERN.exec(this.source);
        if (!match) {
            return null;
        }
        this.position = ANNOTATION_PATTERN.lastIndex;
        return match[0].slice(1);
    }

    readQuotedAnnotation() {
        const start = this.position + 2;
        const end = this.source.indexOf("`", start);
        if (end === -1) {
            throw new SyntaxError(`Expected "\`" at position ${this.source.length}`);
        }
        this.position = end + 1;
        return this.source.slice(start, end);
    }

    readOperator(operators) {
        this.skipWhitespace();
        const operator = this.source[this.position];
        if (!operators.includes(operator)) {
            return null;
        }
        this.position++;
        return operator;
    }

    readMultiplicativeOperator() {
        this.skipWhitespace();
        if (this.source.startsWith("**", this.position)) {
            return null;
        }
        return this.readExactOperator(["//", "*", "/", "%"]);
    }

    readExactOperator(operators) {
        this.skipWhitespace();
        const operator = operators.find(candidate => this.source.startsWith(candidate, this.position));
        if (!operator) {
            return null;
        }
        this.position += operator.length;
        return operator;
    }

    isIdentifierStart() {
        return /[A-Za-z_]/.test(this.source[this.position] ?? "");
    }

    skipWhitespace() {
        while (/\s/.test(this.source[this.position] ?? "")) {
            this.position++;
        }
    }

    unexpectedToken() {
        const token = this.source[this.position] ?? "end of input";
        return new SyntaxError(`Unexpected ${JSON.stringify(token)} at position ${this.position}`);
    }
}

export function parseExpression(source) {
    if (typeof source !== "string") {
        throw new TypeError("Expression must be a string");
    }
    return new ExpressionParser(source).parse();
}

export function removeAnnotations(source) {
    return source.replace(ANNOTATIONS_PATTERN, "");
}

function requireParameterCount(operation, parameters, expectedCounts) {
    if (expectedCounts.includes(parameters.length)) {
        return;
    }
    throw new TypeError(`Operator "${operation}" received ${parameters.length} parameters`);
}

function factorial(value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError("Factorial requires a nonnegative integer");
    }
    if (value > MAX_FACTORIAL_INPUT) {
        throw new RangeError(`Factorial input must not exceed ${MAX_FACTORIAL_INPUT}`);
    }

    let result = 1;
    for (let factor = 2; factor <= value; factor++) {
        result *= factor;
    }
    return result;
}

function calculate(operation, parameters) {
    if (operation === "+") {
        requireParameterCount(operation, parameters, [1, 2]);
        return parameters.length === 1 ? +parameters[0] : parameters[0] + parameters[1];
    }
    if (operation === "-") {
        requireParameterCount(operation, parameters, [1, 2]);
        return parameters.length === 1 ? -parameters[0] : parameters[0] - parameters[1];
    }
    if (operation === "*") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] * parameters[1];
    }
    if (operation === "/") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] / parameters[1];
    }
    if (operation === "%") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] % parameters[1];
    }
    if (operation === "//") {
        requireParameterCount(operation, parameters, [2]);
        return Math.floor(parameters[0] / parameters[1]);
    }
    if (operation === "!") {
        requireParameterCount(operation, parameters, [1]);
        return factorial(parameters[0]);
    }
    if (operation === "~") {
        requireParameterCount(operation, parameters, [1]);
        return ~parameters[0];
    }
    if (operation === "<<") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] << parameters[1];
    }
    if (operation === ">>") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] >> parameters[1];
    }
    if (operation === ">>>") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] >>> parameters[1];
    }
    if (operation === "&") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] & parameters[1];
    }
    if (operation === "^") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] ^ parameters[1];
    }
    if (operation === "|") {
        requireParameterCount(operation, parameters, [2]);
        return parameters[0] | parameters[1];
    }
    if (operation === "log") {
        requireParameterCount(operation, parameters, [1, 2]);
        if (parameters.length === 1) {
            return Math.log(parameters[0]);
        }
        return Math.log(parameters[0]) / Math.log(parameters[1]);
    }

    const mathFunction = Object.hasOwn(Math, operation) ? Math[operation] : null;
    if (typeof mathFunction !== "function") {
        throw new RangeError(`Unknown operation "${operation}"`);
    }
    if (VARIADIC_MATH_FUNCTIONS.has(operation)) {
        if (parameters.length === 0) {
            throw new TypeError(`Operator "${operation}" received 0 parameters`);
        }
    } else {
        requireParameterCount(operation, parameters, [mathFunction.length]);
    }
    return mathFunction(...parameters);
}

export function evaluate(tree) {
    if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
        throw new TypeError("Tree must be an object");
    }
    if (!("op" in tree)) {
        if (!("v" in tree)) {
            throw new TypeError("Value node must contain a v key");
        }
        return tree.v;
    }
    if (typeof tree.op !== "string" || !Array.isArray(tree.p)) {
        throw new TypeError("Operation node must contain an op string and p array");
    }

    const parameters = tree.p.map(parameter => evaluate(parameter));
    if (parameters.some(parameter => typeof parameter !== "number")) {
        throw new TypeError(`Operation "${tree.op}" requires numeric parameters`);
    }
    tree.v = calculate(tree.op, parameters);
    return tree.v;
}
