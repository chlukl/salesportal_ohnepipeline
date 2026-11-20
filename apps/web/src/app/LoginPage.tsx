/** Login: dev mode shows the seeded users as cards; Entra mode a single «Mit Microsoft anmelden». */
import { ROLE_LABELS, type AuthConfigResponse, type DevUser } from '@sales-portal/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, LogIn, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Badge, Button, cn, Skeleton } from '@/components/ui';
import { api, errorMessage } from './api';
import { ME_QUERY_KEY } from './auth';
import { toast } from './toast';

const ROLE_HINT: Record<string, string> = {
  admin: 'Alle Rollen, Admin und «Ansicht als»',
  coldcaller: 'Anrufliste, Anruf, Ergebnis, Termin',
  sales: 'Termine, Briefings, Dashboard',
  ai_specialist: 'Erstgespräche, Briefings, Dashboard',
};

function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login') ? value : '/';
}

export function LoginPage() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const error = params.get('fehler');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<AuthConfigResponse>('/api/auth/config') });
  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api.get<DevUser[]>('/api/auth/dev-users'),
    enabled: config.data?.authMode === 'dev',
  });

  const loginAs = async (user: DevUser) => {
    setPending(user.id);
    try {
      await api.post('/api/auth/dev-login', { userId: user.id });
      await queryClient.resetQueries({ queryKey: ME_QUERY_KEY });
      navigate(returnTo, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const order = ['coldcaller', 'sales', 'ai_specialist', 'admin'];
  const users = [...(devUsers.data ?? [])].sort(
    (a, b) => Math.min(...a.roles.map((r) => order.indexOf(r)), 9) - Math.min(...b.roles.map((r) => order.indexOf(r)), 9) || a.roles.length - b.roles.length,
  );

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-6 py-16">
      <div className="w-full max-w-[720px]">
        <div className="mb-10 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.015em] text-fg">Sales-Portal</h1>
            <p className="text-sm text-fg-muted">Vom CRM-Lead zum Termin – in einem Fenster.</p>
          </div>
          {config.data && (
            <Badge className="ml-auto" tone={config.data.environmentLabel === 'Prod' ? 'danger' : config.data.environmentLabel === 'Sandbox' ? 'warning' : 'info'} variant="outline" dot size="md">
              {config.data.environmentLabel}
            </Badge>
          )}
        </div>

        {error && (
          <div role="alert" className="mb-6 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
            Die Anmeldung hat nicht geklappt. Bitte nochmals versuchen.
          </div>
        )}

        {config.isLoading && <Skeleton className="h-40 w-full" />}

        {config.data?.authMode === 'entra' && (
          <div className="rounded-lg border border-border bg-surface p-8 shadow-sm">
            <h2 className="text-lg font-semibold text-fg">Anmelden</h2>
            <p className="mt-1 text-sm text-fg-muted">Mit deinem Kallysoft-Konto (Microsoft Entra ID).</p>
            <Button
              variant="primary"
              size="lg"
              icon={LogIn}
              className="mt-6"
              onClick={() => window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`)}
            >
              Mit Microsoft anmelden
            </Button>
          </div>
        )}

        {config.data?.authMode === 'dev' && (
          <>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-fg">Als wer möchtest du arbeiten?</h2>
              <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
                <ShieldCheck className="size-3.5" aria-hidden />
                Entwicklungs-Login mit Demo-Daten
              </span>
            </div>
            <ul className="grid grid-cols-2 gap-3">
              {devUsers.isLoading && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[112px]" />)}
              {users.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => void loginAs(u)}
                    disabled={pending !== null}
                    className={cn(
                      'group flex h-full w-full items-start gap-4 rounded-lg border border-border bg-surface p-5 text-left shadow-sm transition-all',
                      'hover:-translate-y-px hover:border-primary/50 hover:shadow-md disabled:opacity-60',
                    )}
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-base font-semibold text-primary">
                      {u.displayName.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between">
                        <span className="text-[15px] font-semibold text-fg">{u.displayName}</span>
                        <ArrowRight className="size-4 text-fg-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                      </span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <Badge key={r} tone={r === 'admin' ? 'primary' : 'neutral'}>
                            {ROLE_LABELS[r]}
                          </Badge>
                        ))}
                      </span>
                      <span className="mt-2 block text-[13px] text-fg-muted">
                        {u.roles.includes('admin') ? ROLE_HINT.admin : ROLE_HINT[u.roles[0]] ?? ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
