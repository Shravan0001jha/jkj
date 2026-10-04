#!/usr/bin/env node
// Compares the TypeScript contract (packages/shared/src) with the Swift models
// (IrisWorkplace/Model/Contract.swift, Events.swift, API.swift). Fails when:
//   - a string-union type has a member the Swift enum lacks, or vice versa;
//   - an interface has a field the Swift struct lacks, or vice versa;
//   - an optional/required mismatch (`x?:` vs a non-optional Swift field);
//   - a WORKPLACE_API key has no Swift counterpart;
//   - a socket event or command type is unknown to Events.swift.
// It runs before XCTest in `make test`, so drift breaks the run.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', '..', '..', 'packages', 'shared', 'src');
const ts = ['types.ts', 'protocol.ts', 'context.ts', 'workplace.ts', 'workplace-api.ts', 'workplace-v2.ts'].map(f => readFileSync(join(shared, f), 'utf8')).join('\n');
const swift = ['Model/Contract.swift', 'Model/ContractV2.swift', 'Model/Events.swift', 'Model/API.swift'].map(f => readFileSync(join(here, '..', 'IrisWorkplace', f), 'utf8')).join('\n');

const problems = [];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const tsClean = strip(ts);
const swiftClean = strip(swift);

// ---- Swift side ----
const swiftEnums = {};
for (const m of swiftClean.matchAll(/enum (\w+): (?:String|Int), Codable[^{]*\{([\s\S]*?)\n\}/g)) {
  const cases = [];
  for (const c of m[2].matchAll(/case ([^\n]+)/g)) {
    for (const part of c[1].split(',')) {
      const mm = part.trim().match(/^(\w+)(?:\s*=\s*"([^"]+)"|\s*=\s*(\d+))?/);
      if (mm) cases.push(mm[2] ?? (mm[3] !== undefined ? Number(mm[3]) : mm[1]));
    }
  }
  swiftEnums[m[1]] = cases;
}
const swiftStructs = {};
for (const m of swiftClean.matchAll(/struct (\w+)(?:: [^{]*)?\{([\s\S]*?)\n\}/g)) {
  const fields = {};
  for (const f of m[2].matchAll(/^\s{4}var (\w+): ([^\n{]+?)\s*$/gm)) fields[f[1]] = f[2].trim().endsWith('?');
  swiftStructs[m[1]] = fields;
}

// ---- TypeScript side ----
const tsUnions = {};
for (const m of tsClean.matchAll(/export type (\w+) =([^;]+);/g)) {
  const members = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]);
  const nums = [...m[2].matchAll(/\b(\d)\b/g)].map(x => Number(x[1]));
  if (members.length) tsUnions[m[1]] = members;
  else if (nums.length && !/\{/.test(m[2])) tsUnions[m[1]] = nums;
}
const tsInterfaces = {};
for (const m of tsClean.matchAll(/export interface (\w+)(?: extends (\w+))? \{/g)) {
  // Walk to the balanced closing brace so one-line interfaces parse too.
  let i = m.index + m[0].length, depth = 1;
  while (i < tsClean.length && depth > 0) { if (tsClean[i] === '{') depth++; else if (tsClean[i] === '}') depth--; i++; }
  const body = tsClean.slice(m.index + m[0].length, i - 1);
  const fields = {};
  depth = 0;
  for (const stmt of body.split(/[;\n]/)) {
    const t = stmt.trim();
    if (depth === 0) {
      const f = t.match(/^(\w+)(\?)?:/);
      if (f) fields[f[1]] = !!f[2];
    }
    depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
  }
  tsInterfaces[m[1]] = { fields, extends: m[2] };
}
for (const [name, def] of Object.entries(tsInterfaces)) {
  if (def.extends && tsInterfaces[def.extends]) def.fields = { ...tsInterfaces[def.extends].fields, ...def.fields };
}

// v2's `ActivityKind` (item activity) shares its name with protocol.ts's inline `ActivityEvent.kind`
// (Swift `ActivityKind`): compare it with the Swift `ItemActivityKind`.
{
  const v2 = strip(readFileSync(join(shared, 'workplace-v2.ts'), 'utf8')).match(/export type ActivityKind =([^;]+);/)?.[1] ?? '';
  tsUnions.ItemActivityKind = [...v2.matchAll(/'([^']+)'/g)].map(x => x[1]);
}
// Inline unions on fields become named Swift enums.
const inlineUnions = {
  'Unit.kind': 'UnitKind', 'InboxItem.state': 'InboxState', 'InboxAnswer.via': 'AnswerVia', 'OrgProposal.state': 'ProposalState',
  'Release.state': 'ReleaseState', 'LintFinding.severity': 'LintSeverity', 'Role.budgetClass': 'BudgetClass',
  'McpServer.transport': 'McpTransport', 'ActivityEvent.kind': 'ActivityKind',
  'SpendEntry.tag': 'SpendTag', 'RateLimitWindow.window': 'RateLimitWindowKind', 'RateLimitWindow.status': 'RateLimitStatus',
  'RoomThread.state': 'RoomThreadState',
  'InboxItem.urgency': 'InboxUrgency', 'RoomMessage.kind': 'RoomMessageKind', 'LogEntry.from': 'LogFrom',
  'Area.state': 'AreaState', 'PlanFlag.kind': 'PlanFlagKind', 'ReleasePostItem.kind': 'ReleaseItemKind',
};
for (const [key, swiftName] of Object.entries(inlineUnions)) {
  const [iface, field] = key.split('.');
  const src = tsClean.match(new RegExp(`export interface ${iface}[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  const line = src.match(new RegExp(`\\n\\s*${field}\\??: ([^;\\n]+)`))?.[1] ?? '';
  const members = [...line.matchAll(/'([^']+)'/g)].map(x => x[1]);
  if (members.length) tsUnions[swiftName] = members;
}
// Unions the Swift side names differently.
const unionAliases = { StallReason: ['idle', 'loop'], AlertLevel: ['info', 'needs-you', 'blocked', 'cap'] };
Object.assign(tsUnions, unionAliases);

// ---- Compare unions ----
const skipUnions = new Set(['WorkState', 'FeatureState', 'AssignmentState', 'ServerEvent', 'ClientCommand', 'WorkplaceServerEvent', 'WorkplaceClientCommand', 'PivotRows']);
for (const [name, members] of Object.entries(tsUnions)) {
  if (skipUnions.has(name)) continue;
  const sw = swiftEnums[name];
  if (!sw) { problems.push(`union ${name}: no Swift enum`); continue; }
  const a = new Set(members.map(String)), b = new Set(sw.map(String));
  for (const x of a) if (!b.has(x)) problems.push(`union ${name}: '${x}' missing from Swift`);
  // `unknown` is the client's own fallback for a value it does not know (LenientEnum), never sent.
  for (const x of b) if (!a.has(x) && x !== 'unknown') problems.push(`union ${name}: Swift has extra '${x}'`);
}
// WorkState = FeatureState | AssignmentState
{
  const want = new Set([...(tsUnions.FeatureState ?? []), ...(tsUnions.AssignmentState ?? [])]);
  const have = new Set(swiftEnums.WorkState ?? []);
  for (const x of want) if (!have.has(x)) problems.push(`union WorkState: '${x}' missing from Swift`);
  for (const x of have) if (!want.has(x) && x !== 'unknown') problems.push(`union WorkState: Swift has extra '${x}'`);
}
{
  const have = new Set(swiftEnums.PivotRows ?? []);
  for (const x of ['charter', 'platform', 'team']) if (!have.has(x)) problems.push(`union PivotRows: '${x}' missing from Swift`);
}

// ---- Compare interfaces ----
const structAliases = { Attachment: 'Attachment', Coverage: 'Coverage' };
const skipInterfaces = new Set(['CreateAgentRequest', 'SendMessageRequest', 'BrowseEntry', 'BrowseResponse', 'McpListResponse', 'SaveContextRequest', 'McpCatalogEntry', 'WorkQuery']);
for (const [name, def] of Object.entries(tsInterfaces)) {
  if (skipInterfaces.has(name)) continue;
  const sw = swiftStructs[structAliases[name] ?? name];
  if (!sw) { problems.push(`interface ${name}: no Swift struct`); continue; }
  for (const [f, optional] of Object.entries(def.fields)) {
    if (!(f in sw)) { problems.push(`interface ${name}.${f}: missing from Swift`); continue; }
    if (optional && !sw[f]) problems.push(`interface ${name}.${f}: optional in TS, required in Swift`);
  }
  // Emitted by the server but not declared in packages/shared yet; reported to the lead.
  const undeclared = {
    WorkplaceHealthResponse: ['resilience'],
    // Ahead of packages/shared: docs/LLD-app-fixes.md on `app/fixes` (§1, §5, §8). Drop on merge.
    LogEntry: ['fromName'],
    RoomMessage: ['truncated'],
    CommentRequest: ['mentions'],
  };
  for (const f of Object.keys(sw)) if (!(f in def.fields) && !(undeclared[name] ?? []).includes(f)) problems.push(`interface ${name}.${f}: Swift has a field the contract lacks`);
}

// ---- WORKPLACE_API keys ----
const apiBlock = tsClean.match(/export const WORKPLACE_API = \{([\s\S]*?)\n\} as const;/)?.[1] ?? '';
for (const m of apiBlock.matchAll(/^  (\w+):/gm)) {
  const key = m[1];
  if (!new RegExp(`static (?:let|func) ${key}\\b`).test(swiftClean)) problems.push(`WORKPLACE_API.${key}: no Swift counterpart in API.swift`);
}

// ---- Socket event and command types ----
const eventTypes = [...tsClean.matchAll(/\{ type: '([\w.]+)'/g)].map(m => m[1]);
const knownEvents = new Set([...(swiftClean.match(/static let knownTypes: \[String\] = \[([\s\S]*?)\]/g) ?? []).flatMap(b => [...b.matchAll(/"([\w.]+)"/g)].map(m => m[1]))]);
for (const t of new Set(eventTypes)) if (!knownEvents.has(t)) problems.push(`socket type '${t}': not in Events.swift knownTypes`);

if (problems.length) {
  console.error(`Contract drift (${problems.length}):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`contract check ok: ${Object.keys(tsUnions).length} unions, ${Object.keys(tsInterfaces).length - skipInterfaces.size} interfaces, ${[...apiBlock.matchAll(/^  (\w+):/gm)].length} API paths, ${new Set(eventTypes).size} socket types`);
