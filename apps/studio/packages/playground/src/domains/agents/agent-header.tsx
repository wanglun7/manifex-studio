import { Header, Breadcrumb, Crumb, Icon, AgentIcon } from '@mastra/playground-ui';
import { Link } from 'react-router';
import { AgentCombobox } from '@/domains/agents/components/agent-combobox';

export function AgentHeader({ agentId }: { agentId: string }) {
  return (
    <Header border={false}>
      <Breadcrumb>
        <Crumb as={Link} to={`/agents`}>
          <Icon>
            <AgentIcon />
          </Icon>
          Agents
        </Crumb>
        <Crumb as="span" to="" isCurrent>
          <AgentCombobox value={agentId} variant="ghost" size="sm" />
        </Crumb>
      </Breadcrumb>
    </Header>
  );
}
