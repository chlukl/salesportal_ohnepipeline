/** Mock mail: stores every mail in `mock_outbox` (redirected to MAIL_TEST_RECIPIENT when configured). Nothing leaves the portal. */
import type { MailDraft, SentMail } from '@sales-portal/shared';
import { mockOutbox } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import type { AdapterDeps } from '../types';
import type { MailAdapter, MailSender } from './types';

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

export class MockMailAdapter implements MailAdapter {
  readonly mode = 'mock' as const;

  constructor(private readonly deps: AdapterDeps) {}

  async send(from: MailSender, draft: MailDraft): Promise<SentMail> {
    const recipients = [...draft.to, ...(draft.cc ?? [])];
    if (draft.to.length === 0) throw badRequest('Mindestens ein Empfänger nötig');
    for (const r of recipients) if (!EMAIL_RE.test(r)) throw badRequest('Ungültige E-Mail-Adresse');
    const testRecipient = this.deps.config.mailTestRecipient;
    const deliveredTo = testRecipient ? [testRecipient] : draft.to;
    const [row] = await this.deps.db
      .insert(mockOutbox)
      .values({
        fromUserId: from.userId,
        fromEmail: from.email,
        to: deliveredTo,
        cc: testRecipient ? [] : (draft.cc ?? []),
        originalTo: testRecipient ? recipients : null,
        subject: draft.subject,
        body: draft.body,
        relatedLeadId: draft.relatedLeadId ?? null,
        sentAt: this.deps.now(),
      })
      .returning({ id: mockOutbox.id, sentAt: mockOutbox.sentAt });
    this.deps.log.info({ mailId: row.id, redirected: !!testRecipient }, 'mock mail stored in outbox');
    return { id: row.id, sentAt: row.sentAt.toISOString(), deliveredTo, redirected: !!testRecipient };
  }
}
