/**
 * Routes (ARCHITECTURE §4). Each module page lives in `src/pages/<module>/index.tsx` (default export) and is lazy-loaded.
 * Shared file – implementers replace their page file; new routes only additively.
 */
import type { Role } from '@sales-portal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { Button, EmptyState, Skeleton, SkeletonText } from '@/components/ui';
import { ApiError, UNAUTHORIZED_EVENT } from './api';
import { AuthProvider, ME_QUERY_KEY, useMeQuery } from './auth';
import { Layout } from './Layout';
import { LoginPage } from './LoginPage';
import { RequireRoles } from './RequireRoles';
import { Toaster } from './toast';

const PendenzenPage = lazy(() => import('@/pages/pendenzen'));
const LeadsPage = lazy(() => import('@/pages/leads'));
const WorkspacePage = lazy(() => import('@/pages/workspace'));
const HistoryPage = lazy(() => import('@/pages/history'));
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const AdminPage = lazy(() => import('@/pages/admin'));
const UseCasesPage = lazy(() => import('@/pages/admin/UseCasesPage'));

const ROLES_COLDCALL: Role[] = ['coldcaller', 'admin'];
const ROLES_WORKSPACE: Role[] = ['coldcaller', 'sales', 'ai_specialist', 'admin'];
const ROLES_DASHBOARD: Role[] = ['sales', 'ai_specialist', 'admin'];
const ROLES_ADMIN: Role[] = ['admin'];

function PageFallback() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <SkeletonText lines={4} />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function page(Component: ComponentType, roles?: Role[]): ReactNode {
  const content = (
    <Suspense fallback={<PageFallback />}>
      <Component />
    </Suspense>
  );
  return roles ? <RequireRoles roles={roles}>{content}</RequireRoles> : content;
}

/** Root: global toasts + «session expired → login». */
function Root() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => {
      if (window.location.pathname.startsWith('/login')) return;
      queryClient.removeQueries({ queryKey: ME_QUERY_KEY });
      navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, queryClient]);
  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [location.pathname]);
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

/** Loads /api/me; without session → /login. */
function AuthGate() {
  const me = useMeQuery();
  const location = useLocation();
  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <Skeleton className="h-10 w-48" />
      </div>
    );
  }
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    }
    return (
      <EmptyState
        icon={RefreshCw}
        title="Portal nicht erreichbar"
        description="Der Server antwortet gerade nicht. Deine Entwürfe sind gespeichert."
        action={
          <Button variant="primary" onClick={() => void me.refetch()}>
            Nochmals versuchen
          </Button>
        }
      />
    );
  }
  return (
    <AuthProvider me={me.data}>
      <Layout />
    </AuthProvider>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Seite nicht gefunden"
      description="Diese Adresse gibt es im Portal nicht."
      action={
        <Button variant="secondary" onClick={() => navigate('/')}>
          Zu den Pendenzen
        </Button>
      }
    />
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        path: '/',
        element: <AuthGate />,
        children: [
          { index: true, element: page(PendenzenPage) },
          { path: 'anrufliste', element: page(LeadsPage, ROLES_COLDCALL) },
          { path: 'lead/:id', element: page(WorkspacePage, ROLES_WORKSPACE) },
          { path: 'historie', element: page(HistoryPage, ROLES_COLDCALL) },
          { path: 'dashboard', element: page(DashboardPage, ROLES_DASHBOARD) },
          { path: 'admin/*', element: page(AdminPage, ROLES_ADMIN) },
          { path: 'use-cases', element: page(UseCasesPage, ROLES_DASHBOARD) },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
