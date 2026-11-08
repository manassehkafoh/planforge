/**
 * Sandboxed formula language for custom fields (replaces the legacy dynamic-code evaluation, threat T8).
 *
 * Grammar (no loops, no assignment, no user-defined functions, no property access, no host objects):
 *   expr    := or ( '?' expr ':' expr )?
 *   or      := and ( '||' and )*        and := cmp ( '&&' cmp )*
 *   cmp     := add ( ('=='|'!='|'<'|'<='|'>'|'>=') add )?
 *   add     := mul ( ('+'|'-') mul )*   mul := unary ( ('*'|'/'|'%') unary )*
 *   unary   := ('-'|'!') unary | primary
 *   primary := number | string | true | false | null | field | NAME '(' args ')' | '(' expr ')'
 * Fields are plain identifiers looked up in the supplied record (own enumerable data properties only).
 * Functions: MIN MAX ROUND ABS FLOOR CEIL IF COALESCE CONCAT LEN UPPER LOWER.
 * Limits: source length, AST depth and evaluation steps are bounded; every violation is a FormulaError.
 */
export type Value = number | string | boolean | null;
export class FormulaError extends Error {
  code: 'SYNTAX' | 'LIMIT' | 'TYPE' | 'UNKNOWN_FUNCTION' | 'DIV_ZERO';
  constructor(code: FormulaError['code'], message: string) { super(message); this.code = code; }
}

type Node =
  | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'lit'; v: boolean | null }
  | { k: 'field'; name: string } | { k: 'un'; op: '-' | '!'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node } | { k: 'call'; fn: string; args: Node[] };

export const LIMITS = { source: 2000, depth: 32, steps: 5000 };

interface Tok { t: 'num' | 'str' | 'id' | 'op' | 'end'; v: string }
function lex(src: string): Tok[] {
  if (src.length > LIMITS.source) throw new FormulaError('LIMIT', 'formula too long');
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*)|(\|\||&&|==|!=|<=|>=|[-+*/%()<>!?:,]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new FormulaError('SYNTAX', `unexpected character at ${i}`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2].replace(/\\(.)/g, '$1') });
    else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
    else out.push({ t: 'op', v: m[4] });
  }
  out.push({ t: 'end', v: '' });
  return out;
}

export function parse(src: string): Node {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const eat = (v?: string) => { const t = toks[i]; if (v !== undefined && t.v !== v) throw new FormulaError('SYNTAX', `expected '${v}' but found '${t.v || 'end'}'`); i++; return t; };
  const guard = (d: number) => { if (d > LIMITS.depth) throw new FormulaError('LIMIT', 'expression nested too deeply'); };
  const expr = (d: number): Node => {
    guard(d);
    const c = or(d + 1);
    if (peek().t === 'op' && peek().v === '?') { eat('?'); const a = expr(d + 1); eat(':'); const b = expr(d + 1); return { k: 'cond', c, a, b }; }
    return c;
  };
  const binary = (next: (d: number) => Node, ops: string[]) => (d: number): Node => {
    guard(d);
    let a = next(d + 1);
    while (peek().t === 'op' && ops.includes(peek().v)) { const op = eat().v; a = { k: 'bin', op, a, b: next(d + 1) }; }
    return a;
  };
  const unary = (d: number): Node => {
    guard(d);
    if (peek().t === 'op' && (peek().v === '-' || peek().v === '!')) { const op = eat().v as '-' | '!'; return { k: 'un', op, a: unary(d + 1) }; }
    return primary(d + 1);
  };
  const primary = (d: number): Node => {
    guard(d);
    const t = eat();
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (peek().t === 'op' && peek().v === '(') {
        eat('(');
        const args: Node[] = [];
        if (!(peek().t === 'op' && peek().v === ')')) { args.push(expr(d + 1)); while (peek().v === ',') { eat(','); args.push(expr(d + 1)); } }
        eat(')');
        return { k: 'call', fn: t.v.toUpperCase(), args };
      }
      return { k: 'field', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') { const e = expr(d + 1); eat(')'); return e; }
    throw new FormulaError('SYNTAX', `unexpected '${t.v || 'end'}'`);
  };
  const mul = binary(unary, ['*', '/', '%']);
  const add = binary(mul, ['+', '-']);
  const cmp = binary(add, ['==', '!=', '<=', '>=', '<', '>']);
  const and = binary(cmp, ['&&']);
  const or = binary(and, ['||']);
  const root = expr(0);
  if (peek().t !== 'end') throw new FormulaError('SYNTAX', `unexpected '${peek().v}'`);
  return root;
}

const num = (v: Value): number => { if (typeof v !== 'number' || Number.isNaN(v)) throw new FormulaError('TYPE', 'number expected'); return v; };
const str = (v: Value): string => { if (v === null) return ''; return String(v); };

export function evaluate(src: string | Node, fields: Record<string, Value> = {}): Value {
  const ast = typeof src === 'string' ? parse(src) : src;
  let steps = 0;
  const ev = (n: Node): Value => {
    if (++steps > LIMITS.steps) throw new FormulaError('LIMIT', 'evaluation step limit exceeded');
    switch (n.k) {
      case 'num': case 'str': case 'lit': return n.v;
      case 'field': return Object.prototype.hasOwnProperty.call(fields, n.name) ? fields[n.name] : null;
      case 'un': { const a = ev(n.a); return n.op === '-' ? -num(a) : !truthy(a); }
      case 'cond': return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
      case 'bin': {
        if (n.op === '&&') { const a = ev(n.a); return truthy(a) ? truthy(ev(n.b)) : false; }
        if (n.op === '||') { const a = ev(n.a); return truthy(a) ? true : truthy(ev(n.b)); }
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case '+': return typeof a === 'string' || typeof b === 'string' ? str(a) + str(b) : num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': { const d = num(b); if (d === 0) throw new FormulaError('DIV_ZERO', 'division by zero'); return num(a) / d; }
          case '%': { const d = num(b); if (d === 0) throw new FormulaError('DIV_ZERO', 'division by zero'); return num(a) % d; }
          case '==': return a === b;
          case '!=': return a !== b;
          default: {
            if (typeof a === 'string' && typeof b === 'string') return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b;
            const x = num(a), y = num(b);
            return n.op === '<' ? x < y : n.op === '<=' ? x <= y : n.op === '>' ? x > y : x >= y;
          }
        }
      }
      case 'call': return call(n.fn, n.args, ev);
    }
  };
  return ev(ast);
}

const truthy = (v: Value) => v !== null && v !== false && v !== 0 && v !== '';

function call(fn: string, args: Node[], ev: (n: Node) => Value): Value {
  const need = (min: number, max = min) => { if (args.length < min || args.length > max) throw new FormulaError('SYNTAX', `${fn} expects ${min === max ? min : `${min}-${max}`} argument(s)`); };
  switch (fn) {
    case 'IF': need(3); return truthy(ev(args[0])) ? ev(args[1]) : ev(args[2]);
    case 'COALESCE': { for (const a of args) { const v = ev(a); if (v !== null) return v; } return null; }
    case 'MIN': need(1, 50); return Math.min(...args.map((a) => num(ev(a))));
    case 'MAX': need(1, 50); return Math.max(...args.map((a) => num(ev(a))));
    case 'ROUND': { need(1, 2); const x = num(ev(args[0])), p = args[1] ? num(ev(args[1])) : 0; if (p < 0 || p > 10) throw new FormulaError('LIMIT', 'precision out of range'); const f = 10 ** p; return Math.round(x * f) / f; }
    case 'ABS': need(1); return Math.abs(num(ev(args[0])));
    case 'FLOOR': need(1); return Math.floor(num(ev(args[0])));
    case 'CEIL': need(1); return Math.ceil(num(ev(args[0])));
    case 'CONCAT': need(1, 50); return args.map((a) => str(ev(a))).join('');
    case 'LEN': need(1); return str(ev(args[0])).length;
    case 'UPPER': need(1); return str(ev(args[0])).toUpperCase();
    case 'LOWER': need(1); return str(ev(args[0])).toLowerCase();
    default: throw new FormulaError('UNKNOWN_FUNCTION', `unknown function ${fn}`);
  }
}
