import type {
  GetAgentResponse,
  ReorderModelListParams,
  UpdateModelInModelListParams,
  UpdateModelParams,
} from '@mastra/client-js';
import { useMastraClient } from '@mastra/react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthCapabilities } from '@/domains/auth/hooks/use-auth-capabilities';
import { isAuthenticated } from '@/domains/auth/types';
import { usePlaygroundStore } from '@/store/playground-store';

const withAgentId = (agentId: string, agent: GetAgentResponse): GetAgentResponse => ({
  ...agent,
  id: agent.id || agentId,
});

export const useAgents = (options?: { enabled?: boolean }) => {
  const client = useMastraClient();
  const { requestContext } = usePlaygroundStore();
  const { data: capabilities, isLoading: isAuthLoading } = useAuthCapabilities();

  const allowedAgentIds = capabilities && isAuthenticated(capabilities) ? capabilities.access?.agentIds : undefined;

  return useQuery({
    queryKey: ['agents', requestContext, allowedAgentIds?.join(',') ?? 'all'],
    queryFn: async () => {
      if (!allowedAgentIds || allowedAgentIds.includes('*')) {
        const agents = await client.listAgents(requestContext);
        return Object.fromEntries(Object.entries(agents).map(([agentId, agent]) => [agentId, withAgentId(agentId, agent)]));
      }

      const uniqueAgentIds = Array.from(new Set(allowedAgentIds));
      const entries = await Promise.all(
        uniqueAgentIds.map(async agentId => {
          try {
            const agent = await client.getAgent(agentId).details(requestContext);
            return [agent.id || agentId, withAgentId(agentId, agent)] as const;
          } catch {
            return null;
          }
        }),
      );

      const agents = entries.filter((entry): entry is readonly [string, GetAgentResponse] => Boolean(entry));
      const seenAgents = new Set<string>();

      return Object.fromEntries(
        agents.filter(([, agent]) => {
          const agentKey = `${agent.name}:${agent.modelId}`;
          if (seenAgents.has(agentKey)) return false;
          seenAgents.add(agentKey);
          return true;
        }),
      );
    },
    enabled: options?.enabled !== false && !isAuthLoading,
  });
};

export const useUpdateAgentModel = (agentId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateModelParams) => client.getAgent(agentId).updateModel(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
    },
    onError: err => {
      console.error('Error updating model', err);
    },
  });
};

export const useReorderModelList = (agentId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: ReorderModelListParams) => client.getAgent(agentId).reorderModelList(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
    },
    onError: err => {
      console.error('Error reordering model list', err);
    },
  });
};

export const useUpdateModelInModelList = (agentId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateModelInModelListParams) =>
      client.getAgent(agentId).updateModelInModelList(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
    },
    onError: err => {
      console.error('Error updating model in model list', err);
    },
  });
};

export const useResetAgentModel = (agentId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => client.getAgent(agentId).resetModel(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
    },
    onError: err => {
      console.error('Error resetting model', err);
    },
  });
};
