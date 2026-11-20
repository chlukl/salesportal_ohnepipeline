/** Rollen: Personen, Rollen vergeben/entfernen (mit «Rückgängig»), Person per E-Mail hinzufügen, «Ansicht als». */
import { ROLE_LABELS, ROLES, type PortalUser, type Role } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Input, SkeletonText, Table, TBody, TD, TH, THead, Toggle, TR } from '@/components/ui';

const ROLE_HELP: Record<Role, string> = {
  coldcaller: 'Anrufliste, Anruf, Ergebnis, Termin buchen, Anrufhistorie. Kein Dashboard.',
  sales: 'Pendenzen mit eigenen Terminen und Briefings, Dashboard.',
  ai_specialist: 'Pendenzen mit allen Erstgesprächen, Briefings, Dashboard.',
  admin: 'Rollen, Regeln, Vorlagen, Einstellungen, Protokoll und Fehler.',
};

export function RolesTab() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const [adding, setAdding] = useState(false);
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<{ items: PortalUser[] }>('/api/admin/users') });

  const setRoles = useMutation({
    mutationFn: (v: { id: string; roles: Role[] }) => api.put<PortalUser>(`/api/admin/users/${v.id}/roles`, { roles: v.roles }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
  const setActive = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.put<PortalUser>(`/api/admin/users/${v.id}/active`, { isActive: v.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const toggleRole = async (u: PortalUser, role: Role) => {
    const before = u.roles;
    const next = before.includes(role) ? before.filter((r) => r !== role) : [...before, role];
    try {
      await setRoles.mutateAsync({ id: u.id, roles: next });
      toast.success(`${u.displayName}: ${ROLE_LABELS[role]} ${next.includes(role) ? 'vergeben' : 'entfernt'}`, {
        action: { label: 'Rückgängig', onClick: () => setRoles.mutate({ id: u.id, roles: before }) },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const toggleActive = async (u: PortalUser) => {
    try {
      await setActive.mutateAsync({ id: u.id, isActive: !u.isActive });
      toast.success(u.isActive ? `Zugang von ${u.displayName} gesperrt – laufende Sitzungen beendet` : `Zugang von ${u.displayName} wieder aktiv`, {
        action: { label: 'Rückgängig', onClick: () => setActive.mutate({ id: u.id, isActive: u.isActive }) },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  useShortcut('n', () => setAdding(true), { description: 'Person hinzufügen', group: 'Admin' });

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Personen und Rollen"
          description="Rollen liegen im Portal, nicht im CRM. Änderungen gelten sofort, auch in laufenden Sitzungen."
          actions={
            <Button variant="primary" icon={UserPlus} kbd="N" onClick={() => setAdding(true)}>
              Person hinzufügen
            </Button>
          }
        />
        {users.isLoading ? (
          <div className="p-5">
            <SkeletonText lines={5} />
          </div>
        ) : !users.data?.items.length ? (
          <EmptyState icon={Users} title="Noch keine Personen" description="Füge die erste Person mit ihrer Microsoft-Adresse hinzu – sie meldet sich danach mit ihrem Konto an." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>E-Mail (Anmeldung)</TH>
                {ROLES.map((r) => (
                  <TH key={r} align="center" title={ROLE_HELP[r]}>
                    {ROLE_LABELS[r]}
                  </TH>
                ))}
                <TH align="center">Zugang aktiv</TH>
              </tr>
            </THead>
            <TBody>
              {users.data.items.map((u) => {
                const self = u.id === me.user.id;
                return (
                  <TR key={u.id} className={u.isActive ? undefined : 'opacity-60'}>
                    <TD className="font-medium">
                      {u.displayName} {self && <Badge tone="primary">du</Badge>}
                    </TD>
                    <TD className="text-fg-muted">{u.email}</TD>
                    {ROLES.map((r) => (
                      <TD key={r} align="center">
                        <input
                          type="checkbox"
                          aria-label={`${ROLE_LABELS[r]} für ${u.displayName}`}
                          className="size-4 cursor-pointer accent-[var(--kls-primary)] disabled:cursor-not-allowed"
                          checked={u.roles.includes(r)}
                          disabled={setRoles.isPending || (self && r === 'admin')}
                          title={self && r === 'admin' ? 'Die eigene Admin-Rolle kannst du nicht entfernen' : ROLE_HELP[r]}
                          onChange={() => void toggleRole(u, r)}
                        />
                      </TD>
                    ))}
                    <TD align="center">
                      <div className="flex justify-center">
                        <Toggle label={<span className="sr-only">Zugang aktiv</span>} checked={u.isActive} disabled={self || setActive.isPending} onChange={() => void toggleActive(u)} />
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      <ViewAsCard />
      <AddUserDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function ViewAsCard() {
  const { me, setViewAs } = useAuth();
  const navigate = useNavigate();
  if (!me.isRealAdmin) return null;
  const choose = async (role: Role) => {
    try {
      await setViewAs(role);
      toast.info(`Ansicht als ${ROLE_LABELS[role]}`, { description: 'Zurück über das Band oben oder das Menü bei deinem Namen.' });
      navigate('/');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Card>
      <CardHeader title="Ansicht als" description="Zum Testen: das Portal so sehen, wie es eine Rolle sieht. Deine Rollen ändern sich dabei nicht, Admin-Rechte sind währenddessen aus." />
      <CardBody className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {(['coldcaller', 'sales', 'ai_specialist', 'admin'] as Role[]).filter((r) => r !== 'admin').map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => void choose(role)}
            className="flex flex-col items-start gap-1 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary-subtle/40"
          >
            <span className="flex items-center gap-2 text-sm font-medium text-fg">
              <Eye className="size-4 text-fg-subtle" aria-hidden />
              {ROLE_LABELS[role]}
            </span>
            <span className="text-xs text-fg-muted">{ROLE_HELP[role]}</span>
          </button>
        ))}
      </CardBody>
    </Card>
  );
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const create = useMutation({
    mutationFn: () => api.post<PortalUser>('/api/admin/users', { email, displayName: name, roles }),
    onSuccess: (u) => {
      toast.success(`${u.displayName} hinzugefügt`, { description: 'Die Person kann sich jetzt mit ihrem Microsoft-Konto anmelden.' });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setEmail('');
      setName('');
      setRoles([]);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && name.trim().length >= 2;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Person hinzufügen"
      description="Die Anmeldung läuft über Microsoft (Entra ID). Beim ersten Login wird das Konto über die E-Mail-Adresse verknüpft."
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            Hinzufügen
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        <Input label="E-Mail-Adresse" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vorname.nachname@firma.ch" />
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Vorname Nachname" />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-fg">Rollen</legend>
          {ROLES.map((r) => (
            <Checkbox
              key={r}
              label={ROLE_LABELS[r]}
              description={ROLE_HELP[r]}
              checked={roles.includes(r)}
              onChange={() => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]))}
            />
          ))}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
