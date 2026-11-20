import type { Role } from '@sales-portal/shared';
import { ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, EmptyState } from '@/components/ui';
import { useAuth } from './auth';

/** Client-side guard for pages (UX only – the API enforces the same roles). */
export function RequireRoles({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  if (hasRole(...roles)) return <>{children}</>;
  return (
    <EmptyState
      icon={ShieldOff}
      title="Keine Berechtigung für diese Seite"
      description="Deine Rolle hat keinen Zugriff. Wenn du ihn brauchst, frag den Admin."
      action={
        <Button variant="secondary" onClick={() => navigate('/')}>
          Zu den Pendenzen
        </Button>
      }
    />
  );
}
