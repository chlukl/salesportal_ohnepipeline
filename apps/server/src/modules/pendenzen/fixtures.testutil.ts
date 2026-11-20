/** Test fixtures for the pendenzen/history API tests (small, deterministic mock-CRM + portal rows). Test-only. */
import { RESULT_GROUP_CODES } from '@sales-portal/shared';
import type { Db } from '../../db/client';
import { analyses, bookings, callSessions, changeSets, mockCrmActivities, mockCrmLeads, mockCrmTasks, mockCrmUsers } from '../../db/schema';
import { DEMO_USERS, demoUser } from '../../db/seed/users';

export const IDS = {
  leadAlpha: 'lead-alpha',
  leadBeta: 'lead-beta',
  leadCampaign: 'lead-campaign',
  taskMarkusCallback: 'task-markus-callback',
  taskMarkusLater: 'task-markus-later',
  taskManuel: 'task-manuel',
  sessionUnfinished: '11111111-1111-4111-8111-000000000001',
  sessionMissed: '11111111-1111-4111-8111-000000000002',
  sessionUnknown: '11111111-1111-4111-8111-000000000003',
  csPending: '22222222-2222-4222-8222-000000000001',
  csFailed: '22222222-2222-4222-8222-000000000002',
  analysisReady: '33333333-3333-4333-8333-000000000001',
  bookingManuel: '44444444-4444-4444-8444-000000000001',
  bookingCancelled: '44444444-4444-4444-8444-000000000002',
} as const;

export const UNKNOWN_NUMBER = '+41445550123';

const H = 3_600_000;
const D = 24 * H;

export async function seedFixtures(db: Db, now = new Date()): Promise<void> {
  const markus = demoUser('markus');
  const manuel = demoUser('manuel');
  const nico = demoUser('nico');
  const at = (ms: number) => new Date(now.getTime() + ms);

  await db
    .insert(mockCrmUsers)
    .values(DEMO_USERS.map((u) => ({ id: u.crmUserId, fullname: u.displayName, email: u.email, title: u.title })))
    .onConflictDoNothing();
  await db.insert(mockCrmLeads).values([
    {
      leadid: IDS.leadAlpha,
      companyname: 'Alpha Treuhand AG',
      firstname: 'Anna',
      lastname: 'Muster',
      telephone1: '+41 61 555 01 02',
      domain: 'alpha.example.ch',
      kls_leadscore: 72,
      ownerid: markus.crmUserId,
      statuscode: 1,
    },
    { leadid: IDS.leadBeta, companyname: 'Beta Holzbau GmbH', firstname: 'Beat', lastname: 'Beispiel', telephone1: '079 333 44 55', domain: 'beta.example.ch' },
    {
      leadid: IDS.leadCampaign,
      companyname: 'Gamma Logistik AG',
      firstname: 'Gina',
      lastname: 'Gamma',
      telephone1: '+41 31 555 77 88',
      campaignName: 'KI im KMU',
      campaignJoinedAt: at(-200 * D),
    },
  ]);
  await db.insert(mockCrmTasks).values([
    {
      activityid: IDS.taskMarkusCallback,
      regardingLeadId: IDS.leadAlpha,
      subject: 'Rückruf Alpha Treuhand AG',
      scheduledend: at(-2 * D),
      ownerid: markus.crmUserId,
      taskType: 'callback',
    },
    {
      activityid: IDS.taskMarkusLater,
      regardingLeadId: IDS.leadCampaign,
      subject: 'Nachfassen Gamma',
      scheduledend: at(30 * D),
      ownerid: markus.crmUserId,
      taskType: 'follow_up',
    },
    {
      activityid: IDS.taskManuel,
      regardingLeadId: IDS.leadBeta,
      subject: 'Offerte nachfassen: Beta Holzbau GmbH',
      scheduledend: at(1 * H),
      ownerid: manuel.crmUserId,
      taskType: 'follow_up',
    },
  ]);
  // Outgoing call 3 days ago (reason for the callback) – Markus.
  await db.insert(mockCrmActivities).values({
    activityid: 'pc-alpha-1',
    activitytype: 'phonecall',
    regardingLeadId: IDS.leadAlpha,
    subject: 'Erstkontakt Alpha',
    description: 'Sales-Portal: GL bittet um Rückruf nächste Woche.',
    direction: 'outgoing',
    ownerid: markus.crmUserId,
    phonenumber: '+41 61 555 01 02',
    actualstart: at(-3 * D),
    durationSec: 180,
    kls_anrufergebnis: RESULT_GROUP_CODES.callback,
  });
  await db.insert(callSessions).values([
    {
      id: IDS.sessionUnfinished,
      userId: markus.id,
      leadId: IDS.leadBeta,
      leadName: 'Beat Beispiel',
      companyName: 'Beta Holzbau GmbH',
      phoneE164: '+41793334455',
      direction: 'outbound',
      category: 'outbound',
      status: 'ended',
      dialedAt: at(-1 * H),
      connectedAt: at(-1 * H),
      endedAt: at(-0.5 * H),
    },
    {
      id: IDS.sessionMissed,
      userId: markus.id,
      leadId: IDS.leadAlpha,
      leadName: 'Anna Muster',
      companyName: 'Alpha Treuhand AG',
      phoneE164: '+41615550102',
      phoneDisplay: '+41 61 555 01 02',
      direction: 'inbound',
      category: 'callback_missed',
      status: 'ended',
      dialedAt: at(-2 * H),
      endedAt: at(-2 * H),
      createdAt: at(-2 * H),
    },
    {
      id: IDS.sessionUnknown,
      userId: markus.id,
      phoneE164: UNKNOWN_NUMBER,
      phoneDisplay: '+41 44 555 01 23',
      direction: 'inbound',
      category: 'unknown_number',
      status: 'ended',
      dialedAt: at(-5 * H),
      createdAt: at(-5 * H),
    },
  ]);
  await db.insert(changeSets).values([
    { id: IDS.csPending, leadId: IDS.leadCampaign, kind: 'call_result', status: 'pending', createdBy: markus.id },
    { id: IDS.csFailed, leadId: IDS.leadAlpha, kind: 'call_result', status: 'failed', error: 'CRM antwortet nicht (Timeout)', createdBy: markus.id },
  ]);
  await db.insert(analyses).values({ id: IDS.analysisReady, kind: 'call', leadId: IDS.leadAlpha, ownerUserId: markus.id, status: 'ready' });
  await db.insert(bookings).values([
    {
      id: IDS.bookingManuel,
      bookingRef: 'KLS-TEST-001',
      leadId: IDS.leadCampaign,
      leadName: 'Gina Gamma',
      companyName: 'Gamma Logistik AG',
      salesUserId: manuel.id,
      specialistUserId: nico.id,
      startAt: at(3 * D),
      endAt: at(3 * D + 0.5 * H),
      status: 'booked',
      origin: 'campaign',
      needsPreparation: true,
      preparationNote: 'Demo Belegerfassung',
      subject: 'Vorstellung der Kallysoft – Gamma',
      createdBy: markus.id,
      createdAt: at(-1 * D),
    },
    {
      id: IDS.bookingCancelled,
      bookingRef: 'KLS-TEST-002',
      leadId: IDS.leadAlpha,
      leadName: 'Anna Muster',
      companyName: 'Alpha Treuhand AG',
      salesUserId: manuel.id,
      specialistUserId: nico.id,
      startAt: at(5 * D),
      endAt: at(5 * D + 0.5 * H),
      status: 'cancelled',
      origin: 'coldcall',
      subject: 'Vorstellung der Kallysoft – Alpha',
      createdBy: markus.id,
      updatedAt: at(-1 * H),
    },
  ]);
}
