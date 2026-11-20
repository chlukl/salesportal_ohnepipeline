/**
 * Mock Vera: produces a plausible German demo transcript from the lead context and the call note after a short delay
 * (`pending` before). Everything is invented; the transcript is deterministic per call session.
 */
import type { TranscriptSegment } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import { callSessions, mockCrmLeads } from '../../db/schema';
import type { AdapterDeps } from '../types';
import type { TranscriptAdapter, TranscriptFetchResult, TranscriptRef } from './types';

/** Mock transcripts become available this long after the call ended. */
export const MOCK_TRANSCRIPT_DELAY_MS = 15_000;

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface MockTranscriptInput {
  seed: string;
  callerName: string;
  firstname: string | null;
  lastname: string | null;
  salutation: 'Herr' | 'Frau' | null;
  companyname: string;
  industry: string | null;
  employees: number | null;
  note: string | null;
  durationSec: number;
}

/** Build the demo conversation (exported for tests). */
export function buildMockTranscript(input: MockTranscriptInput): TranscriptSegment[] {
  const h = hash(input.seed);
  const name = input.salutation && input.lastname ? `${input.salutation} ${input.lastname}` : (input.firstname ?? 'Guten Tag');
  const note = (input.note ?? '').trim();
  const topics = [
    'die Rechnungen und Belege, die wir noch von Hand erfassen',
    'die Offerten, die bei uns jedes Mal viel Zeit brauchen',
    'den Mail-Eingang im Verkauf, der kaum noch zu bewältigen ist',
    'die Prüfprotokolle in der Qualität',
  ];
  const topic = topics[h % topics.length];
  const closing = [
    'Schicken Sie mir doch zuerst eine Mail mit Unterlagen, dann schaue ich das an.',
    'Ja, ein Termin nächste Woche wäre gut, das klingt spannend.',
    'Im Moment haben wir keine Zeit, melden Sie sich nach den Ferien wieder.',
    'Wir haben schon einen IT-Partner, aber zeigen Sie mir gerne, was Sie machen.',
  ][(h >> 3) % 4];
  const lines: [TranscriptSegment['speaker'], string][] = [
    ['caller', `Grüezi ${name}, hier ist ${input.callerName} von der Kallysoft Informatik AG. Kurzer Hinweis: Das Gespräch wird für die Notizen transkribiert, ist das in Ordnung?`],
    ['callee', 'Ja, das ist in Ordnung. Worum geht es?'],
    [
      'caller',
      `Wir helfen KMU${input.industry ? ` in der Branche ${input.industry}` : ''}, mit KI Routinearbeit zu sparen. Wo verlieren Sie bei ${input.companyname} heute am meisten Zeit?`,
    ],
    ['callee', `Ehrlich gesagt bei uns sind es vor allem ${topic}.${input.employees ? ` Wir sind ${input.employees} Mitarbeitende.` : ''}`],
    ['caller', 'Das hören wir oft. Genau da lässt sich mit wenig Aufwand viel automatisieren, zum Beispiel mit einer kurzen Demo an Ihren eigenen Dokumenten.'],
  ];
  if (note) lines.push(['callee', `Wie gesagt: ${note.slice(0, 280)}`]);
  lines.push(['callee', closing], ['caller', 'Vielen Dank, ich melde mich wie besprochen. Einen schönen Tag noch!']);

  const step = Math.max(8, Math.floor(input.durationSec / (lines.length + 1)));
  return lines.map(([speaker, text], i) => ({ speaker, startSec: i * step, text }));
}

export class MockTranscriptAdapter implements TranscriptAdapter {
  readonly mode = 'mock' as const;

  constructor(private readonly deps: AdapterDeps) {}

  async fetchTranscript(ref: TranscriptRef): Promise<TranscriptFetchResult> {
    const [session] = await this.deps.db.select().from(callSessions).where(eq(callSessions.id, ref.callSessionId));
    if (!session) return { status: 'unavailable', reason: 'Anruf nicht gefunden' };
    if (!session.veraEnabled) return { status: 'unavailable', reason: 'Vera war ausgeschaltet' };
    const endedAt = session.endedAt ?? (ref.endedAt ? new Date(ref.endedAt) : null);
    if (!endedAt) return { status: 'pending' };
    if (this.deps.now().getTime() < endedAt.getTime() + MOCK_TRANSCRIPT_DELAY_MS) return { status: 'pending' };

    const [lead] = session.leadId ? await this.deps.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, session.leadId)) : [];
    const startedAt = session.connectedAt ?? session.dialedAt ?? new Date(endedAt.getTime() - 180_000);
    // Vera measures the real conversation: a few seconds more than the clicks.
    const durationSec = Math.max(30, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) + (hash(session.id) % 20));
    const segments = buildMockTranscript({
      seed: session.id,
      callerName: ref.userEmail.split('.')[0].replace(/^./, (c) => c.toUpperCase()),
      firstname: lead?.firstname ?? null,
      lastname: lead?.lastname ?? null,
      salutation: lead?.kls_salutation === 845140001 ? 'Frau' : lead?.kls_salutation === 845140000 ? 'Herr' : null,
      companyname: lead?.companyname ?? session.companyName ?? 'Ihre Firma',
      industry: lead?.kls_industry ?? null,
      employees: lead?.numberofemployees ?? null,
      note: session.noteDraft,
      durationSec,
    });
    return {
      status: 'ready',
      transcript: {
        callSessionId: session.id,
        leadId: session.leadId,
        source: 'mock',
        externalRef: `mock-${session.id}`,
        startedAt: startedAt.toISOString(),
        endedAt: new Date(startedAt.getTime() + durationSec * 1000).toISOString(),
        durationSec,
        segments,
      },
    };
  }
}
