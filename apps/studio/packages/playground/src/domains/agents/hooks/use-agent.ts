import { useMastraClient } from '@mastra/react';
import { useQuery } from '@tanstack/react-query';
import { useMergedRequestContext } from '@/domains/request-context';

export const useAgent = (agentId?: string) => {
  const client = useMastraClient();
  const requestContext = useMergedRequestContext();

  return useQuery({
    queryKey: ['agent', agentId, requestContext],
    queryFn: async () => {
      if (!agentId) return null;
      const agent = await client.getAgent(agentId).details(requestContext);
      return {
        ...agent,
        id: agent.id || agentId,
      };
    },
    retry: false,
    enabled: Boolean(agentId),
  });
};
