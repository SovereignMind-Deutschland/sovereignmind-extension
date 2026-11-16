# Sicherheit / Security

## Schwachstelle melden

Bitte melde Sicherheitslücken **nicht** als öffentliches Issue, sondern per E-Mail an
**sovereignmind.de@gmail.com** (Betreff beginnt mit `[SECURITY]`).

Hilfreich sind:

- betroffene Komponente und Version (Datumsversion `JJJJ.MM.TT.HHMM` bzw. Versionsnummer),
- Schritte zum Nachstellen oder ein Proof of Concept,
- Auswirkung aus deiner Sicht und ob die Lücke bereits ausgenutzt wird,
- wie wir dich für Rückfragen erreichen (und ob du namentlich genannt werden möchtest).

Bitte keine echten personenbezogenen Daten oder Kundendaten mitschicken.

## Geltungsbereich

Dieses Repository: die VS-Code-Erweiterung *SovereignMind Preflight* (Prüfläufe, Sonar- und Installer-Ansichten). Lücken in der Anwendung selbst gehören zum Hauptrepository `sovereignmind`, die Meldeadresse ist dieselbe.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für die **jeweils neueste Version** der Erweiterung.

## Ablauf

1. **Eingang:** Wir bestätigen den Eingang deiner Meldung, Ziel: innerhalb von 3 Werktagen.
2. **Bewertung:** Wir stellen die Lücke nach, bewerten Schwere und Betroffenheit und melden uns mit dem Ergebnis.
3. **Behebung:** Wir entwickeln eine Korrektur und stimmen den Veröffentlichungstermin mit dir ab
   (koordinierte Offenlegung, in der Regel spätestens 90 Tage nach Eingang).
4. **Veröffentlichung:** Die Korrektur erscheint in einer neuen Version mit Hinweis im Changelog.
   Auf Wunsch nennen wir dich als Finder.

Wird eine Lücke **aktiv ausgenutzt**, gelten zusätzlich die Meldepflichten nach Art. 14 der EU-Verordnung über
Cyberresilienz (CRA): Frühwarnung innerhalb von 24 Stunden und Meldung innerhalb von 72 Stunden an das zuständige
CSIRT (in Deutschland das BSI). Den internen Ablauf beschreibt `Support/docs/recht/cra-meldeablauf.md` im
Hauptrepository.

## English

Please report security vulnerabilities privately by e-mail to **sovereignmind.de@gmail.com**
(subject starting with `[SECURITY]`), not as a public issue. We aim to acknowledge reports within
3 business days and coordinate disclosure with you (usually within 90 days).
