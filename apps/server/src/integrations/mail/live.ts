/**
 * Live mail adapter (Microsoft Graph) – ARCHITECTURE §5.11, INTENT 6.7/6.10/8.
 *
 * - User action (delegated, Mail.Send): `POST /me/sendMail` – always from the logged-in user's own mailbox;
 *   sending as somebody else is refused.
 * - Background (app-only, Mail.Send application permission scoped with RBAC for Applications):
 *   `POST /users/{sender}/sendMail` – only for mailboxes in GRAPH_ALLOWED_MAILBOXES.
 * - Outside Prod (or whenever MAIL_TEST_RECIPIENT is set) every mail goes to MAIL_TEST_RECIPIENT; outside Prod without
 *   a test recipient nothing is sent.
 * - sendMail is not idempotent → retried only on 429 (request was not processed).
 */
import { randomUUID } from 'node:crypto';
import type { MailDraft, SentMail } from '@sales-portal/shared';
import { badRequest, forbidden } from '../../lib/errors';
import { getLiveRuntime, type LiveRuntime } from '../live/runtime';
import { GraphClient, mailboxPath, normalizeMailbox, toAppError } from '../live/graph';
import { textToHtml } from '../live/dataverseMapping';
import type { AdapterDeps } from '../types';
import type { MailAdapter, MailSender } from './types';

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const MAX_RECIPIENTS = 20;

export class LiveMailAdapter implements MailAdapter {
  readonly mode = 'live' as const;
  private readonly rt: LiveRuntime;
  private readonly graph: GraphClient;

  constructor(
    private readonly deps: AdapterDeps,
    runtime?: LiveRuntime,
  ) {
    this.rt = runtime ?? getLiveRuntime(deps.config, deps.log);
    this.graph = new GraphClient({
      baseUrl: deps.config.graphBaseUrl,
      http: this.rt.http,
      getToken: () => this.rt.tokens.getToken('graph', deps.auth, deps.db),
      log: deps.log,
    });
  }

  async send(from: MailSender, draft: MailDraft): Promise<SentMail> {
    const { config, auth } = this.deps;
    const to = draft.to.map((r) => r.trim());
    const cc = (draft.cc ?? []).map((r) => r.trim());
    if (to.length === 0) throw badRequest('Mindestens ein Empfänger nötig');
    if (to.length + cc.length > MAX_RECIPIENTS) throw badRequest('Zu viele Empfänger');
    for (const r of [...to, ...cc]) if (!EMAIL_RE.test(r)) throw badRequest('Ungültige E-Mail-Adresse');
    if (!draft.subject.trim()) throw badRequest('Betreff fehlt');

    const sender = normalizeMailbox(from.email);
    if (auth.kind === 'user' && sender !== auth.email.trim().toLowerCase()) {
      throw forbidden('Mails gehen nur aus dem eigenen Postfach');
    }
    if (auth.kind === 'system' && config.live.appMailSender && sender !== config.live.appMailSender) {
      throw forbidden('Absender für Hintergrund-Mails ist nicht freigegeben');
    }
    const path = mailboxPath(config.live, auth, sender);

    const testRecipient = config.mailTestRecipient;
    if (config.environmentLabel !== 'Prod' && !testRecipient) {
      throw forbidden('Ausserhalb der Produktion werden Mails nur an die Testadresse gesendet (MAIL_TEST_RECIPIENT fehlt)');
    }
    const redirected = !!testRecipient;
    const deliveredTo = redirected ? [testRecipient as string] : to;
    const body = redirected
      ? `[Testumgebung ${config.environmentLabel} – eigentlich an: ${[...to, ...cc].join(', ')}]\n\n${draft.body}`
      : draft.body;

    const message = {
      subject: draft.subject.slice(0, 255),
      body: { contentType: 'HTML', content: textToHtml(body) },
      toRecipients: deliveredTo.map((address) => ({ emailAddress: { address } })),
      ccRecipients: redirected ? [] : cc.map((address) => ({ emailAddress: { address } })),
    };
    try {
      await this.graph.request({ method: 'POST', path: `${path}/sendMail`, body: { message, saveToSentItems: true }, retry: 'throttle_only' });
    } catch (err) {
      throw toAppError(err);
    }
    const id = randomUUID();
    this.deps.log.info({ mailId: id, redirected, delegated: auth.kind === 'user' }, 'mail sent via graph');
    return { id, sentAt: this.deps.now().toISOString(), deliveredTo, redirected };
  }
}
