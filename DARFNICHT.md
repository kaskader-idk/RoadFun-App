# DARFNICHT.md – Recht, Sicherheit und nicht vollständig umgesetzte PLANS.md-Punkte

Stand: 27. Oktober 2026. Diese Datei beschreibt **keine pauschal „verbotenen“ Funktionen**, sondern die aus Sicherheits-, Rechts- und Zeit-/Technikgründen bewusst eingeschränkten oder noch nicht umgesetzten Anforderungen.

## Im Straßenverkehr

1. **Zeitfahren auf öffentlichen Straßen**: RoadFun stellt eine GPS-Zeitmessung bereit, aber ausschließlich als private Messhilfe **für rechtmäßig freigegebene, abgesperrte Strecken**. Es gibt keine öffentliche Bestenliste und keine Aufforderung, Geschwindigkeitsbegrenzungen zu überschreiten. Manipulationssicherheit/GPS-Präzision nicht garantiert.
2. **Polizei-, Radar-, Stau- und Gefahrenmeldungen**: Meldefunktion ist vorhanden, aber das Melden/Bedienen während der Fahrt darf nicht gegen österreichisches Recht verstoßen. Laut oesterreich.gv.at dürfen Smartphone-Stau- und Radarmelde-Apps während der Fahrt grundsätzlich nicht verwendet werden; Ausnahme für navigationsähnliche Funktion mit montiertem Gerät unter weiteren Voraussetzungen. **Beim Melden, Tippen, Suchen und Eingeben anhalten.** Meldungen dürfen nicht für Behinderung oder Umgehung von Polizeiaktionen missbraucht werden.
3. **„Fun“-Route** ist eine experimentelle Krümmungs-Heuristik über OSRM-Alternativen, nicht eine Empfehlung, schneller zu fahren. Straßenregeln haben Vorrang.

## Privatsphäre und Zugang

4. **Admin "Admin" / Passwort "123321"** wird **nicht** mit allgemein bekanntem schwachem Standardkennwort angelegt. Stattdessen beim ersten Start `ROADFUN_ADMIN_PASSWORD` (mindestens 12 Zeichen) konfigurieren. Der Account heißt weiterhin `Admin`.
5. **„Admin sieht alle Fahrer“** bedeutet in dieser Version: Admin sieht die **aktiven Nutzer, die ihren Live-Standort freiwillig freigeben**. Andere dürfen nicht heimlich geortet werden. Sichtbarkeit für Freunde nur bei akzeptierter Freundschaft.
6. Öffentlicher Zugriff mit Standortdaten verlangt **HTTPS, Einwilligung, sichere Zugangsdaten, Updates, Backups**. Details siehe README.

## Technische Abweichungen gegenüber PLANS.md

7. **Dateiformat**: Persistenz in `/data/roadfun.db` (SQLite) anstelle von `.mdf` (SQL Server LocalDB). Grund: SQL Server LocalDB/MDF sind für Windows gedacht; Proxmox/Linux/kleiner privater Server profitiert von SQLite. Das Backend ist weiterhin C#.
8. **iOS**: Funktionierende installierbare PWA als erster Handy-Client, **keine native iOS-IPA**; Android ist verschoben. Für native iOS-Builds wäre Xcode auf macOS erforderlich.
9. **Navigation**: Kein sprachgeführtes Turn-by-Turn, keine Stau-ETA in Echtzeit. Modus „eco“/„fun“ ist eine begrenzte Bewertungsheuristik für vom Routinganbieter bereitgestellte Alternativen. Ohne Alternativen kein anderer Streckenverlauf.
10. **3D-Umgebung**: Drehbare Höhenroute mit optionalem Raster; keine vollwertige Geländemasche, Gebäude oder realistische 360°-Street-View-Umgebung.
11. **Live-GPS bei gesperrtem iPhone**: Browser/PWA können GPS im Hintergrund unterbrechen. Für Streckenmessung Display aktiv und App im Vordergrund.
12. **Sicherheit/Tests**: Build- und Smoke-Test-Workflow vorhanden, aber noch kein umfangreiches Integrationstest-, Abuse-, Moderations- oder Penetrationsprogramm. App nicht ungeprüft öffentlich freischalten.

**Quellen:** https://www.oesterreich.gv.at/ · https://operations.osmfoundation.org/policies/tiles/ · https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27
