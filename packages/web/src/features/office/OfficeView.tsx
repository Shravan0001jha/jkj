import type { EmployeeCard as Card } from '@jkj/shared';
import { hrefFor, useStore } from '../../state/store.js';
import { firstLines, inr, pct, stateLabel, stateTone, workTone } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { CoverageBar } from '../../components/CoverageBar.js';

/**
 * Who is working on what, what is done, what is blocked, what needs you.
 * Employees are grouped by unit; the numbers on top are the whole product.
 */
export function OfficeView() {
  const office = useStore(s => s.office);

  if (!office) return <div className="pane"><p className="lede">Reading the office…</p></div>;

  const { coverage, spend } = office;
  const people = office.units.reduce((n, u) => n + u.employees.length, 0);
  const working = office.units.flatMap(u => u.employees).filter(e => e.employee.state === 'working').length;

  return (
    <div className="pane">
      <div className="stats">
        <a className={`stat${office.needsYou > 0 ? ' hot' : ''}`} href={hrefFor('inbox')}>
          <b>{office.needsYou}</b><span>need{office.needsYou === 1 ? 's' : ''} you</span>
        </a>
        <div className="stat">
          <b>{working}<small>/{people}</small></b><span>working</span>
        </div>
        <a className="stat" href={hrefFor('spend')}>
          <b>{inr(spend.companyInr)}<small> / {inr(spend.capInr)}</small></b><span>spend today{spend.paused.length ? ` · ${spend.paused.length} paused` : ''}</span>
        </a>
        <a className={`stat${office.lintErrors > 0 ? ' warn' : ''}`} href={hrefFor('org')}>
          <b>{office.lintErrors}</b><span>lint error{office.lintErrors === 1 ? '' : 's'}</span>
        </a>
        <a className="stat wide" href={hrefFor('features')}>
          <b>{pct(coverage.built, coverage.total)}%<small> built · {pct(coverage.verified, coverage.total)}% verified · {pct(coverage.released, coverage.total)}% released</small></b>
          <span>of {coverage.total} requirements in the definition</span>
          <CoverageBar counts={coverage} compact />
        </a>
      </div>

      {office.units.map(({ unit, employees }) => (
        <section key={unit.id} className="unitsec">
          <h3 className="group">{unit.title}{unit.kind === 'chapter' ? ' · chapter' : ''}</h3>
          <div className="grid">
            {employees.map(card => <EmployeeCard key={card.employee.id} card={card} />)}
            {employees.length === 0 && <p className="muted">Nobody here yet.</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function EmployeeCard({ card }: { card: Card }) {
  const { employee } = card;
  const tone = stateTone(employee.state);
  return (
    <a className={`card s-${tone}`} href={hrefFor('employee', employee.id)}>
      <div className="stripe" />
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <div className="an">{employee.name}</div>
          <div className="am">{employee.roleId}{employee.level === 2 ? ' · contractor' : ''}</div>
        </div>
        <Pill tone={tone}>{stateLabel(employee.state)}</Pill>
      </div>
      <div className="chips">
        {card.charters.map(c => <span key={c.id} className="chip" title={c.mission}>{c.title}</span>)}
      </div>
      {card.currentWork ? (
        <div className="now" title={card.currentWork.title}>
          <Pill tone={workTone(card.currentWork.state)}>{card.currentWork.state}</Pill>
          <span className="nowtitle">{card.currentWork.title}</span>
        </div>
      ) : (
        <div className="now empty">no assignment open</div>
      )}
      <div className="task">{card.lastReport ? firstLines(card.lastReport, 3) : 'No report yet.'}</div>
      <div className="foot">
        <span>today <b>{inr(card.spendTodayInr)}</b></span>
        {card.needsYou > 0 && <span className="subchip">{card.needsYou} for you</span>}
        {card.session && <span>{card.session.status === 'running' ? 'session running' : `session ${card.session.status}`}</span>}
        <span className="open">Open →</span>
      </div>
    </a>
  );
}
