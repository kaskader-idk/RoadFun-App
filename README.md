# RoadFun 🚗

**Private Community für Autofahrer – als Web-App und installierbare iPhone-PWA.** C# / ASP.NET Core 8 + SQLite + Leaflet/OpenStreetMap. Ausgangsbasis: [PLANS.md](PLANS.md).

## Aktueller Funktionsumfang

| Funktion | Stand |
|---|---|
| Responsive Web-App / iPhone Home-Screen-App | ✅ PWA, gleicher Funktionsumfang |
| Login, Einladungscode, Profile, Auto, Alter, Bio, Bild | ✅ |
| Freundescode, Anfragen, Textchat | ✅ (Chat aktualisiert alle 10 s) |
| Karte, GPS-Marker, Freunde mit freiwilliger Freigabe | ✅ |
| Meldungen: Polizei, mobile/feste Blitzer, Stau, Gefahr, Blickrichtung | ✅ |
| Car Meets erstellen, ansehen, zusagen, Ziel zur Route übernehmen | ✅ |
| Routenwahl schnell / kurz / eco / fun, KM und ETA | 🟡 OSRM-Alternativen; eco/fun nur Heuristiken, **keine** Live-Verkehrsdaten |
| Experimentelle GPS-Manöver-Navigation mit optionaler Sprache | 🟡 Neu: Abbiegungen von OSRM, Anzeige und Sprachausgabe im Vordergrund; kein Re-Routing |
| Strecken auf Karte anlegen, GPS-Auto-Timer, Distanz, max/Ø km/h, Längs-g | 🟡 GPS-basiert, nicht verifiziert, nur abgesperrte Strecken |
| Drehbare 3D-Routen-Höhenansicht, Raster ein/aus | 🟡 Höhenlinie statt vollwertigem 3D-Terrain oder Gebäuden |
| Admin-Fahrerkarte | ✅ Nur aktive, ausdrücklich freigegebene Standorte |
| Native iOS IPA / Android APK, Hintergrund-GPS, Turn-by-Turn | ❌ Noch nicht umgesetzt |
| Microsoft SQL Server .mdf | ❌ Stattdessen SQLite (Linux-tauglich, siehe unten) |

Nicht als vollständig fertig oder sicher für öffentlichen Betrieb betrachten: siehe [DARFNICHT.md](DARFNICHT.md).

## Neu: Navigations- und Stabilitätsupdate (Oktober 2026)

- OSRM-Routen liefern nun Abbiegehinweise einschließlich Manöverposition, Richtung und Straßenname.
- Nach dem Berechnen einer Route **Navigation starten (Testversion)** wählen. Die Karte folgt der GPS-Position, zeigt den nächsten Richtungswechsel sowie die ungefähre **Luftlinie** dorthin. Sprachhinweise kannst du vor der Fahrt freiwillig einschalten.
- **Wichtige Grenzen:** nur GPS bei geöffneter App, keine automatische Neuberechnung bei Abweichung, keine verlässliche Meterangabe entlang der Straße, kein Live-Verkehr. Kein Ersatz für eine vollwertige Navigation. **Vor Fahrtbeginn einstellen, nicht am Steuer bedienen.**
- Sicherheitskorrektur: Private Strecken anderer Nutzer können nicht mehr für eigene Messungen referenziert werden. Positionsdaten werden beim Abschalten der Freigabe vollständig geleert.
- Login-Limits sind nach Verbindungs-IP statt appweit gruppiert. Hinter einem gemeinsamen Reverse Proxy können sich Nutzer das Limit dennoch teilen.
- Erweiterter API-Smoke-Test inkl. simuliertem OSRM, privaten Strecken und Standortfreigaben.

### Update auf bestehendem Server (Daten bleiben erhalten)

```bash
cd ~/RoadFun-App
git pull --ff-only
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8090/api/health
```

Das Docker-Volume `roadfun-app_roadfun_data` sowie die lokale `.env` bleiben dabei erhalten. **Nicht** `docker compose down -v` verwenden. Falls dein iPhone weiterhin die alte Version anzeigt, die Web-App schließen und neu öffnen oder einmal in Safari neu laden.

## Installation auf deinem Proxmox-Server (Debian-LXC oder Debian-VM)

Am einfachsten in einer **eigenen Debian-VM oder einem für Docker geeigneten LXC** statt direkt auf dem Proxmox-Hypervisor. Docker Engine und das Compose-Plugin müssen installiert sein. Docker in einem Proxmox-LXC erfordert ggf. Nesting; für problemfreie Isolation lieber eine kleine Debian-VM verwenden.

### 1. App starten

```bash
git clone https://github.com/kaskader-idk/RoadFun-App.git
cd RoadFun-App
cp .env.example .env
nano .env
```

Ersetze in `.env` **beide** Werte für `ROADFUN_ADMIN_PASSWORD` (mindestens 12 Zeichen) und `ROADFUN_INVITE_CODE` durch eigene, lange, zufällige Passwörter. Beispiel zum Generieren:

```bash
openssl rand -hex 24
```

Dann:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8090/api/health
```

Erwartete Antwort: `{"status":"ok",...}`. Im lokalen Netzwerk ist die Seite dann unter `http://<IP-der-VM-oder-des-CT>:8090` erreichbar.

**Account:** Benutzername `Admin`, Passwort ist dein `ROADFUN_ADMIN_PASSWORD`. Registrieren dürfen sich andere Nutzer nur mit deinem `ROADFUN_INVITE_CODE` (Registrieren-Schaltfläche auf der Anmeldeseite). `123321` ist bewusst nicht als öffentlich bekanntes Standardpasswort aktiviert.

> Wenn du das Admin-Passwort später in `.env` änderst, wird ein *bereits bestehender* Admin-Account nicht automatisch zurückgesetzt. Für den ersten Start vorab festlegen.

### Wenn der Docker-Build mit einer alten C#-Version fehlschlägt

Falls du zuvor den Fehler `CS0819` in `Program.cs` erhalten hast, lade zuerst den aktuellen Code:

```bash
cd ~/RoadFun-App
git pull --ff-only
docker compose build --progress=plain roadfun
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8090/api/health
```

Der frühere `var x1 = ..., y1 = ...`-Compilerfehler wurde behoben. Wenn der Build dennoch fehlschlägt, die **erste neue Compilerfehlermeldung** einschließlich Dateiname und Zeilennummer prüfen. Bei einem Containerstartfehler: `docker compose logs --tail=100 roadfun`.

### 2. Über HTTPS bereitstellen (erforderlich für iPhone-GPS und PWA)

Smartphone-GPS / Service Worker benötigen einen **sicheren HTTPS-Ursprung** (HTTP funktioniert für die Website, nicht zuverlässig für diese Funktionen). **Port 8090 niemals direkt ins Internet freigeben.**

Wenn du bereits **Nginx Proxy Manager** auf deinem Netzwerk betreibst:

1. Füge unter **Proxy Hosts → Add Proxy Host** deine Domain hinzu, beispielsweise `roadfun.deinedomain.at`.
2. Scheme: **http**, Forward Hostname/IP: **IP der VM/des Containers, auf dem RoadFun läuft**, Forward Port: **8090**.
3. Im SSL-Reiter ein **gültiges Zertifikat** auswählen/erstellen, **Force SSL** aktivieren. Für Let's Encrypt ist eine erreichbare gültige Domain nötig; `.home` erhält kein öffentliches Let's-Encrypt-Zertifikat.
4. Per LAN, VPN oder einem sicher konfigurierten Tunnel auf die HTTPS-Domain zugreifen. Für private Nutzung kann eine interne CA funktionieren, wenn das iPhone dieser CA **ausdrücklich** vertraut.

**Wenn du einen eigenen lokalen CA-Zertifikatsaussteller nutzt (z. B. \`roadfun.home\`):** Exportiere das **Root-CA-Zertifikat** (nur den öffentlichen Teil, **niemals den privaten Schlüssel**), übertrage es auf das iPhone und öffne es dort. Installiere das geladene Profil unter **Einstellungen → Allgemein → VPN & Geräteverwaltung**. Aktiviere anschließend unter **Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen** das vollständige Vertrauen für genau diese CA. Die RoadFun-URL muss zum Hostnamen im Serverzertifikat passen. Du solltest nur deiner eigenen CA vertrauen. Dokumentation: https://support.apple.com/en-au/102390

Deine Proxmox-IP, die RoadFun-IP und die Proxy-IP sind nicht zwangsläufig gleich. Verwende die tatsächliche IP des Gerätes/CT, wo Docker läuft.

### 3. Auf dem iPhone installieren – **ohne App Store, Sideloadly oder Apple-Developer-Konto**

1. Auf dem iPhone in **Safari** die **HTTPS-Adresse** von RoadFun öffnen.
2. **Teilen** → **Zum Home-Bildschirm** (ggf. „Als Web-App öffnen“ aktivieren) → **Hinzufügen**.
3. RoadFun über das Icon öffnen; ggf. **Standort erlauben**.
4. Für Freunde-Live-Standort in **Profil → Live-Standort teilen** einschalten. Standard: **aus**.

Es ist **eine PWA, keine native .ipa-Datei**. Das iPhone stoppt/pausiert GPS im Hintergrund bzw. bei gesperrtem Bildschirm; für Zeitmessungen geöffnet lassen. Eine native iOS-App mit dauerhaftem Hintergrund-GPS würde einen macOS/Xcode-Build und zusätzliche iOS-Berechtigungen brauchen.

### 4. Updates & Backup

```bash
cd RoadFun-App
git pull --ff-only
docker compose up -d --build
docker compose logs -f --tail=100
```

Die Daten liegen persistent im Docker-Volume `roadfun_data` (SQLite DB, Avatare). Backup bei angehaltenem Container:

```bash
docker compose stop roadfun
docker run --rm -v roadfun-app_roadfun_data:/source:ro -v "$PWD":/backup alpine sh -c 'cd /source && tar czf /backup/roadfun-backup.tar.gz .'
docker compose start roadfun
```

**Wichtig:** Der Volume-Name hängt vom Compose-Projektnamen ab. Vorher mit `docker volume ls` prüfen und ggf. `roadfun-app_roadfun_data` anpassen. `docker compose down -v` **löscht alle App-Daten**.

### 5. API lokal ohne Docker (für Entwicklung)

.NET SDK 8.0 installieren, dann:

```bash
export ROADFUN_ADMIN_PASSWORD="$(openssl rand -hex 24)"
export ROADFUN_INVITE_CODE="$(openssl rand -hex 24)"
dotnet run --project src/RoadFun.Api/RoadFun.Api.csproj
```

Den angezeigten lokalen HTTP-Port öffnen. Für GPS auf anderen Geräten HTTPS verwenden. Tests: `dotnet build src/RoadFun.Api/RoadFun.Api.csproj -c Release`, `node --check src/RoadFun.Api/wwwroot/app.js`, `bash scripts/smoke-test.sh`.

## Bedienung

- **Route:** Start optional auf Karte wählen; ohne Startpunkt aktuelle GPS-Position. Ziel auswählen, Modus wählen, berechnen. Ergebnis enthält Entfernung und Ankunftszeit.
- **Melden:** Karte antippen (oder aktuelle Position übernehmen), Kategorie und optional Blickrichtung (0° Nord / 90° Ost) eintragen. Meldungen werden als rote Kreise sichtbar.
- **Strecken:** Start und Ziel auf Karte wählen; Strecke speichern; anschließend „GPS-Messung aktivieren“. Für einen eindeutigen Start zuerst mindestens 65 m von der Startzone entfernen und dann innerhalb von 35 m einfahren. Stop innerhalb von 35 m um den Zielpunkt, frühestens nach 5 Sekunden. Keine zuverlässige Sport-Zeitnahme; GPS-Fehler und iOS-Aussetzer möglich.
- **3D-Höhe:** Erst Route berechnen, dann „3D-Höhe“ öffnen und mit Finger/Maus drehen.
- **Freunde:** Freundescode teilen; Anfrage annehmen; Chat öffnen. Standort nur bei aktivierter, freiwilliger Freigabe.
- **Meets:** Punkt auf Karte, Datum und Beschreibung anlegen; Freunde können auf „Teilnehmen“ klicken.

## Architektur & Privatsphäre

```text
iPhone PWA / Desktop Browser --HTTPS--> Reverse Proxy (NPM/Caddy)
                                          |
                                    RoadFun ASP.NET Core
                                          |
                           Docker volume /data/roadfun.db (SQLite)
                                          + /data/avatars/
                                          |
                         Routing: OSRM; Elevation: OpenTopoData
Kartenkacheln: OpenStreetMap (direkt Browser -> OSM)
```

- Sessions: 30 Tage, serverseitig gespeicherter SHA-256-Hash des zufällig generierten Tokens.
- Passwörter: PBKDF2-SHA256 mit individuellen Salts; Einladungsgeheimnis wird serverseitig geprüft.
- Freundesstandorte: nur bei Opt-in, ausschließlich für bestätigte Freunde und Admin, nur wenn Update höchstens 3 Minuten zurückliegt. GPS-Aufzeichnung auf dem Client startet für die Anzeige; Positionen werden nur mit Opt-in an den Server geschickt.
- Chat, Meldungen, Strecken, Messergebnisse und Treffen sind auf dem privaten Server persistent.
- Admin hat Überblick über Benutzer, **aber nicht** Zugriff auf ausdrücklich nicht freigegebene Live-Positionen.
- Die Karte und externe Routing-/Höhendienste benötigen Internet; der Offline-Service-Worker cached nur die App-Oberfläche, **keine Offline-Karten**.
- Der Standard-OSRM-Demodienst ist nicht für hohe Last oder verlässlichen Dauerbetrieb bestimmt. Für regelmäßige Nutzung eigenen OSRM-Service konfigurieren: `ROADFUN_ROUTING_URL=https://dein-routing-service`. Das Demo ist nicht mehr als 1 Anfrage/Sekunde vorgesehen.
- Externe Karte, Routing und Höhendienste sehen in unterschiedlichem Umfang abgefragte Koordinaten/IP-Adressen. Für vollständige Datenhoheit diese selbst hosten und die CDN-Bibliotheken lokal ausliefern.

## Einschränkungen / offene Aufgaben

- **Keine fertige native iOS- oder Android-App**; die PWA ist der lauffähige Handy-Client. Keine Push-Nachrichten.
- **Kein Turn-by-Turn** mit Sprachanweisung, keine Live-Staumessung, keine echte fahrdynamische Eco-/Fun-Berechnung. Nur OSRM-Routenalternativen.
- **Kein vollständiges 3D-Straßen-/Gebäude-/Terrainmodell**; 3D zeigt echte, sofern verfügbare Höhenpunkte entlang der Route und ein optionales Raster.
- **SQLite `.db` statt `.mdf`**: `.mdf` gehört zu Microsoft SQL Server/LocalDB; SQLite ist für Linux/Proxmox einfacher. Ein späterer Datenbankprovider-Wechsel ist eine zusätzliche Entwicklungsarbeit.
- **Zeitmessung nicht manipulationssicher**, keine offizielle Rangliste. Straßenrennen im öffentlichen Verkehr sind kein unterstütztes Anwendungsszenario.
- Kein Mailversand zur Account-Wiederherstellung, keine Moderationskonsole, keine vollständige automatisierte Penetrationsprüfung. Vor Exposition gegenüber Fremden Sicherheitsreview und Backups durchführen.

## Hinweise zu externen Diensten und Recht

© OpenStreetMap-Mitwirkende. Bei den OSM-Standardtiles die Nutzungsrichtlinie beachten (kein massenhaftes Herunterladen oder Offline-Prefetch): https://operations.osmfoundation.org/policies/tiles/

OSRM-Demodienst: https://github-wiki-see.page/m/Project-OSRM/osrm-backend/wiki/Demo-server

Österreich: Bedienung von Radar-/Staumelde-Apps während der Fahrt ist grundsätzlich eingeschränkt; die behördliche Ausnahme für navisystemähnliche Apps und montierte Geräte setzt konkrete Voraussetzungen voraus. Einträge und Suchen nur **im stehenden Fahrzeug** vornehmen: https://www.oesterreich.gv.at/

RoadFun ist ein privates Hobbyprojekt. Kein Ersatz für zugelassene Navigation, keine Garantie für Radar- oder Polizeimeldungen. Prüfe [DARFNICHT.md](DARFNICHT.md) für die Abweichungen vom ursprünglichen Plan.
