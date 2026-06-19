import { Button, ErrorState } from '@mastra/playground-ui';

export const PlaygroundConfigGuard = () => {
  const handleRetry = () => {
    window.location.reload();
  };

  return (
    <div className="flex flex-col h-screen w-full items-center justify-center bg-surface1">
      <ErrorState
        title="Service unavailable"
        message="The workspace is not available right now. Please try again in a moment."
        action={<Button onClick={handleRetry}>Retry</Button>}
      />
    </div>
  );
};
