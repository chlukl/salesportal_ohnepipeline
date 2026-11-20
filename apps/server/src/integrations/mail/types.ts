/**
 * Mail adapter: send from the user's own mailbox (Graph sendMail, delegated). Only after an explicit click (ARCHITECTURE §5.11).
 * Outside Prod every mail is redirected to MAIL_TEST_RECIPIENT; the mock writes to `mock_outbox`.
 */
import type { MailDraft, SentMail } from '@sales-portal/shared';

export interface MailSender {
  userId: string | null;
  email: string;
  displayName: string;
}

export interface MailAdapter {
  readonly mode: 'mock' | 'live';
  send(from: MailSender, draft: MailDraft): Promise<SentMail>;
}
