# Intent: Sales-Portal (vom CRM-Lead zum Termin) – Version 2

Stand 20.11.2026 (V2.2) · Grundlage: Intent «Sales-Portal (vom Lead zum Termin)» vom 07.11.2026 (Nico), Lukas' Vorgaben vom 17.11.2026, Ergänzungen und Review vom 20.11.2026.
Dieses Dokument beschreibt das **Was und Warum**. Framework und Code entscheidet die Entwicklung. Basis ist das bestehende Portal
(Abschnitt 9), das auf diesen Intent angepasst wird.

---

## 0. Was sich gegenüber Version 1 ändert

| Thema | Version 1 (07.11.) | Version 2 (17.11.) |
|---|---|---|
| Datenquelle | Excel-Upload im Portal, Anreicherung über Apollo im Portal | **Das Portal liest nur aus dem CRM.** Die Excel-Liste wird vorher nach ICP vorbereitet, angereichert und ins CRM importiert (Vorstufe, Abschnitt 4.1) |
| Scoring | Portal scort selbst | Portal **zeigt** den bestehenden Lead-Score (`kls_leadscore`, Grade A–D, `kls_ki_bewertung`) an, filtert und sortiert danach. Keine zweite Bewertungslogik |
| Anruf | Vera transkribiert, Ergebnis wird bewertet | Zusätzlich: Anruf **aus dem Portal über Teams**, Telefonaktivität mit Zeitstempel und Vera-Infos, KI erkennt das Interesse, Markus wählt das Ergebnis per Klick |
| Terminieren | eigener Schritt | **Neben dem laufenden Anruf** öffnen, Notizen und Übersicht bleiben sichtbar |
| Ansprechperson | – | Mail an die Adresse des angerufenen Leads **oder** an eine andere Person; die neue Person aktualisiert danach den Datensatz |
| Kein Termin | Mail-Entwurf aus Sicht Markus | Mail mit passendem Use Case, auf Wunsch mit kleiner Recherche generiert |
| Kein Interesse | offen | **Ergebnisgruppen zum Anklicken**, jede setzt definierte Felder (Abschnitt 6.5) |
| Freigabe | Markus validiert | Markus gibt **jede** Änderung vor dem CRM-Push frei (Vorschau alt → neu) |
| Briefing | Use Case aus Sicht des Sales | bleibt, als Briefing pro Termin für Sales und Nico |
| Rollen | nicht in V1 | **Rollen ab Start**: Coldcaller, Sales, AI-Spezialist, Admin. Lukas hat alle Rollen; Admin ändert Rollen im Portal |
| Dashboard | nicht in V1 | **Dashboard mit Zahlen** (nicht für die Rolle Coldcaller), Abschnitt 6.12 |
| Design | – | modern, Webapplikation, für grosse Bildschirme optimiert |

**Ergänzungen V2.1 (20.11.2026):**

| Thema | Neu | Abschnitt |
|---|---|---|
| Bedienung | klares, modernes Setup; Gesprächsinfos erst, wenn jemand abnimmt (Anrufmodus), vorher nur das Nötigste | 6.0, 6.2 |
| «Heute» | Arbeitsreihenfolge: was Markus heute noch anrufen oder abschliessen muss | 6.15 |
| Anruf-Backlog | Protokoll, wen Markus wann angerufen hat; Rückrufe von Kunden werden erkannt und zugeordnet | 6.18 |
| Telefonnummern | ein einheitliches Format (+41 …) für Wählen und Rückruf-Erkennung | 6.19 |
| Automatisierte Kampagne | Kampagnen-Leads erst nach 3 Monaten ohne Aktivität in der Anrufliste (bisher 60 Tage), deutlich markiert | 4.1, 5, 6.1 |
| Pendenzen | eigene Seite für Aufgaben, Rückrufe, Termine, Briefings und Absagen, mit Filtern, für alle Rollen | 6.16 |
| Termin aus Kampagne | Arbeitsplatz und Briefing zeigen, welche Kampagnen-Mails der Kunde von wem erhalten hat und welche Use Cases darin gepusht wurden | 6.10, 6.17 |

**Ergänzungen V2.2 (20.11.2026, nach Review):**

| Thema | Neu | Abschnitt |
|---|---|---|
| Nachbearbeitung | zwei Stufen: Ergebnis sofort freigeben, KI-Analyse kommt später in «Analysen zur Freigabe»; Markus wartet nie auf Vera | 6.2, 6.4, 6.9, 6.16 |
| «Heute» | keine Warteschlange mehr; Fälliges zeigen Pendenzen und Anrufliste | 4.2, 6.15, 6.16 |
| Rückrufe | Anrufhistorie mit Kategorien und Rückruf-Suche; automatische Erkennung nur für Rückrufe, als separater Baustein | 6.15, 6.18 |
| Gesprächsdauer | aus Vera, ohne Vera aus den Klicks «Verbunden»/«Aufgelegt» | 6.3 |
| Absagen | Delta-Abfrage statt Benachrichtigungen (Zugang nur intern); klare Regel, was eine Absage ist | 6.11 |
| CRM-Push | Konfliktprüfung: was seit dem Entwurf im CRM geändert wurde, wird angezeigt statt überschrieben | 6.9 |
| Echter Kontakt | eine Definition für «Letzter Kontakt» und die Aufgaben-Regeln | 5 |
| Etappen | Etappe 1 in 1a (Coldcall) und 1b (Übersicht) geteilt; Rückruf-Erkennung separat | 10 |

---

## 1. Ziel

Markus arbeitet den ganzen Coldcall in **einem** Fenster ab: Lead auswählen, anrufen, Ergebnis festhalten, Termin buchen oder Mail
schicken. Das CRM ist danach immer vollständig und richtig, ohne dass Markus zwischen CRM, Teams-Dialer, Terminplaner-App, Outlook
und Notizen wechselt. Sales und Nico bekommen ein Briefing pro Termin, Lukas sieht in Zahlen, was funktioniert.

Das Portal ist erfolgreich, wenn:

- jeder Anruf als **Telefonaktivität** mit Zeitstempel, Dauer, Ergebnis und Notiz im CRM steht, auch ohne Termin
- Markus, sobald jemand abnimmt, alles sieht, was er fürs Gespräch braucht (Personen der Firma, Verlauf, Score, Einstieg, Use Cases);
  vorher und bei «Nicht erreicht» nur das Nötigste
- Markus bei jedem Rückruf sofort weiss, wer anruft und warum er diese Person angerufen hatte
- ein Termin mit Nico und einem Sales während des Gesprächs in wenigen Klicks gebucht ist, inklusive Teams-Einladung und Blocker
- jede CRM-Änderung von Markus freigegeben wurde und im Portal nachvollziehbar ist (wer, wann, alt → neu)
- Lukas pro Branche, Grösse, Grade und Uhrzeit sieht, wo Termine entstehen und wo Absagen
- Markus ohne Schulung versteht, was er gerade tun muss: welcher Anruf als Nächstes kommt, ob ein Anruf läuft, was noch offen ist
- Sales und Nico bei Terminen aus einer Kampagne wissen, welche Mails und Use Cases der Kunde schon bekommen hat

---

## 2. Ist-Prozess heute (Stand 17.11.2026)

| Schritt | Wo heute | Medienbruch / Handarbeit |
|---|---|---|
| Liste aufbauen | Excel, Zefix, Apollo, Pipeline `lead-pruefung/` (Bereinigung, KI-Bewertung, Score V4), Import über «Leads Import v2» bzw. Skripte | läuft getrennt vom Anrufen, Freigaben über das Claude-Dashboard |
| Anrufliste | CRM-Ansicht «Anrufliste nach Lead-Score» (ohne Divendo, ohne «Termin vereinbart») | wenig Filter, Firmenkontext (weitere Personen) nur über die Webressource im Formular |
| Anruf | Teams-Dialer im Vertriebshub | erzeugt «Anrufen …» ohne Ergebnis; fiel 22.–26.10. aus, ohne dass es jemand merkte; Notiz «User notes» meist leer |
| Ergebnis | Anrufstatus, Bewertungskategorie, Notiz am Lead von Hand | nur der **letzte** Stand bleibt, kein Verlauf je Anruf → keine Auswertung je Anruf möglich (CRM-Analyse M5) |
| Termin | Canvas-App «Terminplaner» (Flows «Terminplanung Sales/Buchen») | eigene App, Lead muss dort neu gesucht werden; Freigabelimit in Prod (nur 2 Personen) |
| 3 Terminvorschläge | Terminplaner, Text in die Zwischenablage | Mail von Hand in Outlook, Anrufstatus «Termin vorgeschlagen» von Hand |
| Blocker, Absagen | Blocker-Flows Manuel/Nico (Betreff «Vorstellung der Kallysoft»), Absage-Wächter Manuel, Wochenreport | Erkennung über den Betreff; hängen an Lukas' Verbindungen |
| Nachfassen | Aufgaben (Regeln `REGEL_AUFGABEN.md`), Lemlist-Kampagnen | Aufgaben teils aus Skripten, teils von Hand |
| Offerte, Verkaufschance | Flow «Offerte an CRM» (BCC an offerten_crm@) | funktioniert, ausserhalb des Portals |

**Zahlen aus dem Prod-Abzug vom 15.11.2026** (nur lesend, aggregiert):

- 12'014 offene Leads: 8'232 Neu, 1'953 Kontaktiert, 1'265 Zweitkontakt, 564 Austausch. Davon 1'559 in der automatisierten Kampagne (gesperrt).
- Grade der offenen Leads: A 407 · B 1'028 · C 2'006 · D 2'736 · ohne Bewertung 5'837.
- Anrufe 2026 mit Lead-Bezug: 1'472. Die meisten um 10–11 und 14–16 Uhr; über die Mittagszeit (12–13 Uhr) fast keine.
  Gespräche ab 4 Min. am häufigsten um **10 Uhr und 14–15 Uhr**. Dienstag ist der stärkste Tag.
- 700 Leads mit Anrufstatus, Anteil «Termin vereinbart/vorgeschlagen»: nach Grösse 50–249 MA **23 %**, 20–49 MA 16 %, 10–19 MA 10 %,
  1–4 MA 0 %. Nach Grade A 31 %, B 14 %, C 2 %, D 0 % (kleine Zahlen). Nach Branche z. B. Elektro/Elektronik-Fertigung 38 %,
  Bau 19 % (54 % Absage), Maschinenbau 12 % (52 % Absage), Grosshandel 8 %, Chemie 7 % (57 % Absage). Bei 224 dieser Leads fehlt die Branche.
- Vorsicht: Das ist nur der **aktuelle** Anrufstatus, nicht das Ergebnis je Anruf. Genau das soll das Portal ändern (Abschnitt 8).

---

## 3. Rollen

| Rolle | Wer | Sieht / darf |
|---|---|---|
| Coldcaller | Markus | Anrufliste, Lead-Arbeitsplatz, Anruf, Ergebnis, Termin buchen, 3 Vorschläge, Mail, Freigabe CRM-Push, Anrufhistorie mit Rückruf-Suche, eigene Pendenzen (inkl. Analysen zur Freigabe). **Kein** Dashboard |
| Sales | Manuel, Lukas | Pendenzen-Seite (eigene Termine, Briefings, Absagen/Verschiebungen, Nachfass-Aufgaben), Dashboard |
| AI-Spezialist | Nico | Pendenzen-Seite (alle Erstgespräche, Briefings, Vorbereitungen), Use Cases, Dashboard |
| Admin | Lukas | Rollen vergeben und ändern, Ergebnisgruppen und Feld-Zuordnung pflegen, Vorlagen (Betreff, Einladung, Mails), Terminregeln, Protokoll, Fehler |

- Lukas hat **alle Rollen** (zum Testen) und kann im Portal eine Rolle «ansehen als» wählen, ohne die Rolle zu wechseln.
- Anmeldung über Microsoft Entra ID (SSO, bestehende Konten). Rollen liegen im Portal, nicht im CRM.

---

## 4. Soll-Prozess end-to-end

```
VORSTUFE (ausserhalb des Portals)
  Excel nach ICP vorbereiten → Anreichern (Zefix, Website, Apollo nur als letzte Quelle, KI-Bewertung, Score V4)
  → Abgleich mit dem CRM über Domain (Gleiche Domain in Bearbeitung, bestehende Firma) → Import ins CRM (Leadursprung Zefix)
                                   │
PORTAL                             ▼
  1 Pendenzen/Liste  fällige Pendenzen (6.16), dann Anrufliste mit Filtern (6.1), Tagesziel
  2 Lead-Arbeitsplatz  Firma, alle Personen der Firma, Verlauf, Score + Einstieg + Use Cases, offene Aufgaben
  3 Anruf           Klick → Teams-Anruf; Portal startet Telefonaktivität; volle Infos erst bei «Verbunden»
  4 Gespräch        Markus notiert; bei Bedarf Terminplaner als Seitenfenster (Notizen bleiben sichtbar)
  5 Ergebnis        nach «Aufgelegt»: Markus klickt die Ergebnisgruppe (Termin / 3 Vorschläge / Mail / Rückruf / kein Interesse … )
  6 Folgeaktion     Termin buchen · Vorschläge senden · Mail generieren · Aufgabe · neue Ansprechperson
  7 Freigabe        Vorschau aller CRM-Änderungen (alt → neu), Markus gibt frei → CRM-Push → Protokoll → nächster Lead
  8 Später          Vera-Transkript → KI-Analyse → «Analysen zur Freigabe» → Markus ergänzt die Telefonaktivität
                                   │
NACH DEM TERMIN-BUCHEN             ▼
  Blocker setzen · Briefing an Sales + Nico · Absagen/Verschiebungen erkennen → Blocker anpassen, Markus/Sales informieren
  Nach dem Erstgespräch: Gesprächsnotiz (heute automatisch), Offerte → Flow «Offerte an CRM» (bleibt ausserhalb)
```

### 4.1 Vorstufe: Liste nach ICP, Anreicherung, Import (nicht Teil des Portals)

- Die Logik ist die bestehende: ICP und Score nach `scoring-regeln/README.md`, Pflichtfelder Firmenname und Website.
- Vor dem Import Abgleich über **Domain und Firmenname** mit Leads, Firmen und Kontakten (inkl. Divendo, automatisierte Kampagne,
  «Nicht mehr kontaktieren»). Treffer werden nicht neu angelegt, sondern angereichert oder ausgelassen.
- **Leads aus der automatisierten Kampagne** vorsichtig behandeln: Sie kommen erst in die Anrufliste, wenn 3 Monate keine Aktivität
  mehr war (Abschnitt 5). Tauchen sie in einer neuen Liste wieder auf, bleiben sie bis dahin gesperrt.
- Neue Leads: Leadursprung Zefix, Branche (`kls_industry`), Eigene Kategorie, Mitarbeitende Schweiz, Anrede (`kls_salutation`, nur > 90 %),
  Score und KI-Bewertung, Hauptkontakt pro Firma (max. 2 Leads pro Firma).
- Später kann das Portal dafür eine Seite «Import» bekommen (Admin). Nicht in den ersten Etappen.

### 4.2 Tagesablauf

**Markus (Coldcaller)**
1. Öffnet das Portal: Die Pendenzen (6.16) zeigen Unabgeschlossenes, fällige Rückrufe und Aufgaben, die Anrufhistorie (6.15) verpasste Rückrufe. Danach arbeitet er die Anrufliste nach seinem gespeicherten Filter ab (z. B. Grade A/B, 20–249 MA, Bau ausgenommen).
2. Wählt einen Lead und klickt «Anrufen». Beim Wählen sieht er nur Name, Firma, Nummer und Anrufgrund. Nimmt jemand ab, klickt er
   «Verbunden» und hat alle Infos vor sich; nimmt niemand ab, ein Klick «Nicht erreicht» und weiter zum nächsten Lead.
3. Während des Gesprächs: Das Portal ist im Anrufmodus (6.2); Notizen, bei Interesse Terminplaner im Seitenfenster, Slot wählen, Teilnehmende ergänzen.
4. Nach dem Gespräch: Ergebnisgruppe klicken, Vorschau prüfen, freigeben. Nächster Lead. Die KI-Analysen prüft er später gesammelt (6.4).

**Manuel / Lukas (Sales) und Nico (AI-Spezialist)**
- Arbeiten mit der Pendenzen-Seite (6.16): gebuchte Erstgespräche mit Briefing (bei Kampagnen-Terminen inkl. erhaltener Mails und Use Cases), Absagen und Verschiebungen, offene Nachfass-Aufgaben.
- Nach dem Termin: Gesprächsnotiz kommt automatisch ins CRM; Offerte wie heute per BCC an offerten_crm@.

**Lukas (Admin)**
- Dashboard (Zahlen der Woche), Rollen, Vorlagen, Ergebnisgruppen, Protokoll und Fehler (z. B. abgelaufene Verbindung, fehlgeschlagener CRM-Push).

---

## 5. Leitplanken (gelten im ganzen Portal)

- **Anrufstatus und Bewertungskategorie** setzt Markus im Portal (Entscheid Lukas 17.11.2026: Markus arbeitet nur noch dort).
  Bucht er einen Termin, setzt das Portal «Termin vereinbart» mit der Buchung. Rückrufe plant er direkt im Portal (Datum wählen
  → Anrufstatus + Aufgabe). Die KI schlägt nur vor; ohne Markus' Klick setzt das Portal keinen Anrufstatus und kein Rating.
  Rating allein ist keine Absage (`REGEL_AUFGABEN.md`).
- **Keine Änderung ohne Freigabe**: Jeder CRM-Push zeigt vorher alt → neu. Ausnahmen: reine Hintergrundaufgaben ohne Lead-Felder
  (Blocker setzen, Absagen erkennen, Gesprächsdauer nachtragen) und der Klick «Nicht erreicht», der selbst als Freigabe gilt (6.2).
- **ICP immer aus einer Quelle**: Das Portal hat keine eigene ICP-Liste, es übernimmt den jeweils gültigen Stand aus `scoring-regeln/`
  bzw. der Pipeline. Beispiel: Am 17.11.2026 wurde die öffentliche Hand in Prod wieder geöffnet. `scoring-regeln/README.md`,
  `lead_pruefung.py` und `CLAUDE.md` schliessen sie noch aus und müssen nachgeführt werden (Lead-Bereinigung).
- **Gleiche Score-Logik**: kein eigenes Scoring im Portal. Neu bewerten nur auf Wunsch, dann überschreiben (Abschnitt 1 der Scoring-Regeln).
- **Notizen** des Portals beginnen mit «Sales-Portal:» und zählen nicht als echte Aktivität (wie die Pipeline-Notizen).
- **Echter Kontakt** (eine Definition für «Letzter Kontakt» und die Aufgaben-Regeln): Anruf, bei dem jemand erreicht wurde
  (`kls_anrufergebnis` ausser «Nicht erreicht» und «Falsche Nummer»), Notiz mit Text, gesendete Mail, Termin. Für ältere Anrufe ohne
  Ergebnis gilt wie bisher «Anruf ≥ 4 Min.». `scoring-regeln/` und `REGEL_AUFGABEN.md` werden nachgeführt (offene Frage 12).
- **Gesperrt / ausgeblendet** in der Anrufliste: automatisierte Kampagne (bis 3 Monate ohne Aktivität, siehe unten), Divendo-Coldcall, Zweitkontakt, geschlossene Leads,
  «Nicht mehr kontaktieren», «Gleiche Domain in Bearbeitung», bestehende Firma im CRM (Besitzer informieren).
- **Automatisierte Kampagne vorsichtig behandeln** (Entscheid Lukas 20.11.2026): Ein Kampagnen-Lead erscheint erst in der Anrufliste,
  wenn **3 Monate keine Aktivität** war (bisher 60 Tage). Vorschlag, was als Aktivität zählt: versendete Kampagnen-Mail, Klick,
  Antwort, Anruf, Notiz mit Text, Termin; Öffnungen allein nicht, weil sie unzuverlässig gemessen werden (offene Frage 5).
  Danach trägt der Lead das Abzeichen «aus Kampagne», und Markus sieht die erhaltenen Mails mit Use Cases (6.17).
- **Aufgaben** nur nach `REGEL_AUFGABEN.md` (neueste Info gewinnt, keine doppelte Aufgabe pro Firma, max. 3 pro Person und Tag).
- **Keine Mails an Kunden ohne Klick** von Markus bzw. dem Sales. Tests nur mit Testadressen.

---

## 6. Funktionen im Detail

### 6.0 Bedienung und Design (gilt für alle Seiten)

Das Portal muss sich ohne Schulung erschliessen. Markus soll nie suchen müssen, was als Nächstes zu tun ist.

- **Ein klarer nächster Schritt:** Jede Seite hat eine hervorgehobene Hauptaktion («Anrufen», «Ergebnis wählen», «Freigeben»); alles andere tritt zurück.
- **Ruhiges, modernes Layout:** viel Weissraum, eine Schrift, Kallysoft-Farben sparsam; Farbe nur dort, wo sie etwas bedeutet (Grade, Status, Warnung). Keine CRM-Formulare nachbauen.
- **Status immer oben sichtbar:** feste Kopfleiste mit Anrufstatus (bereit · wählt · im Gespräch mm:ss · Nachbearbeitung), Zähler für offene Pendenzen, Analysen zur Freigabe und verpasste Rückrufe, Umgebung Sandbox/Prod.
- **Alltagssprache statt CRM-Sprache:** Begriffe so, wie Markus sie verwendet («Rückruf», «kein Bedarf»); Codes wie 845140006 sieht nur der Admin.
- **Schnell:** nächster Lead und Seitenwechsel ohne spürbare Wartezeit, Daten im Hintergrund vorladen.
- **Nichts geht verloren:** Notizen speichern laufend als Entwurf, auch bei Fehler oder geschlossenem Fenster; «Rückgängig» statt vieler Sicherheitsabfragen.
- **Tastatur:** Kürzel für die häufigsten Aktionen, Übersicht mit «?».
- **Leere Zustände erklären den nächsten Schritt** («Keine fälligen Pendenzen – weiter mit der Anrufliste»).
- **Abnahme mit Markus:** ein Testtag in der Sandbox; jede Stelle, an der er zögert oder sucht, wird vor dem Livegang bereinigt.

### 6.1 Anrufliste und Filter

Gespeicherte Filter pro Person, Sortierung frei, Spalten wählbar. Vorschläge aus den vorhandenen Daten:

| Filter | Feld / Quelle | Warum |
|---|---|---|
| Grade / Score | `kls_leadscore` (A ≥ 70, B ≥ 50, C ≥ 30) | Grade A hat die höchste Terminquote |
| Mitarbeitende (Bänder) | `numberofemployees`: 5–9 · 10–19 · 20–49 · 50–249 · 250–999 · 1'000+ · unbekannt | 50–249 MA klar am besten, unter 5 MA kein Termin |
| Branche | `kls_industry` (147 Werte) | starke Unterschiede (z. B. Bau, Maschinenbau, Chemie viele Absagen) |
| Eigene Kategorie | `kls_custom_industry` (76 Werte) | feiner als die Branche, Kernbranchen |
| Organisationstyp | privat · öffentliche Hand · Verein/Stiftung (Rechtsform, KI-Feld `organisation`) | öffentliche Hand ist seit 17.11.2026 wieder Zielkunde, gleicher Ablauf wie privat (KI-Aufträge liegen unter der Ausschreibungsgrenze, Entscheid Lukas); Filter nur zur Auswahl und Auswertung |
| Region | PLZ-Bereich / Kanton (`address1_postalcode`, `address1_stateorprovince`) | Touren, Sprache, Auswertung |
| Fälligkeit | offene Aufgabe / Wiedervorlage, Anrufstatus Rückruf, nächster Versuch nach «Nicht erreicht» (nicht im selben Halbtag) | Rückrufe zuerst; ersetzt die frühere Warteschlange «Heute» |
| Anrufstatus | `kls_callstatus` | z. B. nur «Nicht erreicht» nochmals |
| Bewertung Sales | `kls_rating_category` | z. B. «Später wieder melden» |
| Statusgrund | Neu, Kontaktiert, Austausch | |
| Letzter Kontakt | jüngster echter Kontakt (Abschnitt 5) | Kontaktpause sichtbar machen |
| Thema / Quelle | `subject`, `leadsourcecode`, `kls_lead_support` | Kampagnen, Divendo, BC/NAV-Research |
| Kampagne | Kampagnen-Zugehörigkeit, letzte Kampagnen-Aktivität | gesperrt bis 3 Monate ohne Aktivität (Abschnitt 5), danach filterbar, Abzeichen «aus Kampagne» |
| Rolle der Ansprechperson | aus `jobtitle` (GL, IT, Finanzen/Betrieb …) | Entscheider zuerst |
| Erreichbarkeit | Telefon / Mobil vorhanden, E-Mail geprüft | ohne Nummer nicht in die Tagesliste |
| Besitzer | `ownerid` | Markus' Leads vs. andere |

Sobald das Dashboard genug Daten hat, zeigt die Anrufliste einen Hinweis auf gute Anrufzeiten (heute 10 Uhr und 14–15 Uhr, Dienstag).

### 6.2 Lead-Arbeitsplatz (Layout für grosse Bildschirme)

Drei Bereiche nebeneinander, nichts verschwindet beim Anrufen oder Terminieren:

| Links | Mitte | Rechts (umschaltbar) |
|---|---|---|
| Firma, Ansprechperson, alle Personen der Firma (Domain/Name), Kontaktdaten, Score-Abzeichen, Einstieg, Stichworte, nächster Schritt | Verlauf (Notizen, Anrufe, Mails, Termine, neueste zuerst), Notizfeld des laufenden Anrufs, KI-Zusammenfassung | **Terminplaner** · **3 Vorschläge** · **Mail** · **Ergebnis & Freigabe** |

Modernes Design, Kallysoft-Farben, Tastaturkürzel für die häufigsten Aktionen (nächster Lead, Anrufen, Ergebnis), Breite ab ca. 1'600 px optimiert, Laptop noch nutzbar.

**Wählen und Anrufmodus:** Die Gesprächsinfos braucht Markus erst, wenn jemand abnimmt. Vorher und bei «Nicht erreicht» lenken sie nur ab.

- **Wählen** (nach Klick «Anrufen»): schmale Leiste mit Name, Funktion, Firma, Nummer und Anrufgrund in einer Zeile (z. B. «Erstkontakt»,
  «Rückruf vereinbart», «aus Kampagne»), dazu zwei grosse Knöpfe **«Verbunden»** und **«Nicht erreicht»**. «Nicht erreicht» speichert
  mit einem Klick Telefonaktivität, Anrufstatus und nächsten Versuch (der Klick gilt als Freigabe, weil keine weiteren Lead-Felder
  betroffen sind) und springt zum nächsten Lead.
- **Anrufmodus** (nach «Verbunden»): Der Arbeitsplatz wechselt sichtbar und zeigt alles fürs Gespräch:

| Bereich | Inhalt im Anrufmodus |
|---|---|
| Kopfleiste (farbig, fest) | «Im Gespräch» mit Laufzeit, Name, Funktion, Firma, Nummer; Vera-Status (zeichnet auf / aus) mit Knopf zum Ausschalten; in den ersten Sekunden die Erinnerung an den Transkriptions-Hinweis |
| Spickzettel (links oben) | Einstieg in 1–2 Sätzen, 2–3 passende Use Cases, Stichworte aus der KI-Bewertung, Grösse, Branche, Entscheider ja/nein |
| Vorgeschichte in einer Zeile | letzter echter Kontakt (wann, wer, Ergebnis), offene Aufgabe; bei Kampagnen-Leads die erhaltenen Mails und Use Cases (6.17) |
| Einwände | kurze Antworten auf die häufigsten Einwände (hat Partner, zu klein, kein Budget, keine Zeit), im Admin pflegbar |
| Notizfeld (Mitte) | Cursor steht direkt im Feld, speichert laufend |
| Schnellknöpfe (rechts) | Termin · 3 Vorschläge · Mail · Rückruf · andere Person; öffnen im rechten Bereich, Notizen bleiben sichtbar |
| eingeklappt | voller Verlauf, Filter, Liste (mit einem Klick aufklappbar) |

Nach dem Klick «Aufgelegt» wechselt das Portal in «Nachbearbeitung»: Ergebnisgruppe wählen, Notiz ergänzen, Vorschau prüfen,
freigeben. Auf das Transkript von Vera wird **nicht** gewartet; die KI-Analyse folgt später (6.4). Nach der Freigabe ist Markus
wieder «bereit», und der nächste Lead aus seiner Anrufliste steht da. Teams meldet dem Portal weder Abheben noch Auflegen direkt,
deshalb die Klicks «Verbunden» und «Aufgelegt» (offene Frage 8).

### 6.3 Anruf über Teams, Vera, Telefonaktivität

- Klick auf die Nummer startet den Anruf in Teams (Teams-Telefonie). Das Portal legt die **Telefonaktivität** an: Von Markus, An Lead,
  Bezug Lead, Beginn, Ende, Dauer, Richtung ausgehend, Betreff «Anruf <Firma> – <Ergebnis>», Text = Notiz (die KI-Zusammenfassung
  kommt nach Freigabe der Analyse dazu, 6.4), Vera-Infos (Transkript-ID/Link, Stichworte).
- **Gesprächsdauer:** Beginn, Ende und Dauer kommen aus Vera, sobald das Transkript da ist; ohne Vera aus den Klicks «Verbunden» und
  «Aufgelegt». Das Portal trägt die genaue Dauer im Hintergrund an der Telefonaktivität nach (keine Lead-Felder, keine Freigabe).
  Die Teams-Anrufprotokolle werden dafür nicht gebraucht (offene Frage 9).
- Markus ruft **nur noch über das Portal** an, das Teams öffnet (entschieden 17.11.2026). Den CRM-Teams-Dialer nutzt er nicht mehr,
  damit keine zweite Aktivität «Anrufen …» entsteht.
- Vera liefert das Transkript; Weg (API, Webhook, Export) ist offen. **Ins CRM kommt nur die Analyse** (Zusammenfassung, Interesse,
  Ergebnis) als Text der Telefonaktivität, nie das Transkript (Entscheid Lukas 17.11.2026). Das Transkript liegt nur im Portal bzw.
  bei Vera und wird nach einer festen Frist automatisch gelöscht (Vorschlag 30 Tage, im Admin einstellbar).
- **Hinweis auf die Transkription:** Markus weist zu Beginn jedes Gesprächs darauf hin (entschieden 17.11.2026, wegen StGB Art. 179ter).
  Das Portal zeigt beim Anrufstart eine kurze Erinnerung. Will die Person das nicht, schaltet Markus Vera für diesen Anruf aus
  (dann nur Notizen).

### 6.4 KI-Analyse des Gesprächs (Vorschlag)

Aus Transkript, Notiz und CRM-Kontext erstellt die KI (Claude, Structured Output):

| Ausgabe | Inhalt |
|---|---|
| Zusammenfassung | 3–5 Sätze, Fakten mit Zeitangaben («Ende Q1», «nach den Ferien») |
| Interesse | 0 kein · 1 schwach · 2 offen · 3 klar, mit Begründung (Zitat) |
| Bedarf / Pain | genannte Abläufe, Systeme, Probleme → passende Use Cases aus dem Katalog |
| Entscheider erreicht | ja / nein / weitergeleitet an … (Name, Funktion, E-Mail, wenn genannt) |
| Einwände | Partner vorhanden, intern/Konzern, zu klein, kein Budget, falscher Zeitpunkt, kein Interesse |
| Vorschlag | Ergebnisgruppe, nächster Schritt mit Datum, Felder (alt → neu) |

**Ablauf in zwei Stufen** (Markus wartet nie auf Vera):

1. **Sofort nach dem Gespräch** gibt Markus Ergebnis, Notiz und Felder frei (6.2, 6.9) und ist wieder bereit.
2. **Später** läuft die Analyse im Hintergrund, sobald das Transkript da ist, und landet in der Liste **«Analysen zur Freigabe»**
   (Pendenzen 6.16, Zähler in der Kopfleiste). Markus prüft sie zwischendurch oder am Tagesende:
   - Ein Klick ergänzt die Telefonaktivität um Zusammenfassung und Interesse (`kls_interesse`).
   - Schlägt die KI mehr vor (andere Ergebnisgruppe, neue Ansprechperson, Entscheider), erscheint das als alt → neu wie in 6.9.
   - Ist Vera ausgeschaltet oder liegt nach 30 Min. (im Admin einstellbar) kein Transkript vor, entfällt die Analyse ohne Rückfrage;
     es bleibt bei der Notiz.
   - Eine Use-Case-Mail direkt nach dem Gespräch (6.7) entsteht aus der Notiz. Das Briefing (6.10) wird aktualisiert, sobald die
     Analyse freigegeben ist.

Die Analyse ist Hilfe, kein Automatismus.

### 6.5 Ergebnisgruppen und Lead-Felder (entschieden 17.11.2026, Werte im Admin anpassbar)

Markus klickt nach dem Gespräch **eine** Gruppe an. Das Portal schlägt sie aus der KI-Analyse vor und füllt daraus die Feldänderungen,
die in der Freigabe-Vorschau erscheinen (alt → neu). Werte aus den Prod-Metadaten vom 17.11.2026; Ausnahme 845140009 «Termin
vorgeschlagen», das vor Etappe 2 in Prod zu prüfen ist (Abschnitt 8).

**Immer, bei jeder Gruppe:**
- Telefonaktivität (6.3) mit Ergebnis (`kls_anrufergebnis`) und der Notiz als Text; die **analysierte Zusammenfassung** kommt nach der
  Freigabe der Analyse dazu (6.4). Beides steht im Anruf selbst, nicht in einer «Sales-Portal:»-Notiz: Ein Anruf mit Inhalt zählt in Score und Aufgaben-Regeln als echtes Gespräch, eine Portal-Notiz nicht.
- Besitzer des Leads → Markus, sobald er jemanden erreicht hat (alle Gruppen ausser «Nicht erreicht» und «Falsche Nummer»; Entscheid Lukas).
- Neu → Kontaktiert (`statuscode` 2), sobald jemand erreicht wurde. «Austausch» und «Zweitkontakt» bleiben.
- Aufgaben nur nach `REGEL_AUFGABEN.md` (keine zweite offene Aufgabe pro Firma, max. 3 pro Person und Tag); bestehende Aufgabe anpassen statt neu.
- Disqualifizieren immer erst nach einer Notiz «Sales-Portal: Nicht qualifiziert – <Grund>» mit dem Beleg aus dem Gespräch.

| Gruppe | Anrufstatus `kls_callstatus` | Bewertung `kls_rating_category` | Status / Statusgrund | Weitere Felder | Folgeaktion |
|---|---|---|---|---|---|
| Nicht erreicht | 845140001 Nicht erreicht | – | bleibt | – | ab dem 3. «Nicht erreicht» in 14 Tagen schlägt das Portal eine Mail (6.7) vor |
| Rückruf vereinbart | nach Datum: heute 845140002 · morgen 845140003 · bis 7 Tage 845140004 · bis 31 Tage 845140005 · später 845140010 (Wert für 1–3 Monate fehlt, offene Frage 13) | – | offen, Kontaktiert | – | Aufgabe mit Datum und Uhrzeit an Markus |
| Wartet / Ansprechperson informiert | 845140008 | – | offen, Kontaktiert | ggf. neue Ansprechperson (6.8) | Aufgabe nachfassen in 1 Woche |
| **Termin gebucht** | 845140006 Termin vereinbart (mit der Buchung) | optional Nachfrage-Stufe, wenn Budget genannt | offen, Kontaktiert | wie heute im Flow «Buchen»: `kls_lead_support` 845140004 Verkauf, `subject` «KI Termin»; `kls_interests` + 845140014 KI-Dienstleistungen (ergänzen, nicht ersetzen); `decisionmaker` = Ja, wenn Entscheider im Termin | Termin, Blocker, Briefing |
| **3 Vorschläge gesendet** | 845140009 Termin vorgeschlagen | – | offen, Kontaktiert | `kls_interests` + KI-Dienstleistungen | E-Mail-Aktivität; Aufgabe nachfassen nach 3 Arbeitstagen. Bestätigt der Kunde, bucht Markus → «Termin gebucht» |
| Mail mit Infos gewünscht | 845140008 | 845140004 Potenzial vorhanden (wenn Interesse ≥ 2) | offen, Kontaktiert | `kls_interests` + KI-Dienstleistungen | Use-Case-Mail (6.7), Aufgabe nachfassen in 1 Woche |
| Später wieder melden | nach genanntem Zeitpunkt (wie Rückruf) | 845140005 Später wieder melden | offen, Kontaktiert | – | Aufgabe auf den genannten Zeitpunkt |
| Kein Bedarf (aktuell) | 845140010 Rückruf in 3-6 Monaten | 845140010 Kein Bedarf (aktuell) | offen, Kontaktiert | – | Aufgabe in 6 Monaten (Regel: frühestens 3 Monate) |
| Hat Partner | – | 845140006 Kein Bedarf – hat Partner | offen, Kontaktiert | – | keine Aufgabe; nach 6 Monaten erlaubt die Aufgaben-Regel einen neuen Anlauf |
| Intern / Konzern | – | 845140008 Kein Bedarf – intern / Konzern | **disqualifiziert: 6 Nicht mehr interessiert** (Entscheid Lukas) | – | keine |
| Zu klein (unter 5 MA) | – | 845140007 Passt nicht (zu klein) | disqualifiziert: 845140003 Ausserhalb ICP, Notiz «zu klein» | `numberofemployees` = genannte Zahl | keine. Ab 5 MA nur Bewertung setzen, Lead bleibt offen (Mindestgrösse-Regel) |
| Nicht mehr kontaktieren | 845140007 Nicht mehr kontaktieren | – | disqualifiziert: 6 Nicht mehr interessiert | `donotphone`, `donotemail`, `donotbulkemail` = Ja | keine. Lemlist prüft die Sperre heute nicht → Kampagnen-Ausschluss separat |
| Mitbewerber / IT-Dienstleister | – | – | disqualifiziert: 845140003 Ausserhalb ICP | `kls_competitor` = Ja | keine |
| Person nicht mehr in der Firma / falsche Person | – | – | mit neuer Person: alter Lead 5 Kontakt nicht möglich, neuer Lead übernimmt (6.8); ohne neue Person: bleibt offen | – | ohne neue Person: Research-Auftrag (Kontakt-Research) |
| Falsche Nummer | – | – | bleibt | `telephone1`/`mobilephone` korrigieren, wenn bekannt | sonst Hinweis «Nummer prüfen» |

**Nicht verwendet** (in Prod praktisch leer oder Altlast): `kls_phone_call` («Anruf», Datum, zuletzt 2020), `kls_customer_potential`
(3 Werte von 12'000), `leadqualitycode` (fast überall Standard «Aussichtsreich»; der Score ersetzt ihn), Bewertung 845140009 (veraltet).

**Wie es gebaut wird:** Jede Gruppe ist im Admin eine Regel mit einer Liste von Feldaktionen («setzen», «zu Mehrfachauswahl hinzufügen»,
«nur wenn leer», «disqualifizieren mit Statusgrund», «Notiz», «Aufgabe nach Regel X»). Das Portal rechnet daraus die Vorschau, schreibt
nach der Freigabe in einem Durchgang (Notiz → Felder → Status) und protokolliert den alten Wert jedes Felds. Regeln sind versioniert,
damit das Dashboard weiss, mit welcher Regel ein Anruf gespeichert wurde.

### 6.6 Termin buchen (löst den Terminplaner ab)

Die Regeln sind die des heutigen Terminplaners (`CLAUDE.md`, Buchungsregeln) und des Intents V1:

| Regel | Vorgabe |
|---|---|
| Teilnehmende intern | Nico + Manuel (Standard); Nico + Lukas per **Schalter** «Zusatzcall» (entschieden 17.11.2026, keine feste Schwelle), nur wenn Manuel zur selben Zeit nicht kann |
| Dauer | 30 Min., Teams-Meeting, Organisator = der Sales (Einladung im Kalender des Sales über Markus' Stellvertretung) |
| Zeitfenster | Start 09:00–11:30 und 14:00–16:00, 12:30–14:00 keine Termine |
| Puffer | 30 Min. davor und 30 Min. danach frei, also 1,5 h am Stück, **für alle und zu jeder Startzeit**, auch um 09:00 und 14:00 (Wunsch Nico und Manuel, entschieden 17.11.2026). Die Terminplaner-App lässt den Puffer davor um 09:00/14:00 heute weg; das Portal übernimmt diese Ausnahme nicht |
| Doppelbuchungs-Schutz | vor dem Anlegen Verfügbarkeit nochmals prüfen (`getSchedule`), sonst «belegt» |
| Teilnehmende extern | Adresse des Leads, weitere Adressen möglich (Format + Domain-Plausibilität) |
| Betreff / Text | Vorlage «Vorstellung der Kallysoft Informatik AG als KI-Spezialist – {Firma}», vor dem Senden anpassbar |
| 3 Vorschläge | Logik des Terminplaners 1.0.0.14 übernehmen: Monatsauswahl (laufender Monat ab morgen + 3, ab dem 21. ist der nächste vorgewählt), Zeitwunsch (egal/Vormittag/Nachmittag), je ein Vorschlag pro Monatsdrittel (1–10, 11–20, 21–Ende), Halbtag abwechselnd, verschiedene Tage und Uhrzeiten, «anderer» tauscht einen Vorschlag. **Neu: nie zwei Vorschläge in derselben Kalenderwoche** (in 1.0.0.14 nicht garantiert, z. B. 10. und 11. des Monats; 1.0.0.13 hatte diese Regel). Ausgabe direkt als Mail-Entwurf statt Zwischenablage |
| Kennzeichnung | Outlook-Kategorie «Kallysoft Erstgespräch» **und** eigene Termin-ID als erweiterte Eigenschaft am Termin (wie `KlsTerminStand` in der Lösung Kalender Termin-Updates), dazu `iCalUId` in der Buchungstabelle (Abschnitt 8) |
| Blocker | setzt das Portal beim Buchen selbst (30 Min. davor, 30 Min. danach, wie die heutigen Blocker-Flows) in den Kalendern von Sales und Nico, verknüpft mit der Termin-ID |

### 6.7 Mail ohne Termin (Use-Case-Mail)

- Auf Knopfdruck: KI erstellt aus KI-Bewertung, Gesprächsnotiz und optional einer kleinen Recherche (Website, eine Websuche) einen
  Mail-Entwurf aus Sicht von Markus mit 1–2 passenden Use Cases und Terminangebot (optional 3 Vorschläge eingebettet).
- Markus bearbeitet und sendet aus seinem Postfach; die gesendete Mail wird als E-Mail-Aktivität am Lead gespeichert.
- Aufhänger nur mit Quelle (keine erfundenen Details), wie in `CRM-Analyse.md` 3.3.

### 6.8 Andere Ansprechperson

- Termin oder Mail an die Person des Anrufs **oder** an eine andere Person (Name, Funktion, E-Mail, Telefon erfassen).
- Danach wird der Datensatz aktualisiert: gleiche Person mit neuer Adresse → Lead aktualisieren; andere Person → neuer Lead derselben
  Firma (Anrede nach der 90-%-Regel), bisheriger Lead wird Zweitkontakt oder «Kontakt nicht möglich». Max. 2 Leads pro Firma,
  Hauptkontakt-Regeln aus `scoring-regeln/README.md` Abschnitt 8. Alles in der Freigabe-Vorschau.

### 6.9 Freigabe vor dem CRM-Push

- Eine Vorschau pro Anruf: Telefonaktivität, Lead-Felder (alt → neu), Notiz, Aufgabe, Termin, Mail.
- Ein Klick «Freigeben und speichern». Fehlschlag → im Portal sichtbar, erneut versuchen, nichts geht verloren (Entwurf bleibt im Portal).
- **Konfliktprüfung:** Unmittelbar vor dem Push liest das Portal die betroffenen Felder neu. Hat jemand sie seit dem Entwurf im CRM
  geändert, zeigt die Vorschau den Konflikt (Entwurf · CRM jetzt · neu), und Markus entscheidet. Nichts wird still überschrieben.
- **Zwei Stufen:** Ergebnis und Felder sofort, die KI-Analyse später als eigene kurze Freigabe (6.4).
- Protokoll im Portal: wer, wann, welche Felder, alter Wert (zum Zurücksetzen).

### 6.10 Briefing für Gespräche (entschieden 17.11.2026)

- **Empfänger:** der gebuchte Sales und Nico (also Manuel + Nico bzw. Lukas + Nico).
- **Inhalt:** Firma (Kurzprofil, Grösse, Branche), Ansprechperson und Rolle, Verlauf (Coldcall-Zusammenfassung, frühere Kontakte,
  Offerten/Projekte), Use Cases aus Sicht des gebuchten Sales, Einstiegsfragen, offene Punkte, was vorzubereiten ist.
- **Termin aus einer Kampagne:** Das Briefing zeigt zuoberst, dass der Kontakt über die Kampagne kam: welche Mails der Kunde von wem
  erhalten hat (Absender, Datum, Betreff), welche Use Cases darin gepusht wurden und wie er reagiert hat (6.17). So knüpfen Sales
  und Nico an das an, was der Kunde schon kennt.
- **Muss etwas vorbereitet werden** (Markus setzt bei der Buchung ein Häkchen, z. B. Prototyp, Demo, Unterlagen, Fragen des Kunden;
  die KI-Analyse kann es nachträglich vorschlagen): **Mail 1 Woche vor dem Termin** an beide. Liegt der Termin näher als 1 Woche, geht die Mail sofort.
- **Sonst** (alles, was ad hoc ohne Vorbereitung geht; intern so festgelegt): **Briefing-Eintrag im Kalender** von Sales und Nico,
  direkt auf dem Termin (gleiche Zeit), mit dem Briefing im Text, eigene Kategorie
  bzw. Farbe («Kallysoft Briefing»), als «frei» angezeigt (blockiert keine Slots), Betreff ohne «Vorstellung der Kallysoft».
- Im Portal ist das Briefing beim Termin immer sichtbar; bei Verschiebung zieht der Briefing-Eintrag mit, bei Absage wird er gelöscht.

### 6.11 Blocker, Absagen, Verschiebungen (löst Blocker-Flows und Absage-Wächter ab)

- Das Portal überwacht seine Termine über die Termin-ID per **Delta-Abfrage alle paar Minuten**. Graph-Änderungsbenachrichtigungen
  bräuchten einen öffentlich erreichbaren Endpunkt und passen nicht zum Zugang nur intern/VPN.

| Ereignis | Reaktion |
|---|---|
| Termin gelöscht bzw. vom Organisator abgesagt, oder der Hauptkontakt lehnt ab | **Absage:** Meldung an Markus mit Lead (Name, Firma, Telefon, Link), Blocker und Briefing-Eintrag entfernen, Lead im Portal als «Termin abgesagt» markieren (Anrufstatus erst nach Markus' Klick) |
| eine weitere externe Person lehnt ab | Hinweis an Markus und den Sales, Termin bleibt |
| Nico oder der Sales lehnt ab | Warnung an Markus «neu planen»; Termin und Blocker bleiben, bis Markus neu plant |
| verschoben | Blocker und Briefing-Eintrag mitverschieben, Briefing aktualisieren |

- Übergang: Lukas deaktiviert beim Livegang des Portals alle alten Flows (Blocker, Absage-Wächter, Wochenreport, Terminplaner).
  Bereits gebuchte Termine bekommen vorher einmalig die Termin-ID (Abgleich über Betreff), damit das Portal auch sie überwacht.

### 6.12 Dashboard (Rollen Sales, AI-Spezialist, Admin)

| Bereich | Kennzahlen |
|---|---|
| Aktivität | Anrufe pro Tag/Woche, Gespräche ≥ 4 Min., Erreichbarkeit nach Stunde und Wochentag (Heatmap) |
| Ergebnis | Ergebnisgruppen je Woche, Terminquote, Absagequote, Gründe der Absagen |
| Wo es wirkt | Terminquote und Absagequote nach **Branche**, Eigener Kategorie, Organisationstyp (privat/öffentlich), **MA-Band**, Grade, Region, Quelle/Kampagne; beste und schlechteste Branche mit Mindestanzahl (z. B. n ≥ 10) und Vertrauensintervall |
| Termine | gebuchte Erstgespräche je Sales (Anteil Zusatzcalls Lukas), Absagen/Verschiebungen, freie Kapazität Manuel + Nico je Woche (wie Wochenreport) |
| Score-Check | Terminquote je Grade (wie `matrix_messung.py`), ob der Score trennt |
| Pipeline (später) | Termin → Verkaufschance → Offerte → gewonnen, aus Flow «Offerte an CRM» |

Der Wochenreport (Mail montags an sales@) wird aus denselben Zahlen erzeugt und ersetzt den Flow.

### 6.13 Lead-Score sichtbar

- Score-Abzeichen (Grade-Farbe) in Liste und Arbeitsplatz, erste Zeilen von `kls_ki_bewertung` (Stand, Grade, Einstieg, Stichworte,
  nächster Schritt), Details aufklappbar. Filter und Sortierung nach Score und Grade, «Kontaktpause bis …» sichtbar.
- «Neu bewerten» (Admin/Sales) stösst die bestehende Bewertungslogik an und überschreibt (Kennzeichen «(Sales-Portal)» in der letzten Zeile).

### 6.14 Admin

Rollen, «Ansicht als», Ergebnisgruppen und Feld-Zuordnung, Vorlagen (Betreff, Einladung, Mails, Briefing), Terminregeln (Zeiten, Puffer),
Löschfrist Transkripte, Verbindungen/Zugänge (Ablaufdatum Geheimnisse), Protokoll und Fehler, Umgebung Sandbox/Prod sichtbar.

### 6.15 Anrufhistorie (keine Warteschlange)

«Heute» als feste Warteschlange entfällt (Entscheid 20.11.2026). Was fällig ist, zeigen die Pendenzen (6.16), neue Leads kommen aus
der Anrufliste (6.1, sortiert nach Fälligkeit und Score). Die Anrufhistorie beantwortet zwei Fragen: **Wen habe ich wann angerufen?**
und **Wer ruft an bzw. hat angerufen?**

- **Liste:** alle Anrufe von Markus, neueste zuerst: Datum, Uhrzeit, Person, Firma, Nummer, Ergebnis, Notiz in einer Zeile.
  Quelle sind die Telefonaktivitäten, die das Portal anlegt (6.3).
- **Kategorien** (filterbar): ausgehend · Rückruf angenommen · Rückruf verpasst · unbekannte Nummer. Dazu Filter nach Tag und Ergebnis,
  Suche nach Name, Firma oder Nummer.
- **Verpasste Rückrufe** werden der Person zugeordnet (6.18) und bleiben hervorgehoben, bis Markus zurückgerufen oder sie erledigt hat.
  Der Zähler in der Kopfleiste zeigt, wie viele offen sind.
- **Rückruf-Suche** jederzeit über das Suchfeld oben (6.18).

### 6.16 Pendenzen (alle Rollen)

Eine eigene Seite pro Person mit allem, was sie erledigen oder vorbereiten muss. Sie ist für alle die Startseite; bei Markus stehen
unabgeschlossene Anrufe, fällige Rückrufe und Aufgaben zuoberst.

| Art | Inhalt |
|---|---|
| Aufgaben | Nachfass-Aufgaben, Rückrufe, Research-Aufträge (aus dem CRM, nach `REGEL_AUFGABEN.md`) |
| Termine | gebuchte Erstgespräche mit Status (gebucht, verschoben, abgesagt, durchgeführt) |
| Briefings | offen, gelesen, Vorbereitung erledigt (Häkchen aus 6.10) |
| Absagen / Verschiebungen | was neu zu planen ist |
| Unabgeschlossene Anrufe | Anrufe ohne Ergebnis oder ohne Freigabe: kein Anruf bleibt ohne CRM-Eintrag liegen |
| Analysen zur Freigabe | KI-Analysen, die die Telefonaktivität ergänzen (6.4) |
| Freigaben | übrige Entwürfe, die noch nicht ins CRM gepusht sind |
| Fehler | fehlgeschlagener CRM-Push, nicht gesendete Mail |

- **Filter:** Art, Fälligkeit (überfällig, heute, diese Woche, später), Person (Admin und «Ansicht als»), Firma, Herkunft (Coldcall,
  Kampagne, andere), Status (offen, erledigt). Filter speicherbar wie in der Anrufliste.
- **Aktionen direkt in der Liste:** erledigen, verschieben, Lead öffnen, Briefing öffnen. Erledigen schliesst die Aufgabe im CRM;
  sind Lead-Felder betroffen, kommt die Freigabe-Vorschau (6.9).

### 6.17 Leads und Termine aus der Kampagne

Kommt ein Termin über die automatisierte Kampagne zustande oder ruft Markus einen ehemaligen Kampagnen-Lead an, muss sichtbar sein,
was der Kunde schon bekommen hat.

- **Arbeitsplatz und Anrufmodus:** Abzeichen «aus Kampagne» und die erhaltenen Mails: «Mail von <Absender> erhalten», Datum, Betreff,
  die darin gepushten Use Cases, Reaktion (Klick, Antwort).
- **Briefing (6.10):** dieselben Angaben zuoberst, damit Sales und Nico an den gepushten Use Cases anknüpfen statt sie zu wiederholen.
- **Buchung:** Herkunft «Kampagne» am Termin bzw. in `kls_buchung`, damit das Dashboard Kampagnen- und Coldcall-Termine trennt.
- **Datenquelle:** Lemlist bzw. die E-Mail-Aktivitäten, die der Lemlist-Flow ins CRM schreibt. Damit das Portal weiss, welche Use
  Cases eine Mail enthielt, braucht jeder Kampagnenschritt eine feste Use-Case-Kennung (offene Frage 6).

### 6.18 Rückrufe erkennen

Ruft ein Kunde zurück, muss Markus sofort wissen, wer es ist und warum er ihn angerufen hatte.

- **Rückruf-Suche (Etappe 1b):** Suchfeld oben im Portal, jederzeit per Kürzel. Markus tippt die angezeigte Nummer in beliebigem Format
  ein; das Portal sucht über alle Telefonfelder (Leads, Kontakte, Firmen, mit dem einheitlichen Format aus 6.19) und öffnet den Treffer
  im Anrufmodus, mit dem letzten Anruf und seinem Grund zuoberst. Der Anruf wird als **eingehende** Telefonaktivität gespeichert
  (Kategorie «Rückruf angenommen»).
- **Automatische Erkennung (separater Baustein, nur für Rückrufe):** Das Portal liest die Teams-Anrufprotokolle von Markus' Nummer
  (Microsoft Graph), gleicht eingehende und verpasste Anrufe mit den Nummern im CRM ab und
  - trägt sie in der Anrufhistorie als «Rückruf angenommen» oder «Rückruf verpasst» ein, z. B. «Rückruf von <Person, Firma> um 10:12 –
    zuletzt angerufen am 18.11.»,
  - schlägt die eingehende Telefonaktivität am Lead vor (Speichern nach Markus' Klick).

  Andere Anrufe (intern, privat, nicht im CRM) verarbeitet das Portal nicht.
- **Technik und Grenzen:** Power Automate hat dafür keinen Standard-Connector; es geht nur über Graph mit einer App-Berechtigung, die
  für die Anrufe der ganzen Firma gilt (Admin-Zustimmung). Das Portal verarbeitet nur Markus' Anrufe und verwirft den Rest. Die
  Protokolle kommen mit Verzögerung; den Kunden schon **während es klingelt** anzuzeigen, bräuchte einen eigenen Teams-Bot und ist
  nicht vorgesehen. Vor der Umsetzung technisch prüfen (offene Frage 10).
- **Unbekannte Nummer:** Hinweis «nicht im CRM» mit der Möglichkeit, sie einem Lead zuzuordnen.

### 6.19 Telefonnummern in einem Format

Im CRM stehen Nummern in verschiedenen Formaten (+41 61 …, 061 …, 0041 …, mit und ohne Leerzeichen). Für Wählen und Rückruf-Erkennung
braucht das Portal ein einheitliches Format.

- **Im Portal:** Jede Nummer wird beim Lesen ins internationale Format umgerechnet («0…» und «0041…» → +41, ausländische wie +49 oder
  +33 bleiben, Durchwahl getrennt). Verglichen und gewählt wird ohne Leerzeichen (+41611234567), angezeigt lesbar (+41 61 123 45 67).
- **Nicht eindeutig oder ungültig** (zu kurz, Text, mehrere Nummern in einem Feld): Hinweis «Nummer prüfen» im Arbeitsplatz; der Lead
  fällt aus der Tagesliste (Filter Erreichbarkeit).
- **Schreiben ins CRM:** Korrigiert oder ergänzt das Portal eine Nummer, dann immer im einheitlichen Format, mit Freigabe.
- **Bestand bereinigen:** einmalig über die Pipeline (Vorstufe), mit Vorschau und Protokoll wie die übrige Lead-Bereinigung; danach
  schreibt auch der Import nur noch dieses Format (offene Frage 11).

---

## 7. Automationsbausteine

| Baustein | Heute | Im Portal |
|---|---|---|
| Slots suchen | Flow «Terminplanung Sales» + App-Logik | **neu im Portal** (getSchedule, prüft jede Startzeit = Etappe 4 des Terminplaners) |
| Termin buchen + Lead-Update | Flow «Terminplanung Buchen» | **neu im Portal**, gleiche Felder |
| 3 Vorschläge | App 1.0.0.14 | **neu im Portal**, Logik übernehmen |
| Blocker | Blocker-Flows Manuel/Nico | **neu im Portal** (über Termin-ID), Flows danach aus |
| Absagen | Absage-Wächter Manuel | **neu im Portal**, Flow danach aus |
| Wochenreport | Flow | **Dashboard + Mail aus dem Portal**, Flow danach aus |
| Telefonaktivität | Teams-Dialer im CRM | **neu im Portal** mit Ergebnis und Vera |
| Transkript-Analyse, Use-Case-Mail, Briefing | – | **neu** (Claude API) |
| Score, KI-Bewertung, Bereinigung | Pipeline `lead-pruefung/` | **bleibt**, Portal zeigt an |
| Liste vorbereiten, Import | Excel, Skripte, «Leads Import v2» | **bleibt Vorstufe** |
| Aufgaben-Regeln | `REGEL_AUFGABEN.md`, Skripte | **im Portal umgesetzt** (gleiche Regeln) |
| Lemlist, Offerte an CRM | Flows in CRMPowerAutomate | **bleiben**, Portal zeigt Ergebnis im Verlauf; Kampagnen-Mails mit Use Cases in Arbeitsplatz und Briefing (6.17) |
| Sperre Kampagnen-Leads | 60 Tage | **im Portal**: 3 Monate ohne Aktivität |
| Rückruf-Erkennung | – | **separat** (Teams-Anrufprotokolle über Graph, nur Markus' Nummer) |
| Gesprächsnotizen nach Termin | automatisch ins CRM | bleibt |

---

## 8. Architektur und Datenmodell

**Entschieden (Intent V1):** eigene Webapplikation, intern in Docker gehostet, keine Power App. Gründe, die dafür sprechen: Freigabelimit
der verwalteten Prod-Umgebung für Canvas-Apps, Layout und Tempo, KI-Funktionen, eine Oberfläche für alles. Nachteil: Der CRM-Teams-Dialer
und Formularfunktionen (intelligentes Einfügen) stehen im Portal nicht zur Verfügung.

```
 Browser (Markus, Sales, Nico, Lukas) ──SSO Entra ID──► Portal (Docker: Web-App + API + Hintergrund-Worker + DB)
                                                          │
          ┌───────────────────────────┬───────────────────┼──────────────────────┬────────────────────┐
          ▼                           ▼                   ▼                      ▼                    ▼
   Dataverse Web API          Microsoft Graph        Claude API             Vera (Transkripte)   Teams (Anruf)
   Leads, Aktivitäten,        Kalender, Teams-Meeting, Analyse, Mail,       API/Webhook offen    Start aus dem Portal
   Notizen, Aufgaben,         Mail senden, Änderungen  Briefing (Structured
   Buchungen                  (Absagen, Rückrufe)      Outputs)
```

- **Benutzeraktionen im Namen des Benutzers** (delegiert, On-Behalf-Of): CRM-Änderungen erscheinen als Markus, Termine über Markus'
  Stellvertretung im Kalender des Sales, Mails aus dem eigenen Postfach. So stimmen Besitzer und Verlauf, und es braucht keine
  breiten App-Rechte.
- **Hintergrundaufgaben über die bestehende Entra-App des Portals** (vorhanden, mit allen nötigen Berechtigungen; Entscheid Lukas
  17.11.2026): Absagen erkennen (Delta-Abfrage), Blocker, Briefing-Einträge und -Mails, Wochenreport, später Rückruf-Erkennung (6.18). Löst nebenbei «alles hängt an Lukas' Verbindungen».
  Empfehlung: Mail- und Kalenderrechte trotzdem auf die nötigen Postfächer einschränken (RBAC for Applications), Geheimnis bzw.
  Zertifikat nur als Docker-Secret.
- **Zugang:** nur im internen Netz bzw. über VPN, Anmeldung per Entra-SSO ohne zusätzliches MFA (Entscheid Lukas 17.11.2026).
- **KI:** Claude, vermutlich über das bestehende Abo (offen). Hinweis: Ein Abo (claude.ai/Team) gilt für Personen, die Claude selbst
  bedienen. Ein Portal, das selbständig Gespräche analysiert und Mails entwirft, braucht einen **API-Zugang** (Claude Console oder
  Microsoft Foundry) mit Datenschutzvertrag. Richtwert nach den Preisen in `CRM-Analyse.md`: rund $0.05–0.10 pro Anrufanalyse mit
  Opus 5.5, bei ~70 Anrufen pro Woche also etwa $15–30 pro Monat, dazu Use-Case-Mails und Briefings.
- **Portal-Datenbank** (z. B. Postgres im Docker): Rollen, gespeicherte Filter, Entwürfe, Transkripte (mit Löschfrist), Analysen,
  Freigabe-Protokoll. Personendaten nur so viel wie nötig.
- **Entwicklung und Test gegen die Sandbox**, Prod erst nach Abnahme. Umgebung im Portal immer sichtbar.

**Ergänzungen im CRM (FixCRMSolution, nur ergänzend, nach Lukas' Auftrag):**

| Element | Zweck |
|---|---|
| Tabelle `kls_buchung` (Termin-ID, `iCalUId`, Event-ID, Lead, Sales, Start, Status gebucht/abgesagt/verschoben/durchgeführt, Herkunft Coldcall/Kampagne, Blocker-IDs) | sichere Erkennung unabhängig vom Betreff («Ideen für später» im Terminplaner) |
| Telefonanruf: `kls_anrufergebnis` (Auswahl = Ergebnisgruppe), `kls_interesse` (0–3), `kls_transkript_link` | Auswertung je Anruf statt nur letzter Stand (CRM-Analyse M5) |
| keine neuen Lead-Felder für «Letzter Anruf» | Entscheid Lukas 17.11.: kein solches Feld; Portal rechnet aus den Aktivitäten |
| Anrufstatus 845140009 «Termin vorgeschlagen» | in 6.5 verwendet; gibt es in der Sandbox, in Prod vor Etappe 2 prüfen (heute wird «Termin vorgeschlagen» von Hand gesetzt) |

---

## 9. Ausgangsbasis: bestehendes Portal

Lukas möchte das bestehende Portal (vom AI-Spezialisten gebaut) übernehmen und auf diesen Intent anpassen. Vor der Umsetzung:

1. Code und Stand ansehen (Repository/Ordner, Technologie, Hosting, Anmeldung, angebundene Systeme).
2. Abgleich mit diesem Intent: was ist da, was fehlt, was widerspricht (z. B. Excel-Import im Portal, eigenes Scoring).
3. Daraus den Etappenplan präzisieren.

Das bestehende Portal läuft **intern bei Kallysoft** (Docker, Stand 17.11.2026). Code und Zugang liegen nicht in diesem Projektordner;
die Bestandsaufnahme (Punkte 1–3) machen Nico bzw. Lukas am internen System oder geben den Code dafür frei.

---

## 10. Etappen (MVP zuerst)

| Etappe | Inhalt | Ergebnis |
|---|---|---|
| 0 Grundlage | Bestandsaufnahme bestehendes Portal, Entra-SSO, Rollen inkl. Admin und «Ansicht als», Anbindung Sandbox, Klick-Prototyp von Anrufliste, Anrufmodus und Pendenzen mit Markus testen, Vera-Weg klären (offene Fragen 2 und 9) | Portal zeigt Leads aus der Sandbox, Lukas kann Rollen vergeben |
| 1a MVP Coldcall | Bedienkonzept (6.0), Anrufliste mit Filtern inkl. Kampagnen-Sperre (braucht offene Frage 5), einheitliche Telefonnummern, Lead-Arbeitsplatz mit Anrufmodus, Anruf über Teams, Telefonaktivität, Ergebnisgruppen (zuerst als feste Konfiguration), Freigabe-Vorschau mit Konfliktprüfung, CRM-Push, Aufgaben nach Regel | Markus kann einen Tag nur im Portal arbeiten (ohne Termin buchen) |
| 1b Übersicht | Pendenzen (unabgeschlossene Anrufe, Aufgaben, Freigaben), Anrufhistorie mit Kategorien und Rückruf-Suche, Admin-Editor für Ergebnisgruppen | Markus findet alles Offene und jeden Rückruf im Portal |
| 2 Termin | Slots, Buchen, 3 Vorschläge als Mail, andere Ansprechperson, Termin-ID + `kls_buchung`, Pendenzen um Termine und Absagen ergänzt | Terminplaner-App wird nicht mehr gebraucht |
| 3 KI im Anruf | Vera-Anbindung inkl. Gesprächsdauer, Analyse mit «Analysen zur Freigabe», Use-Case-Mail, Briefing (Mail bzw. Kalendereintrag), Kampagnen-Kontext (6.17) | braucht den Vera-Weg und den Claude-Zugang |
| 4 Ablösung Flows | Blocker, Absagen/Verschiebungen, Wochenreport aus dem Portal; Blocker-Flows, Absage-Wächter, Wochenreport, Terminplaner-Flows aus | ein System für Termine |
| 5 Dashboard | Kennzahlen 6.12, Score-Check | Lukas sieht, wo Termine entstehen |
| Separat | Automatische Rückruf-Erkennung (6.18), sobald 1b läuft und der technische Test (offene Frage 10) positiv ist | verpasste Rückrufe erscheinen ohne Zutun in der Anrufhistorie |
| Danach | Import-Seite (Vorstufe im Portal), Pipeline bis Offerte, Buchungsseite für Kunden | |

Umstellung: Beim Livegang deaktiviert Lukas alle alten Flows. Bereits gebuchte Termine bekommen vorher die Termin-ID (einmaliger
Abgleich über Betreff), damit keine Blocker oder Absagemeldungen verloren gehen.

---

## 11. Entscheide

**Entschieden (Lukas, 17.11. und 20.11.2026):**

| Thema | Entscheid |
|---|---|
| Anrufstatus | Markus setzt ihn im Portal; «Termin vereinbart» kommt mit der Buchung, Rückrufe plant er direkt dort |
| Puffer, Blocker | 30 Min. davor und danach, für alle und zu jeder Startzeit; Blocker 30 Min. |
| Transkription | Markus weist im Gespräch darauf hin; ins CRM nur die Analyse, Transkript wird nach einer Frist gelöscht |
| Anrufen | nur über das Portal, das Teams öffnet; kein CRM-Dialer mehr |
| Alte Flows | Lukas deaktiviert alle beim Livegang |
| Zusatzcall Lukas | Schalter, keine Schwelle |
| 3 Vorschläge | Logik aus dem Terminplaner 1.0.0.14 + nie zwei in derselben Woche |
| Ergebnisgruppen | Tabelle 6.5; «Intern/Konzern» wird disqualifiziert |
| Besitzer | wechselt auf Markus, sobald er jemanden erreicht |
| Briefing | an Sales + Nico; Mail 1 Woche vorher, wenn etwas vorzubereiten ist, sonst Kalendereintrag zur Terminzeit mit eigener Kategorie |
| Zugang | intern/VPN, SSO ohne MFA |
| Entra-App | bestehende App des Portals mit allen Berechtigungen |
| Öffentliche Hand | Zielkunde wie privat (KI-Aufträge unter der Ausschreibungsgrenze) |
| Kampagnen-Leads (20.11.) | erst nach 3 Monaten ohne Aktivität in die Anrufliste (bisher 60 Tage) |
| Pendenzen (20.11.) | eigene Seite für alle Rollen, inkl. Briefings, mit Filtern |
| Bedienung (20.11.) | klares, modernes Setup; Gesprächsinfos erst, wenn jemand abnimmt |
| Anrufhistorie (20.11.) | wen Markus wann angerufen hat, kategorisiert (ausgehend, Rückruf angenommen/verpasst); Rückrufe werden zugeordnet, automatische Erkennung nur für Rückrufe und separat |
| «Heute» (20.11.) | keine Warteschlange; Fälliges über Pendenzen und Anrufliste |
| Nachbearbeitung (20.11.) | zwei Stufen: Ergebnis sofort freigeben, KI-Analyse später über «Analysen zur Freigabe» |
| Gesprächsdauer (20.11.) | aus Vera, ohne Vera aus den Klicks |
| Absagen (20.11.) | Delta-Abfrage; Absage = Termin gelöscht oder Hauptkontakt lehnt ab (Regeln 6.11) |
| CRM-Push (20.11.) | Konflikte anzeigen statt überschreiben |
| Briefing (20.11.) | bleibt: Kalendereintrag direkt auf dem Termin für alles Ad-hoc, Mail 1 Woche vorher nur bei Vorbereitung (z. B. Prototyp) |
| Sterneintrag (20.11.) | keine eigene Prüfung im Portal |

**Noch offen** (blockiert den Start nicht, Lukas 17.11.2026: «ich nehms mal so»; die Vorschläge gelten bis auf Weiteres):

| # | Frage | Vorschlag |
|---|---|---|
| 1 | Bestehendes Portal: Technologie und wer es betreut (läuft intern) | Bestandsaufnahme als Etappe 0 |
| 2 | Vera: Wie kommt das Transkript ins Portal (API, Webhook, Export)? Löschfrist? | 30 Tage, im Admin einstellbar |
| 3 | Claude: Abo oder API-Zugang? (Abo reicht für ein selbständig laufendes Portal nicht, siehe 8) | API-Zugang über das Firmenkonto mit Kostendeckel im Admin |
| 4 | Ab wie vielen «Nicht erreicht» soll das Portal eine Mail vorschlagen? | 3 Versuche in 14 Tagen |
| 5 | Kampagne: Was zählt als Aktivität für die 3-Monats-Sperre? | versendete Mail, Klick, Antwort, Anruf, Notiz mit Text, Termin; Öffnungen nicht |
| 6 | Kampagne: Woher weiss das Portal, welche Use Cases in einer Mail gepusht wurden? | Use-Case-Kennung je Kampagnenschritt in Lemlist pflegen; Portal liest sie über die Lemlist-API oder die E-Mail-Aktivität |
| 7 | Kampagne: Antwortet ein Lead positiv, kommt er trotz Sperre sofort zu Markus? | ja, als Pendenz «Antwort aus Kampagne» |
| 8 | Abheben und Auflegen: Teams meldet beides dem Portal nicht direkt | Klicks «Verbunden» und «Aufgelegt»; später evtl. Signal von Vera |
| 9 | Vera: Liefert Vera Beginn, Ende und Dauer des Gesprächs mit dem Transkript? | mit dem Vera-Weg (Frage 2) in Etappe 0 prüfen; sonst Klicks |
| 10 | Rückruf automatisch erkennen: Wie schnell liefern die Teams-Anrufprotokolle, sind die Nummern der Anrufenden enthalten, und ist die firmenweite Graph-Berechtigung intern in Ordnung? | technisch prüfen; bis dahin Rückruf-Suche |
| 11 | Telefonnummern im CRM: lesbar (+41 61 123 45 67) oder kompakt (+41611234567) speichern? Bestand bereinigen? | lesbar speichern, Bestand einmalig über die Pipeline bereinigen |
| 12 | Echter Kontakt: `scoring-regeln/` und `REGEL_AUFGABEN.md` auf die Definition aus Abschnitt 5 umstellen (Ergebnis statt Dauer)? | ja, mit der Lead-Bereinigung nachführen |
| 13 | Anrufstatus für «Rückruf in 1–3 Monaten» fehlt (heute fällt das auf «Rückruf in 3–6 Monaten») | Wert in der FixCRMSolution ergänzen |

---

## 12. Risiken

| Risiko | Gegenmassnahme |
|---|---|
| Transkription ohne Hinweis (StGB 179ter, DSG) | Hinweis zu Beginn jedes Anrufs (entschieden), Erinnerung im Portal, Vera pro Anruf abschaltbar |
| Fehlende Blocker/Absagemeldungen bei bestehenden Terminen nach dem Abschalten der Flows | Termin-ID für bereits gebuchte Termine vor dem Livegang nachtragen |
| Falsche Lead-Änderungen durch die KI | nur Vorschläge, Freigabe mit Vorschau alt → neu, Protokoll mit Zurücksetzen |
| Ausfall Portal = Stillstand Coldcall | Entwürfe bleiben im Portal; Notfall: CRM direkt, Terminplaner-App bis Etappe 4 nicht löschen |
| Abgelaufene Geheimnisse/Verbindungen | Ablaufdatum im Admin sichtbar, Warnung 30 Tage vorher |
| Breite Rechte der Entra-App (alle Postfächer) | Rechte auf die nötigen Postfächer einschränken, Geheimnis nur als Docker-Secret, Zugriffe protokollieren |
| Lemlist schreibt weiter an gesperrte Leads («Nicht mehr kontaktieren») | Sperre im Lemlist-Flow bzw. in Lemlist selbst nachziehen |
| Dataverse-Speicher | keine Transkripte/PDFs im CRM, nur Zusammenfassung und Link |
| Daten im Dashboard zu dünn (heute nur letzter Anrufstatus, Branche fehlt oft) | Ergebnis je Anruf speichern (`kls_anrufergebnis`), Branche in der Vorstufe pflegen, Kennzahlen erst ab n ≥ 10 zeigen |
| Zwei Wahrheiten beim Scoring | Portal nutzt nur `kls_leadscore`/`kls_ki_bewertung` und die Regeln aus `scoring-regeln/` |
| Kampagnen-Lead wird zu früh angerufen (Doppelkontakt, wirkt unkoordiniert) | Sperre 3 Monate ab letzter Aktivität, Abzeichen und Mail-Verlauf im Arbeitsplatz |
| Kunde ruft zurück, Markus erkennt ihn nicht | Anrufhistorie und Rückruf-Suche ab Etappe 1b, automatische Erkennung separat; einheitliche Nummern |
| Firmenweite Berechtigung für Teams-Anrufprotokolle (Rückruf-Erkennung) | nur Anrufe auf Markus' Nummer verarbeiten, Rest sofort verwerfen, Zugriffe protokollieren |
| Analysen zur Freigabe bleiben liegen | Zähler in der Kopfleiste; die Notiz steht ohnehin schon im CRM, eine nicht freigegebene Analyse fehlt nur als Ergänzung |
| Portal ist zu überladen, Markus weicht aufs CRM aus | Bedienkonzept 6.0, Klick-Prototyp in Etappe 0, Testtag mit Markus vor dem Livegang |

---

## 13. Nicht Teil des Portals

- Listen vorbereiten, Anreichern, Import (Vorstufe, Abschnitt 4.1) – später evtl. als Admin-Seite
- Lemlist-Kampagnen, Flow «Offerte an CRM» (bleiben, Ergebnisse erscheinen im Verlauf)
- Landingpages (KI-Check), ERP-Invoice, Kally-Design (weitere Vorhaben aus V1)
