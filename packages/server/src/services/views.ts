import type {
  EmployeeDetail,
  FeatureBoard,
  FeatureDetail,
  OfficeResponse,
  OrgResponse,
  Pivot,
  PivotCell,
  PivotRows,
  RequestStatus,
  WorkItem,
  PivotItem,
  AssignmentState,
} from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as work from './work.js';
import * as requests from './requests.js';
import { chiefOfStaff } from './features.js';
import * as inbox from './inbox.js';
import * as spend from './spend.js';
import * as proposals from './proposals.js';
import * as health from './health.js';
import * as runs from './runs.js';
import { coverage } from './requirements.js';
import { lint } from './ownership.js';
import { orgHistory, readEmployeeFile, summarise } from './org.js';
import * as stall from './stall.js';

/**
 * Screens are views over the data (brief §6). Each function here builds one
 * response shape from the services and decides nothing.
 */

export function office(wp: Workplace): OfficeResponse {
  const reqs = wp.requirements();
  const units = wp.org.units
    .filter(u => u.kind === 'unit')
    .map(unit => ({ unit, employees: wp.org.employees.filter(e => e.unitId === unit.id).map(e => employees.card(wp, e.id)) }));
  const cards = units.flatMap(u => u.employees);
  return {
    chiefOfStaff: chiefOfStaff(wp) ?? '',
    units,
    coverage: coverage(reqs),
    needsYou: inbox.openCount(wp),
    spend: spend.summary(wp),
    lintErrors: lint(wp.org, reqs).filter(f => f.severity === 'error').length,
    counts: {
      working: cards.filter(c => c.employee.state === 'working').length,
      blocked: cards.filter(c => c.employee.state === 'blocked').length,
      stalled: stall.stalledAssignments(wp).length,
      needsYou: inbox.openCount(wp),
      total: cards.length,
    },
  };
}

export function org(wp: Workplace): OrgResponse {
  return {
    units: wp.org.units,
    roles: wp.org.roles,
    employees: wp.org.employees.map(e => ({ ...e, state: employees.stateOf(wp, e.id) })),
    charters: [...wp.org.charters.values()].map(summarise),
    map: wp.org.map,
    lint: lint(wp.org, wp.requirements()),
    proposals: proposals.list(wp),
    history: orgHistory(wp.org.dir),
  };
}

export function employeeDetail(wp: Workplace, id: string): EmployeeDetail {
  const e = employees.employee(wp, id);
  const open = employees.sessionsOf(id).map(s => runs.getRunAgent(s.agentId)).filter((a): a is NonNullable<typeof a> => !!a);
  const { state, reason } = employees.stateWithReason(wp, id);
  return {
    employee: { ...e, state, ...(reason ? { stateReason: reason } : {}) },
    charters: e.charterIds.map(c => wp.org.charters.get(c)).filter((c): c is NonNullable<typeof c> => !!c).map(summarise),
    status: readEmployeeFile(wp.org, id, 'status.md'),
    handoff: readEmployeeFile(wp.org, id, 'handoff.md'),
    sessions: open,
    assignments: stall.annotate(wp, work.list(wp, { employeeId: id })),
    spendTodayInr: spend.summary(wp).byEmployee[id] ?? 0,
    signals: health.signals(wp).employees[id] ?? { throughput7d: 0, rework7d: 0, falseDoneRate7d: 0, costPerDoneInr: 0 },
    needsYou: employees.needsYouItems(wp, id),
  };
}

export function featureBoard(wp: Workplace): FeatureBoard {
  const features = work.list(wp, { kind: 'feature' });
  const byState: Record<string, number> = {};
  const status: Record<string, RequestStatus> = {};
  for (const f of features) { byState[f.state] = (byState[f.state] ?? 0) + 1; status[f.id] = requests.status(wp, f); }
  return { features, byState, status };
}

export function featureDetail(wp: Workplace, id: string): FeatureDetail {
  const feature = work.require$(wp, id);
  const reqs = wp.requirements();
  return {
    feature,
    assignments: stall.annotate(wp, work.list(wp, { kind: 'assignment', featureId: id })),
    requirements: reqs.filter(r => feature.requirementIds.includes(r.id)),
    route: work.routeFeature(wp, feature),
    status: requests.status(wp, feature),
  };
}

/** One assignment in a pivot cell: its state, the evidence it reported, and where to see it. */
function pivotItem(a: WorkItem): PivotItem {
  const e = a.evidence;
  return {
    id: a.id, title: a.title, state: a.state as AssignmentState,
    ...(a.employeeId ? { employeeId: a.employeeId } : {}),
    ...(e ? { evidence: { tests: `${e.tests.passed} passed, ${e.tests.failed} failed`, commits: e.commits, liveVerified: e.liveVerified.length, notVerified: e.notVerified.length } } : {}),
    href: a.employeeId ? `#/employee/${a.employeeId}?item=${a.id}` : `#/assign?item=${a.id}`,
  };
}

/** Assignments counted per (row, feature) cell; rows by charter, platform or team. */
export function pivot(wp: Workplace, rows: PivotRows): Pivot {
  const features = work.list(wp, { kind: 'feature' });
  const assignments = work.list(wp, { kind: 'assignment' }).filter(a => a.featureId);
  const rowsOf = (a: typeof assignments[number]): string[] => {
    if (rows === 'charter') return a.charterId ? [a.charterId] : ['(none)'];
    if (rows === 'platform') return a.platformIds.length ? a.platformIds : ['(none)'];
    const e = wp.org.employees.find(x => x.id === a.employeeId);
    return e ? [e.unitId] : ['(none)'];
  };
  const cells: Record<string, Record<string, PivotCell>> = {};
  const rowSet = new Set<string>();
  for (const a of assignments) {
    for (const r of rowsOf(a)) {
      rowSet.add(r);
      const row = (cells[r] ??= {});
      const cell = (row[a.featureId!] ??= { total: 0, byState: {}, items: [] });
      cell.total += 1;
      cell.byState[a.state] = (cell.byState[a.state] ?? 0) + 1;
      cell.items.push(pivotItem(a));
    }
  }
  return { rows: [...rowSet].sort(), cols: features.map(f => f.id), cells };
}
