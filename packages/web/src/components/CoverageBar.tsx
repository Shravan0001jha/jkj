import type { CoverageCounts } from '@jkj/shared';
import { pct } from '../lib/format.js';

/**
 * How much of the definition is owned, built, verified and released. The
 * segments nest: verified is inside built, released inside verified, so the
 * bar is drawn from the outermost measure inward.
 */
export function CoverageBar({ counts, compact = false }: { counts: CoverageCounts; compact?: boolean }) {
  const { total } = counts;
  return (
    <div className={`covbar${compact ? ' compact' : ''}`}>
      <div className="track" role="img" aria-label={`${counts.built} built, ${counts.verified} verified, ${counts.released} released of ${total}`}>
        <span className="seg built" style={{ width: `${pct(counts.built, total)}%` }} />
        <span className="seg verified" style={{ width: `${pct(counts.verified, total)}%` }} />
        <span className="seg released" style={{ width: `${pct(counts.released, total)}%` }} />
      </div>
      {!compact && (
        <div className="covlegend">
          <span><i className="owned" />owned {counts.owned}/{total}</span>
          <span><i className="planned" />planned {counts.planned}</span>
          <span><i className="built" />built {counts.built}</span>
          <span><i className="verified" />verified {counts.verified}</span>
          <span><i className="released" />released {counts.released}</span>
        </div>
      )}
    </div>
  );
}
