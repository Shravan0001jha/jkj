import type {
  EmployeeDetail, FeatureBoard, FeatureDetail, OfficeResponse, OrgResponse, Pivot, PivotCell, PivotRows,
} from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as work from './work.js';
import * as inbox from './inbox.js';
import * as spend from './spend.js';
import * as proposals from './proposals.js';
import * as health from './health.js';
import * as runs from './runs.js';
import { coverage } from './requirements.js';
import { lint } from './ownership.js';
import { orgHistory, readEmployeeFile, summarise } from './org.js';

/**
 * Screens are views over the data (brief §6). Each function here builds one
 * response shape from the services and decides nothing.
 */

export function office(wp: Workplace): OfficeResponse {
  const reqs = wp.requirements();
  return {
    units: wp.org.units
      .filter(u => u.kind === 'unit')
      .map(unit => ({ unit, employees: wp.org.employees.filter(e => e.unitId === unit.id).map(e => employees.card(wp, e.id)) })),
    coverage: coverage(reqs),
    needsYou: inbox.openCount(wp),
    spend: spend.summary(wp),
    lintErrors: lint(wp.org, reqs).filter(f => f.severity === 'error').length,
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
  return {
    employee: { ...e, state: employees.stateOf(wp, id) },
    charters: e.charterIds.map(c => wp.org.charters.get(c)).filter((c): c is NonNullable<typeof c> => !!c).map(summarise),
    status: readEmployeeFile(wp.org, id, 'status.md'),
    handoff: readEmployeeFile(wp.org, id, 'handoff.md'),
    sessions: open,
    assignments: work.list(wp, { employeeId: id }),
    spendTodayInr: spend.summary(wp).byEmployee[id] ?? 0,
    signals: health.signals(wp).employees[id] ?? { throughput7d: 0, rework7d: 0, falseDoneRate7d: 0, costPerDoneInr: 0 },
  };
}

export function featureBoard(wp: Workplace): FeatureBoard {
  const features = work.list(wp, { kind: 'feature' });
  const byState: Record<string, number> = {};
  for (const f of features) byState[f.state] = (byState[f.state] ?? 0) + 1;
  return { features, byState };
}

export function featureDetail(wp: Workplace, id: string): FeatureDetail {
  const feature = work.require$(wp, id);
  const reqs = wp.requirements();
  return {
    feature,
    assignments: work.list(wp, { kind: 'assignment', featureId: id }),
    requirements: reqs.filter(r => feature.requirementIds.includes(r.id)),
    route: work.routeFeature(wp, feature),
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
      const cell = (row[a.featureId!] ??= { total: 0, byState: {} });
      cell.total += 1;
      cell.byState[a.state] = (cell.byState[a.state] ?? 0) + 1;
    }
  }
  return { rows: [...rowSet].sort(), cols: features.map(f => f.id), cells };
}
