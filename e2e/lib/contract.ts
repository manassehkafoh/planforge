// OpenAPI response-schema validation (ajv) built from api/openapi.yaml. OAS3.0 -> JSON-Schema adaptation is explicit and documented.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ROOT } from './harness.ts';

export const oas: any = parse(readFileSync(ROOT + '/api/openapi.yaml', 'utf8'));

// OAS 3.0 -> JSON Schema 2019 differences handled here:
//  * exclusiveMinimum/Maximum are booleans in OAS3.0 -> converted to numeric form
//  * nullable handled natively by ajv ("nullable" keyword); readOnly/discriminator/example are annotations (ignored)
function adapt(n: any): any {
  if (Array.isArray(n)) return n.map(adapt);
  if (n && typeof n === 'object') {
    const o: any = {};
    for (const [k, v] of Object.entries(n)) o[k] = adapt(v);
    if (o.exclusiveMinimum === true && typeof o.minimum === 'number') { o.exclusiveMinimum = o.minimum; delete o.minimum; }
    else if (o.exclusiveMinimum === false) delete o.exclusiveMinimum;
    if (o.exclusiveMaximum === true && typeof o.maximum === 'number') { o.exclusiveMaximum = o.maximum; delete o.maximum; }
    else if (o.exclusiveMaximum === false) delete o.exclusiveMaximum;
    return o;
  }
  return n;
}
const doc = adapt(oas);
const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false, discriminator: false });
addFormats(ajv);
// OAS declares plan instants as `date-time` yet defines them as NAIVE local (docs/07 section 1.8). RFC 3339 requires an offset, so the
// stock format would reject every plan instant. We accept naive local OR offset date-time here and assert system timestamps (with offset) separately.
const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const RFC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
ajv.addFormat('date-time', { type: 'string', validate: (s: string) => (NAIVE.test(s) || RFC.test(s)) && !Number.isNaN(Date.parse(s.replace(/Z|[+-]\d{2}:\d{2}$/, '') + 'Z')) });
ajv.addFormat('int64', { type: 'number', validate: (n: number) => Number.isInteger(n) });
ajv.addFormat('int32', { type: 'number', validate: (n: number) => Number.isInteger(n) });
ajv.addFormat('uri-reference', true);
export const isNaiveLocal = (s: unknown) => typeof s === 'string' && NAIVE.test(s);
export const isRfc3339 = (s: unknown) => typeof s === 'string' && RFC.test(s);
ajv.addSchema(doc, 'oas');

const cache = new Map<string, any>();
const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
function pointerFor(path: string, method: string, status: number, ct: string) {
  return `oas#/paths/${esc(path)}/${method.toLowerCase()}/responses/${status}/content/${esc(ct)}/schema`;
}
export function validateAgainst(ref: string, data: unknown): string[] {
  let v = cache.get(ref);
  if (!v) { v = ajv.compile({ $ref: ref }); cache.set(ref, v); }
  if (v(data)) return [];
  return (v.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}${e.params && Object.keys(e.params).length ? ' ' + JSON.stringify(e.params) : ''}`);
}
/** Validate a response body against the schema declared for (path template, method, status). Returns error list ([] = valid). */
export function validateResponse(pathTemplate: string, method: string, status: number, body: unknown, ct = 'application/json'): string[] {
  const op = oas.paths?.[pathTemplate]?.[method.toLowerCase()];
  if (!op) return [`operation ${method} ${pathTemplate} not in OpenAPI`];
  const r = op.responses?.[String(status)];
  if (!r) return [`status ${status} not declared for ${method} ${pathTemplate} (declared: ${Object.keys(op.responses).join(',')})`];
  if (r.$ref) return validateAgainst('oas#/components/schemas/Problem', body);
  if (!r.content?.[ct]) return [`content type ${ct} not declared for ${status}`];
  return validateAgainst(pointerFor(pathTemplate, method, status, ct), body);
}
export const validateSchemaName = (name: string, body: unknown) => validateAgainst(`oas#/components/schemas/${name}`, body);
export const operations: Array<{ path: string; method: string; operationId: string }> = [];
for (const [p, item] of Object.entries<any>(oas.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]) operations.push({ path: p, method: m.toUpperCase(), operationId: item[m].operationId });
