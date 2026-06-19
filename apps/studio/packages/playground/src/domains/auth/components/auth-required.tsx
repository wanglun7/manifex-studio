import { LogoWithoutText } from '@mastra/playground-ui';
import { Navigate, useLocation } from 'react-router';
import { useAuthCapabilities } from '../hooks/use-auth-capabilities';
import { isAuthenticated } from '../types';

export type AuthRequiredProps = {
  children: React.ReactNode;
  /** URL to redirect to for login (defaults to /login) */
  loginUrl?: string;
  /** URL to redirect to for signup (defaults to /signup) */
  signupUrl?: string;
};

/**
 * Wrapper component that redirects to login when authentication is required.
 *
 * If auth is enabled and the user is not authenticated, redirects to the login
 * page with the current route as the post-login destination. Otherwise, renders
 * children normally.
 *
 * @example
 * ```tsx
 * import { AuthRequired } from '@/domains/auth/components/auth-required';
 *
 * function ProtectedPage() {
 *   return (
 *     <AuthRequired>
 *       <MyProtectedContent />
 *     </AuthRequired>
 *   );
 * }
 * ```
 */
export function AuthRequired({ children, loginUrl = '/login' }: AuthRequiredProps) {
  const { data: capabilities, isLoading } = useAuthCapabilities();
  const location = useLocation();

  // While loading, show nothing (or could show a skeleton)
  if (isLoading) {
    return <>{children}</>;
  }

  // If auth is not enabled, render children
  if (!capabilities?.enabled) {
    return <>{children}</>;
  }

  // If user is authenticated, render children
  if (isAuthenticated(capabilities)) {
    return <>{children}</>;
  }

  // No login capability available - show auth required message without login option
  if (!capabilities.login) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex flex-col items-center space-y-6 text-center">
          <LogoWithoutText className="h-16 w-16 opacity-50" />
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-neutral6">Authentication Required</h2>
            <p className="max-w-sm text-neutral3">
              This page requires authentication, but no login method is configured. Please contact your administrator.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const redirectPath = new URL(`${location.pathname}${location.search}${location.hash}`, window.location.origin).href;
  const url = new URL(loginUrl, window.location.origin);
  url.searchParams.set('redirect', redirectPath);
  const loginTarget = url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;

  return <Navigate to={loginTarget} replace />;
}
