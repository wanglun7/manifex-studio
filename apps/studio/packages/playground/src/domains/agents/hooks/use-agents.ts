import type {
  GetAgentResponse,
  ReorderModelListParams,
  UpdateModelInModelListParams,
  UpdateModelParams,
} from '@mastra/client-js';
import { useMastraClient } from '@mastra/react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStudioConfig } from '@/domains/configuration/context/studio-config-state';
import { usePlaygroundStore } from '@/store/playground-store';

export const useAgents = (options?: { enabled?: boolean }) => {
  const { requestContext } = usePlaygroundStore();
  const { baseUrl, headers } = useStudioConfig();

  return useQuery({
    queryKey: ['agents', requestContext, baseUrl, headers],
    queryFn: async () => {
      const url = new URL('/manifex/app/agents', baseUrl);
      const response = await fetch(url, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      return response.json() as Promise<Record<string, GetAgentResponse>>;
    },
    enabled: options?.enabled !== false && Boolean(baseUrl),
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
