// @vitest-environment jsdom
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthRequired } from '../auth-required';
import type { AuthCapabilities } from '@/domains/auth/types';
import { server } from '@/test/msw-server';

const BASE_URL = 'http://localhost:4111';

const unauthenticatedCapabilities = {
  enabled: true,
  login: { type: 'credentials' as const },
} satisfies AuthCapabilities;

const authenticatedCapabilities = {
  enabled: true,
  login: { type: 'credentials' as const },
  user: { id: 'user-1', email: 'u@example.com' },
  capabilities: { user: true, session: true, sso: false, rbac: false, acl: false },
  access: null,
} satisfies AuthCapabilities;

const authDisabledCapabilities = {
  enabled: false,
  login: { type: 'credentials' as const },
} satisfies AuthCapabilities;

function authHandler(capabilities: AuthCapabilities) {
  return http.get(`${BASE_URL}/api/auth/capabilities`, () => HttpResponse.json(capabilities));
}

function renderProtectedRoute(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const router = createMemoryRouter(
    [
      {
        path: '/login',
        element: <div>Login page</div>,
      },
      {
        path: '/agents',
        element: (
          <AuthRequired>
            <div>Protected agents</div>
          </AuthRequired>
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );

  render(
    <MastraReactProvider baseUrl={BASE_URL}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MastraReactProvider>,
  );

  return router;
}

afterEach(() => {
  server.resetHandlers();
  cleanup();
});

describe('AuthRequired', () => {
  it('redirects unauthenticated users to login with the requested route', async () => {
    server.use(authHandler(unauthenticatedCapabilities));

    const router = renderProtectedRoute('/agents?tab=recent#top');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });

    const expectedRedirect = new URL('/agents?tab=recent#top', window.location.origin).href;
    expect(router.state.location.search).toBe(`?redirect=${encodeURIComponent(expectedRedirect)}`);
    expect(await screen.findByText('Login page')).toBeTruthy();
    expect(screen.queryByText(/sign in to continue/i)).toBeNull();
  });

  it('renders children for authenticated users', async () => {
    server.use(authHandler(authenticatedCapabilities));

    renderProtectedRoute('/agents');

    expect(await screen.findByText('Protected agents')).toBeTruthy();
  });

  it('renders children when auth is disabled', async () => {
    server.use(authHandler(authDisabledCapabilities));

    renderProtectedRoute('/agents');

    expect(await screen.findByText('Protected agents')).toBeTruthy();
  });
});
