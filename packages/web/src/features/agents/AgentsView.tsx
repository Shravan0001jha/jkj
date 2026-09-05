import { useStore, agentById } from '../../state/store.js';
import { AgentGrid } from './AgentGrid.js';
import { AgentChat } from './AgentChat.js';
import { AgentList } from './AgentList.js';

/**
 * The Agents tab is one of two screens: the grid of everything in the
 * project, or one open conversation with the project's agents down the side.
 */
export function AgentsView() {
  const openAgent = useStore(s => agentById(s, s.openAgentId));

  if (!openAgent) {
    return <div className="pane"><AgentGrid /></div>;
  }

  return (
    <div className="chatwrap">
      <AgentList />
      <AgentChat agent={openAgent} />
    </div>
  );
}
