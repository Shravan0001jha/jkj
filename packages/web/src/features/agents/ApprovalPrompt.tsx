import type { Agent, PendingApproval } from '@jkj/shared';
import { resolveApproval } from '../../state/store.js';

/**
 * The one moment a session needs a human. Two answers, each with a different
 * blast radius, so each gets its own button rather than a dropdown.
 */
export function ApprovalPrompt({ agent, approval }: { agent: Agent; approval: PendingApproval }) {
  return (
    <div className="approve">
      <div className="t">⚠ Waiting for your approval</div>
      <div className="why">{approval.reason}</div>
      <pre>{approval.tool}  {approval.input}</pre>
      <div className="row">
        <button className="btn primary sm" onClick={() => resolveApproval(agent.id, 'once')}>
          Allow once
        </button>
        <button className="btn sm" onClick={() => resolveApproval(agent.id, 'always')}>
          Always allow {approval.tool}
        </button>
        <button className="btn sm danger" onClick={() => resolveApproval(agent.id, 'deny')}>
          Deny
        </button>
      </div>
      {(agent.alwaysAllowed?.length ?? 0) > 0 && (
        <div className="allowed">
          No longer asking about: {agent.alwaysAllowed!.join(', ')}
        </div>
      )}
    </div>
  );
}
