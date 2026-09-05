import type { ActivityEvent } from '@jkj/shared';
import { getSnapshot } from './workspace.js';

/**
 * A feed across every project, derived from the sessions themselves. There is
 * no event log on disk, so each session contributes what can be stated
 * truthfully: when it last did something, and what it was asked to do.
 */
export async function listActivity(limit = 40): Promise<ActivityEvent[]> {
  const { agents, details } = await getSnapshot();

  return agents
    .filter(a => !a.parentAgentId)
    .map(agent => {
      const detail = details.get(agent.id);
      const kind: ActivityEvent['kind'] =
        agent.status === 'running' ? 'started'
        : agent.status === 'waiting' ? 'waiting'
        : 'finished';

      return {
        id: `ev_${agent.id}`,
        at: agent.endedAt ?? detail?.endedAt ?? agent.startedAt,
        projectId: agent.projectId,
        kind,
        message: `**${agent.name}** — ${summarise(agent.task)}`,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

function summarise(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}
