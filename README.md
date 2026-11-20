# Sales-Portal

Vom CRM-Lead zum Termin – in einem Fenster. Fachliche Grundlage: [`docs/INTENT.md`](docs/INTENT.md),
technischer Vertrag: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Das Portal läuft **heute lokal ohne externe Systeme** (Demo-Modus mit ~400 erfundenen Schweizer KMU-Leads) und später
in Docker auf dem internen Server gegen Sandbox/Prod (Dataverse, Microsoft Graph, Claude, Vera).

## Schnellstart lokal

Voraussetzungen: Node.js 24, npm 11. Kein Docker, keine Datenbank nötig.

```bash
npm install
npm run dev
```

- Web: <http://localhost:5173> (Vite, leitet `/api` an den Server weiter)
- API: <http://localhost:3000> (Fastify, PGlite in `apps/server/data/pglite`, Mock-Integrationen, Dev-Login)
- Ist in der Umgebung `PORT` gesetzt (z. B. durch einen Preview-Launcher), stattdessen `node scripts/dev.mjs` verwenden: Es hält die API fix auf Port 3000 (`API_PORT` überschreibt).
- Beim ersten Start werden Demo-Daten angelegt (dauert ein paar Sekunden). Zurücksetzen: Ordner `apps/server/data` löschen.

**Dev-Login** (Karte anklicken, keine Passwörter):

| Benutzer | Rollen | Wofür |
|---|---|---|
| Lukas | Admin, Sales, AI-Spezialist, Coldcaller | alles, inkl. «Ansicht als» |
| Markus | Coldcaller | Anrufliste, Anruf, Ergebnis, Termin |
| Manuel | Sales | Termine, Briefings, Dashboard |
| Nico | AI-Spezialist | Erstgespräche, Briefings, Dashboard |

Alle E-Mail-Adressen sind Platzhalter auf `example.ch`; Firmen, Personen und Nummern sind erfunden. Im Mock-Modus
wird nie wirklich gewählt (Anrufe werden simuliert) und keine Mail verlässt das Portal (Tabelle `mock_outbox`).

### Befehle

| Befehl | Was |
|---|---|
| `npm run dev` | Server + Worker + Vite parallel (mit PGlite läuft der Job-Runner im API-Prozess, der Worker beendet sich mit Hinweis) |
| `npm run build` | Web (Vite) und Server (esbuild-Bundle nach `apps/server/dist`) bauen |
| `npm start` | gebauten Server starten; liefert auch das gebaute Web aus (`http://localhost:3000`) |
| `npm run start:worker` | gebauten Worker starten (nur mit Postgres) |
| `npm run typecheck` | TypeScript in allen Paketen |
| `npm test` | vitest (shared + server) |
| `npm run db:generate` | nach Schema-Änderung neue SQL-Migration erzeugen (`apps/server/src/db/migrations`) |

Migrationen werden beim Start automatisch angewendet (Postgres: mit Advisory-Lock, damit API und Worker nicht kollidieren).

## Betrieb mit Docker

```bash
mkdir secrets
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" > secrets/session_secret.txt
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   > secrets/token_enc_key.txt
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > secrets/db_password.txt
# Entra-Client-Secret und Claude-API-Key aus dem Passwort-Tresor:
#   secrets/entra_client_secret.txt, secrets/anthropic_api_key.txt
cp .env.example .env          # PUBLIC_URL, TRUST_PROXY, ENTRA_TENANT_ID, ENTRA_CLIENT_ID, DATAVERSE_URL … setzen
# TRUST_PROXY = Adresse des TLS-Proxy aus Sicht des Containers (Proxy auf dem Host: Gateway des Compose-Netzes,
#   docker network inspect <projekt>_internal → Gateway, z.B. 172.18.0.1)
docker compose up -d --build
```

- `app`: API + Web, Port 3000 (standardmässig nur an `127.0.0.1` gebunden – TLS-Reverse-Proxy davor, Zugang nur intern/VPN)
- `worker`: Hintergrundjobs (gleiches Image, `node apps/server/dist/worker.js`)
- `db`: Postgres 16 mit Volume `db-data`
- Container laufen als Non-root, mit read-only Root-FS (`/tmp` als tmpfs), `no-new-privileges`, ohne Capabilities.
- Healthcheck: `GET /api/health` (ohne Auth, ohne Details); Worker über eine Heartbeat-Datei.
- Geheimnisse ausschliesslich als Docker-Secrets (`*_FILE`), nie in `.env`.

Für einen Demo-Server ohne Live-Systeme: `INTEGRATIONS=mock` **und** `ALLOW_MOCK_IN_PRODUCTION=true` (sonst verweigert der Server den Start).

## Konfiguration

Alle Variablen sind in [`.env.example`](.env.example) beschrieben. Die wichtigsten:

| Variable | Bedeutung |
|---|---|
| `AUTH_MODE` | `dev` (Login-Seite mit Seed-Benutzern, **nur** mit `HOST` auf 127.0.0.1/localhost und `PUBLIC_URL` auf localhost) oder `entra` (Microsoft Entra ID, OIDC + PKCE) |
| `TRUST_PROXY` | `false` oder Adresse(n) des Reverse Proxy (IP/CIDR, z. B. `172.18.0.1`); `true` wird abgelehnt. In docker compose Pflicht |
| `BOOTSTRAP_ADMIN_EMAILS` | Anmeldenamen (UPN) von Tenant-Mitgliedern, die beim ersten Entra-Login Admin werden (oder solange kein aktiver Admin existiert) |
| `INTEGRATIONS` | `mock` oder `live`, pro Adapter überschreibbar (`CRM_ADAPTER`, `CALENDAR_ADAPTER`, `MAIL_ADAPTER`, `AI_ADAPTER`, `TRANSCRIPT_ADAPTER`, `TELEPHONY_ADAPTER`) |
| `DATABASE_URL` | Postgres; leer = PGlite (lokal) |
| `ENVIRONMENT_LABEL` | `Demo` / `Sandbox` / `Prod` – immer in der Kopfleiste sichtbar |
| `MAIL_TEST_RECIPIENT` | ausserhalb Prod gehen alle Kunden-Mails an diese Adresse |

**Der Server startet nicht**, wenn `NODE_ENV=production` und: `AUTH_MODE=dev`, Mock-Adapter ohne
`ALLOW_MOCK_IN_PRODUCTION=true`, `SESSION_SECRET` fehlt oder kürzer als 32 Bytes ist, `PUBLIC_URL` nicht `https://` ist,
`DATABASE_URL` fehlt, oder bei `AUTH_MODE=entra` Tenant/Client/Secret/`TOKEN_ENC_KEY` fehlen.

## Architektur in Kürze

```
packages/shared   Domänentypen, Optionsets (i18n), Telefonnummern, «echter Kontakt», Kampagnen-Sperre,
                  Ergebnisgruppen-Regeln (Default), Slot-/Aufgaben-Regeln (Signaturen)
apps/server       Fastify 5 + zod · drizzle (Postgres/PGlite) · Auth (Sessions, CSRF, RBAC, Entra) ·
                  Module unter /api/<modul> · Adapter (crm, calendar, mail, ai, transcripts, telephony; je mock/live) ·
                  Job-Runner (SKIP LOCKED) · Seed
apps/web          React 19 · Vite · React Router · TanStack Query · Tailwind 4 · UI-Kit · App-Shell
```

- **Module** (`apps/server/src/modules/<modul>/`, Web: `apps/web/src/pages/<modul>/`): me, leads, workspace, calls,
  changesets, pendenzen, history, scheduling, ai, dashboard, admin. Jedes Modul registriert Routen, Kopfleisten-Zähler und
  Jobs in seinem eigenen Ordner (`index.ts` mit `defineModule`).
- **Adapter**: jedes externe System hinter einem Interface (`integrations/<x>/types.ts`) mit `mock.ts` und `live.ts`.
- **Design-Tokens**: eine Datei, `apps/web/src/app/theme.css` (`--kls-*`, hell + dunkel). Echte Kallysoft-Farben dort setzen.

## Sicherheit

- Serverseitige Sessions (Cookie `sp_sid`: httpOnly, `Secure` in Prod, `SameSite=Lax`), ID nur als HMAC-Hash in der DB,
  Idle-Timeout 12 h, absolut 7 Tage, Rotation beim Login, Logout löscht serverseitig.
- CSRF: jede nicht-GET-Anfrage braucht `X-CSRF-Token` **und** Same-Origin (`Origin`/`Sec-Fetch-Site`). Kein CORS.
- RBAC: jede `/api`-Route deklariert ihre Rollen (`requireRoles(...)`); eine Route ohne Deklaration verhindert den Start.
  Öffentlich sind nur `/api/health` und `/api/auth/*`. «Ansicht als» nur für echte Admins.
- Strikte CSP (`default-src 'self'`, keine Inline-Scripts, `frame-ancestors 'none'`), HSTS in Prod, `Referrer-Policy: no-referrer`.
- Rate-Limit global (300/min) und strenger für Login (10/min) und KI-Endpunkte; angemeldet pro Benutzer gezählt, anonym pro IP
  (`TRUST_PROXY` nur mit konkreter Proxy-Adresse – sonst könnte ein Client über X-Forwarded-For eine eigene IP wählen).
- Entra-Benutzer werden über die Objekt-ID erkannt; ein vorab angelegter Benutzer wird nur über den Anmeldenamen (UPN) eines
  Tenant-Mitglieds verknüpft (nie über die Mail-Adresse, nie für Gäste).
- Entra-Tokens AES-256-GCM-verschlüsselt in der DB (für spätere On-Behalf-Of-Aufrufe), nie im Browser, nie im Log.
- Audit-Log für CRM-Änderungen und Admin-Aktionen; Logs ohne Personendaten (pino-Redaction, URLs ohne Query, fehlgeschlagene
  DB-Abfragen ohne Parameterwerte – auch in `jobs.last_error`).
- Transkripte nur in der Portal-DB mit Löschfrist (Job im Worker), KI-Ausgaben sind immer nur Vorschläge mit Freigabe.
- Keine Fremd-CDNs: Schrift (Inter) und alle Assets selbst gehostet.

## Live-Anbindung

Die Live-Adapter (`CRM_ADAPTER`, `CALENDAR_ADAPTER`, `MAIL_ADAPTER` = `live`) sprechen direkt mit der Dataverse Web API v9.2
und Microsoft Graph. Code: `apps/server/src/integrations/{crm,calendar,mail}/live.ts`, Hilfen in `apps/server/src/integrations/live/`
(Token, HTTP mit Retry, OData, Graph, Delta-Ablage). Tests ohne Netzwerk: `apps/server/test/live-*.test.ts`.

### Wer handelt wann?

| Aktion | Identität | Token |
|---|---|---|
| Benutzeraktionen (Lead lesen, Ergebnis freigeben, Aufgabe erledigen, Termin buchen, Mail senden) | **delegiert** als angemeldete Person – CRM-Verlauf und Besitzer zeigen die echte Person | aus der Portal-Session (verschlüsselte Entra-Tokens): Refresh-Token-Austausch pro Ressource; On-Behalf-Of, wenn die Session ein Token für die Portal-API hat (`ENTRA_DELEGATED_FLOW`) |
| Hintergrundjobs (Delta-Abfrage Absagen, Blocker, Briefing-Einträge/-Mails, Wochenreport, Dauer nachtragen) | **App** (Portal-App-Registrierung) | Client Credentials mit Secret oder Zertifikat |

Ohne gültige Session-Tokens antwortet die API mit 401 `reauth_required` («Bitte neu anmelden»). Mit `AUTH_MODE=dev`
(nur Entwicklung/Sandbox, in Produktion verboten) laufen auch Benutzeraktionen über die App-Identität.

### Benötigte Berechtigungen der Entra-App (zur Prüfung)

**Delegiert** (API-Berechtigungen der App-Registrierung, Administratorzustimmung erteilen):

| API | Berechtigung | Wofür |
|---|---|---|
| Microsoft Graph | `openid`, `profile`, `email`, `offline_access` | Anmeldung, Refresh-Token für die delegierten Zugriffe |
| Microsoft Graph | `User.Read` | Profil der angemeldeten Person |
| Microsoft Graph | `Calendars.ReadWrite.Shared` | Frei/Belegt (`getSchedule`), Termin im Kalender des Sales über Markus' Stellvertretung anlegen/ändern/löschen |
| Microsoft Graph | `Mail.Send` | Use-Case-Mail und 3 Vorschläge aus dem **eigenen** Postfach (Senden als jemand anderes verweigert das Portal) |
| Dynamics CRM (Dataverse) | `user_impersonation` | alle CRM-Zugriffe als angemeldete Person (Rechte = ihre Sicherheitsrollen im CRM) |

Nur bei `ENTRA_DELEGATED_FLOW=obo`: unter «Eine API verfügbar machen» den Bereich `api://<client-id>/access_as_user` anlegen
und in `ENTRA_SCOPES` statt `User.Read` anfordern.

**Anwendung** (App-only, nur für Hintergrundjobs):

| API | Berechtigung | Wofür | Einschränkung |
|---|---|---|---|
| Microsoft Graph | `Calendars.ReadWrite` | Delta-Abfrage (Absagen/Verschiebungen), Blocker und Briefing-Einträge in den Kalendern von Sales und Nico | **RBAC for Applications** auf die Portal-Postfächer (siehe unten) |
| Microsoft Graph | `Mail.Send` | Briefing-Mail, Wochenreport aus `GRAPH_APP_MAIL_SENDER` | **RBAC for Applications** |
| Dataverse | – (keine API-Berechtigung) | Hintergrund-Updates im CRM (Dauer an der Telefonaktivität, Buchungen) | **Anwendungsbenutzer** in der Dataverse-Umgebung (Power Platform Admin Center → Umgebung → Einstellungen → Anwendungsbenutzer) mit eigener, minimaler Sicherheitsrolle |
| Microsoft Graph | `CallRecords.Read.All` | **erst später**, Rückruf-Erkennung (INTENT 6.18, Feature `callbackDetection`) – heute nicht verwendet | gilt für die ganze Firma, Portal verwirft alles ausser Markus' Anrufe |

Minimal-Sicherheitsrolle des Dataverse-Anwendungsbenutzers: Lesen Lead/Kontakt/Firma/Benutzer (Organisation), Lesen + Schreiben
Telefonanruf/E-Mail/Termin/Aufgabe/Notiz (Organisation), Lesen + Schreiben + Anlegen `kls_buchung`. Kein Löschen, kein Zuweisen
an andere Teams, keine Anpassungsrechte.

Zusätzlich für die Termin-Buchung (delegiert): Markus braucht im Exchange **Stellvertretung/Bearbeiten** auf den Kalendern von
Manuel und Lukas (Organisator ist der Sales), Nico und der Sales Leserechte für Frei/Belegt.

### Empfohlene Postfach-Einschränkung (RBAC for Applications)

Die Graph-Anwendungsrechte gelten ohne Einschränkung für **alle** Postfächer der Firma. Deshalb die Rechte nicht in Entra
tenantweit zustimmen, sondern in Exchange Online auf eine Gruppe beschränken (Rechte aus Entra und aus RBAC addieren sich –
eine tenantweite Zustimmung in Entra hebt die Einschränkung auf):

```powershell
Connect-ExchangeOnline
# Dienstprinzipal der Portal-App in Exchange bekannt machen (Objekt-ID aus «Unternehmensanwendungen»)
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Sales-Portal"
# Gruppe der Postfächer, die das Portal im Hintergrund nutzen darf
New-DistributionGroup -Name "SalesPortal-Postfaecher" -Type Security -Members manuel@…,nico@…,lukas@…,markus@…,sales@…
New-ManagementScope -Name "SalesPortal-Postfaecher" -RecipientRestrictionFilter "MemberOfGroup -eq '<DistinguishedName der Gruppe>'"
New-ManagementRoleAssignment -App <client-id> -Role "Application Calendars.ReadWrite" -CustomResourceScope "SalesPortal-Postfaecher"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "SalesPortal-Postfaecher"
# Prüfen: InScope = True nur für die Gruppe
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource manuel@…
```

Das Portal erzwingt dieselbe Liste zusätzlich selbst: `GRAPH_ALLOWED_MAILBOXES` (Komma-getrennt). Ohne diese Liste verweigert
es jeden App-Zugriff auf Postfächer; delegiert sind nur Postfächer der Liste erlaubt (die Liste muss also alle Portal-Benutzer
enthalten, die Mails senden oder Termine buchen).

### Einstellungen

| Variable | Bedeutung |
|---|---|
| `DATAVERSE_URL` | `https://<org>.crm4.dynamics.com` (ohne Pfad) – Pflicht bei `CRM_ADAPTER=live` |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | Pflicht, sobald ein Microsoft-Adapter `live` ist (auch mit `AUTH_MODE=dev`) |
| `ENTRA_CLIENT_SECRET_FILE` **oder** `ENTRA_CLIENT_CERT_FILE` + `ENTRA_CLIENT_KEY_FILE` | App-Zugang; Zertifikat empfohlen (PEM, nur als Docker-Secret) |
| `ENTRA_DELEGATED_FLOW` | `auto` (Standard) · `refresh_token` · `obo` |
| `GRAPH_ALLOWED_MAILBOXES` | erlaubte Postfächer (siehe oben) |
| `GRAPH_APP_MAIL_SENDER` | Absender für Hintergrund-Mails, muss in der Liste stehen |
| `GRAPH_DELTA_PAST_DAYS` / `GRAPH_DELTA_FUTURE_DAYS` | Zeitfenster der Delta-Abfrage (Standard 7 / 180 Tage, Fenster wird alle 7 Tage neu gestartet) |
| `DATAVERSE_CAMPAIGN_SENDER_IDS` | systemuser-IDs, deren E-Mail-Aktivitäten Kampagnen-Mails sind (Lemlist-Flow) |
| `DATAVERSE_BOOKING_ENTITY_SET` | Entitätsmenge der Buchungstabelle (Standard `kls_buchungs`) |
| `LIVE_HTTP_TIMEOUT_MS` | Timeout pro Anfrage (Standard 30 s) |

Fehlt eine Einstellung eines Adapters, der auf `live` steht, verweigert der Server den Start mit einer klaren Meldung.

### Verhalten

- **Dataverse**: OData mit `$select/$filter/$orderby/$top`, Paging über `@odata.nextLink` (nur auf denselben Host),
  formatierte Werte über `Prefer: odata.include-annotations`. Alle Werte in Filtern werden escaped, IDs als GUID geprüft.
- **Freigabe-Push** (`applyChangeSet`): Notiz → Felder → Aktivitäten → Aufgaben → neue Leads → Status, mit Ergebnis pro Operation.
  Die Felder aller Datensätze gehen als **ein atomarer `$batch`-Changeset** mit `If-Match`-ETag; unmittelbar davor liest das
  Portal die Felder neu und vergleicht sie mit dem Entwurf (Konflikt pro Feld, «überschreiben»/«CRM-Wert behalten» wird
  respektiert). ETag-Konflikt (412) → alle Feldänderungen «Konflikt». Schlägt ein Schritt fehl, wird der Status **nicht**
  geändert (nie disqualifizieren ohne Notiz). Abgeschlossene Aktivitäten werden zum Ändern kurz geöffnet und wieder abgeschlossen.
- **Rückruf-Suche**: Serverfilter auf die üblichen Schreibweisen der Nummer (+41 61 …, 061 …, 0041…) plus die letzten vier
  Ziffern, danach exakte Prüfung im Portal mit der einheitlichen Normalisierung.
- **Graph**: Zeiten in UTC (`Prefer: outlook.timezone="UTC"`), Termine mit Kategorie, Teams-Meeting und Termin-ID als
  erweiterte Eigenschaft (`String {6b1d3c84-2f0e-4a55-9a7e-0c5f1d2b8e73} Name KlsTerminId`, dazu `… Name KlsRolle` für
  Blocker/Briefing-Einträge), idempotentes Anlegen über `transactionId`. Delta über `calendarView/delta`; das Token (deltaLink +
  Fensterbeginn) liegt pro Postfach in `sync_state` (`calendar.delta:<postfach>`, Job des scheduling-Moduls bzw.
  `syncCalendarDelta`). Das Zeitfenster wird alle 7 Tage neu gestartet; abgelaufener Delta-Stand (410) → vollständiger Neuabgleich.
- **Mail**: delegiert `POST /me/sendMail`, App `POST /users/{absender}/sendMail`; ausserhalb Prod immer an
  `MAIL_TEST_RECIPIENT` (ohne diese Adresse wird nichts gesendet).
- **Robustheit**: Retry mit exponentiellem Backoff bei 429/503/504 unter Beachtung von `Retry-After`; nicht-idempotente
  Anfragen (Anlegen, Mail senden) nur bei 429. Tokens im Speicher mit Ablauf (5 Min. Puffer), nie im Log; Logs enthalten nur
  Pfade ohne Query, IDs und Postfächer maskiert.

### Vor dem Livegang in der Sandbox prüfen (Annahmen)

- Felder der FixCRMSolution an `phonecall`: `kls_anrufergebnis`, `kls_interesse`, `kls_transkript_link`.
- Tabelle `kls_buchung`: Entitätsmenge und Spalten (`kls_terminid`, `kls_icaluid`, `kls_eventid`, `kls_start`, `kls_end`,
  `kls_status`, `kls_herkunft`, `kls_blockerids`, Lookup `kls_lead`) sowie Optionswerte (`BOOKING_STATUS_CODES`/`BOOKING_ORIGIN_CODES`
  in `crm/live.ts`).
- Aufgabentyp wird in `task.category` geschrieben (`follow_up`, `callback`, `research`, `other`).
- «Bestehende Firma im CRM» = Firma mit `customertypecode` 3 (Kunde).
- Kampagnen-Mitgliedschaft = `kls_lead_support` «Automatisierte Kampagne» (Code in `i18n.ts` als Annahme markiert);
  Kampagnen-Mails = E-Mail-Aktivitäten der `DATAVERSE_CAMPAIGN_SENDER_IDS`. Use Cases und Reaktionen (Lemlist) sind nicht im CRM.
- Telefonat-Dauer im CRM in Minuten (`actualdurationminutes`); die genaue Dauer ergibt sich aus Beginn/Ende.
- Qualifizieren eines Leads (`statecode` 1) braucht die Aktion `QualifyLead` und ist nicht umgesetzt; Disqualifizieren geht per Status.
