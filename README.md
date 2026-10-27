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
| 3D-Gelände entlang der Route, Satellitenbilder, OSM-Bäume und 5 Ebenen-Schalter | 🟡 Mapzen DEM + Esri World Imagery + OSM (Bäume in Wäldern nur modellhaft, keine Gebäude) |
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

## Routing-Fix: HTTP 502 / Ausfall des OSRM-Demoservers

Wenn `/api/route` bislang `502 Bad Gateway` zurückgab, konnte das Backend seinen konfigurierten externen OSRM-Routingdienst nicht nutzen. Die aktualisierte Version probiert automatisch Valhalla als zweite Engine und cached erfolgreiche Antworten für 15 Minuten. Der aktive Anbieter steht nach einer Berechnung in der Routenübersicht (`OSRM`, `Valhalla` oder `(Cache)`). Ein Provider-HTTP-Fehler oder Timeout erzeugt jetzt eine aussagekräftigere Fehlermeldung.

**Beim Update werden deine Benutzerkonten und Daten nicht gelöscht:**

```bash
cd ~/RoadFun-App
git pull --ff-only
docker compose up -d --build
curl -fsS http://127.0.0.1:8090/api/health
```

Prüfe das Routing (Koordinaten-Beispiel aus Oberösterreich). Der Endpoint benötigt Anmeldung; wähle zur manuellen Prüfung am besten die Route direkt in der RoadFun-Oberfläche. Teste bei einem erneuten Fehler zunächst die Erreichbarkeit von **beiden** Routing-Anbietern aus demselben Container:

```bash
docker exec roadfun sh -c 'getent hosts router.project-osrm.org; getent hosts valhalla1.openstreetmap.de'
docker logs roadfun --tail 100
curl -I --max-time 10 https://router.project-osrm.org
curl -I --max-time 10 https://valhalla1.openstreetmap.de/status
```

Hinweis: Host-`curl` allein beweist nicht, dass aus **Docker** heraus alle ausgehenden Verbindungen funktionieren. Zum Test im gleichen Netzwerk kann man einen temporären `curlimages/curl`-Container starten:

```bash
docker run --rm --network container:roadfun curlimages/curl:latest -I --max-time 10 https://valhalla1.openstreetmap.de/status
```

Wenn **beide** externen Dienste ausfallen, liegt das Problem wahrscheinlich bei DNS, TLS, Docker-Networking oder den öffentlichen Servern. Ein lokaler OSRM/Valhalla-Server über `ROADFUN_ROUTING_URL` ist langfristig zuverlässiger. Die zweite Engine lässt sich via `ROADFUN_ROUTING_FALLBACK_URL` konfigurieren (oder auf `disabled` setzen).

OSRM und Valhalla sind **öffentliche Demo-Server**, keine garantierten Produktivdienste. Bitte sparsam verwenden (RoadFun drosselt Demo-Anfragen) und die entsprechenden Nutzungsrichtlinien einhalten: https://github-wiki-see.page/m/Project-OSRM/osrm-backend/wiki/Demo-server und https://valhalla.github.io/valhalla/start/introduction/. Die Abfrage überträgt Start- und Zielkoordinaten an den jeweiligen Dienst.

## Neu: Lokales High-Speed-Routing und adressbasierte Navigation

**Routing-Algorithmus:** Optional wird RoadFun jetzt von einem lokalen OSRM-Server versorgt, der **Contraction Hierarchies (CH)** verwendet. CH beschleunigt die Route selbst durch eine einmalige Aufbereitung des Straßengraphen. Das ist bei statischen Straßengewichten sehr schnell; für sehr häufig veränderte Verkehrsdaten ist OSRM-MLD besser geeignet. RoadFun unterstützt derzeit keine Echtzeit-Verkehrsdaten und bietet bei Eco/Fun eine heuristische Wahl aus Routing-Alternativen, **keinen eigenständigen optimierten Eco-/Kurven-Algorithmus**.

**Lokal auf Proxmox starten (optional):** Der Stand der App funktioniert weiterhin ohne lokalen OSRM mit den bisherigen öffentlichen Providern. Ein lokaler Routingserver braucht freien Speicherplatz, viel RAM während des Imports und eine OpenStreetMap-PBF-Datei. Das Geofabrik-Extrakt `austria-latest.osm.pbf` wird beim ersten Aufruf heruntergeladen.

```bash
cd ~/RoadFun-App
bash scripts/setup-local-routing.sh
```

Auf einem Host mit wenig RAM (z. B. 8 GB) kann die CH-Aufbereitung für ganz Österreich fehlschlagen oder vom OOM-Killer beendet werden. Dann einen **kleineren PBF-Ausschnitt für die Region** bereitstellen und das Skript mit `ROADFUN_PBF_FILE=/absoluter/pfad/region.osm.pbf bash scripts/setup-local-routing.sh` aufrufen. Solche Ausschnitte decken nur das gewählte Gebiet ab, inklusive eventueller Grenzen. Die vorbereiteten Graphdateien liegen unter `routing-data/` und werden nicht auf GitHub hochgeladen.

Nach erfolgreicher Vorbereitung in `.env` eintragen:
```env
ROADFUN_ROUTING_URL=http://osrm:5000
```

Danach **beide Container** hochfahren:

```bash
docker compose --profile local-routing up -d --build
docker compose ps
docker compose logs --tail 50 osrm
```

Der OSRM-Port 5000 wird nur **intern im Docker-Netz** freigegeben. Die Straßenroute benötigt nach der Aufbereitung **keine externe Routing-API**; bei Nichtverfügbarkeit kann RoadFun weiter den in `.env` angegebenen Valhalla-Dienst als Fallback verwenden. Die Geocodierung ist davon unabhängig.

**Google-Maps-artige Routeneingabe:** Über **Route** erscheint jetzt links oben ein schwebendes Fenster auf der Karte. Start und Ziel können per Adresse, `Breitengrad, Längengrad` oder über die Kartennadel gewählt werden. Adressen werden über Photon gesucht, von RoadFun auf fünf Ergebnisse und auf sparsame Anfragen begrenzt. Bei einem eigenen Photon-Server kann `ROADFUN_GEOCODER_URL` in `.env` gesetzt werden. Der öffentliche Photon-Demoserver kann ausfallen oder Anfragen drosseln; Kartenauswahl/Koordinaten funktionieren unabhängig davon.

## Neu: 3D-Gebäude und sichtbarere Wälder

In der 3D-Ansicht gibt es einen unabhängigen **Häuser**-Schalter. Die Modelle werden als einfache Gebäudekörper aus kartierten OSM-Grundrissen extrudiert; `height` oder `building:levels` steuern die Höhe, andernfalls wird die Höhe geschätzt. Es gibt keine echten Fassaden, präzise Dachformen oder LIDAR-Gebäudedaten. Pro Ansicht werden bis zu 180 Gebäude gebaut.

Die Baumabfrage kann nun einen **kleinen, begrenzten Ausschnitt um die Streckenmitte** auch bei langen Routen laden; außerdem wurde ein zweiter Overpass-Dienst als Fallback ergänzt und das Netzwerktimeout erhöht. Bäume erscheinen nur dort, wo OSM `natural=tree` oder Waldflächen kartiert hat; Waldflächenbäume sind **synthetisch verteilte** Modelle, keine wirklich vermessenen Baumstandorte. Das Geländeraster wurde von rund 32 auf bis zu **60 Unterteilungen pro Kachel** verfeinert; das bietet glattere Übergänge, ist aber kein höher aufgelöstes Höhendataset.

Quellen: [OSRM-Anleitung](https://project-osrm.org/docs/v26.4.0/tools), [Austria OSM PBF](https://download.geofabrik.de/europe/austria.html), [Photon](https://github.com/komoot/photon), [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API). Bei Gebäude-/Waldfragen sendet der Server nur den Kartenausschnitt an den OSM-Provider. Die 3D-Darstellung benötigt weiterhin Internet für Satellitenbilder/Höhendaten.

## Neu: Realitätsnäheres 3D-Gelände, Satellit und Vegetation

Im **3D-Höhen**-Fenster wird die berechnete Route auf ein echtes Höhenmodell drapiert statt frei im Raum angezeigt. Umgebendes Gelände wird aus [Mapzen Terrain Tiles / AWS Open Data](https://registry.opendata.aws/terrain-tiles/) erzeugt (Terrarium-RGB dekodiert als Höhe in Metern). [Esri World Imagery](https://www.esri.com/en-us/arcgis/products/arcgis-online/resources) kann als Satellitentextur darüber angezeigt werden. Die Straße bleibt die geglättete OSRM/Valhalla-Geometrie.

**Unabhängige 3D-Schalter:** Gelände, Satellitenbilder, Bäume, Straße sowie Raster/Nordpfeil; außerdem frei einstellbare Reliefüberhöhung und Kamera-Reset. Startmarker grün, Zielmarker rot.

**Bäume:** Der Backend-Endpunkt `/api/terrain/vegetation` fragt mit einem **serverseitig festgelegten, begrenzten Overpass-QL-Ausdruck** einen kleinen Ausschnitt über [OpenStreetMap / Overpass by Private.coffee](https://overpass.private.coffee/) ab. Einzelne mit `natural=tree` markierte Bäume werden an ihrem echten OSM-Kartenpunkt platziert. Für `natural=wood`- bzw. `landuse=forest`-Polygone verteilt RoadFun **stilisierte, deterministisch erzeugte Modelle** innerhalb der Flächen. Dies ist **keine** vollständige Messung einzelner Baumstandorte oder eine 3D-Rekonstruktion: unkartierte Baumgruppen fehlen, Satellitenbilder können älter sein.

**Daten-/Leistungslimits:** maximal 16 Satellitenkacheln pro angezeigter Route, automatisch reduzierter Detailgrad für lange Routen; maximal 500 Baum-Modelle; maximal 0,12° pro Achse für detaillierte Vegetationsabfragen. Höhenraster wird passend zur Karte auf maximal Zoom 13 geladen, damit das iPhone nicht überlastet wird. Externe Quellen erfordern Internetzugriff **vom iPhone/Browser** (Satellit und Höhenkacheln) bzw. **vom RoadFun-Docker-Container** (Baumdaten). Ein Ausfall von Satellitenbildern wird durch eine einfarbige Reliefkarte abgefangen; bei Ausfall des Mapzen-Dienstes wird auf die ältere Höhenlinien-Ansicht zurückgefallen.

**Datenschutz und Urheberrecht:** Die Abfrage von Satelliten-/Höhenkacheln überträgt den gewählten Kartenausschnitt an Esri bzw. AWS; der OSM-Baumdienst erhält den Ausschnitt vom Server. Keine Weitergabe von Account-Passwörtern. Esri-Bilder dürfen nur gemäß den geltenden Nutzungsbedingungen verwendet werden; die Kartendarstellung zeigt die jeweiligen Quellen und ein dauerhaftes Quellenfeld. OSM-Daten stehen unter ODbL und benötigen Attribution. Höhenquellen können regional unterschiedliche Qualität und Auflösung haben.

**Update (Volume und Accounts bleiben erhalten):**
```bash
cd ~/RoadFun-App
git pull --ff-only
docker compose up -d --build
docker compose ps
```
Die PWA-Asset-Version wurde erhöht; bei veralteter Ansicht Safari neu laden bzw. die Homescreen-App ganz schließen.

## 3D-Routenansicht: korrekt ausgerichtete, breite Straßenkurve

Die 3D-Ansicht verwendet jetzt **alle detailreichen Koordinaten** der berechneten Route als Kurvenstützpunkte statt nur 30 geradlinig verbundene Punkte. Eine **centripetale Catmull-Rom-Kurve** glättet die Anzeige und erzeugt eine **breite blaue Straßenfläche** mit hellen Außenkanten, grünem Startpunkt und rotem Zielpunkt. Der Nordpfeil zeigt im 3D-Koordinatensystem wirklich nach Norden; Osten ist rechts, Norden vorne oben aus der voreingestellten Kameraposition. Die Kamera ist weiterhin vollständig drehbar, und **Ansicht zurücksetzen** stellt die Ausgangsperspektive wieder her.

Die bis zu 30 extern abgefragten Höhendatenpunkte werden nun **nach echter Entfernung entlang der Route** verteilt und anschließend für jeden detaillierten Routenpunkt interpoliert. Das verhindert, dass Höhenwerte fälschlich nach Arrayposition statt nach Streckenlänge zugeordnet werden.

Die Linienbreite ist **zur Sichtbarkeit bewusst übertrieben**. Das Gelände bleibt ein ebenes Raster; es handelt sich nicht um echte 3D-Landschaft, realistische Fahrbahnabmessungen oder LIDAR-Straßendaten.

Für die iPhone-PWA wurden die Dateien versionsweise aktualisiert. Nach dem Serverupdate die RoadFun-App schließen und neu öffnen; falls notwendig in Safari die Website neu laden.

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
