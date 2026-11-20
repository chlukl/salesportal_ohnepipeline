/** Demo users (mock / dev mode only). Fixed ids so links and tests are stable. Emails are obviously fake. */
import type { Role } from '@sales-portal/shared';

export const DEMO_EMAILS = {
  lukas: 'lukas.demo@example.ch',
  markus: 'markus.demo@example.ch',
  manuel: 'manuel.demo@example.ch',
  nico: 'nico.demo@example.ch',
} as const;

export interface DemoUser {
  key: keyof typeof DEMO_EMAILS;
  id: string;
  email: string;
  displayName: string;
  title: string;
  roles: Role[];
  crmUserId: string;
  phoneE164: string | null;
}

export const DEMO_USERS: DemoUser[] = [
  {
    key: 'lukas',
    id: '00000000-0000-4000-8000-000000000001',
    email: DEMO_EMAILS.lukas,
    displayName: 'Lukas',
    title: 'Geschäftsleitung · Admin',
    roles: ['coldcaller', 'sales', 'ai_specialist', 'admin'],
    crmUserId: 'c0000000-0000-4000-8000-000000000001',
    phoneE164: null,
  },
  {
    key: 'markus',
    id: '00000000-0000-4000-8000-000000000002',
    email: DEMO_EMAILS.markus,
    displayName: 'Markus',
    title: 'Coldcaller',
    roles: ['coldcaller'],
    crmUserId: 'c0000000-0000-4000-8000-000000000002',
    phoneE164: '+41615550102',
  },
  {
    key: 'manuel',
    id: '00000000-0000-4000-8000-000000000003',
    email: DEMO_EMAILS.manuel,
    displayName: 'Manuel',
    title: 'Sales',
    roles: ['sales'],
    crmUserId: 'c0000000-0000-4000-8000-000000000003',
    phoneE164: null,
  },
  {
    key: 'nico',
    id: '00000000-0000-4000-8000-000000000004',
    email: DEMO_EMAILS.nico,
    displayName: 'Nico',
    title: 'AI-Spezialist',
    roles: ['ai_specialist'],
    crmUserId: 'c0000000-0000-4000-8000-000000000004',
    phoneE164: null,
  },
];

/** CRM-only users (no portal login). */
export const CRM_ONLY_USERS = [
  { id: 'c0000000-0000-4000-8000-000000000010', fullname: 'Sandra Marketing', email: 'sandra.demo@example.ch', title: 'Marketing' },
  { id: 'c0000000-0000-4000-8000-000000000011', fullname: 'Divendo Team', email: 'divendo.demo@example.ch', title: 'Partner Coldcall' },
  { id: 'c0000000-0000-4000-8000-000000000012', fullname: 'Reto Account', email: 'reto.demo@example.ch', title: 'Account Manager' },
];

export const demoUser = (key: DemoUser['key']): DemoUser => DEMO_USERS.find((u) => u.key === key) as DemoUser;
