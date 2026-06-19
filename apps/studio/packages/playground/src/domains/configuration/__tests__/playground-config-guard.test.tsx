// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlaygroundConfigGuard } from '../components/playground-config-guard';
import { StudioConfigContext } from '../context/studio-config-state';
import type { StudioConfigContextType } from '../context/studio-config-state';

const contextValue: StudioConfigContextType = {
  baseUrl: '',
  headers: {},
  apiPrefix: undefined,
  isLoading: false,
  setConfig: () => {},
};

describe('PlaygroundConfigGuard', () => {
  it('does not expose the Mastra connection configuration form', () => {
    render(
      <StudioConfigContext.Provider value={contextValue}>
        <PlaygroundConfigGuard />
      </StudioConfigContext.Provider>,
    );

    expect(screen.queryByText(/mastra instance url/i)).toBeNull();
    expect(screen.queryByText(/api prefix/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /save configuration/i })).toBeNull();
    expect(screen.getByText(/service unavailable/i)).toBeTruthy();
  });
});
