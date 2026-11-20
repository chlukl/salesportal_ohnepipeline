/**
 * Demo data for the mock CRM (~400 invented Swiss SME leads, persons, 8 weeks of activities, tasks, campaign mails,
 * bookings and calendars). Deterministic (seeded PRNG); all dates are relative to `now`.
 * Runs only when the CRM adapter is mock and `mock_crm_leads` is empty.
 */
import {
  CALL_STATUS,
  INTEREST_KI_SERVICES,
  LEAD_SUPPORT,
  normalizePhone,
  RATING,
  RESULT_GROUP_CODES,
  RESULT_GROUP_LABELS,
  snapshotKey,
  STATE,
  STATUS,
  zurichDate,
  zurichTime,
  type CampaignReaction,
  type ResultGroupKey,
} from '@sales-portal/shared';
import { count, type InferInsertModel } from 'drizzle-orm';
import type { Db } from '../client';
import {
  auditLog,
  bookings,
  callSessions,
  changeSets,
  mockCalendarEvents,
  mockCrmAccounts,
  mockCrmActivities,
  mockCrmContacts,
  mockCrmLeads,
  mockCrmTasks,
  mockCrmUsers,
  notifications,
} from '../schema';
import {
  CALL_NOTES,
  CAMPAIGN_SUBJECTS,
  CAMPAIGNS,
  EMPLOYEE_BAND_WEIGHTS,
  ERP_SYSTEMS,
  FEMALE_FIRST,
  INDUSTRIES,
  JOB_TITLES_PRIVATE,
  JOB_TITLES_PUBLIC,
  MALE_FIRST,
  MEETING_SUBJECTS,
  SURNAMES,
  TOWNS,
  type IndustryDef,
  type Town,
} from './data';
import { Prng } from './prng';
import { CRM_ONLY_USERS, DEMO_USERS, demoUser } from './users';

type LeadRow = InferInsertModel<typeof mockCrmLeads>;
type AccountRow = InferInsertModel<typeof mockCrmAccounts>;
type ContactRow = InferInsertModel<typeof mockCrmContacts>;
type ActivityRow = InferInsertModel<typeof mockCrmActivities>;
type TaskRow = InferInsertModel<typeof mockCrmTasks>;
type EventRow = InferInsertModel<typeof mockCalendarEvents>;
type BookingRow = InferInsertModel<typeof bookings>;

const TARGET_LEADS = 400;
const SEED = 20261120;

const LUKAS = demoUser('lukas');
const MARKUS = demoUser('markus');
const MANUEL = demoUser('manuel');
const NICO = demoUser('nico');
const [SANDRA, DIVENDO, RETO] = CRM_ONLY_USERS;

const DAY = 86_400_000;

function translit(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/é|è/g, 'e')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface DemoSeedResult {
  seeded: boolean;
  counts: Record<string, number>;
}

export async function seedDemo(db: Db, options: { now?: Date } = {}): Promise<DemoSeedResult> {
  const [{ n }] = await db.select({ n: count() }).from(mockCrmLeads);
  if (Number(n) > 0) return { seeded: false, counts: {} };

  const now = options.now ?? new Date();
  const rnd = new Prng(SEED);
  const data = generate(rnd, now);

  await db.transaction(async (tx) => {
    const chunked = async <T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) => {
      for (let i = 0; i < rows.length; i += 200) await insert(rows.slice(i, i + 200));
    };
    await tx.insert(mockCrmUsers).values([
      ...DEMO_USERS.map((u) => ({ id: u.crmUserId, fullname: u.displayName, email: u.email, title: u.title })),
      ...CRM_ONLY_USERS,
    ]);
    await chunked(data.accounts, (c) => tx.insert(mockCrmAccounts).values(c));
    await chunked(data.leads, (c) => tx.insert(mockCrmLeads).values(c));
    await chunked(data.contacts, (c) => tx.insert(mockCrmContacts).values(c));
    await chunked(data.activities, (c) => tx.insert(mockCrmActivities).values(c));
    await chunked(data.tasks, (c) => tx.insert(mockCrmTasks).values(c));
    await chunked(data.events, (c) => tx.insert(mockCalendarEvents).values(c));
    if (data.bookings.length) await tx.insert(bookings).values(data.bookings);
    if (data.callSessions.length) await tx.insert(callSessions).values(data.callSessions);
    if (data.changeSets.length) await tx.insert(changeSets).values(data.changeSets);
    if (data.auditLog.length) await tx.insert(auditLog).values(data.auditLog);
    if (data.notifications.length) await tx.insert(notifications).values(data.notifications);
  });

  return {
    seeded: true,
    counts: {
      leads: data.leads.length,
      accounts: data.accounts.length,
      contacts: data.contacts.length,
      activities: data.activities.length,
      tasks: data.tasks.length,
      events: data.events.length,
      bookings: data.bookings.length,
      callSessions: data.callSessions.length,
      changeSets: data.changeSets.length,
      notifications: data.notifications.length,
    },
  };
}

// =====================================================================================================================

interface Generated {
  leads: LeadRow[];
  accounts: AccountRow[];
  contacts: ContactRow[];
  activities: ActivityRow[];
  tasks: TaskRow[];
  events: EventRow[];
  bookings: BookingRow[];
  callSessions: InferInsertModel<typeof callSessions>[];
  changeSets: InferInsertModel<typeof changeSets>[];
  auditLog: InferInsertModel<typeof auditLog>[];
  notifications: InferInsertModel<typeof notifications>[];
}

type Scenario =
  | 'new_untouched'
  | 'new_not_reached'
  | 'contacted'
  | 'exchange'
  | 'campaign_locked'
  | 'campaign_unlocked'
  | 'divendo'
  | 'disqualified'
  | 'dnc'
  | 'qualified'
  | 'same_domain';

function generate(rnd: Prng, now: Date): Generated {
  const out: Generated = {
    leads: [],
    accounts: [],
    contacts: [],
    activities: [],
    tasks: [],
    events: [],
    bookings: [],
    callSessions: [],
    changeSets: [],
    auditLog: [],
    notifications: [],
  };
  const usedNames = new Set<string>();
  const nowMs = now.getTime();

  // ---- time helpers (Europe/Zurich wall clock) ----------------------------------------------------------------------
  const isoDay = (offsetDays: number) => zurichDate(new Date(nowMs + offsetDays * DAY));
  const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const workdayIso = (offsetDays: number, dir: 1 | -1) => {
    let off = offsetDays;
    let iso = isoDay(off);
    while (weekday(iso) === 0 || weekday(iso) === 6) {
      off += dir;
      iso = isoDay(off);
    }
    return iso;
  };
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const callHour = () => rnd.weighted([[8, 2], [9, 6], [10, 12], [11, 9], [12, 1], [13, 2], [14, 11], [15, 12], [16, 6], [17, 2]] as const);
  /** A past business-hours instant `daysBack` days ago (never in the future). */
  const pastAt = (daysBack: number): Date => {
    let back = Math.max(0, daysBack);
    for (;;) {
      const d = zurichTime(workdayIso(-back, -1), hhmm(callHour(), rnd.int(0, 59)));
      if (d.getTime() < nowMs - 10 * 60_000) return d;
      back += 1;
    }
  };
  const futureAt = (daysAhead: number, h: number, m = 0): Date => zurichTime(workdayIso(daysAhead, 1), hhmm(h, m));
  const addMin = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

  // ---- phone helpers ---------------------------------------------------------------------------------------------------
  const subscriber = () => `${rnd.int(2, 9)}${String(rnd.int(0, 999_999)).padStart(6, '0')}`;
  const fmtSwiss = (area: string, sub: string, variant: number): string => {
    const a = `${sub.slice(0, 3)} ${sub.slice(3, 5)} ${sub.slice(5, 7)}`;
    switch (variant) {
      case 0:
        return `+41 ${area} ${a}`;
      case 1:
        return `0${area} ${a}`;
      case 2:
        return `0${area}${sub}`;
      case 3:
        return `0041 ${area} ${a}`;
      case 4:
        return `+41${area}${sub}`;
      case 5:
        return `0${area}/${a}`;
      default:
        return `+41 (0)${area} ${a}`;
    }
  };
  const companyPhone = (town: Town): string => {
    const kind = rnd.weighted([
      ['plain', 82],
      ['ext', 5],
      ['invalid', 4],
      ['multiple', 4],
      ['foreign', 2],
      ['text', 3],
    ] as const);
    const sub = subscriber();
    switch (kind) {
      case 'ext':
        return rnd.chance(0.5) ? `${fmtSwiss(town.area, sub, 0)} / ${rnd.int(200, 299)}` : `${fmtSwiss(town.area, sub, 1)} int. ${rnd.int(10, 99)}`;
      case 'invalid':
        return rnd.pick([`0${town.area} ${sub.slice(0, 3)} ${sub.slice(3, 5)}`, '123 45', `0${town.area}12345`]);
      case 'multiple':
        return `${fmtSwiss(town.area, sub, 1)} / 07${rnd.pick(['6', '8', '9'])} ${subscriber().slice(0, 3)} ${rnd.int(10, 99)} ${rnd.int(10, 99)}`;
      case 'foreign':
        return town.canton === 'BS' || town.canton === 'BL' ? `+49 7621 ${rnd.int(100000, 999999)}` : `+33 3 89 ${rnd.int(10, 99)} ${rnd.int(10, 99)} ${rnd.int(10, 99)}`;
      case 'text':
        return rnd.pick(['folgt', 'unbekannt', 'siehe Website']);
      default:
        return fmtSwiss(town.area, sub, rnd.weighted([[0, 30], [1, 25], [2, 10], [3, 8], [4, 6], [5, 4], [6, 4]] as const));
    }
  };
  const mobilePhone = () => {
    const prefix = rnd.pick(['76', '77', '78', '79']);
    const sub = subscriber();
    return fmtSwiss(prefix, sub, rnd.weighted([[1, 50], [0, 30], [3, 10], [4, 10]] as const));
  };

  // ---- company / person helpers -------------------------------------------------------------------------------------------
  const makeName = (ind: IndustryDef, town: Town): string | null => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const s = rnd.pick(SURNAMES);
      let s2 = rnd.pick(SURNAMES);
      if (s2 === s) s2 = rnd.pick(SURNAMES);
      const name = rnd
        .pick(ind.patterns)
        .replace('{S2}', s2)
        .replace('{S}', s)
        .replace('{C}', town.city)
        .replace('{W}', ind.words.length ? rnd.pick(ind.words) : 'Technik');
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    return null;
  };
  const person = (orgType: IndustryDef['orgType'], management: boolean) => {
    const female = rnd.chance(0.38);
    const firstname = rnd.pick(female ? FEMALE_FIRST : MALE_FIRST);
    const lastname = rnd.pick(SURNAMES);
    const titles = orgType === 'public' ? JOB_TITLES_PUBLIC : JOB_TITLES_PRIVATE;
    const jobtitle = rnd.chance(0.08)
      ? null
      : management
        ? rnd.pick(female ? titles.managementF : titles.management)
        : rnd.pick(female ? titles.otherF : titles.other);
    return { female, firstname, lastname, jobtitle };
  };
  const scoreFor = (): number | null => {
    const grade = rnd.weighted([['A', 7], ['B', 13], ['C', 20], ['D', 20], ['U', 40]] as const);
    switch (grade) {
      case 'A':
        return rnd.int(70, 92);
      case 'B':
        return rnd.int(50, 69);
      case 'C':
        return rnd.int(30, 49);
      case 'D':
        return rnd.int(6, 29);
      default:
        return null;
    }
  };
  const gradeLetter = (score: number) => (score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D');
  const assessment = (ind: IndustryDef, score: number, employees: number | null, created: Date): string => {
    const erp = rnd.pick(ERP_SYSTEMS);
    const kws = [...rnd.sample(ind.keywords, 3), `ERP ${erp}`];
    const uc = rnd.pick(ind.useCases);
    const org = ind.orgType === 'public' ? 'öffentliche Hand' : ind.orgType === 'association' ? 'Verein/Stiftung' : 'privat';
    return [
      `Stand: ${zurichDate(new Date(created.getTime() + 2 * DAY)).split('-').reverse().join('.')} (Score V4)`,
      `Grade: ${gradeLetter(score)} (${score})`,
      `Einstieg: ${rnd.pick(ind.einstieg)}`,
      `Stichworte: ${kws.join(', ')}`,
      `Nächster Schritt: Anruf ${rnd.chance(0.6) ? 'GL' : 'Leitung Finanzen/IT'}, Use Case ${uc} vorstellen`,
      `Organisation: ${org}`,
      `Grösse: ${employees ?? 'unbekannt'} MA (Zefix/Website)`,
      `Quelle: Website, Zefix${rnd.chance(0.2) ? ', Apollo' : ''}`,
    ].join('\n');
  };

  // ---- activity helpers ----------------------------------------------------------------------------------------------------
  const pushCall = (
    leadId: string,
    company: string,
    at: Date,
    result: ResultGroupKey | null,
    opts: { durationSec?: number | null; note?: string | null; interest?: number | null; direction?: 'outgoing' | 'incoming'; owner?: string; phone?: string | null } = {},
  ) => {
    const reached = result != null && result !== 'not_reached' && result !== 'wrong_number';
    const durationSec = opts.durationSec !== undefined ? opts.durationSec : reached ? rnd.int(75, 760) : result ? rnd.int(15, 45) : null;
    out.activities.push({
      activityid: rnd.guid(),
      activitytype: 'phonecall',
      regardingLeadId: leadId,
      subject: result ? `Anruf ${company} – ${RESULT_GROUP_LABELS[result]}` : `Anruf ${company}`,
      description: opts.note ?? null,
      direction: opts.direction ?? 'outgoing',
      ownerid: opts.owner ?? MARKUS.crmUserId,
      phonenumber: opts.phone ?? null,
      actualstart: at,
      actualend: durationSec != null ? new Date(at.getTime() + durationSec * 1000) : at,
      durationSec,
      statecode: 1,
      kls_anrufergebnis: result ? RESULT_GROUP_CODES[result] : null,
      kls_interesse: reached ? (opts.interest ?? null) : null,
      createdon: at,
      modifiedon: at,
    });
  };
  const pushNote = (leadId: string, at: Date, text: string, owner = MARKUS.crmUserId) => {
    out.activities.push({
      activityid: rnd.guid(),
      activitytype: 'note',
      regardingLeadId: leadId,
      subject: text.startsWith('Sales-Portal:') ? 'Sales-Portal' : 'Notiz',
      description: text,
      ownerid: owner,
      actualstart: at,
      statecode: 1,
      createdon: at,
      modifiedon: at,
    });
  };
  const pushMail = (leadId: string, at: Date, subject: string, body: string, to: string | null, owner = MARKUS.crmUserId) => {
    out.activities.push({
      activityid: rnd.guid(),
      activitytype: 'email',
      regardingLeadId: leadId,
      subject,
      description: body,
      direction: 'outgoing',
      ownerid: owner,
      fromText: owner === MARKUS.crmUserId ? MARKUS.email : null,
      toText: to,
      actualstart: at,
      statecode: 1,
      createdon: at,
      modifiedon: at,
    });
  };
  const pushTask = (
    leadId: string | null,
    subject: string,
    due: Date,
    taskType: TaskRow['taskType'],
    owner = MARKUS.crmUserId,
    statecode = 0,
    description: string | null = null,
  ) => {
    const created = new Date(Math.min(nowMs - DAY, due.getTime() - rnd.int(1, 10) * DAY));
    out.tasks.push({
      activityid: rnd.guid(),
      regardingLeadId: leadId,
      subject,
      description,
      scheduledend: due,
      ownerid: owner,
      statecode,
      taskType,
      createdon: created,
      modifiedon: statecode === 1 ? due : created,
      completedon: statecode === 1 ? new Date(Math.min(due.getTime(), nowMs - 3600_000)) : null,
    });
  };
  const callStatusForFollowUp = (due: Date): number => {
    const days = Math.round((Date.parse(`${zurichDate(due)}T00:00:00Z`) - Date.parse(`${zurichDate(now)}T00:00:00Z`)) / DAY);
    if (days <= 0) return CALL_STATUS.CALLBACK_TODAY;
    if (days === 1) return CALL_STATUS.CALLBACK_TOMORROW;
    if (days <= 7) return CALL_STATUS.CALLBACK_7_DAYS;
    if (days <= 31) return CALL_STATUS.CALLBACK_31_DAYS;
    return CALL_STATUS.CALLBACK_3_6_MONTHS;
  };
  const noteFor = (key: string) => rnd.pick(CALL_NOTES[key] ?? CALL_NOTES.legacy).replace('{day}', rnd.pick(['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag']));

  // ---- bookings ---------------------------------------------------------------------------------------------------------------------
  let bookingCount = 0;
  const bookingSlots: [number, number, number][] = [
    [-4, 10, 0],
    [2, 10, 0],
    [3, 14, 30],
    [6, 9, 30],
    [8, 15, 0],
    [10, 11, 0],
    [13, 14, 0],
  ];
  const addBooking = (lead: LeadRow, origin: 'coldcall' | 'campaign', bookedAt: Date): boolean => {
    if (bookingCount >= bookingSlots.length) return false;
    const [offset, h, m] = bookingSlots[bookingCount];
    bookingCount += 1;
    const start = offset < 0 ? zurichTime(workdayIso(offset, -1), hhmm(h, m)) : futureAt(offset, h, m);
    const end = addMin(start, 30);
    const extraCall = bookingCount === 4;
    const sales = extraCall ? LUKAS : MANUEL;
    const ref = `KLS-${zurichDate(start).replace(/-/g, '')}-${String(bookingCount).padStart(3, '0')}`;
    const iCalUId = `demo-ical-${rnd.guid()}`;
    const subject = `Vorstellung der Kallysoft Informatik AG als KI-Spezialist – ${lead.companyname}`;
    const attendees = [
      { email: sales.email, name: sales.displayName, type: 'required' as const, response: 'organizer' as const },
      { email: NICO.email, name: NICO.displayName, type: 'required' as const, response: 'accepted' as const },
      ...(lead.emailaddress1
        ? [{ email: lead.emailaddress1, name: `${lead.firstname ?? ''} ${lead.lastname ?? ''}`.trim(), type: 'required' as const, response: 'accepted' as const }]
        : []),
    ];
    const mainIds: string[] = [];
    const blockerIds: string[] = [];
    for (const mailbox of [sales.email, NICO.email]) {
      const id = rnd.guid();
      mainIds.push(id);
      out.events.push({
        id,
        mailbox,
        subject,
        body: 'Teams-Besprechung',
        startAt: start,
        endAt: end,
        showAs: 'busy',
        categories: ['Kallysoft Erstgespräch'],
        organizer: sales.email,
        attendees,
        extendedProperties: { KlsTerminId: ref },
        iCalUId,
        isOnlineMeeting: true,
        onlineJoinUrl: 'https://teams.microsoft.com/l/meetup-join/demo',
        lastModified: bookedAt,
      });
      for (const [bStart, label] of [
        [addMin(start, -30), 'Vorbereitung'],
        [end, 'Nachbereitung'],
      ] as const) {
        const bid = rnd.guid();
        blockerIds.push(bid);
        out.events.push({
          id: bid,
          mailbox,
          subject: `Blocker ${label}: ${lead.companyname}`,
          startAt: bStart,
          endAt: addMin(bStart, 30),
          showAs: 'busy',
          categories: ['Kallysoft Erstgespräch'],
          organizer: mailbox,
          extendedProperties: { KlsTerminId: ref, KlsRolle: 'blocker' },
          lastModified: bookedAt,
        });
      }
    }
    out.activities.push({
      activityid: rnd.guid(),
      activitytype: 'appointment',
      regardingLeadId: lead.leadid,
      subject,
      description: 'Teams-Meeting, gebucht im Sales-Portal',
      ownerid: sales.crmUserId,
      scheduledstart: start,
      scheduledend: end,
      actualstart: start,
      statecode: start.getTime() < nowMs ? 1 : 0,
      createdon: bookedAt,
      modifiedon: bookedAt,
    });
    out.bookings.push({
      bookingRef: ref,
      leadId: lead.leadid,
      leadName: `${lead.firstname ?? ''} ${lead.lastname ?? ''}`.trim() || null,
      companyName: lead.companyname,
      salesUserId: sales.id,
      specialistUserId: NICO.id,
      extraCall,
      startAt: start,
      endAt: end,
      status: start.getTime() < nowMs ? 'held' : 'booked',
      origin,
      eventId: mainIds[0],
      iCalUId,
      blockerEventIds: blockerIds,
      briefingEventIds: [],
      needsPreparation: bookingCount === 3,
      preparationNote: bookingCount === 3 ? 'Kunde wünscht kurze Demo zur Belegerfassung mit eigenen Beispielen.' : null,
      briefingStatus: start.getTime() < nowMs ? 'read' : 'open',
      externalAttendees: lead.emailaddress1
        ? [{ email: lead.emailaddress1, name: `${lead.firstname ?? ''} ${lead.lastname ?? ''}`.trim(), isMainContact: true, response: 'accepted' }]
        : [],
      subject,
      body: null,
      createdBy: MARKUS.id,
      createdAt: bookedAt,
      updatedAt: bookedAt,
    });
    if (start.getTime() > nowMs) {
      pushTask(lead.leadid, `Nach Erstgespräch nachfassen: ${lead.companyname}`, addMin(end, 3 * 24 * 60), 'follow_up', sales.crmUserId);
    }
    return true;
  };

  // ---- main loop ------------------------------------------------------------------------------------------------------------
  let campaignUnlockedBooked = false;
  while (out.leads.length < TARGET_LEADS) {
    const ind = rnd.weighted(INDUSTRIES.map((i) => [i, i.weight] as const));
    const town = rnd.pick(TOWNS);
    const name = makeName(ind, town);
    if (!name) continue;
    const domainSlug = translit(name.replace(/\b(AG|GmbH|& Co\.|Group)\b/g, '').trim());
    const domain = `${domainSlug}.example`;
    const band = rnd.weighted(EMPLOYEE_BAND_WEIGHTS);
    let employees = band ? rnd.int(band[0], band[1]) : null;
    if (ind.orgType !== 'private' && employees != null && employees < 10) employees = rnd.int(15, 120);
    const score = scoreFor();
    const createdon = new Date(nowMs - rnd.int(30, 420) * DAY);
    const mainPhone = companyPhone(town);
    const customIndustry = ind.custom.length && rnd.chance(0.8) ? rnd.pick(ind.custom) : null;

    // Account + contacts for ~35 % of the companies.
    const hasAccount = rnd.chance(0.35);
    const accountId = hasAccount ? rnd.guid() : null;
    const isCustomer = hasAccount && rnd.chance(0.12);
    if (hasAccount && accountId) {
      out.accounts.push({
        accountid: accountId,
        name,
        websiteurl: `https://www.${domain}`,
        domain,
        telephone1: mainPhone,
        address1_city: town.city,
        address1_postalcode: town.plz,
        address1_stateorprovince: town.canton,
        numberofemployees: employees,
        industry: ind.industry,
        ownerid: isCustomer ? RETO.id : LUKAS.crmUserId,
        isCustomer,
        createdon,
        modifiedon: createdon,
      });
    }

    const leadCount = rnd.chance(0.22) ? 2 : 1;
    const maxContacts = hasAccount ? Math.min(3 - leadCount, rnd.int(0, 2)) : 0;
    for (let c = 0; c < maxContacts; c++) {
      const p = person(ind.orgType, false);
      out.contacts.push({
        contactid: rnd.guid(),
        parentcustomerid: accountId,
        firstname: p.firstname,
        lastname: p.lastname,
        jobtitle: p.jobtitle,
        emailaddress1: rnd.chance(0.85) ? `${translit(p.firstname)}.${translit(p.lastname)}@${domain}` : null,
        telephone1: rnd.chance(0.7) ? fmtSwiss(town.area, subscriber(), rnd.int(0, 2)) : null,
        mobilephone: rnd.chance(0.3) ? mobilePhone() : null,
        domain,
        createdon,
        modifiedon: createdon,
      });
    }

    for (let li = 0; li < leadCount && out.leads.length < TARGET_LEADS; li++) {
      const main = li === 0;
      const p = person(ind.orgType, main ? rnd.chance(0.75) : rnd.chance(0.2));
      const leadid = rnd.guid();
      const scenario: Scenario = main
        ? rnd.weighted([
            ['new_untouched', 38],
            ['new_not_reached', 15],
            ['contacted', 21],
            ['exchange', 4],
            ['campaign_locked', 7],
            ['campaign_unlocked', 6],
            ['divendo', 3],
            ['disqualified', 3],
            ['dnc', 1.5],
            ['qualified', 1],
            ['same_domain', 1.5],
          ] as const)
        : 'new_untouched';
      const lead: LeadRow = {
        leadid,
        companyname: name,
        firstname: p.firstname,
        lastname: p.lastname,
        jobtitle: p.jobtitle,
        emailaddress1: rnd.chance(0.9) ? `${translit(p.firstname)}.${translit(p.lastname)}@${domain}` : null,
        telephone1: main ? mainPhone : rnd.chance(0.6) ? fmtSwiss(town.area, subscriber(), rnd.int(0, 4)) : null,
        mobilephone: rnd.chance(main ? 0.3 : 0.5) ? mobilePhone() : null,
        websiteurl: rnd.chance(0.95) ? `https://www.${domain}` : null,
        domain,
        numberofemployees: employees,
        kls_industry: ind.industry,
        kls_custom_industry: customIndustry,
        kls_leadscore: score,
        kls_ki_bewertung: score != null ? assessment(ind, score, employees, createdon) : null,
        kls_callstatus: null,
        kls_rating_category: null,
        statecode: STATE.OPEN,
        statuscode: main ? STATUS.NEW : rnd.chance(0.5) ? STATUS.SECOND_CONTACT : STATUS.NEW,
        ownerid: LUKAS.crmUserId,
        subject: rnd.weighted([['Zefix-Import Q3 2026', 50], ['Zefix-Import Q2 2026', 25], ['BC/NAV-Research', 5], [null, 20]] as const),
        leadsourcecode: rnd.weighted([[845140000, 70], [845140001, 10], [8, 10], [null, 10]] as const),
        kls_lead_support: rnd.chance(0.05) ? LEAD_SUPPORT.BC_NAV_RESEARCH : rnd.chance(0.6) ? LEAD_SUPPORT.COLDCALL : null,
        kls_interests: rnd.chance(0.1) ? [rnd.pick([845140000, 845140002, 845140005])] : [],
        decisionmaker: main && p.jobtitle && /schäftsf|Inhaber|CEO|leiter|schreiber/i.test(p.jobtitle) ? true : null,
        donotphone: false,
        donotemail: false,
        donotbulkemail: false,
        kls_competitor: null,
        kls_salutation: rnd.chance(0.9) ? (p.female ? 845140001 : 845140000) : null,
        address1_postalcode: town.plz,
        address1_city: town.city,
        address1_stateorprovince: town.canton,
        parentaccountid: accountId,
        orgType: ind.orgType,
        campaignName: null,
        campaignJoinedAt: null,
        createdon,
        modifiedon: createdon,
      };
      let lastTouch = createdon.getTime();
      const touch = (d: Date) => {
        lastTouch = Math.max(lastTouch, d.getTime());
      };

      switch (scenario) {
        case 'new_untouched': {
          if (rnd.chance(0.1)) {
            // Older call via the CRM dialer without result («Anrufen …», short).
            const at = pastAt(rnd.int(30, 55));
            pushCall(leadid, name, at, null, { durationSec: rnd.int(10, 90), owner: LUKAS.crmUserId });
            touch(at);
          }
          if (rnd.chance(0.12)) {
            const at = pastAt(rnd.int(5, 50));
            pushNote(leadid, at, 'Sales-Portal: Lead-Bereinigung – Branche und Grösse ergänzt (Pipeline).', LUKAS.crmUserId);
          }
          break;
        }
        case 'new_not_reached': {
          const attempts = rnd.int(1, 3);
          let back = rnd.int(1, 20);
          for (let a = 0; a < attempts; a++) {
            const at = pastAt(back);
            pushCall(leadid, name, at, 'not_reached', { phone: lead.telephone1 });
            touch(at);
            back += rnd.int(1, 5);
          }
          lead.kls_callstatus = CALL_STATUS.NOT_REACHED;
          lead.ownerid = MARKUS.crmUserId;
          break;
        }
        case 'contacted': {
          lead.statuscode = STATUS.CONTACTED;
          lead.ownerid = MARKUS.crmUserId;
          let back = rnd.int(1, 40);
          const earlier = rnd.int(0, 2);
          for (let a = 0; a < earlier; a++) {
            const at = pastAt(back + rnd.int(2, 8));
            pushCall(leadid, name, at, 'not_reached', { phone: lead.telephone1 });
          }
          let result = rnd.weighted([
            ['callback', 20],
            ['waiting', 12],
            ['meeting_booked', 10],
            ['proposals_sent', 8],
            ['info_mail', 12],
            ['later', 12],
            ['no_need', 12],
            ['has_partner', 8],
            ['wrong_person', 4],
          ] as const) as ResultGroupKey;
          if (result === 'meeting_booked' && bookingCount >= bookingSlots.length) result = 'proposals_sent';
          if (result === 'meeting_booked') back = Math.min(back, 12);
          const callAt = pastAt(back);
          const interest = result === 'meeting_booked' || result === 'proposals_sent' ? 3 : result === 'info_mail' ? rnd.int(1, 3) : result === 'no_need' || result === 'has_partner' ? rnd.int(0, 1) : rnd.int(1, 2);
          pushCall(leadid, name, callAt, result, { note: noteFor(result), interest, phone: lead.telephone1 });
          touch(callAt);
          switch (result) {
            case 'callback': {
              const due = rnd.chance(0.35) ? pastAt(rnd.int(0, 4)) : futureAt(rnd.int(0, 20), rnd.pick([9, 10, 11, 14, 15]));
              lead.kls_callstatus = callStatusForFollowUp(due);
              pushTask(leadid, `Rückruf ${name}`, due, 'callback');
              break;
            }
            case 'waiting': {
              lead.kls_callstatus = CALL_STATUS.WAITING;
              pushTask(leadid, `Nachfassen ${name}`, new Date(callAt.getTime() + 7 * DAY), 'follow_up');
              break;
            }
            case 'meeting_booked': {
              lead.kls_callstatus = CALL_STATUS.MEETING_BOOKED;
              lead.kls_lead_support = LEAD_SUPPORT.SALES;
              lead.subject = 'KI Termin';
              lead.kls_interests = [...new Set([...(lead.kls_interests ?? []), INTEREST_KI_SERVICES])];
              lead.decisionmaker = true;
              addBooking(lead, 'coldcall', callAt);
              break;
            }
            case 'proposals_sent': {
              lead.kls_callstatus = CALL_STATUS.MEETING_PROPOSED;
              lead.kls_interests = [...new Set([...(lead.kls_interests ?? []), INTEREST_KI_SERVICES])];
              pushMail(leadid, addMin(callAt, 20), `Terminvorschläge: Kallysoft Informatik AG als KI-Spezialist – ${name}`, 'Guten Tag … Passt Ihnen einer dieser Termine? …', lead.emailaddress1 ?? null);
              pushTask(leadid, `Nachfassen Terminvorschläge ${name}`, new Date(callAt.getTime() + 3 * DAY), 'follow_up');
              break;
            }
            case 'info_mail': {
              lead.kls_callstatus = CALL_STATUS.WAITING;
              if (interest >= 2) lead.kls_rating_category = RATING.POTENTIAL;
              lead.kls_interests = [...new Set([...(lead.kls_interests ?? []), INTEREST_KI_SERVICES])];
              pushMail(leadid, addMin(callAt, 45), `${name}: Belege automatisch erfassen mit KI`, 'Guten Tag … zwei Beispiele aus Ihrer Branche …', lead.emailaddress1 ?? null);
              pushTask(leadid, `Nachfassen Use-Case-Mail ${name}`, new Date(callAt.getTime() + 7 * DAY), 'follow_up');
              break;
            }
            case 'later': {
              const due = futureAt(rnd.int(25, 120), 10);
              lead.kls_callstatus = callStatusForFollowUp(due);
              lead.kls_rating_category = RATING.LATER;
              pushTask(leadid, `Wieder melden ${name}`, due, 'callback');
              break;
            }
            case 'no_need': {
              lead.kls_callstatus = CALL_STATUS.CALLBACK_3_6_MONTHS;
              lead.kls_rating_category = RATING.NO_NEED_CURRENT;
              pushTask(leadid, `Neuer Anlauf ${name}`, new Date(callAt.getTime() + 182 * DAY), 'follow_up');
              break;
            }
            case 'has_partner': {
              lead.kls_rating_category = RATING.NO_NEED_PARTNER;
              break;
            }
            case 'wrong_person': {
              pushTask(leadid, `Kontakt-Research ${name}`, futureAt(rnd.int(0, 5), 9), 'research');
              break;
            }
            default:
              break;
          }
          if (rnd.chance(0.25)) {
            const at = addMin(callAt, rnd.int(5, 60));
            pushNote(leadid, at, rnd.pick(['GL wirkt offen, will aber zuerst ERP-Projekt abschliessen.', 'Hinweis von Zentrale: Entscheid liegt beim Inhaber.', 'Kunde hat Interesse an Wissens-Chat für Handbücher erwähnt.']));
          }
          // A few customer callbacks (incoming) in the last days.
          if (rnd.chance(0.12)) {
            const at = pastAt(rnd.int(0, 8));
            pushCall(leadid, name, at, rnd.pick(['callback', 'waiting', 'info_mail'] as const), {
              direction: 'incoming',
              note: 'Kunde ruft zurück.',
              interest: 2,
              phone: lead.telephone1,
            });
            touch(at);
          }
          break;
        }
        case 'exchange': {
          lead.statuscode = STATUS.EXCHANGE;
          lead.ownerid = rnd.chance(0.5) ? RETO.id : LUKAS.crmUserId;
          for (let a = 0; a < rnd.int(1, 3); a++) {
            const at = pastAt(rnd.int(15, 55));
            pushCall(leadid, name, at, null, { durationSec: rnd.int(200, 1500), note: noteFor('legacy'), owner: lead.ownerid ?? undefined });
            touch(at);
          }
          if (rnd.chance(0.5)) {
            const at = pastAt(rnd.int(10, 40));
            out.activities.push({
              activityid: rnd.guid(),
              activitytype: 'appointment',
              regardingLeadId: leadid,
              subject: `Austausch ${name}`,
              description: 'Präsentation Business Central',
              ownerid: lead.ownerid,
              scheduledstart: at,
              scheduledend: addMin(at, 60),
              actualstart: at,
              statecode: 1,
              createdon: at,
              modifiedon: at,
            });
            touch(at);
          }
          break;
        }
        case 'campaign_locked':
        case 'campaign_unlocked': {
          const locked = scenario === 'campaign_locked';
          const campaign = locked ? CAMPAIGNS[0] : CAMPAIGNS[1];
          lead.kls_lead_support = LEAD_SUPPORT.CAMPAIGN;
          lead.subject = 'KI-Kampagne';
          lead.campaignName = campaign.name;
          const firstMailDaysAgo = rnd.int(campaign.ageDays[0], campaign.ageDays[1]);
          const joined = new Date(nowMs - (firstMailDaysAgo + 2) * DAY);
          lead.campaignJoinedAt = joined;
          const steps = rnd.int(1, 3);
          const sender = rnd.chance(0.6) ? { name: LUKAS.displayName, email: LUKAS.email, crm: LUKAS.crmUserId } : { name: SANDRA.fullname, email: SANDRA.email, crm: SANDRA.id };
          for (let s = 0; s < steps; s++) {
            const daysAgo = firstMailDaysAgo - s * 7;
            if (!locked && daysAgo < 95) break;
            if (daysAgo < 1) break;
            const at = pastAt(daysAgo);
            const reactions: CampaignReaction[] = [];
            if (rnd.chance(0.6)) reactions.push({ kind: 'opened', at: new Date(at.getTime() + rnd.int(1, 48) * 3600_000).toISOString() });
            if (locked && rnd.chance(0.2)) reactions.push({ kind: 'clicked', at: new Date(at.getTime() + rnd.int(2, 60) * 3600_000).toISOString() });
            if (locked && s === steps - 1 && rnd.chance(0.12)) reactions.push({ kind: rnd.chance(0.6) ? 'replied_positive' : 'replied_negative', at: new Date(at.getTime() + rnd.int(3, 72) * 3600_000).toISOString() });
            out.activities.push({
              activityid: rnd.guid(),
              activitytype: 'email',
              regardingLeadId: leadid,
              subject: rnd.pick(CAMPAIGN_SUBJECTS).replace('{Firma}', name).replace('{Branche}', ind.industry ?? 'KMU'),
              description: 'Automatisierte Kampagnen-Mail (Lemlist).',
              direction: 'outgoing',
              ownerid: sender.crm,
              fromText: sender.email,
              toText: lead.emailaddress1,
              actualstart: at,
              statecode: 1,
              isCampaign: true,
              campaignName: campaign.name,
              campaignStep: s + 1,
              campaignSenderName: sender.name,
              campaignSenderEmail: sender.email,
              campaignUseCaseIds: rnd.sample(ind.useCases, rnd.int(1, 2)),
              campaignReactions: reactions,
              createdon: at,
              modifiedon: at,
            });
            touch(at);
          }
          if (!locked && !campaignUnlockedBooked && rnd.chance(0.25) && bookingCount < bookingSlots.length) {
            // A former campaign lead Markus called and booked → booking with origin «campaign».
            const at = pastAt(rnd.int(1, 6));
            pushCall(leadid, name, at, 'meeting_booked', { note: 'Kennt die Kampagnen-Mail zur Belegerfassung, will mehr sehen. Termin gebucht.', interest: 3, phone: lead.telephone1 });
            lead.statuscode = STATUS.CONTACTED;
            lead.ownerid = MARKUS.crmUserId;
            lead.kls_callstatus = CALL_STATUS.MEETING_BOOKED;
            lead.subject = 'KI Termin';
            lead.kls_interests = [INTEREST_KI_SERVICES];
            addBooking(lead, 'campaign', at);
            campaignUnlockedBooked = true;
            touch(at);
          }
          break;
        }
        case 'divendo': {
          lead.kls_lead_support = LEAD_SUPPORT.DIVENDO_COLDCALL;
          lead.ownerid = DIVENDO.id;
          lead.subject = 'Divendo Coldcall';
          break;
        }
        case 'disqualified': {
          const result = rnd.pick(['internal_group', 'too_small', 'competitor'] as const);
          const at = pastAt(rnd.int(3, 50));
          pushCall(leadid, name, at, result, { note: noteFor(result), interest: 0, phone: lead.telephone1 });
          pushNote(leadid, addMin(at, 2), `Sales-Portal: Nicht qualifiziert – ${RESULT_GROUP_LABELS[result]}. ${noteFor(result)}`);
          lead.statecode = STATE.DISQUALIFIED;
          lead.statuscode = result === 'internal_group' ? STATUS.NO_LONGER_INTERESTED : STATUS.OUTSIDE_ICP;
          lead.kls_rating_category = result === 'internal_group' ? RATING.NO_NEED_INTERNAL : result === 'too_small' ? RATING.TOO_SMALL : null;
          if (result === 'too_small') lead.numberofemployees = rnd.int(1, 4);
          if (result === 'competitor') lead.kls_competitor = true;
          lead.ownerid = MARKUS.crmUserId;
          touch(at);
          break;
        }
        case 'dnc': {
          const at = pastAt(rnd.int(3, 50));
          pushCall(leadid, name, at, 'do_not_contact', { note: noteFor('do_not_contact'), interest: 0, phone: lead.telephone1 });
          pushNote(leadid, addMin(at, 2), 'Sales-Portal: Nicht qualifiziert – möchte nicht mehr kontaktiert werden.');
          lead.statecode = STATE.DISQUALIFIED;
          lead.statuscode = STATUS.NO_LONGER_INTERESTED;
          lead.kls_callstatus = CALL_STATUS.DO_NOT_CONTACT;
          lead.donotphone = true;
          lead.donotemail = true;
          lead.donotbulkemail = true;
          lead.ownerid = MARKUS.crmUserId;
          touch(at);
          break;
        }
        case 'qualified': {
          lead.statecode = STATE.QUALIFIED;
          lead.statuscode = STATUS.QUALIFIED;
          lead.ownerid = RETO.id;
          break;
        }
        case 'same_domain': {
          lead.statuscode = STATUS.SAME_DOMAIN_IN_PROGRESS;
          break;
        }
      }
      lead.modifiedon = new Date(lastTouch);
      out.leads.push(lead);
    }
  }

  // ---- extra tasks so Markus has overdue / today / this week items ---------------------------------------------------------
  const markusOpen = () => out.tasks.filter((t) => t.ownerid === MARKUS.crmUserId && t.statecode === 0);
  const openLeads = out.leads.filter((l) => l.statecode === 0 && l.statuscode === STATUS.CONTACTED);
  const startToday = zurichTime(zurichDate(now), '00:00').getTime();
  const endToday = startToday + DAY;
  const ensure = (predicate: (d: number) => boolean, needed: number, makeDue: () => Date, subject: string) => {
    let have = markusOpen().filter((t) => t.scheduledend && predicate(t.scheduledend.getTime())).length;
    let guard = 0;
    while (have < needed && guard++ < 50) {
      const lead = rnd.pick(openLeads);
      if (out.tasks.some((t) => t.regardingLeadId === lead.leadid && t.statecode === 0)) continue;
      pushTask(lead.leadid, subject.replace('{company}', lead.companyname), makeDue(), 'callback');
      have += 1;
    }
  };
  ensure((d) => d < startToday, 4, () => pastAt(rnd.int(1, 6)), 'Rückruf {company}');
  ensure((d) => d >= startToday && d < endToday, 3, () => zurichTime(zurichDate(now), hhmm(rnd.pick([10, 11, 14, 15, 16]), rnd.pick([0, 30]))), 'Rückruf {company}');
  ensure((d) => d >= endToday && d < startToday + 7 * DAY, 5, () => futureAt(rnd.int(1, 6), rnd.pick([9, 10, 14, 15])), 'Nachfassen {company}');
  // Completed history.
  for (let i = 0; i < 12; i++) {
    const lead = rnd.pick(openLeads);
    pushTask(lead.leadid, `Rückruf ${lead.companyname}`, pastAt(rnd.int(3, 50)), 'callback', MARKUS.crmUserId, 1);
  }
  // Follow-ups for Manuel.
  for (let i = 0; i < 3; i++) {
    const lead = rnd.pick(openLeads);
    pushTask(lead.leadid, `Offerte nachfassen: ${lead.companyname}`, futureAt(rnd.int(-2, 8), 10), 'follow_up', MANUEL.crmUserId);
  }

  // ---- missed callbacks (portal call_sessions, history 6.15) ------------------------------------------------------------------
  const callbackLead = out.leads.find((l) => l.statuscode === STATUS.CONTACTED && l.telephone1 && /^\+41 \d\d \d{3} \d\d \d\d$/.test(l.telephone1));
  if (callbackLead) {
    const at = pastAt(0);
    out.callSessions.push({
      userId: MARKUS.id,
      leadId: callbackLead.leadid,
      leadName: `${callbackLead.firstname ?? ''} ${callbackLead.lastname ?? ''}`.trim(),
      companyName: callbackLead.companyname,
      phoneE164: (callbackLead.telephone1 as string).replace(/\s/g, ''),
      phoneDisplay: callbackLead.telephone1,
      direction: 'inbound',
      category: 'callback_missed',
      // Never connected: 'abandoned', not 'ended' – an 'ended' session counts as the user's running call («Nachbearbeitung»).
      status: 'abandoned',
      dialedAt: at,
      endedAt: at,
      createdAt: at,
      updatedAt: at,
    });
  }
  const unknownAt = pastAt(1);
  out.callSessions.push({
    userId: MARKUS.id,
    phoneE164: '+41445550123',
    phoneDisplay: '+41 44 555 01 23',
    direction: 'inbound',
    category: 'unknown_number',
    status: 'abandoned',
    dialedAt: unknownAt,
    endedAt: unknownAt,
    createdAt: unknownAt,
    updatedAt: unknownAt,
  });

  // ---- calendars: busy time for Manuel, Nico, Lukas, Markus --------------------------------------------------------------------
  const mailboxes = [MANUEL.email, NICO.email, LUKAS.email, MARKUS.email];
  for (const mailbox of mailboxes) {
    for (let offset = -5; offset <= 40; offset++) {
      const iso = isoDay(offset);
      if (weekday(iso) === 0 || weekday(iso) === 6) continue;
      const vacation = (mailbox === NICO.email && offset >= 16 && offset <= 20) || (mailbox === MANUEL.email && (offset === 9 || offset === 23));
      if (vacation) {
        out.events.push({
          id: rnd.guid(),
          mailbox,
          subject: 'Ferien',
          startAt: zurichTime(iso, '00:00'),
          endAt: zurichTime(isoDay(offset + 1), '00:00'),
          showAs: 'oof',
          organizer: mailbox,
          lastModified: new Date(nowMs - 20 * DAY),
        });
        continue;
      }
      const n = rnd.int(1, 3);
      for (let k = 0; k < n; k++) {
        const startH = rnd.pick([8, 9, 10, 11, 13, 14, 15, 16]);
        const startM = rnd.pick([0, 30]);
        const dur = rnd.pick([30, 60, 60, 90, 120]);
        const start = zurichTime(iso, hhmm(startH, startM));
        out.events.push({
          id: rnd.guid(),
          mailbox,
          subject: rnd.pick(MEETING_SUBJECTS),
          startAt: start,
          endAt: addMin(start, dur),
          showAs: rnd.chance(0.1) ? 'tentative' : 'busy',
          organizer: mailbox,
          lastModified: new Date(nowMs - rnd.int(1, 30) * DAY),
        });
      }
    }
  }

  addPortalStates();
  return out;

  /**
   * Portal states for a complete first click-through (Pendenzen tabs, header counters, Admin › Protokoll / Fehler,
   * Dashboard «Absagen/Verschiebungen»): two calls that just ended (the AI transcript sweep turns them into
   * «Analysen zur Freigabe» a few seconds after the start), an unfinished call, an approval draft, a failed CRM push,
   * a cancelled and a rescheduled meeting, a campaign reply, a failed mail and audit entries.
   * Briefings need no seed: the briefing sweep runs 5–15 s after the start for all upcoming bookings.
   */
  function addPortalStates(): void {
    const bookedLeadIds = new Set(out.bookings.map((b) => b.leadId));
    const sessionLeadIds = new Set(out.callSessions.map((s) => s.leadId).filter(Boolean));
    const pool = out.leads.filter(
      (l) =>
        l.statecode === STATE.OPEN &&
        l.statuscode === STATUS.CONTACTED &&
        l.ownerid === MARKUS.crmUserId &&
        !l.donotphone &&
        !bookedLeadIds.has(l.leadid) &&
        !sessionLeadIds.has(l.leadid) &&
        normalizePhone(l.telephone1).status === 'ok',
    );
    const take = (): LeadRow | null => (pool.length ? pool.splice(rnd.int(0, pool.length - 1), 1)[0] : null);
    const person = (l: LeadRow) => `${l.firstname ?? ''} ${l.lastname ?? ''}`.trim() || null;
    const lastActivity = () => out.activities[out.activities.length - 1];
    const markusActor = { actorUserId: MARKUS.id, actorLabel: MARKUS.displayName };

    // ---- 1. Two calls that ended a few minutes ago, result pushed → AI analysis «zur Freigabe» ----------------------------
    for (const [minutesAgo, durationSec] of [
      [16, 290],
      [9, 230],
    ] as const) {
      const lead = take();
      if (!lead) break;
      const phone = normalizePhone(lead.telephone1);
      const connectedAt = new Date(nowMs - minutesAgo * 60_000);
      const dialedAt = new Date(connectedAt.getTime() - 25_000);
      const endedAt = new Date(connectedAt.getTime() + durationSec * 1000);
      const pushedAt = new Date(endedAt.getTime() + 60_000);
      const note = noteFor('waiting');
      pushCall(lead.leadid, lead.companyname, connectedAt, 'waiting', { durationSec, note, interest: 2, phone: lead.telephone1 });
      const activity = lastActivity();
      const oldStatus = lead.kls_callstatus ?? null;
      lead.kls_callstatus = CALL_STATUS.WAITING;
      lead.modifiedon = pushedAt;
      const sessionId = rnd.guid();
      const csId = rnd.guid();
      const activityOpId = rnd.guid();
      const fieldOpId = rnd.guid();
      const fieldChanged = oldStatus !== CALL_STATUS.WAITING;
      out.callSessions.push({
        id: sessionId,
        userId: MARKUS.id,
        leadId: lead.leadid,
        leadName: person(lead),
        companyName: lead.companyname,
        phoneE164: phone.e164,
        phoneDisplay: phone.display,
        direction: 'outbound',
        category: 'outbound',
        status: 'completed',
        reason: 'Nachfassen',
        dialedAt,
        connectedAt,
        endedAt,
        durationSec,
        durationSource: 'clicks',
        veraEnabled: true,
        noteDraft: note,
        noteSavedAt: endedAt,
        resultGroup: 'waiting',
        changeSetId: csId,
        crmPhonecallId: activity.activityid,
        createdAt: dialedAt,
        updatedAt: pushedAt,
      });
      out.changeSets.push({
        id: csId,
        leadId: lead.leadid,
        callSessionId: sessionId,
        kind: 'call_result',
        ruleKey: 'waiting',
        ruleVersion: 1,
        status: 'pushed',
        operations: fieldChanged
          ? [{ id: fieldOpId, entity: 'lead', entityId: lead.leadid, field: 'kls_callstatus', label: 'Anrufstatus', oldValue: oldStatus, newValue: CALL_STATUS.WAITING, mode: 'set' }]
          : [],
        activities: [
          {
            id: activityOpId,
            action: 'create',
            type: 'phonecall',
            leadId: lead.leadid,
            subject: activity.subject ?? `Anruf ${lead.companyname}`,
            text: note,
            direction: 'outgoing',
            start: connectedAt.toISOString(),
            end: endedAt.toISOString(),
            durationSec,
            resultCode: RESULT_GROUP_CODES.waiting,
            interest: 2,
            phoneNumber: phone.display,
          },
        ],
        baseSnapshot: { [snapshotKey('lead', lead.leadid, 'kls_callstatus')]: oldStatus },
        results: [
          { opId: activityOpId, kind: 'activity', ok: true, createdId: activity.activityid },
          ...(fieldChanged ? [{ opId: fieldOpId, kind: 'field' as const, ok: true }] : []),
        ],
        createdBy: MARKUS.id,
        createdAt: endedAt,
        updatedAt: pushedAt,
        pushedAt,
        pushedBy: MARKUS.id,
      });
      out.auditLog.push(
        { ...markusActor, at: pushedAt, action: 'changeset.push', entity: 'change_set', entityId: csId, changeSetId: csId, meta: { leadId: lead.leadid, ruleKey: 'waiting', ruleVersion: 1, kind: 'call_result' } },
        { ...markusActor, at: pushedAt, action: 'crm.activity_create', entity: 'phonecall', entityId: activity.activityid, changeSetId: csId, newValue: { subject: activity.subject, resultCode: RESULT_GROUP_CODES.waiting, statecode: null }, meta: { leadId: lead.leadid } },
        ...(fieldChanged
          ? [{ ...markusActor, at: pushedAt, action: 'crm.field_update', entity: 'lead', entityId: lead.leadid, field: 'kls_callstatus', oldValue: oldStatus, newValue: CALL_STATUS.WAITING, changeSetId: csId, meta: { mode: 'set', label: 'Anrufstatus' } }]
          : []),
      );
    }

    // ---- 2. Unfinished call from yesterday: hung up, result missing ---------------------------------------------------------
    const unfinished = take();
    if (unfinished) {
      const phone = normalizePhone(unfinished.telephone1);
      const connectedAt = pastAt(1);
      const endedAt = addMin(connectedAt, 5);
      out.callSessions.push({
        userId: MARKUS.id,
        leadId: unfinished.leadid,
        leadName: person(unfinished),
        companyName: unfinished.companyname,
        phoneE164: phone.e164,
        phoneDisplay: phone.display,
        direction: 'outbound',
        category: 'outbound',
        status: 'ended',
        reason: 'Folgeanruf',
        dialedAt: new Date(connectedAt.getTime() - 20_000),
        connectedAt,
        endedAt,
        durationSec: 300,
        durationSource: 'clicks',
        veraEnabled: true,
        noteDraft: 'Interesse an automatischer Belegerfassung, will intern mit der Buchhaltung sprechen. Rückmeldung bis Ende Woche.',
        noteSavedAt: endedAt,
        createdAt: new Date(connectedAt.getTime() - 20_000),
        updatedAt: endedAt,
      });
    }

    // ---- 3. Approval draft: corrected phone number of a lead with an unusable number -----------------------------------------
    const badPhone =
      out.leads.find((l) => l.statecode === STATE.OPEN && l.ownerid === MARKUS.crmUserId && normalizePhone(l.telephone1).status === 'text') ??
      out.leads.find((l) => l.statecode === STATE.OPEN && !!l.telephone1 && ['text', 'invalid'].includes(normalizePhone(l.telephone1).status));
    if (badPhone) {
      const at = new Date(nowMs - 2 * 3600_000);
      const town = TOWNS.find((t) => t.city === badPhone.address1_city) ?? TOWNS[0];
      const fixed = fmtSwiss(town.area, subscriber(), 0);
      out.changeSets.push({
        leadId: badPhone.leadid,
        kind: 'phone_fix',
        status: 'draft',
        operations: [
          { id: rnd.guid(), entity: 'lead', entityId: badPhone.leadid, field: 'telephone1', label: 'Telefon', oldValue: badPhone.telephone1, newValue: fixed, mode: 'set' },
        ],
        baseSnapshot: { [snapshotKey('lead', badPhone.leadid, 'telephone1')]: badPhone.telephone1 },
        createdBy: MARKUS.id,
        createdAt: at,
        updatedAt: at,
      });
    }

    // ---- 4. Failed CRM push (Pendenzen «Fehler», Admin › Fehler) ------------------------------------------------------------------
    const failedLead = take();
    if (failedLead) {
      const at = new Date(nowMs - 26 * 3600_000);
      const csId = rnd.guid();
      const taskOpId = rnd.guid();
      const error = 'CRM nicht erreichbar (Zeitüberschreitung) – die Aufgabe wurde nicht angelegt. Bitte erneut senden.';
      out.changeSets.push({
        id: csId,
        leadId: failedLead.leadid,
        kind: 'task',
        status: 'failed',
        tasks: [
          {
            id: taskOpId,
            action: 'create',
            leadId: failedLead.leadid,
            subject: `Nachfassen ${failedLead.companyname}`,
            dueAt: futureAt(2, 10).toISOString(),
            ownerId: MARKUS.crmUserId,
            taskType: 'follow_up',
          },
        ],
        results: [{ opId: taskOpId, kind: 'task', ok: false, error: 'Zeitüberschreitung' }],
        error,
        createdBy: MARKUS.id,
        createdAt: at,
        updatedAt: at,
      });
      out.auditLog.push({ ...markusActor, at, action: 'changeset.push_failed', entity: 'change_set', entityId: csId, changeSetId: csId, meta: { leadId: failedLead.leadid, kind: 'task', error } });
    }

    // ---- 5. Cancelled + rescheduled meeting (Pendenzen «Absagen», Dashboard «Absagen/Verschiebungen») -------------------------
    const upcoming = out.bookings.filter((b) => b.status === 'booked').sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const cancelled = upcoming[upcoming.length - 1];
    const rescheduled = upcoming.length > 2 ? upcoming[1] : undefined;
    if (cancelled) {
      const at = new Date(nowMs - 3 * 3600_000);
      cancelled.status = 'cancelled';
      cancelled.updatedAt = at;
      // Outlook removed the meeting (and the portal its blockers); the CRM appointment is cancelled.
      out.events = out.events.filter((e) => (e.extendedProperties as Record<string, string> | null | undefined)?.KlsTerminId !== cancelled.bookingRef);
      cancelled.blockerEventIds = [];
      for (const a of out.activities) {
        if (a.activitytype === 'appointment' && a.regardingLeadId === cancelled.leadId && a.scheduledstart?.getTime() === cancelled.startAt.getTime()) {
          a.statecode = 2;
          a.modifiedon = at;
        }
      }
      for (const t of out.tasks) if (t.regardingLeadId === cancelled.leadId && t.statecode === 0 && t.taskType === 'follow_up') t.statecode = 2;
    }
    if (rescheduled) {
      const at = new Date(nowMs - 20 * 3600_000);
      // Moved by the customer to the next working day, same time.
      let shift = DAY;
      while ([0, 6].includes(weekday(zurichDate(new Date(rescheduled.startAt.getTime() + shift))))) shift += DAY;
      rescheduled.status = 'rescheduled';
      rescheduled.updatedAt = at;
      rescheduled.startAt = new Date(rescheduled.startAt.getTime() + shift);
      rescheduled.endAt = new Date(rescheduled.endAt.getTime() + shift);
      for (const e of out.events) {
        if ((e.extendedProperties as Record<string, string> | null | undefined)?.KlsTerminId !== rescheduled.bookingRef) continue;
        e.startAt = new Date(e.startAt.getTime() + shift);
        e.endAt = new Date(e.endAt.getTime() + shift);
        e.lastModified = at;
      }
      for (const a of out.activities) {
        if (a.activitytype !== 'appointment' || a.regardingLeadId !== rescheduled.leadId || !a.scheduledstart || !a.scheduledend) continue;
        a.scheduledstart = new Date(a.scheduledstart.getTime() + shift);
        a.scheduledend = new Date(a.scheduledend.getTime() + shift);
        a.actualstart = a.scheduledstart;
        a.modifiedon = at;
      }
    }

    // ---- 6. Notifications: campaign reply, mail not sent -------------------------------------------------------------------------
    const campaignLead = out.leads.find((l) => l.statecode === STATE.OPEN && l.campaignName && l.emailaddress1);
    if (campaignLead) {
      out.notifications.push({
        userId: MARKUS.id,
        kind: 'campaign_reply',
        title: `Antwort aus Kampagne: ${campaignLead.companyname}`,
        body: `${person(campaignLead) ?? 'Der Kontakt'} hat auf die Kampagnen-Mail geantwortet und möchte mehr wissen – bitte anrufen.`,
        link: `/lead/${campaignLead.leadid}`,
        entity: 'lead',
        entityId: campaignLead.leadid,
        severity: 'info',
        createdAt: new Date(nowMs - 5 * 3600_000),
      });
    }
    const mailLead = take();
    if (mailLead) {
      out.notifications.push({
        userId: MARKUS.id,
        kind: 'mail_failed',
        title: `Mail nicht gesendet: ${mailLead.companyname}`,
        body: 'Die Use-Case-Mail konnte nicht gesendet werden (Postfach nicht erreichbar). Der Entwurf ist gespeichert – bitte erneut senden.',
        link: `/lead/${mailLead.leadid}`,
        entity: 'lead',
        entityId: mailLead.leadid,
        severity: 'error',
        createdAt: new Date(nowMs - 50 * 60_000),
      });
    }

    // ---- 7. A few more audit entries (logins, admin action) --------------------------------------------------------------------
    for (const [u, hoursAgo] of [
      [LUKAS, 30],
      [MARKUS, 26],
      [MANUEL, 22],
      [MARKUS, 2],
    ] as const) {
      out.auditLog.push({ actorUserId: u.id, actorLabel: u.displayName, at: new Date(nowMs - hoursAgo * 3600_000), action: 'auth.login', entity: 'user', entityId: u.id, meta: { method: 'dev' } });
    }
    out.auditLog.push({
      actorUserId: LUKAS.id,
      actorLabel: LUKAS.displayName,
      at: new Date(nowMs - 29 * 3600_000),
      action: 'admin.role_grant',
      entity: 'user',
      entityId: MARKUS.id,
      field: 'role',
      newValue: 'coldcaller',
    });
  }
}
