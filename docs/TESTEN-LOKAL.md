# Lokal testen

Zwei Stufen, beide ohne Docker:

| Stufe | Was | Braucht |
|---|---|---|
| **1 · Demo** | ganzes Portal mit ~400 erfundenen Leads, alles simuliert | nichts |
| **2 · Live-CRM** | echte Leads aus Dataverse, alles andere simuliert | Entra-App «Sales-Portal Dev» + Zertifikat (liegt bereit) |

Nur eine Stufe gleichzeitig starten (beide belegen die Ports 5173 und 3000).

---

## Stufe 1 · Demo-Modus

```powershell
npm run dev
```

Oder im Claude-Browser-Pane die Konfiguration **sales-portal-dev**. Dann <http://localhost:5173> öffnen und einen Benutzer
anklicken (kein Passwort). Es wird nie gewählt, keine Mail verlässt das Portal (landet im Mock-Postausgang).

Demo-Daten zurücksetzen: Server stoppen, Ordner `apps/server/data/pglite` löschen, neu starten.

### Test-Checkliste

Punkte mit **(neu V2.3)** prüfen gezielt die Änderungen der letzten Version.

#### Vorbereitung und Anmeldung
- [ ] Portal starten und <http://localhost:5173> öffnen → Login-Seite «Als wer möchtest du arbeiten?» mit Lukas, Markus, Manuel und Nico, ohne Passwort
- [ ] Als Markus anmelden → Startseite ist «Pendenzen»; die Kopfleiste zeigt Anrufstatus «bereit», die Zähler und das Abzeichen «Demo» (Tooltip «Demo-Daten») (neu V2.3)
- [ ] Navigation von Markus prüfen → Pendenzen, Anrufliste, Anrufhistorie; kein Dashboard, keine Use Cases, kein Admin. `/dashboard` direkt aufrufen → «Keine Berechtigung für diese Seite»
- [ ] Taste «?» drücken → Übersicht der Tastaturkürzel öffnet sich (Gruppen Allgemein, Anrufliste, Anruf)

#### Coldcaller (Markus): Anrufliste
- [ ] Anrufliste öffnen → Leads nach Fälligkeit und Score sortiert, mit Score-Abzeichen, Anrufstatus, «Kontaktpause bis …» und dem Hinweis «Gute Anrufzeiten: 10 Uhr und 14–15 Uhr»
- [ ] Spalten ansehen → die Spalte «Telefon» steht direkt neben «Ansprechperson» und ist als Anruf-Knopf erkennbar (Hörer-Symbol, Akzentfarbe) (neu V2.3)
- [ ] Lead ohne Nummer oder gesperrten Lead suchen → zeigt «Nummer prüfen» bzw. eine graue Nummer mit dem Grund als Tooltip und lässt sich aus der Liste nicht anrufen (neu V2.3)
- [ ] Filter setzen (Grade, MA-Band, Branche, Erreichbarkeit), über «Filter speichern» sichern, Spalten wählen und neu laden → der gespeicherte Filter lässt sich wieder anwenden
- [ ] Kampagnen-Filter «Nur «aus Kampagne» (entsperrt)» wählen → nur Leads mit dem Abzeichen «aus Kampagne»; Markus sieht die Option «Nur gesperrte (Admin)» nicht
- [ ] Auf das Tagesziel klicken und den Wert ändern → die Anzeige «x von y Anrufen heute · n Gespräche» passt sich an
- [ ] Mit J/K oder den Pfeiltasten die Zeile wechseln, dann Enter oder O drücken → der Lead öffnet als eigene Seite, ohne Anruf (neu V2.3)

#### Coldcaller: Anruf aus der Liste
- [ ] Auf eine Telefonnummer klicken → kein Seitenwechsel. Über der Liste erscheint eine schmale Leiste (Name, Funktion, Firma, Nummer, Anrufgrund) mit «Verbunden», «Nicht erreicht» und «Abbrechen». Dazu kommt der Hinweis «Demo-Modus: Es wird nicht wirklich gewählt», und die Kopfleiste zeigt «wählt …» (neu V2.3)
- [ ] Eine Zeile markieren und Taste A drücken → gleicher Ablauf wie der Klick auf die Nummer (neu V2.3)
- [ ] «Nicht erreicht» (oder Taste X) → Hinweis «Nicht erreicht – gespeichert» mit dem nächsten Versuch. Markus bleibt in der Liste, der Lead verschwindet, der nächste Lead ist markiert, und Taste A ruft ihn an (neu V2.3)
- [ ] Im Hinweis «Rückgängig» klicken → «Rückgängig gemacht – der Anruf ist wieder offen», der Lead ist wieder in der Liste und markiert (neu V2.3)
- [ ] Denselben Lead mehrmals «Nicht erreicht» setzen (Filteroption «Nicht erreicht erst im nächsten Halbtag wieder zeigen» ausschalten) → ab dem 3. Versuch bietet der Hinweis «Mail vorbereiten» an
- [ ] In der Wählleiste «Abbrechen» → es wird nichts gespeichert, der Status geht zurück auf «bereit»
- [ ] «Verbunden» (oder Taste V) → der Arbeitsplatz öffnet als grosses Fenster über der Liste, die Kopfleiste zeigt «im Gespräch mm:ss» mit laufender Zeit (neu V2.3)
- [ ] Im Gesprächsfenster prüfen → «Vera zeichnet auf» mit Knopf «Vera ausschalten», die Erinnerung an den Transkriptions-Hinweis, der Spickzettel (Einstieg, Use Cases, Einwände), das Notizfeld mit Cursor und die Schnellknöpfe Termin · 3 Vorschläge · Mail · Rückruf · andere Person
- [ ] «Zur Liste» oder Esc → das Fenster schliesst; die Liste steht mit gleichem Filter, gleicher Position und Auswahl da. Die Leiste «Gespräch öffnen» (oder der Anrufstatus oben) holt das Gespräch zurück, und die Zeit läuft weiter (neu V2.3)
- [ ] Im Gespräch eine Notiz tippen und die Seite neu laden (F5) → das Gespräch öffnet sich wieder, die Notiz ist erhalten («Entwurf gespeichert hh:mm:ss»)

#### Coldcaller: Ergebnis und Freigabe
- [ ] «Aufgelegt» → Status «Nachbearbeitung» mit Gesprächsdauer. Ergebnisgruppe «Rückruf vereinbart» mit «Morgen 10:00» wählen → die Vorschau zeigt alt → neu (Telefonaktivität, Anrufstatus, Aufgabe)
- [ ] «Freigeben und speichern» → Hinweis «Telefonaktivität und Felder sind im CRM» mit «Rückgängig». Das Fenster schliesst, Markus ist zurück in der Liste, der nächste Lead ist markiert, der Status ist «bereit» (neu V2.3)
- [ ] Ergebnis «Intern / Konzern» oder «Zu klein» wählen → ein Grund als Beleg wird verlangt; die Vorschau zeigt die Notiz «Sales-Portal: Nicht qualifiziert – …» und den disqualifizierten Status
- [ ] Schnellknopf «andere Person» → neue Ansprechperson erfassen («Gleiche Person, neue Angaben» oder «Andere Person (neuer Lead)», Anrede offen lassen); die Angaben erscheinen in der Vorschau
- [ ] Den Lead danach öffnen → der Verlauf zeigt den neuen Anruf zuoberst, mit Ergebnis und Notiz

#### Coldcaller: Termin, 3 Vorschläge, Mail
- [ ] Im Gespräch «Termin» → der Terminplaner öffnet rechts, die Notizen bleiben sichtbar. Freie Zeiten nur 09:00–11:30 und 14:00–16:00 mit Puffer; der Schalter «Zusatzcall» tauscht Manuel gegen Lukas; das Häkchen für Vorbereitung ist vorhanden
- [ ] «Termin buchen» → «Termin gebucht – Einladung ist verschickt, Blocker sind gesetzt»; danach das Ergebnis «Termin gebucht» freigeben (Anrufstatus «Termin vereinbart» in der Vorschau)
- [ ] «3 Vorschläge» → drei Vorschläge in verschiedenen Kalenderwochen. Zeitwunsch Vormittag/Nachmittag einstellbar; «Anderer 1. Vorschlag» tauscht einen aus; der Mailtext ist bearbeitbar. «Vorschläge senden» → die Vorschau zeigt «Termin vorgeschlagen» und eine Nachfass-Aufgabe
- [ ] «Mail» → «Mail-Entwurf erstellen» (optional mit Recherche, gekennzeichnet «Demo-Recherche») → Entwurf mit 1–2 Use Cases und «Quellen der Aufhänger». Senden → «Mail gesendet – Als E-Mail-Aktivität am Lead gespeichert»

#### Coldcaller: Analysen, Anrufhistorie, Rückruf-Suche
- [ ] Nach einem Gespräch mit Vera kurz warten (das Demo-Transkript kommt nach etwa 15 Sek.) → der Zähler «Analysen zur Freigabe» steigt. Klick darauf → Zusammenfassung, Interesse, Einwände; «Analyse ergänzen» → «Anruf ergänzt», bzw. «Analyse verwerfen»
- [ ] Ein Gespräch mit «Vera ausschalten» führen → für diesen Anruf entsteht keine Analyse, es bleibt bei der Notiz
- [ ] Anrufhistorie öffnen → eigene Anrufe, neueste zuerst. Kategorie-Filter (ausgehend, Rückruf angenommen, Rückruf verpasst, unbekannte Nummer); Taste M zeigt nur verpasste Rückrufe. Einen verpassten Rückruf als erledigt markieren → der Zähler in der Kopfleiste sinkt
- [ ] Taste «/» → Rückruf-Suche. Eine Nummer in anderem Format eingeben (z. B. «061 …» oder «0041 …») → Treffer. «Rückruf annehmen» → der Lead öffnet im Anrufmodus mit «Rückruf angenommen». Eine unbekannte Nummer → «Nicht im CRM»

#### Sales (Manuel)
- [ ] Als Manuel anmelden → Navigation Pendenzen, Dashboard, Use Cases; keine Anrufliste, keine Historie; kein Anrufstatus in der Kopfleiste und nur der Zähler Pendenzen
- [ ] Pendenzen → der von Markus gebuchte Termin steht mit Status da. «Briefing öffnen» → Firma, Ansprechperson, Verlauf, Use Cases, Einstiegsfragen; bei einem Kampagnen-Termin zuoberst die erhaltenen Kampagnen-Mails. «Vorbereitung erledigt» abhaken
- [ ] Dashboard prüfen → Aktivität mit Heatmap, Ergebnisgruppen, «Wo es wirkt» (Branche, MA-Band, Grade, mit Mindestanzahl), Termine je Sales mit Zusatzcalls, freie Kapazität und Score-Check. Woche, Monat und Quartal umschalten
- [ ] Use Cases als Manuel öffnen → Katalog nur lesbar, ohne Anlegen oder Bearbeiten

#### AI-Spezialist (Nico)
- [ ] Als Nico anmelden → Pendenzen mit allen Erstgesprächen und Briefings; Dashboard und Use Cases sichtbar
- [ ] Use Cases → einen neuen Use Case anlegen (Taste N) und einen bestehenden bearbeiten; er wird gespeichert und angezeigt

#### Admin (Lukas)
- [ ] Benutzermenü › «Ansicht als» › Coldcaller → Banner «Ansicht als Coldcaller», Navigation wie bei Markus, Admin nicht erreichbar. Danach «Zurück zu meinen Rollen»
- [ ] Admin › Rollen → Markus zusätzlich die Rolle Sales geben und mit «Rückgängig» zurücknehmen; eine Person per E-Mail hinzufügen
- [ ] Admin › Ergebnisgruppen, Vorlagen, Einwände, Terminregeln und Einstellungen durchgehen. Einen Einwand-Text ändern und speichern → der neue Text erscheint im Spickzettel des Arbeitsplatzes
- [ ] Admin › Protokoll, Fehler und Verbindungen → die Freigaben von Markus stehen mit wer, wann und alt → neu; die Verbindungen zeigen Modus und Ablaufdatum
- [ ] An einem gebuchten Termin («Termine dieses Leads», Menü «Demo: so reagiert das Portal») nacheinander «Kunde lehnt ab», «Nico lehnt ab» und «In Outlook um 1 Tag verschoben» auslösen → Absage, Warnung bzw. Verschiebung erscheinen bei Markus und Manuel in den Pendenzen («Neu planen», «Absage ansehen»)
- [ ] Admin › Einstellungen › Wochenreport einen Empfänger eintragen. Dashboard › «Vorschau Wochenreport» › «Jetzt senden» → «Wochenreport gesendet»
- [ ] Anrufliste als Lukas → zusätzliche Kampagnen-Optionen «Nur gesperrte (Admin)» und «Alle (Admin)»

#### Übergreifend: Pendenzen, Kopfleiste, Designs, Sprache
- [ ] Pendenzen öffnen → Standard ist «Meine Pendenzen». Filter Art, Fälligkeit, Herkunft, Status und Person wirken; ein Filter lässt sich speichern und als Standard setzen (neu V2.3)
- [ ] Als Markus die Person «Manuel» wählen → Banner «Du siehst die Pendenzen von Manuel – nur ansehen». Lead und Briefing öffnen geht; erledigen und verschieben werden nicht angeboten (neu V2.3)
- [ ] «Ganzes Team» wählen → alle Pendenzen mit «für <Name>», gemeinsame Termine nur einmal (z. B. «für Manuel & Nico»), Banner «nur ansehen». Gleiches Ergebnis auch als Lukas (neu V2.3)
- [ ] Als Lukas die Pendenzen von Markus wählen → eine Aufgabe für Markus erledigen oder verschieben ist möglich. Der Kopfleisten-Zähler zählt weiterhin nur die eigenen Pendenzen von Lukas (neu V2.3)
- [ ] In der eigenen Liste eine Aufgabe erledigen → «Aufgabe erledigt» mit «Rückgängig». Eine Aufgabe auf ein Datum verschieben → die Fälligkeit ist angepasst
- [ ] Kopfleisten-Zähler (Pendenzen, Analysen zur Freigabe, verpasste Rückrufe) mit den Listen vergleichen → die Zahlen stimmen, und ein Klick führt zur gefilterten Liste
- [ ] Benutzermenü › Design: Standard, Kallysoft, Graphit und Sand je mit Hell, Dunkel und «Wie System» durchschalten → nur Farben, Ecken und Logo ändern sich, das Layout bleibt. Kallysoft zeigt Pill-Buttons und die Logo-Kachel «KS:», dunkel in Navy (neu V2.3)
- [ ] Beim Durchklicken auf Sprache achten → alle Texte, Hinweise, Fehlermeldungen und KI-Texte auf Deutsch (CH), mit «ss» statt «ß», ohne CRM-Codes ausser im Admin (neu V2.3)

#### Bekannte Abweichungen von INTENT V2.3
- **Design pro Person:** INTENT will die Wahl pro Person; heute wird sie pro **Browser** gespeichert. Alle Dev-Benutzer im selben Browser teilen sich das Design.
- **Microsoft-Anmeldung mit Zertifikat:** INTENT Abschnitt 8 sieht das vor; die Anmeldung kann heute nur Client-Secret (Hintergrundjobs und CRM-Zugriff können Zertifikat).

#### Nicht testbar / noch nicht umgesetzt
- Automatische Rückruf-Erkennung aus Teams-Anrufprotokollen (Flag `callbackDetection`): nicht umgesetzt, verpasste Rückrufe sind Demo-Daten
- «Neu bewerten» des Lead-Scores (Flag `rescoring`): nicht vorhanden
- Konfliktprüfung vor dem CRM-Push («CRM jetzt»): im Demo-Modus nicht gezielt auslösbar (höchstens zwei Browser am selben Lead)
- Echtes Wählen über Teams, Vera-Transkripte, Claude-Analysen/-Mails/-Briefings: im Demo-Modus simuliert bzw. Beispieltexte
- Gesendete Mails: keine Ansicht im Portal, Inhalt nur in der DB-Tabelle `mock_outbox`; im Portal steht nur die E-Mail-Aktivität im Verlauf
- Feiertage bei Arbeitstagen und Nachfass-Fristen: nicht umgesetzt
- Löschfrist der Transkripte: Einstellung vorhanden, Wirkung im Test nicht beobachtbar
- Pipeline-Bereich im Dashboard, Import-Seite, Buchungsseite für Kunden: laut INTENT später

---

## Stufe 2 · Live-CRM (echtes Dataverse)

Das Portal liest und schreibt dann echte CRM-Daten. Kalender, Mail, Telefonie, Transkripte und KI bleiben simuliert.

### Was schon vorbereitet ist

- **Zertifikat** (gültig bis 23.11.2027), ausserhalb des Projekts:
  `C:\Users\lukas.klueppel\secrets\salesportal\dev-lokal\`
  - `sales-portal-dev-lokal.cer`: öffentlicher Teil, **den** in Entra hochladen
  - `cert.pem` + `key.pem`: liest das Portal; `key.pem` ist geheim, nie weitergeben, nie ins Repo
  - SHA-1-Fingerabdruck: `610FEEDEC1707EB76E240F2500B73C3F91CF4A59` (muss in Entra so angezeigt werden)
- **`.env.live`** im Projektordner (von Git ignoriert): Konfiguration für den Live-Test, es fehlen nur noch 3 Werte.
- **Startkonfiguration** `sales-portal-live` in `.claude/launch.json`.

### Was du einrichten musst (einmalig, ca. 20 Min.)

1. **App-Registrierung anlegen**: Entra Admin Center → *Identität → Anwendungen → App-Registrierungen → Neue
   Registrierung*. Name `Sales-Portal Dev`, «Nur Konten in diesem Organisationsverzeichnis». Redirect-URI leer lassen
   (braucht es erst für die echte Microsoft-Anmeldung).
2. **Zertifikat hochladen**: in der App → *Zertifikate & Geheimnisse → Zertifikate → Zertifikat hochladen* →
   `sales-portal-dev-lokal.cer`. Fingerabdruck mit dem obigen vergleichen.
3. **API-Berechtigungen**: für Stufe 2 **keine** nötig. Dataverse erlaubt den App-Zugang über den
   Anwendungsbenutzer (Schritt 4), nicht über Entra-Berechtigungen.
4. **Anwendungsbenutzer in Dataverse**: Power Platform Admin Center → *Umgebungen →* (Sandbox, falls vorhanden) →
   *Einstellungen → Benutzer + Berechtigungen → Anwendungsbenutzer → Neuer App-Benutzer* → App `Sales-Portal Dev`
   wählen, Business Unit, **Sicherheitsrolle** zuweisen:
   - **Gegen Prod: zuerst eine Rolle «nur lesen»** (Lesen auf Lead, Kontakt, Firma, Benutzer, Telefonanruf, E-Mail,
     Termin, Aufgabe, Notiz, `kls_buchung`). Dann kann das Portal nichts kaputt machen: eine Freigabe schlägt sichtbar
     fehl statt ins CRM zu schreiben.
   - Gegen die Sandbox: die Minimalrolle aus dem README (Lesen + Schreiben auf Aktivitäten, `kls_buchung` anlegen).
5. **Drei Werte in `.env.live` eintragen**:
   - `ENTRA_TENANT_ID`: Verzeichnis-ID (Übersicht der App)
   - `ENTRA_CLIENT_ID`: Anwendungs-ID (Übersicht der App)
   - `DATAVERSE_URL`: z. B. `https://<org>.crm4.dynamics.com` (Power Platform Admin Center → Umgebung → «Umgebungs-URL»)

### Starten

Demo-Server zuerst stoppen, dann:

```powershell
node --env-file=.env.live scripts/dev.mjs
```

Oder im Browser-Pane **sales-portal-live**. Die Kopfleiste zeigt **Sandbox**. Fehlt ein Wert, startet der Server nicht und
nennt genau, was fehlt.

### Gut zu wissen

- **Wer handelt?** Mit dem Dev-Login laufen alle Aktionen als **Portal-App**, nicht als Person. Im CRM-Verlauf steht
  dann die App als Autor. Die echte Anmeldung pro Person (Microsoft-Login) ist Stufe 3 und braucht zusätzlich ein
  **Client-Secret**: Die Anmeldung im Portal unterstützt heute nur Secret, kein Zertifikat.
- **Dev-Benutzer ≠ CRM-Benutzer.** Lukas/Markus/Manuel/Nico sind Demo-Benutzer. Ansichten, die nach «meinen» Leads oder
  Besitzern filtern, können deshalb leer sein. Das ist kein Fehler des CRM-Zugangs.
- **Kein Risiko für Kunden:** Mail und Kalender sind simuliert, und `ENVIRONMENT_LABEL=Sandbox` sorgt dafür, dass Mails
  auch später nur an `MAIL_TEST_RECIPIENT` gehen, selbst gegen das Prod-CRM.
- Die Live-Daten liegen in einer eigenen lokalen Datenbank (`apps/server/data/pglite-live`), getrennt vom Demo-Modus.
- Zugang sperren: in Entra das Zertifikat löschen (oder den Anwendungsbenutzer in Dataverse deaktivieren). Ein bereits
  ausgestelltes Token gilt noch bis zu einer Stunde; danach kommt das Portal nicht mehr ins CRM.

### Vor dem ersten Live-Test prüfen (Annahmen im Code)

Siehe README «Vor dem Livegang in der Sandbox prüfen»: Felder `kls_anrufergebnis`, `kls_interesse`, `kls_transkript_link`
an `phonecall`, Tabelle `kls_buchung` und ihre Optionswerte, Kampagnen-Kennzeichnung.

---

## Docker

Das Image baut auf diesem PC fehlerfrei (`docker build` geprüft). Für den Funktionstest bringt Docker aber nichts:
Der Container läuft wie auf dem Server (`NODE_ENV=production`) und verlangt deshalb Microsoft-Anmeldung mit
Client-Secret, `https://` (TLS-Proxy davor) und Postgres. Der Dev-Login ist dort absichtlich gesperrt.

Sinnvoll als **Generalprobe vor dem Server-Deployment**, wenn Stufe 2 läuft und ein Client-Secret für die Dev-App existiert.
