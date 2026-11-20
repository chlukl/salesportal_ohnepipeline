# Sales-Portal – Architektur-Vertrag (verbindlich für alle Umsetzer)

Fachliche Grundlage: `docs/INTENT.md` (V2.2). Dieses Dokument legt das **Wie** fest. Wer etwas davon ändern muss,
dokumentiert es hier im Abschnitt «Änderungen» am Ende.

## 1. Ziele der Umsetzung

- Lauffähige Webapplikation, die **heute lokal ohne externe Systeme** läuft (Mock-Modus mit realistischen Demo-Daten)
  und später **in Docker auf dem internen Server** gegen Sandbox/Prod (Dataverse, Graph, Claude, Vera) läuft.
- Alle externen Systeme hinter **Adaptern** (Interface + `mock` + `live`). Umschaltung per Env-Variable.
- **Security by default**: serverseitige Sessions, RBAC auf jedem Endpunkt, CSRF-Schutz, strikte CSP, Validierung mit zod,
  Audit-Log, keine Secrets im Code, Docker-Secrets, Non-root-Container.
- UI-Sprache: **Deutsch (Schweiz, ohne ß)**, Alltagssprache (INTENT 6.0). Code, Bezeichner, Kommentare: Englisch.

## 2. Stack

| Teil | Wahl |
|---|---|
| Runtime | Node.js 24, TypeScript (strict), ES Modules |
| Repo | npm workspaces: `packages/shared`, `apps/server`, `apps/web` |
| Server | Fastify 5, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`, zod (+ `fastify-type-provider-zod`) |
| DB | Postgres 16 in Prod (`pg`), **PGlite** (`@electric-sql/pglite`) lokal, wenn `DATABASE_URL` fehlt. ORM: drizzle-orm, Migrationen mit drizzle-kit, beim Start angewendet |
| Worker | separater Prozess (`apps/server/src/worker.ts`), gleiche Codebasis, DB-basierte Job-Tabelle mit `SELECT … FOR UPDATE SKIP LOCKED` |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query, Tailwind CSS 4, lucide-react Icons, Schrift Inter via `@fontsource` (selbst gehostet, keine CDNs) |
| Tests | vitest (shared + server), Logik-Tests Pflicht für Regeln (Telefon, Slots, Vorschläge, Ergebnisgruppen, Aufgaben-Regeln) |
| KI | `@anthropic-ai/sdk`, Modell `claude-opus-5-5` (Analyse, Briefing), `claude-sonnet-5-5` (Mail-Entwurf); Structured Outputs via Tool-Schema |

## 3. Ordnerstruktur und Besitz

```
packages/shared/src/
  types.ts            Domänentypen (Lead, Activity, Task, CallSession, ChangeSet, Roles …)
  phone.ts            Telefonnummern normalisieren (INTENT 6.19)
  resultGroups.ts     Ergebnisgruppen-Engine: Regel + Lead + Eingaben → ChangeSet (INTENT 6.5)
  taskRules.ts        REGEL_AUFGABEN (keine 2. offene Aufgabe pro Firma, max 3/Person/Tag, neueste Info gewinnt)
  scheduling.ts       Slot-Suche + 3 Vorschläge (INTENT 6.6)
  realContact.ts      Definition «echter Kontakt» + Kampagnen-Sperre (INTENT 5)
  i18n.ts             Anzeigetexte für CRM-Codes (Optionsets)
apps/server/src/
  index.ts            API-Prozess        worker.ts   Worker-Prozess
  config.ts           Env + *_FILE-Secrets, zod-validiert, harte Fehler bei unsicherer Prod-Konfig
  db/                 schema.ts, client.ts, migrations/, seed/ (Demo-Daten)
  auth/               session, entra (OIDC+PKCE), dev-login, csrf, rbac
  integrations/       crm/ calendar/ mail/ ai/ transcripts/ telephony/  (je: types.ts, mock.ts, live.ts, index.ts)
  modules/<modul>/    routes.ts + service.ts pro Fachmodul (siehe 4)
  jobs/               Job-Runner + Job-Handler
  lib/                audit.ts, errors.ts, logger.ts
apps/web/src/
  app/                Router, Layout, Kopfleiste, Auth-Kontext, API-Client, Tastaturkürzel, Theme-Tokens
  components/ui/      Basiskomponenten (Button, Badge, Card, Table, Drawer, Dialog, Toast, EmptyState, GradeBadge …)
  pages/<modul>/      eine Seite/Ordner pro Modul (siehe 4)
```

**Regel für parallele Umsetzer:** Jeder Umsetzer schreibt nur in seine Modul-Ordner
(`apps/server/src/modules/<modul>/`, `apps/web/src/pages/<modul>/`, zugewiesene Dateien in `packages/shared/src/`,
zugewiesene Integrationen). Gemeinsame Dateien (Schema, Router, Navigation, `types.ts`) sind vom Fundament
vorbereitet. Braucht ein Umsetzer dort eine Änderung, dann **nur additiv** (neue Tabelle/neuer Typ am Ende, keine
Umbenennung) und Eintrag in «Änderungen» unten. **Keine neuen npm-Pakete** installieren; fehlt eines, melden.

## 4. Module (Server-Prefix `/api/<modul>`, Web-Route)

| Modul | Web-Route | Rollen | Inhalt (INTENT) |
|---|---|---|---|
| `me` | – | alle | aktueller Benutzer, Rollen, «Ansicht als», Kopfleisten-Zähler |
| `leads` | `/anrufliste` | coldcaller, admin | Anrufliste, Filter, gespeicherte Filter, Spaltenwahl (6.1, 6.13) |
| `workspace` | `/lead/:id` | coldcaller, sales, ai_specialist, admin | Lead-Arbeitsplatz, Personen der Firma, Verlauf, Spickzettel (6.2, 6.17) |
| `calls` | (im Arbeitsplatz) | coldcaller, admin | Anruf-Session: Wählen → Verbunden → Aufgelegt → Nachbearbeitung, Notiz-Entwurf (6.2, 6.3) |
| `changesets` | (im Arbeitsplatz + Pendenzen) | coldcaller, admin | Ergebnisgruppe → Vorschau alt→neu → Konfliktprüfung → Push → Protokoll (6.5, 6.9) |
| `pendenzen` | `/` (Startseite) | alle | Pendenzen mit Filtern und Aktionen (6.16) |
| `history` | `/historie` | coldcaller, admin | Anrufhistorie, Kategorien, Rückruf-Suche (6.15, 6.18) |
| `scheduling` | (Seitenfenster im Arbeitsplatz) | coldcaller, admin | Slots, Buchen, 3 Vorschläge, Blocker, Buchungen (6.6, 6.8, 6.11) |
| `ai` | (Arbeitsplatz + Pendenzen) | coldcaller, sales, ai_specialist, admin | Analysen zur Freigabe, Use-Case-Mail, Briefing (6.4, 6.7, 6.10) |
| `dashboard` | `/dashboard` | sales, ai_specialist, admin (**nie** coldcaller) | Kennzahlen (6.12) |
| `admin` | `/admin/*` | admin | Rollen, Ergebnisgruppen-Editor, Vorlagen, Terminregeln, Einwände, Einstellungen, Protokoll, Fehler (6.14) |

## 5. Sicherheit (nicht verhandelbar)

1. **Auth**: `AUTH_MODE=entra|dev`. `entra`: OIDC Authorization Code + PKCE (openid-client), confidential client, State+Nonce,
   Tokens nur serverseitig (verschlüsselt mit AES-256-GCM, Schlüssel aus Secret) für spätere OBO-Aufrufe. `dev`: Login-Seite mit
   Auswahl der Seed-Benutzer. **Start verweigern**, wenn `NODE_ENV=production` und `AUTH_MODE=dev` oder `INTEGRATIONS=mock`
   ohne `ALLOW_MOCK_IN_PRODUCTION=true`, oder wenn `SESSION_SECRET` < 32 Bytes.
2. **Sessions**: serverseitig in DB, Cookie `sp_sid` (httpOnly, `Secure` in Prod, `SameSite=Lax`, Path=/), ID = 32 Byte Zufall,
   in der DB nur als SHA-256-Hash. Idle-Timeout 12 h, absolut 7 Tage, Rotation beim Login, Logout löscht serverseitig.
3. **CSRF**: alle nicht-GET-Anfragen brauchen Header `X-CSRF-Token` (pro Session, konstantzeit-verglichen) **und** gültigen
   `Origin`/`Sec-Fetch-Site: same-origin`. Kein CORS (gleiche Origin; Vite-Proxy in Dev).
4. **RBAC**: Rollen `coldcaller | sales | ai_specialist | admin`, mehrere pro Benutzer, liegen im Portal (nicht im CRM).
   Jeder Route-Handler deklariert `roles` via `requireRoles(...)`; Default = verweigert (Route ohne Deklaration → Fehler beim Start).
   «Ansicht als» (nur echte Admins): Session hält `viewAsRole`; effektive Rollen = `[viewAsRole]`. Rückkehr (`DELETE /api/me/view-as`)
   ist immer erlaubt, wenn der **echte** Benutzer Admin ist. Objektzugriff: Daten anderer Personen nur, wenn die Rolle es erlaubt
   (z. B. Pendenzen fremder Personen nur Admin).
5. **Validierung**: jede Route mit zod-Schema für params/query/body; Antworten nie mit internen Fehlern/Stacktraces.
6. **Header**: helmet mit strikter CSP (`default-src 'self'`, kein `unsafe-inline` für Scripts, `frame-ancestors 'none'`,
   `connect-src 'self'`), HSTS in Prod, `Referrer-Policy: no-referrer`, `X-Content-Type-Options`.
7. **Rate-Limit**: global moderat, Login- und KI-Endpunkte strenger.
8. **Audit**: jede CRM-Änderung und jede Admin-Aktion in `audit_log` (wer, wann, Entität, Feld, alt, neu, ChangeSet-ID).
   Logs ohne Personendaten im Klartext (pino mit Redaction für Telefon, E-Mail, Notiztext, Tokens).
9. **Secrets**: nur über Env bzw. `<NAME>_FILE` (Docker-Secrets). `.env` ist in `.gitignore`, `.env.example` dokumentiert alles.
10. **KI/Daten**: Transkripte nur in Portal-DB, Löschfrist (Default 30 Tage, Admin-Einstellung), Löschjob im Worker. Ins CRM nur Analyse.
    Prompt-Injection: Transkript-/CRM-Text wird als Daten in klar getrennten Blöcken übergeben, KI-Ausgaben sind **immer nur Vorschläge**
    (ChangeSet mit Freigabe), nie direkte Aktionen.
11. **Mails an Kunden** nur nach Klick; im Mock/Sandbox-Modus gehen Mails an `MAIL_TEST_RECIPIENT` bzw. in den Mock-Postausgang.
12. **Container**: Multi-Stage-Build, Non-root-User, read-only Root-FS möglich, Healthcheck, keine Dev-Dependencies im Image.

## 6. Kernmodelle (in `packages/shared/src/types.ts`)

- `Role = 'coldcaller' | 'sales' | 'ai_specialist' | 'admin'`
- `Lead` – Felder spiegeln Dataverse-Namen (`leadid`, `companyname`, `firstname`, `lastname`, `jobtitle`, `emailaddress1`,
  `telephone1`, `mobilephone`, `websiteurl`, `numberofemployees`, `kls_industry`, `kls_custom_industry`, `kls_leadscore`,
  `kls_ki_bewertung`, `kls_callstatus`, `kls_rating_category`, `statecode`, `statuscode`, `ownerid`, `subject`, `leadsourcecode`,
  `kls_lead_support`, `kls_interests` (number[]), `decisionmaker`, `donotphone`, `donotemail`, `donotbulkemail`, `kls_competitor`,
  `kls_salutation`, `address1_postalcode`, `address1_city`, `address1_stateorprovince`, `modifiedon`) plus berechnet:
  `grade`, `phones` (normalisiert), `campaign` (Status/Sperre), `lastRealContact`.
- `ChangeSet` – `{ id, leadId, callSessionId?, kind: 'call_result'|'analysis'|'task'|'booking'|'contact_person'|…,
   ruleVersion, operations: FieldOp[], activities: ActivityOp[], tasks: TaskOp[], notes: NoteOp[], baseSnapshot, status:
   'draft'|'pending'|'conflict'|'pushed'|'failed', error? }`
- `FieldOp` – `{ entity: 'lead'|'phonecall'|…, entityId, field, label, oldValue, newValue, mode: 'set'|'add_to_multiselect'|'set_if_empty' }`
- `Conflict` – `{ field, draftValue (alt im Entwurf), crmNow, newValue }` – Push mit Konflikt nur nach expliziter Entscheidung pro Feld.
- Ergebnisgruppen-Regel: `{ key, label, version, callStatus: {mode:'fixed'|'by_date', value?}, ratingCategory?, state?, fieldActions: FieldAction[],
   followUp: {type:'task'|'mail'|'booking'|'research'|'none', offsetDays?}, setsOwnerToCaller, setsContacted }` – Default-Regeln exakt nach INTENT 6.5.

## 7. Adapter-Verträge (Kurzform)

- `CrmAdapter`: `listLeads(query)`, `getLead(id)`, `getCompanyPersons(leadId)`, `getTimeline(leadId)`, `getFieldValues(entity,id,fields)`
  (für Konfliktprüfung), `applyChangeSet(cs, actor)` (Reihenfolge Notiz → Felder → Status; Rückgabe pro Operation ok/Fehler),
  `listTasks(ownerId|filter)`, `completeTask`, `rescheduleTask`, `searchByPhone(e164)`, `listCampaignMails(leadId)`, `listPhoneCalls(filter)`.
  `mock`: liest/schreibt Tabellen `mock_crm_*` in der Portal-DB (Seed: ~400 Leads, Firmen mit 1–3 Personen, Verlauf, Aufgaben,
  Kampagnen-Mails, Telefonate der letzten 8 Wochen – realistisch, aber **erfunden**). `live`: Dataverse Web API v9.2 mit OBO-Token.
- `CalendarAdapter`: `getSchedule(emails, from, to)`, `createEvent`, `updateEvent`, `deleteEvent`, `delta(mailbox, token)`. `mock` in DB.
- `MailAdapter`: `send(fromUser, draft)` → `mock` legt in `mock_outbox` ab.
- `AiAdapter`: `analyzeCall`, `draftUseCaseMail`, `buildBriefing` – `mock` liefert deterministische, plausible Vorschläge; `live` Claude API.
- `TranscriptAdapter` (Vera): `fetchTranscript(callRef)` – `mock` erzeugt Demo-Transkript nach kurzer Verzögerung.
- `Telephony`: liefert Wähl-URL (`tel:`/Teams-Deeplink `https://teams.microsoft.com/l/call/0/0?users=4:<e164>`).

Umschaltung: `INTEGRATIONS=mock|live` (global) mit Überschreibung pro Adapter (`CRM_ADAPTER`, `CALENDAR_ADAPTER`, `AI_ADAPTER`, …).
Umgebung (`ENVIRONMENT_LABEL=Demo|Sandbox|Prod`) immer in der Kopfleiste sichtbar.

## 8. UI-Grundsätze (INTENT 6.0)

- Feste Kopfleiste: Anrufstatus (bereit · wählt · im Gespräch mm:ss · Nachbearbeitung), Zähler Pendenzen / Analysen / verpasste
  Rückrufe, Rückruf-Suchfeld (Kürzel `/`), Umgebungs-Badge, Benutzer + «Ansicht als».
- Linke Navigation schmal: Pendenzen, Anrufliste, Anrufhistorie, Dashboard, Admin (nur sichtbar, wenn Rolle erlaubt – Server erzwingt).
- Farbe nur mit Bedeutung: Grade A–D, Status, Warnung. Design-Tokens als CSS-Variablen (`--kls-primary` usw.) in einer Datei,
  damit die echten Kallysoft-Farben später an einer Stelle gesetzt werden. Hell- und Dunkelmodus.
- Optimiert ab 1600 px, nutzbar ab 1280 px. Tastaturkürzel mit Übersicht auf `?`. Leere Zustände erklären den nächsten Schritt.
- Notizen speichern laufend (debounced) als Entwurf auf dem Server; «Rückgängig» statt Bestätigungsdialoge.

## 9. Betrieb

- `npm run dev` – startet Server (PGlite, Mock, Dev-Login, Port 3000) + Worker + Vite (Port 5173, Proxy `/api`).
- `npm run build` / `npm start` – Prod-Build; Server liefert das gebaute Web aus.
- `docker compose up` – `app` (API + Web), `worker`, `db` (Postgres 16); Secrets über `secrets/` + Docker-Secrets.
- Healthcheck `GET /api/health` (ohne Auth, ohne Details).

## Änderungen

(Umsetzer tragen hier additive Änderungen an gemeinsamen Dateien ein: Datum, Modul, was, warum.)

### 20.11.2026 – Fundament (alle gemeinsamen Dateien)

- **PGlite + Worker**: PGlite erlaubt nur einen Prozess. Ohne `DATABASE_URL` läuft der Job-Runner deshalb im API-Prozess
  (`WORKER_EMBEDDED` wird erzwungen); `worker.ts` beendet sich dann mit Hinweis. Mit Postgres läuft der Worker getrennt.
- **Config, zusätzliche Prod-Sperren** (über §5.1 hinaus): `PUBLIC_URL` muss `https://` sein; `DATABASE_URL` Pflicht
  (PGlite nur mit `ALLOW_PGLITE_IN_PRODUCTION=true`); bei `AUTH_MODE=entra` Tenant/Client/Secret/`TOKEN_ENC_KEY` Pflicht;
  live-KI ohne `ANTHROPIC_API_KEY`, live-CRM ohne `DATAVERSE_URL`, live-Mail ausserhalb Prod ohne `MAIL_TEST_RECIPIENT` → Start verweigert.
- **RBAC-Deklaration**: `config: requireRoles(...)` · `requireAuth()` (jeder angemeldete Benutzer, z. B. `/api/me`) ·
  `requireRealAdmin()` («Ansicht als», ignoriert viewAs) · `publicRoute()` – öffentlich nur unter `/api/health` und `/api/auth/*`
  (sonst Startfehler). Kein impliziter Admin-Bypass: `admin` wird in den Rollen explizit aufgeführt.
- **Session-ID** in der DB als HMAC-SHA256 mit `SESSION_SECRET` (statt reinem SHA-256). **OIDC-Flow-Status** (PKCE-Verifier,
  state, nonce) in einem verschlüsselten, kurzlebigen Cookie (`sp_oidc`, Path `/api/auth`) statt in einer DB-Tabelle.
- **Telefonie im Mock** liefert keine Wähl-Links (`simulated: true`): Demo-Nummern sind erfunden und könnten echten Personen gehören.
- **Zusätzliche Tabellen/Spalten**: `sync_state` (Delta-Tokens), `call_sessions.handled_at`, `analyses.owner_user_id`/`usage`,
  `bookings.briefing_mail_sent_at`/`crm_booking_id`; Mock-Hilfsspalten `mock_crm_leads.domain`/`org_type`/`campaign_name`/
  `campaign_joined_at`, `mock_crm_contacts.domain`.
- **Typen** (`types.ts`): `Grade` enthält `'unrated'` («unbewertet»); Band `'1-4'` zusätzlich zu INTENT 6.1; `ChangeSet` zusätzlich
  `stateChanges`, `leadCreates`, `conflicts`, `results`; `NormalizedPhone.candidates` (alle Nummern eines «mehrere Nummern»-Felds für die Rückruf-Suche).
- **Adapter-Erweiterungen**: `CrmAdapter.getLeads`, `updatePhoneCall` (Dauer/Analyse im Hintergrund), `listUsers`, `getFilterOptions`;
  `CalendarAdapter.listEvents`, `getEvent`. Adapter pro Anfrage über `adaptersFor(request)` (OBO), in Jobs `ctx.adapters` (App).
- **Optionsets**: Codes, die nicht in INTENT 6.5 stehen (u. a. alle `kls_anrufergebnis`-Werte, Statusgrund Austausch/Zweitkontakt/
  Gleiche Domain/Bestehende Firma, `kls_lead_support` ausser Verkauf, `kls_interests` ausser 845140014), sind in `i18n.ts`
  mit `assumed: true` markiert und vor dem Livegang gegen die Sandbox-Metadaten zu prüfen.
- **Auslegung offene Frage 5** (`realContact.ts`): Anrufe/Notizen/Termine verlängern die Kampagnen-Sperre nur, solange sie läuft –
  Markus' eigene Anrufe nach dem Entsperren sperren den Lead nicht erneut. Kampagnen-Mails zählen nicht als «gesendete Mail» für
  den echten Kontakt (nur für die Sperre).
- **Shared-Dateien neu**: `resultGroupDefaults.ts` (Default-Regeln v1 nach 6.5), `assessment.ts` (`kls_ki_bewertung` parsen), `time.ts` (Europe/Zurich).
- **Build**: Server wird mit esbuild gebündelt (`apps/server/scripts/build.mjs`, `@sales-portal/shared` inline, npm-Pakete extern);
  der gebaute Server liefert `apps/web/dist` aus, sobald es existiert (SPA-Fallback für Client-Routen).


### 20.11.2026 – pendenzen + history

- **Neue Tabellen** (Migration `0001_tranquil_justin_hammer.sql`): `pendenz_states` (pro Benutzer «erledigt»/«verschoben bis» für
  Portal-Pendenzen ohne eigenes Erledigt-Feld: Briefings, Termine, Absagen, Fehler) und `phone_assignments` (unbekannte
  Rückruf-Nummer → Lead, nur im Portal; ins CRM geht eine Nummer weiterhin nur über eine Freigabe). `call_sessions.handled_at`
  wird für «verpasster Rückruf erledigt» genutzt (vom Fundament vorgesehen).
- **Rückruf öffnen**: Header-Suche ruft `POST /api/calls { leadId, direction: 'inbound', phoneE164, reason }` (Vertrag des
  calls-Moduls; Zusatzfelder optional) und öffnet `/lead/:id?anruf=<callId>&richtung=eingehend`.
- **Typen** (`types.ts`, am Ende angehängt): `PendenzEntry`, `PendenzFilter`, `PendenzPerson`, `PendenzenResponse`, `PendenzAction`,
  `PendenzTone`, `HistoryRow`, `HistoryResponse`, `CallbackHit`, `CallbackSearchResponse` (API-Vertrag Server ↔ Web).
- **Kopfleiste** (`Header.tsx`, nur Suchteil): `CallbackSearch` rendert `@/pages/history/CallbackSearch` (nur Coldcaller/Admin);
  Kürzel `/` bleibt. **Links in den Arbeitsplatz** (für das workspace-Modul, optional auszuwerten): `?anruf=<callSessionId>&richtung=eingehend`
  (Rückruf angenommen), `?briefing=<bookingId>`, `?analyse=<analysisId>`, `?freigabe=<changeSetId>`.
- **API** pendenzen: `GET /api/pendenzen?kinds&due&origins&company&status&userId`, `GET /persons` (echter Admin),
  `POST /tasks/:id/complete|reschedule`, `PUT /state`, `GET|POST|PUT|DELETE /filters`. history: `GET /api/history`,
  `POST /sessions/:id/handled`, `GET /callback-search?q=`, `POST|DELETE /assignments`. Zähler `pendenzen` und `missedCallbacks` registriert.

### 20.11.2026 – scheduling

- **Keine Schema-/Typ-Änderungen** an gemeinsamen Dateien. Neue Exporte nur in der eigenen Datei `packages/shared/src/scheduling.ts`
  (Slot-Suche, 3 Vorschläge inkl. Wochenregel, `swapProposal`, `checkAttendeeEmail`, `buildSchedulingChangeSet`, Text-/Datums-Helfer).
- **Kalender-Kennzeichnung** (Vertrag für das ai-Modul): Hauptmeeting `extendedProperties.KlsTerminId = bookingRef`; Blocker und
  Briefing-Einträge zusätzlich `KlsRolle = 'blocker' | 'briefing'`. Briefing-Einträge bitte mit beiden Properties anlegen und die
  Event-ID in `bookings.briefing_event_ids` speichern – dann verschiebt/entfernt der Delta-Job sie mit (6.10/6.11).
- **Change Sets**: Buchung erzeugt `kind 'booking'`, `ruleKey 'meeting_booked'` (Felder nach aktiver Regel, Termin-Aktivität);
  gesendete Vorschläge `kind 'mail'`, `ruleKey 'proposals_sent'` (E-Mail-Aktivität, Aufgabe nach 3 Arbeitstagen über `applyTaskRules`).
  Status `draft`, Freigabe über `ChangeSetPreview`. Die Telefonaktivität des Anrufs bleibt beim Ergebnis-Change-Set des calls-Moduls.
- **Panels** (`@/pages/scheduling`): `SchedulingPanel` / `ProposalsPanel` mit `{ leadId; callSessionId?; onClose?; onDone?(result) }`
  (`onClose` jetzt optional, `onDone` neu: `{ kind: 'booked', bookingId, changeSetId } | { kind: 'proposals_sent', changeSetId }`).
- **Jobs**: `recurring:scheduling.calendar_delta` (alle 3 Min., Token in `sync_state` `calendar.delta:<postfach>`),
  `scheduling.ensure_blockers` (Nachholen von Blockern). Benachrichtigungen in `notifications` (`booking_cancelled`,
  `booking_rescheduled`, `attendee_declined`, `internal_declined`) mit `entity 'booking'` und Link `/lead/:id`.
- **Demo**: `POST /api/scheduling/bookings/:id/simulate` (nur Admin, nur Mock-Kalender) simuliert Absage/Ablehnung/Verschiebung
  in Outlook und lässt den Delta-Job einmal laufen.

### 20.11.2026 – Dashboard + Admin

- **types.ts (additiv, am Ende)**: API-Typen `DashboardRange`, `RateValue`, `DashboardBreakdownRow`, `DashboardDimension`, `DashboardBreakdown`,
  `DashboardReport`, `WeeklyReportPreview` (Dashboard) sowie `ResultGroupRuleVersion`, `SecretExpiry`, `AdminConnections`, `AdminSettings`,
  `AdminErrorItem` (Admin) – damit Server und Web denselben Vertrag nutzen.
- **settings-Tabelle, neue Schlüssel ohne Schemaänderung** (nicht in `SettingsMap`, eigene zod-Validierung in `modules/admin/extraSettings.ts`):
  `weeklyReport.recipient`, `weeklyReport.sender`, `secrets.expiry` (vom Admin eingetragene Ablaufdaten). `sync_state`-Schlüssel
  `dashboard.weeklyReport` (zuletzt gesendete Woche) und `admin.secretExpiryNotified`. Keine Migration nötig.
- **Dashboard-Definitionen**: Termin = «Termin gebucht» oder «3 Vorschläge gesendet»; Absage = Kein Bedarf, Hat Partner, Intern/Konzern,
  Zu klein, Nicht mehr kontaktieren, Mitbewerber. Quoten je erreichtem Lead (Termin zählt immer, sonst letztes Ergebnis), erst ab n ≥ 10,
  mit Wilson-95%-Intervall. Freie Kapazität eigene Berechnung (`dashboard/stats.ts#freeSlotStarts`, gleiche Regeln wie 6.6).
- **Jobs**: `recurring:dashboard.weekly_report` (alle 30 Min. geprüft, sendet ab Montag 07:00 Zürich einmal für die Vorwoche, holt nach),
  `recurring:admin.secret_expiry_check` (Benachrichtigung an aktive Admins 30 Tage vor Ablauf, einmal pro Geheimnis/Status).
- **Zurücksetzen aus dem Protokoll** (`POST /api/admin/audit/:id/revert`): nur für `crm.field_update` auf `lead`; legt einen neuen
  `change_sets`-Eintrag an (`kind: 'manual'`, `status: 'draft'`, eine `FieldOp` alt→neu, `baseSnapshot` mit CRM-Wert) – geschrieben wird
  erst über die normale Freigabe des changesets-Moduls (muss `kind: 'manual'` anzeigen/pushen können).

### 20.11.2026 – Live-Integrationen (Dataverse, Graph)

- **config.ts (additiv)**: neue Env-Variablen `ENTRA_CLIENT_CERT(_FILE)`, `ENTRA_CLIENT_KEY(_FILE)` (auch in `SECRET_NAMES`),
  `ENTRA_AUTHORITY_HOST`, `ENTRA_DELEGATED_FLOW`, `GRAPH_ALLOWED_MAILBOXES`, `GRAPH_APP_MAIL_SENDER`, `GRAPH_DELTA_PAST_DAYS`,
  `GRAPH_DELTA_FUTURE_DAYS`, `DATAVERSE_CAMPAIGN_SENDER_IDS`, `DATAVERSE_BOOKING_ENTITY_SET`, `LIVE_HTTP_TIMEOUT_MS`;
  `AppConfig.live` (Typ `LiveConfig`). Startfehler **nur für Adapter auf `live`** (auch ausserhalb Prod): Tenant/Client und
  Secret oder Zertifikat fehlen, `DATAVERSE_URL` fehlt/nicht https/mit Pfad, ungültige Postfächer/GUIDs, `offline_access` fehlt.
  `.env.example` ergänzt.
- **Neue Dateien** `integrations/live/*` (Token-Dienst OBO/Refresh/Client-Credentials, HTTP mit Retry/Timeout, OData-Builder,
  Dataverse-Client inkl. `$batch`, Mapping, Graph-Client, `calendarSync.ts`). Adapter-Konstruktoren haben ein optionales
  zweites Argument (`LiveRuntime`, für Tests); `adaptersFor`/Factory unverändert.
- **Postfach-Regel**: App-Zugriff auf Postfächer nur mit `GRAPH_ALLOWED_MAILBOXES`; delegiert nur Postfächer der Liste (wenn gesetzt).
  Mail delegiert nur aus dem eigenen Postfach.
- **Kalender-Delta-Token** ist opak (`<deltaLink>#sp-window=<Fensterbeginn>`); der Live-Adapter startet das Fenster nach 7 Tagen
  selbst neu (Ergebnis enthält dann alle Termine des Fensters → Verarbeitung muss idempotent sein). Gleiches `sync_state`-Format
  wie der scheduling-Job (`{ token, polledAt }` + `startedAt`). Gelesene erweiterte Eigenschaften: `KlsTerminId`, `KlsRolle`.
- **Zusatz an `LiveCrmAdapter`** (nicht im `CrmAdapter`-Interface): `upsertBooking(booking, crmBookingId, actor)` für `kls_buchung`
  (Spaltennamen Annahme, siehe README). Annahmen zu FixCRMSolution-Feldern stehen in README «Live-Anbindung».

### 20.11.2026 – ai (KI: Vera, Analyse, Use-Case-Mail, Briefing)

- **Keine Schema-/Typ-Änderungen** an gemeinsamen Dateien, keine Migration. Genutzt werden `analyses` (kind `call` | `use_case_mail` |
  `briefing`, `usage.costUsd`), `transcripts` (`delete_after` = jetzt + `transcripts.retentionDays`), `bookings.briefing_*`,
  `call_sessions.duration_sec/duration_source/transcript_ref`, `sync_state` (`vera_webhook:<sha256>` für Replay-Schutz).
- **Service-Funktionen** (`modules/ai/service.ts`, deps über `aiDepsFor(request)` bzw. `aiDepsFromJob(ctx)`): `onCallSessionEnded(deps, callSessionId)`
  (calls, nach «Aufgelegt»), `onBookingCreated` / `updateBriefingForBooking` / `deleteBriefingForBooking` (scheduling). Sweeps
  `recurring:ai.transcript_sweep` (1 Min.) und `recurring:ai.briefing_sweep` (5 Min.) decken fehlende Aufrufe ab.
- **Jobs**: `ai.fetch_transcript`, `ai.analyze_call`, `ai.sync_call_duration` (Dauer von Vera an die Telefonaktivität, ohne Freigabe),
  `ai.build_briefing`, `ai.deliver_briefing`, `ai.briefing_mail`, `recurring:ai.webhook_delivery_cleanup`.
- **Change Sets**: `kind 'analysis'` (Telefonaktivität `action 'update'` mit Notiz + KI-Zusammenfassung + `kls_interesse`, dazu nur
  angekreuzte Vorschläge) und `kind 'mail'` (E-Mail-Aktivität der Use-Case-Mail), beide **ohne `callSessionId`** und gepusht über
  `changesets/service.pushChangeSet`. Analyse-Entwürfe liegen bis zur Freigabe als `status 'draft'` in `change_sets` – Pendenzen
  zeigt sie als «Analysen zur Freigabe» (Zähler `analysen` registriert), nicht zusätzlich unter «Freigaben».
- **Briefing-Kalendereinträge** mit `KlsTerminId` + `KlsRolle 'briefing'`, «frei», Kategorie `booking.rules.briefingCategory`; IDs in
  `bookings.briefing_event_ids`. Status offen/gelesen/Vorbereitung erledigt in `bookings.briefing_status` (`POST /api/ai/briefings/:id/status`).
- **KI live**: Structured Output über `output_config.format` (JSON-Schema) statt Tool-Schema – erzwungenes `tool_choice` lehnen
  `claude-opus-5-5`/`claude-sonnet-5-5` ab; serverseitiger Refusal-Fallback (`fallbacks: 'default'`). Monatsdeckel `ai.monthlyBudgetUsd`
  (Zürich-Monat, 429 `ai_budget_exceeded`).
- **Vera-Webhook** `POST /api/ai/vera/webhook` (HMAC-SHA256 + Zeitfenster + Replay-Schutz) ist in `modules/ai/veraWebhook.ts`
  umgesetzt und getestet, aber **nicht gemountet**: braucht eine Fundament-Erweiterung (Maschinen-Route ohne Session/Origin-Prüfung
  in `rbac.ts`/`plugin.ts`, `VERA_WEBHOOK_SECRET(_FILE)` in `config.ts`). Bis dahin holt der Pull-Job die Transkripte.

### 20.11.2026 – Coldcall-Kern (leads, workspace, calls, changesets)

- **Typen** (`types.ts`, additiv): `Lead.nextAttemptAt?` (nächster Versuch nach «Nicht erreicht», nie im selben Halbtag);
  `LeadQuery.hideRetryPending?`, `excludeLeadIds?`, `campaignNames?`, `requireEmail?`; `ActivityOp.statecode?` (Update setzt
  z. B. eine Telefonaktivität bei «Rückgängig» auf storniert). Live-Adapter muss diese Query-Felder ebenfalls unterstützen.
- **Mock-CRM** (`integrations/crm/mock.ts`): `applyChangeSet` schreibt echt in `mock_crm_*` (Reihenfolge Telefonaktivität →
  Notiz → neue Leads → Felder → Aufgaben → Status; fehlgeschlagene Notiz blockiert die Disqualifizierung; `modifiedon` wird
  hochgezählt). Lesend ergänzt: `nextAttemptAt`, die neuen Query-Felder, stornierte Anrufe (statecode 2) fehlen in
  `listPhoneCalls`. `sortLeads(..., now)`: bei `due_then_score` zählt nur «heute fällig/überfällig» als fällig (künftige
  Rückrufe verdrängen frische Leads nicht mehr).
- **Audit**: die Feld-Protokollierung (alt → neu, ChangeSet-ID) macht der changesets-Service für jeden Adapter – Adapter
  protokollieren `applyChangeSet` nicht selbst. Alter Wert = CRM-Wert unmittelbar vor dem Push (Konfliktprüfung).
- **Entwurfs-Eingaben** des Nachbearbeitungs-Formulars liegen in `change_sets.base_snapshot['meta:input']` (kein CRM-Feld,
  keine Schemaänderung), damit ein Reload das Formular wiederherstellt.
- **Regeln (Auslegung)**: Disqualifizieren verlangt einen Grund aus dem Gespräch (Beleg); fehlt der Regel eine Notiz, setzt die
  Engine «Sales-Portal: Nicht qualifiziert – <Gruppe>». Erreichter Kontakt ohne neue Folgeaufgabe schliesst offene Aufgaben
  dieses Leads («neueste Info gewinnt»). Vereinbarte Rückruf-Termine werden von «max. 3 pro Tag» nicht verschoben (nur Hinweis);
  generierte Aufgaben nie am Wochenende. «Andere Ansprechperson» bei allen Gruppen mit erreichtem Kontakt; bisheriger Lead →
  Zweitkontakt (bei «Falsche Person» → Kontakt nicht möglich); max. 2 offene Leads pro Firma.
- **KI-Hook**: «Aufgelegt» ruft bei Vera an `onCallSessionEnded()` des ai-Moduls auf (Fehler blockieren nie; der Sweep des
  ai-Moduls fängt sie auf). Recurring-Job `calls.sweep_stale`: Anrufe > 2 h «wählt/im Gespräch» → Nachbearbeitung (nie verworfen).

### 20.11.2026 – Integration (calls ↔ scheduling ↔ changesets ↔ ai ↔ pendenzen)

- **Booking/mail change sets beenden keinen Anruf**: `changesets/service` setzt den Anruf (Status, `resultGroup`, `changeSetId`,
  `crmPhonecallId`) nur noch bei `kind 'call_result' | 'not_reached'`; nur ein `call_result` beendet einen laufenden Anruf beim
  Freigeben. Vorher hat die Freigabe der Buchung (kind `booking`, mit `callSessionId`) den Anruf ohne Telefonaktivität auf
  «abgeschlossen» gesetzt – «Termin gebucht» als Anrufergebnis war danach nicht mehr möglich (409).
- **Keine doppelten Feld-Schreibvorgänge** («Termin gebucht»): beim Push werden Feld-Operationen weggelassen, deren Wert schon im
  CRM steht (`dropNoOps`, nach der Konfliktprüfung; `add_to_multiselect`: alle Werte schon vorhanden). Egal ob zuerst die Buchung
  oder das Anrufergebnis freigegeben wird – das zweite Change Set schreibt nur noch seine Aktivität, ohne Feld-Audit.
- **Briefing-Hooks** (scheduling → ai): `SchedulingDeps.briefing` (`briefingHooks()` in `scheduling/util.ts`, optional) ruft
  `onBookingCreated` nach dem Buchen, `updateBriefingForBooking` nach Verschieben (Portal und Delta-Job) und
  `deleteBriefingForBooking` nach Absage (Portal und Delta-Job). Fehler werden geloggt, nie geworfen; der 5-Min-Sweep bleibt Netz.
- **Pendenzen**: Analyse-Entwürfe (`change_sets.kind 'analysis'`) erscheinen nur als «KI-Analyse», nicht zusätzlich als «Freigabe»;
  KI-Analysen nur noch mit Status `ready` (zur Freigabe) und `failed` (verwerfen) – `pending/running` sind nicht bearbeitbar.
  Buchungs-/Mail-Entwürfe eines offenen Anrufs bleiben als Freigabe sichtbar (nur das Ergebnis-Change-Set steckt im «offenen Anruf»).
- **Arbeitsplatz-Deep-Links**: `/lead/:id?freigabe=<changeSetId>` → `ChangeSetPreview`, `?analyse=<id>` → `AnalysisReviewList`,
  `?briefing=<bookingId>` → `BriefingView`, jeweils als Karte oben in der Mitte (schliessbar). `SchedulingPanel`/`ProposalsPanel`
  bekommen `onDone`: nach Buchung bzw. gesendeten Vorschlägen während eines Anrufs ist im Tab «Ergebnis» die passende Gruppe
  (`meeting_booked` / `proposals_sent`) vorgewählt.
- **Test** `apps/server/test/integration.test.ts` (Buchung im Anruf, beide Freigabe-Reihenfolgen ohne Doppel-Audit, Briefing-Job,
  Pendenzen ohne Doppel-Analyse). HTTP-Smoke-Test gegen frische PGlite-DB (Migrationen 0000+0001, Seed) ohne Befund.
- **Bekannte Lücken**: Vera-Webhook weiter nicht gemountet (Pull-Job aktiv); Live-CRM-Adapter ohne `listTasks/completeTask/
  rescheduleTask/searchByPhone/listPhoneCalls`; `LiveCrmAdapter.upsertBooking` wird von scheduling nicht aufgerufen; Feiertage
  nicht modelliert; UI nur per Typecheck/Build und API geprüft, nicht im Browser.

### 20.11.2026 – Fixer dashadmin (Use-Case-Katalog, Admin-Kürzel)

- **Use-Case-Katalog pflegbar** (INTENT 3 «AI-Spezialist: Use Cases»): gespeichert in `settings` unter `useCases.catalog`
  (zod-validiert, keine Schemaänderung/Migration); solange niemand editiert, gelten die Defaults aus `USE_CASES` (i18n.ts) plus
  Kurztext/Branchen in `modules/admin/useCases.ts`. Kennung = Kampagnen-Kennung (Lemlist), unveränderlich, nicht löschbar
  (nur ausblenden). API `GET /api/admin/use-cases` (sales, ai_specialist, admin), `POST /api/admin/use-cases` und
  `PUT /api/admin/use-cases/:id` (ai_specialist, admin), Audit `admin.use_case_create|update`.
- **types.ts (additiv)**: `UseCaseEntry`, `UseCasesResponse`. **router.tsx/nav.ts (additiv)**: Seite `/use-cases`
  (`pages/admin/UseCasesPage.tsx`), Nav-Eintrag «Use Cases» (Kürzel `g u`) für Sales, AI-Spezialist, Admin.
- **Offen für ai/coldcall**: Konsumenten lesen noch die Konstante `USE_CASES`/`useCaseLabel`. Server: `getUseCaseCatalog(db)` und
  `useCaseLabelFrom(catalog, id)` aus `modules/admin/useCases.ts` verwenden (KI-Katalog/Enum, Spickzettel, Briefing, Mail);
  Web: Labels über `GET /api/admin/use-cases` (nur für Rollen mit Lesezugriff).
- **Admin-Bereichswechsel** jetzt `.` / `,` statt `]` / `[` (auf CH-Tastatur nur mit AltGr erreichbar → wurde als `mod+alt+…` erkannt).

### 20.11.2026 – Fixer live (Testumleitung Kalender, «Nicht erreicht» im Live-CRM)

- **config.ts (additiv)**: Startprüfung wie bei `MAIL_ADAPTER=live` auch für `CALENDAR_ADAPTER=live` – in Produktion ausserhalb
  `ENVIRONMENT_LABEL=Prod` ist `MAIL_TEST_RECIPIENT` Pflicht. Grund: Exchange verschickt Teams-Einladungen/Absagen an Teilnehmer.
- **calendar/live.ts**: ausserhalb Prod (oder wenn `MAIL_TEST_RECIPIENT` gesetzt ist) werden externe Teilnehmer (nicht in
  `GRAPH_ALLOWED_MAILBOXES`, nicht deren Domains, nicht die Domain des Organisator-Postfachs) durch `MAIL_TEST_RECIPIENT`
  ersetzt; Originale stehen im Text und in der Extended Property `KlsTestumleitung`, beim Lesen erscheint die Antwort der
  Testadresse wieder bei den Originalen (Absage bleibt testbar). Ohne Testadresse → 403. Ändern/Absagen von Terminen, die noch
  echte Kundenadressen tragen, wird ausserhalb Prod abgelehnt (403).
- **crm/live.ts**: `Lead.nextAttemptAt` wie im Mock (`nextAttemptFor`); `listLeads` lädt dafür die Anrufe der letzten 7 Tage
  der Leads mit `kls_callstatus = Nicht erreicht` → `hideRetryPending` wirkt auch in Sandbox/Prod (INTENT 6.1).

### 20.11.2026 – Fixer overview (Pendenzen, Historie, Kopfleisten-Suche)

- **Keine Schema-/Typ-Änderungen.** Pendenz «Termin abgesagt» verlinkt für Coldcaller/Admin neu auf `/lead/:id?panel=scheduling`
  (für Sales/AI-Spezialist weiter `/lead/:id`, Hinweis «neu planen» entfällt, Hauptknopf «Absage erledigt»). **Offen für workspace
  (coldcall)**: `?panel=scheduling` (und `proposals`) beim Öffnen als Tab vorwählen – heute wird nur `panel=mail` ausgewertet.
### 20.11.2026 – Fixer scheduling

- **Keine Schema-/Typ-Änderungen an gemeinsamen Dateien, keine Migration.** Neue eigene Datei `modules/scheduling/crmSync.ts`.
- **Termin / 3 Vorschläge im laufenden Anruf** (eigener Anruf, Status `dialing|connected|ended`): das Change Set (`booking` bzw.
  `mail`) enthält **nur die Aktivität** (Termin bzw. E-Mail). Lead-Felder, «Neu → Kontaktiert» und die Nachfass-Aufgabe kommen
  einmal mit dem Anrufergebnis derselben Gruppe (keine doppelte Aufgabe, Felder nur in einer Vorschau). Ausserhalb eines Anrufs
  (oder nach freigegebenem Ergebnis) bleibt das volle Change Set. Antwort neu mit `withCallResult` (auch in `SchedulingResult`).
  `callSessionId` wird geprüft (eigener Anruf bzw. Admin, gleicher Lead → sonst 404/400). **Offen für changesets/workspace
  (coldcall)** für «eine Vorschau pro Anruf» (6.9) ganz: beim Freigeben des `call_result` die offenen `booking`/`mail`-Entwürfe
  mit derselben `callSessionId` mit anzeigen und mitpushen; bis dahin bleibt ein kleiner zweiter Klick nur für die Aktivität.
- **Doppelbuchungs-Schutz** serialisiert: Prüfen → Teams-Termin → Buchungszeile (und Verschieben) laufen unter einer Sperre
  (prozessintern + `dbHandle.withAdvisoryLock(727106)` auf Postgres, `SchedulingDeps.lock`).
- **Zusatzcall beim Verschieben**: nur, wenn Manuel zur neuen Zeit nicht kann (409 `extra_call_not_allowed`).
- **CRM-Termin folgt Absage/Verschiebung** (Portal und Delta-Job, Hintergrundaufgabe ohne Lead-Felder): freigegebene Termin-Aktivität
  → `statecode 2` bzw. neue Zeit (Audit `crm.activity_update`); noch nicht freigegebener Entwurf → bei Absage verworfen, bei
  Verschiebung neue Zeit im Entwurf. Verknüpfung über `change_sets.base_snapshot['meta:bookingRef']` (Fallback: Audit der Buchung).
  **Offen für crm/live**: `activityPayload` übernimmt `statecode` bei `update` nicht; **für crm/mock (coldcall)**: `updateActivity`
  setzt `scheduledstart/scheduledend` von Terminen nicht.
- **`kls_buchung`**: `LiveCrmAdapter.upsertBooking` wird beim Buchen, Verschieben und Absagen aufgerufen (wenn der Adapter es
  kann), ID in `bookings.crm_booking_id`; Fehler → Job `scheduling.sync_crm_booking` (Wiederholung).
- **Panels**: eingebettet (Standard) ohne eigenen Rahmen/Titel/Scrollbereich; Esc schliesst (über `useShortcut`, nicht während
  eines Dialogs/Menüs); Prop `embedded={false}` für ein gerahmtes Seitenfenster.

### 20.11.2026 – Fundament-Fixes (Review)

- **Logs ohne Abfragewerte** (`lib/logger.ts`): eigener pino-`err`-Serializer + `safeErrorMessage(err)`. Fehlgeschlagene DB-Abfragen
  (drizzle `DrizzleQueryError`: Meldung enthält alle gebundenen Werte) werden nur mit SQL-Text, pg-Code und Constraint geloggt;
  `params`, Stack-Kopf und pg-`detail`/`where` entfallen, auch als verschachtelte `cause` und in `{ err: { message } }`.
  `jobs.last_error` und der Entra-Login-Fehler nutzen `safeErrorMessage`. **Für alle Module**: Fehlermeldungen nie roh loggen/speichern,
  sondern `{ err }` oder `safeErrorMessage(err)`.
- **Dev-Login nur lokal** (`config.ts`): `AUTH_MODE=dev` verweigert den Start (auch ausserhalb Prod), wenn `HOST` keine Loopback-Adresse
  ist oder `PUBLIC_URL` nicht auf localhost zeigt.
- **TRUST_PROXY** (`config.ts`, `AppConfig.trustProxy: false | string`): nur `false` oder Proxy-Adressen (IP/CIDR bzw. `loopback`/
  `uniquelocal`); `true` («allen vertrauen») und Stufenzahlen (Fastify 5.12 ignoriert sie) → Startfehler. docker-compose verlangt
  `TRUST_PROXY` jetzt explizit (vorher Standard `true`).
- **Rate-Limits pro Benutzer** (`app.ts`): `@fastify/rate-limit` läuft im `preHandler` (nach dem Laden der Session) mit
  `keyGenerator` `user:<echte Benutzer-ID>`, anonym `ip:<request.ip>`. Gilt auch für Routen-Limits (`config.rateLimit`).
- **Entra-Verknüpfung** (`auth/entra.ts`): Identität = `oid` (nach `tid`-Prüfung). Erstverknüpfung mit einem angelegten Benutzer nur
  über den Anmeldenamen (UPN, `preferred_username`/`upn`), nie über den `email`-Claim; nie für Gäste (`acct=1`, fremder `idp`, `#EXT#`),
  nie mit Demo-Benutzern, nie mit einem Benutzer, der schon an eine andere `oid` gebunden ist. Neue Benutzer erhalten den UPN als
  `users.email`. `BOOTSTRAP_ADMIN_EMAILS` vergleicht mit dem UPN und gilt nur beim ersten Login dieser Identität oder solange es keinen
  aktiven Admin gibt (eine im Portal entzogene Admin-Rolle kommt nicht zurück).
- **Kopfleiste** (`Header.tsx`, `Layout.tsx`): Anrufstatus, «Analysen zur Freigabe» und «Verpasste Rückrufe» nur für Coldcaller/Admin;
  Anrufstatus wird im Layout auf jeder Seite vom Server wiederhergestellt (`useRestoreActiveCall` + 60-s-Abfrage `['calls','active']`).
  Bei 1280 px: Suchfeld schrumpft (200–340 px), Name im Anrufstatus und Rollenzeile erst ab 1440 px, mehrere Rollen als «4 Rollen».
- **Tastenhinweise** (`components/ui/keys.ts`, neu): `kbdLabel()`/`keyLabel()`; `<Button kbd>` zeigt auf dem Mac «⌘» statt «Ctrl» und
  akzeptiert auch registrierte Kombinationen (`kbd="mod+enter"`); die «?»-Übersicht nutzt dieselben Labels (Enter als «↵»).
- **Demo-Seed** (`db/seed/demo.ts`): zusätzlich 2 soeben beendete Anrufe mit gepushtem Ergebnis (der KI-Transkript-Sweep erzeugt daraus
  kurz nach dem Start «Analysen zur Freigabe»), 1 unabgeschlossener Anruf ohne Ergebnis, 1 Freigabe-Entwurf (`phone_fix`), 1 fehlgeschlagener
  Push, 1 abgesagter + 1 verschobener Termin, Benachrichtigungen `campaign_reply`/`mail_failed`, Audit-Einträge. Verpasste Rückrufe /
  unbekannte Nummern haben jetzt Status `abandoned` statt `ended` (sonst galten sie als laufender Anruf in «Nachbearbeitung»).
  Keine Schemaänderung, keine Migration.

### 20.11.2026 – Coldcall-Fixes (Review: changesets, calls, leads, workspace)

- **shared `resultGroups.ts` (additiv)**: `ResultInputIssue.field` kann `'booking'` sein (Server-Prüfung «Termin gebucht» ohne
  aktive Buchung); neu `resultGroupShortcuts` / `RESULT_SHORTCUT_RESERVED` / `RESULT_SHORTCUT_FALLBACK` (Kürzel im
  Ergebnis-Panel: reserviert nur noch `e ? / g`; Gruppen ohne Kürzel bekommen i/z/d/c/f/u), `followUpRequirement`,
  `followUpMailSent`. Keine Schema-Änderung, keine Migration.
- **changesets**: Die generischen Routen (`POST /api/changesets`, `/:id/push`, `/:id/discard`) lehnen `kind 'analysis'` ab (409
  `analysis_own_flow`) – KI-Vorschläge nur über `POST /api/ai/analyses/:id/approve` (interne Aufrufe aus modules/ai unverändert).
  `changeSetId` beim Entwurf nur für `call_result`/`not_reached`. **Push atomar**: `executePush` übernimmt die Zeile mit
  `UPDATE … WHERE status IN (draft,conflict,failed) OR (pending AND pushed_by IS NULL AND results = [])` und setzt
  `pushed_by` = pushende Person bis zum Ende; zweiter Push → 409 `push_running`. «pending» ohne `pushed_by` (z. B. Use-Case-Mail
  des ai-Moduls) bleibt pushbar. Hängender «pending»-Eintrag (> 10 Min.) kann verworfen, nicht erneut gepusht werden.
  Konfliktentscheide gehen im gepushten Objekt an den Adapter (`conflicts`), damit der Live-Adapter «Überschreiben» kennt.
  «Termin gebucht» (`followUp.type 'booking'`) braucht eine aktive Buchung (booked/rescheduled) des Leads oder Anrufs –
  beim Entwurf als Issue `booking`, beim Push 409 `booking_missing`. «Rückgängig» eines `call_result` setzt den Anruf zurück auf
  «Nachbearbeitung» (`status 'ended'`, ohne `changeSetId/crmPhonecallId/resultGroup`), damit das Ergebnis neu erfasst wird.
- **calls**: «Nicht erreicht» wechselt den Anruf atomar `dialing → ended` (zweiter Klick 409). `POST /api/calls` lehnt
  ausgehende Anrufe gesperrter Leads (Kampagne, Divendo, Zweitkontakt, gleiche Domain, bestehende Firma, geschlossen) mit 422
  `lead_locked` ab; nur Admins mit `override: { reason }` (Protokoll `call.locked_override`). Neu `GET /api/calls/today`
  (eigene Anrufe/Gespräche heute, Tagesziel; das Ziel selbst ist ein persönlicher Wert im Browser, Standard 40).
- **Mock-CRM**: Kampagnen-Sperre nutzt die Admin-Einstellung `campaign.lockMonths` (vorher fest 3 Monate). **Offen für live**:
  `integrations/crm/live.ts` übergibt `lockMonths` noch nicht an `computeCampaignStatus` (Bereich live).
- **Web**: Arbeitsplatz für Sales/KI-Spezialist mit rechter Spalte «Termin & Briefing» (`GET /api/scheduling/bookings?leadId`,
  `BriefingView`) statt Coldcall-Tabs; `flushNote` wirft, wenn die Notiz nicht gespeichert ist (Push bricht ab).
- **Später** (bewusst nicht umgesetzt): «Neu bewerten» (INTENT 6.13) – die Bewertungslogik/Pipeline ist nicht Teil dieses
  Portals; Knopf + Endpoint folgen mit der Pipeline-Anbindung.
