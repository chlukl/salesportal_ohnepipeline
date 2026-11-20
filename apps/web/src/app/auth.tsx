/**
 * Auth context: `/api/me` via TanStack Query. Provides the user, real/effective roles, «Ansicht als» and the CSRF token.
 *
 *   const { me, hasRole } = useAuth();
 *   if (hasRole('coldcaller', 'admin')) …
 */
import type { MeResponse, Role } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api, ApiError, CSRF_INVALID_EVENT, setCsrfToken } from './api';

export const ME_QUERY_KEY = ['me'] as const;

interface AuthValue {
  me: MeResponse;
  /** true if any effective role matches (UI only – the server enforces). */
  hasRole: (...roles: Role[]) => boolean;
  setViewAs: (role: Role | null) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useMeQuery() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api.get<MeResponse>('/api/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
  });
}

export function AuthProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  const queryClient = useQueryClient();
  setCsrfToken(me.csrfToken);

  useEffect(() => {
    const onCsrf = () => void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    window.addEventListener(CSRF_INVALID_EVENT, onCsrf);
    return () => window.removeEventListener(CSRF_INVALID_EVENT, onCsrf);
  }, [queryClient]);

  const viewAs = useMutation({
    mutationFn: (role: Role | null) =>
      role ? api.put<MeResponse>('/api/me/view-as', { role }) : api.del<MeResponse>('/api/me/view-as'),
    onSuccess: (next) => {
      queryClient.setQueryData(ME_QUERY_KEY, next);
      // Everything else may look different for the new role.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
    },
  });

  const value: AuthValue = {
    me,
    hasRole: (...roles) => roles.some((r) => me.effectiveRoles.includes(r)),
    setViewAs: async (role) => {
      await viewAs.mutateAsync(role);
    },
    logout: async () => {
      const res = await api.post<{ redirectUrl: string }>('/api/auth/logout');
      setCsrfToken(null);
      queryClient.clear();
      window.location.assign(res.redirectUrl || '/login');
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
