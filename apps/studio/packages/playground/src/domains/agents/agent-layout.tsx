import { coreFeatures } from '@mastra/core/features';
import { MainContentLayout } from '@mastra/playground-ui';
import { useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router';
import { AgentPageTabs } from '@/domains/agents/components/agent-page-tabs';
import type { AgentPageTab } from '@/domains/agents/components/agent-page-tabs';
import { AgentTopBarControls } from '@/domains/agents/components/agent-top-bar-controls';
import { PlaygroundModelProvider } from '@/domains/agents/context/playground-model-context';
import { ReviewQueueProvider } from '@/domains/agents/context/review-queue-context';
import { useAgent } from '@/domains/agents/hooks/use-agent';
import { useChannelPlatforms } from '@/domains/agents/hooks/use-channels';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';
import { useIsCmsAvailable } from '@/domains/cms/hooks/use-is-cms-available';
import { useHasObservability } from '@/domains/configuration/hooks/use-has-observability';
import { GenerationProvider } from '@/domains/datasets/context/generation-context';
import { cleanProviderId } from '@/domains/llm/utils';
import { SchemaRequestContextProvider } from '@/domains/request-context/context/schema-request-context';

export const AgentLayout = ({ children }: { children: React.ReactNode }) => {
  const { agentId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isCmsAvailable } = useIsCmsAvailable();
  const { hasObservability } = useHasObservability();
  const { data: channelPlatforms } = useChannelPlatforms();
  const { roles, rbacEnabled, hasPermission, hasAnyPermission, isLoading: isPermissionsLoading } = usePermissions();
  const hasChannels = Boolean(channelPlatforms?.length);
  const hasRoleAwareAuth = rbacEnabled || roles.length > 0;
  const hasDeveloperRole = roles.includes('owner') || roles.includes('operator');
  const canUseDeveloperTabs =
    !isPermissionsLoading && (hasRoleAwareAuth ? hasDeveloperRole : true);

  const isExperimentalFeatures = coreFeatures.has('datasets');
  const showPlayground = isCmsAvailable && isExperimentalFeatures;
  const showObservability = hasObservability && isExperimentalFeatures;
  const showEditorTab = canUseDeveloperTabs && showPlayground && hasAnyPermission(['agents:write', 'stored-agents:write']);
  const showEvaluateTab = canUseDeveloperTabs && showObservability && hasAnyPermission(['scores:read', 'datasets:read']);
  const showReviewTab = canUseDeveloperTabs && showObservability && hasAnyPermission(['scores:read', 'datasets:read']);
  const showTracesTab = showObservability && hasPermission('observability:read');

  const { data: agent } = useAgent(agentId!);

  const defaultProvider = cleanProviderId(agent?.provider ?? '');
  const defaultModel = agent?.modelId ?? '';
  const requestContextSchema = agent?.requestContextSchema;

  const activeTab: AgentPageTab = location.pathname.includes('/editor')
    ? 'versions'
    : location.pathname.includes('/evaluate')
      ? 'evaluate'
      : location.pathname.includes('/review')
        ? 'review'
        : location.pathname.includes('/traces')
          ? 'traces'
          : location.pathname.includes('/channels')
            ? 'channels'
            : 'chat';

  const activeTabAllowed =
    activeTab === 'chat' ||
    (activeTab === 'versions' && showEditorTab) ||
    (activeTab === 'evaluate' && showEvaluateTab) ||
    (activeTab === 'review' && showReviewTab) ||
    (activeTab === 'traces' && showTracesTab) ||
    (activeTab === 'channels' && hasChannels);

  useEffect(() => {
    if (!agentId || isPermissionsLoading || activeTabAllowed) return;
    void navigate(`/agents/${agentId}/chat/new`, { replace: true });
  }, [activeTabAllowed, agentId, isPermissionsLoading, navigate]);

  const showTopBarControls =
    (activeTab === 'versions' && showEditorTab) ||
    (activeTab === 'evaluate' && showEvaluateTab) ||
    (activeTab === 'review' && showReviewTab);

  if (!isPermissionsLoading && !activeTabAllowed) {
    return null;
  }

  const content = (
    <MainContentLayout>
      <AgentPageTabs
        agentId={agentId!}
        activeTab={activeTab}
        showPlayground={showPlayground}
        showObservability={showObservability}
        showChannels={hasChannels}
        showEditorTab={showEditorTab}
        showEvaluateTab={showEvaluateTab}
        showReviewTab={showReviewTab}
        showTracesTab={showTracesTab}
        rightSlot={showTopBarControls ? <AgentTopBarControls requestContextSchema={requestContextSchema} /> : undefined}
      />
      {children}
    </MainContentLayout>
  );

  return (
    <SchemaRequestContextProvider>
      <PlaygroundModelProvider defaultProvider={defaultProvider} defaultModel={defaultModel}>
        <GenerationProvider>
          <ReviewQueueProvider>{content}</ReviewQueueProvider>
        </GenerationProvider>
      </PlaygroundModelProvider>
    </SchemaRequestContextProvider>
  );
};
