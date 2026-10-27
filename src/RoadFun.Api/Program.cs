using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Data.Sqlite;
using System.Globalization;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseWebRoot("wwwroot");
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    // Rate-limit per connecting IP rather than putting all friends in one bucket.
    // Do not trust a client-supplied X-Forwarded-For header.
    o.AddPolicy("auth", context => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            Window = TimeSpan.FromMinutes(1),
            PermitLimit = 20,
            QueueLimit = 0,
            AutoReplenishment = true
        }));
});
builder.Services.AddHttpClient("routing", c => c.Timeout = TimeSpan.FromSeconds(15));
var dataDir = Environment.GetEnvironmentVariable("ROADFUN_DATA_DIR") ?? Path.Combine(builder.Environment.ContentRootPath, "data");
Directory.CreateDirectory(dataDir);
var avatarDir = Path.Combine(dataDir, "avatars");
Directory.CreateDirectory(avatarDir);
var db = new Store(Path.Combine(dataDir, "roadfun.db"));
db.Init();
var adminPassword = Environment.GetEnvironmentVariable("ROADFUN_ADMIN_PASSWORD");
var privateInvite = Environment.GetEnvironmentVariable("ROADFUN_INVITE_CODE");
if (string.IsNullOrWhiteSpace(adminPassword) || adminPassword.Length < 12 ||
    adminPassword.StartsWith("REPLACE-", StringComparison.OrdinalIgnoreCase))
    throw new Exception("Set a unique ROADFUN_ADMIN_PASSWORD (>=12 characters) in .env");
if (string.IsNullOrWhiteSpace(privateInvite) || privateInvite.Length < 16 ||
    privateInvite.StartsWith("REPLACE-", StringComparison.OrdinalIgnoreCase))
    throw new Exception("Set a unique ROADFUN_INVITE_CODE (>=16 characters) in .env");
{
    // Seed only on the first start; never silently overwrite an existing password.
    if (db.One("SELECT id FROM users WHERE username='Admin'") is null)
        db.Exec("INSERT INTO users(id,username,pass_hash,code,is_admin) VALUES($id,'Admin',$pw,$code,1)",
            ("$id", Guid.NewGuid().ToString("N")), ("$pw", Auth.Hash(adminPassword)), ("$code", Auth.Code()));
}
var app = builder.Build();
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["X-Frame-Options"] = "DENY";
    ctx.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    await next();
});
app.UseRateLimiter();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(avatarDir), RequestPath = "/avatars" });
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/api") &&
        !new[] { "/api/health", "/api/auth/login", "/api/auth/register" }.Contains(ctx.Request.Path.Value, StringComparer.OrdinalIgnoreCase))
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
        var user = db.One(@"SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id
            WHERE s.token_hash=$hash AND s.expires_at > $now",
            ("$hash", Auth.TokenHash(token)), ("$now", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
        if (user is null) { ctx.Response.StatusCode = 401; await ctx.Response.WriteAsJsonAsync(new { error = "Bitte anmelden" }); return; }
        ctx.Items["user"] = user;
    }
    await next();
});
var api = app.MapGroup("/api");
api.MapGet("/health", () => Results.Ok(new { status = "ok", utc = DateTime.UtcNow }));

api.MapPost("/auth/register", (Register req) =>
{
    var invite = Environment.GetEnvironmentVariable("ROADFUN_INVITE_CODE");
    if (string.IsNullOrEmpty(invite) || !Auth.Equal(invite, req.InviteCode ?? "")) return Bad("Ungültiger Einladungscode", 403);
    if (!Regex.IsMatch(req.Username ?? "", "^[a-zA-Z0-9_]{3,24}$") || string.IsNullOrEmpty(req.Password) || req.Password.Length < 10 || string.Equals(req.Username, "Admin", StringComparison.OrdinalIgnoreCase)) return Bad("Name: 3–24 Zeichen (a-z, 0-9, _), nicht Admin; Passwort: mindestens 10 Zeichen");
    if (db.One("SELECT id FROM users WHERE username=$n", ("$n", req.Username)) is not null) return Bad("Name bereits vergeben", 409);
    var id = Guid.NewGuid().ToString("N");
    try { db.Exec("INSERT INTO users(id,username,pass_hash,code) VALUES($id,$n,$p,$c)", ("$id", id), ("$n", req.Username), ("$p", Auth.Hash(req.Password)), ("$c", Auth.Code())); }
    catch (SqliteException) { return Bad("Benutzer konnte nicht erstellt werden", 409); }
    return Results.Ok(Auth.Session(db, id));
}).RequireRateLimiting("auth");

api.MapPost("/auth/login", (Login req) =>
{
    var user = db.One("SELECT * FROM users WHERE username=$n", ("$n", req.Username ?? ""));
    if (user is null || !Auth.Verify(req.Password ?? "", S(user, "pass_hash"))) return Bad("Anmeldedaten falsch", 401);
    return Results.Ok(Auth.Session(db, S(user, "id")));
}).RequireRateLimiting("auth");

api.MapPost("/auth/logout", (HttpContext ctx) =>
{
    var token = ctx.Request.Headers.Authorization.ToString().Replace("Bearer ", "", StringComparison.OrdinalIgnoreCase).Trim();
    db.Exec("DELETE FROM sessions WHERE token_hash=$h", ("$h", Auth.TokenHash(token)));
    return Results.NoContent();
});

api.MapGet("/me", (HttpContext ctx) => Results.Ok(Public(U(ctx), true)));
api.MapPatch("/me", (HttpContext ctx, ProfilePatch req) =>
{
    var u = U(ctx);
    var age = req.Age;
    if (age is < 16 or > 110) return Bad("Alter muss zwischen 16 und 110 liegen");
    if ((req.Car?.Length ?? 0) > 80 || (req.Bio?.Length ?? 0) > 500) return Bad("Profiltext zu lang");
    db.Exec(@"UPDATE users SET car=COALESCE($car,car), age=COALESCE($age,age),
        bio=COALESCE($bio,bio), share_location=COALESCE($share,share_location) WHERE id=$id",
        ("$car", req.Car), ("$age", age), ("$bio", req.Bio),
        ("$share", req.ShareLocation is null ? null : req.ShareLocation == true ? 1 : 0), ("$id", S(u, "id")));
    if (req.ShareLocation == false)
        db.Exec("UPDATE users SET lat=NULL,lon=NULL,accuracy=NULL,updated_at=NULL WHERE id=$id", ("$id", S(u, "id")));
    return Results.Ok(Public(db.One("SELECT * FROM users WHERE id=$id", ("$id", S(u, "id")))! , true));
});
api.MapPost("/me/avatar", async (HttpContext ctx) =>
{
    if (!ctx.Request.HasFormContentType) return Bad("multipart/form-data erwartet");
    var form = await ctx.Request.ReadFormAsync();
    var f = form.Files.GetFile("avatar");
    if (f is null || f.Length is < 1 or > 2_000_000) return Bad("Bild muss unter 2 MB sein");
    var type = f.ContentType switch { "image/jpeg" => ".jpg", "image/png" => ".png", "image/webp" => ".webp", _ => "" };
    if (type == "") return Bad("Nur JPEG, PNG und WebP");
    await using var input = f.OpenReadStream();
    var signature = new byte[12];
    var n = await input.ReadAsync(signature.AsMemory(0, 12));
    if (!Auth.ValidImage(signature, n, type)) return Bad("Ungültiges Bild");
    input.Position = 0;
    var id = S(U(ctx), "id");
    var name = id + "-" + Guid.NewGuid().ToString("N") + type;
    await using (var output = File.Create(Path.Combine(avatarDir, name))) await input.CopyToAsync(output);
    db.Exec("UPDATE users SET avatar=$a WHERE id=$id", ("$a", "/avatars/" + name), ("$id", id));
    return Results.Ok(new { avatar = "/avatars/" + name });
});
api.MapGet("/users/{code}", (string code) =>
{
    var u = db.One("SELECT * FROM users WHERE code=$code", ("$code", code.ToUpperInvariant()));
    return u is null ? Bad("Nicht gefunden", 404) : Results.Ok(Public(u, false));
});

api.MapPost("/friends/request", (HttpContext ctx, FriendRequest req) =>
{
    var user = U(ctx);
    var target = db.One("SELECT * FROM users WHERE code=$code", ("$code", (req.Code ?? "").ToUpperInvariant().Trim()));
    if (target is null) return Bad("Code nicht gefunden", 404);
    if (S(target, "id") == S(user, "id")) return Bad("Das ist dein Profil");
    if (db.One("SELECT id FROM friendships WHERE (from_id=$a AND to_id=$b) OR (from_id=$b AND to_id=$a)",
        ("$a", S(user, "id")), ("$b", S(target, "id"))) is not null) return Bad("Anfrage existiert bereits", 409);
    db.Exec("INSERT INTO friendships(id,from_id,to_id,status,created_at) VALUES($id,$a,$b,'pending',$t)",
        ("$id", Guid.NewGuid().ToString("N")), ("$a", S(user, "id")), ("$b", S(target, "id")), ("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    return Results.Ok(new { success = true });
});
api.MapGet("/friends", (HttpContext ctx) =>
{
    var id = S(U(ctx), "id");
    var people = db.All(@"SELECT f.id request_id,f.from_id,f.to_id,f.status,u.username,u.code,u.avatar,u.car
      FROM friendships f JOIN users u ON u.id=CASE WHEN f.from_id=$id THEN f.to_id ELSE f.from_id END
      WHERE f.from_id=$id OR f.to_id=$id ORDER BY f.created_at DESC", ("$id", id));
    return Results.Ok(people.Select(x => new { requestId = S(x, "request_id"), username = S(x, "username"), code = S(x, "code"),
        avatar = S(x, "avatar"), car = S(x, "car"), status = S(x, "status"), incoming = S(x, "to_id") == id }).ToList());
});
api.MapPost("/friends/{requestId}/accept", (HttpContext ctx, string requestId) =>
{
    var changed = db.Exec("UPDATE friendships SET status='accepted' WHERE id=$id AND to_id=$uid AND status='pending'",
        ("$id", requestId), ("$uid", S(U(ctx), "id")));
    return changed == 0 ? Bad("Keine offene Anfrage", 404) : Results.Ok(new { success = true });
});
api.MapDelete("/friends/{requestId}", (HttpContext ctx, string requestId) =>
{
    db.Exec("DELETE FROM friendships WHERE id=$id AND (from_id=$uid OR to_id=$uid)", ("$id", requestId), ("$uid", S(U(ctx), "id")));
    return Results.NoContent();
});
api.MapGet("/messages/{code}", (HttpContext ctx, string code) =>
{
    var other = db.One("SELECT id FROM users WHERE code=$c", ("$c", code.ToUpperInvariant()));
    if (other is null || !Friends(S(U(ctx), "id"), S(other, "id"))) return Bad("Nur mit Freunden chatten", 403);
    var id = S(U(ctx), "id"); var oid = S(other, "id");
    var result = db.All(@"SELECT m.id,m.body,m.created_at,u.username sender FROM messages m JOIN users u ON u.id=m.from_id
       WHERE (m.from_id=$a AND m.to_id=$b) OR (m.from_id=$b AND m.to_id=$a)
       ORDER BY m.created_at DESC LIMIT 100", ("$a", id), ("$b", oid));
    result.Reverse();
    return Results.Ok(result);
});
api.MapPost("/messages/{code}", (HttpContext ctx, string code, TextBody req) =>
{
    var other = db.One("SELECT id FROM users WHERE code=$c", ("$c", code.ToUpperInvariant()));
    if (other is null || !Friends(S(U(ctx), "id"), S(other, "id"))) return Bad("Nur mit Freunden chatten", 403);
    if (string.IsNullOrWhiteSpace(req.Body) || req.Body.Length > 1000) return Bad("Nachricht: 1–1000 Zeichen");
    var me = S(U(ctx), "id");
    var count = db.Number("SELECT COUNT(*) FROM messages WHERE from_id=$id AND created_at>$t", ("$id", me), ("$t", DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeSeconds()));
    if (count > 20) return Bad("Zu viele Nachrichten", 429);
    db.Exec("INSERT INTO messages(id,from_id,to_id,body,created_at) VALUES($id,$a,$b,$msg,$t)",
        ("$id", Guid.NewGuid().ToString("N")), ("$a", me), ("$b", S(other, "id")), ("$msg", req.Body.Trim()), ("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    return Results.Ok(new { success = true });
});

api.MapPost("/location", (HttpContext ctx, Location req) =>
{
    var me = U(ctx);
    if (N(me, "share_location") != 1) return Bad("Standortfreigabe erst im Profil aktivieren", 403);
    if (!ValidPoint(req.Lat, req.Lon) || req.Accuracy is < 0 or > 10000) return Bad("Ungültige Position");
    db.Exec("UPDATE users SET lat=$lat,lon=$lon,accuracy=$a,updated_at=$t WHERE id=$id",
        ("$lat", req.Lat), ("$lon", req.Lon), ("$a", req.Accuracy), ("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds()), ("$id", S(me, "id")));
    return Results.NoContent();
});
api.MapGet("/map/people", (HttpContext ctx) =>
{
    // Clear stale coordinates, not merely hide them.
    db.Exec("UPDATE users SET lat=NULL,lon=NULL,accuracy=NULL,updated_at=NULL WHERE updated_at < $old",
        ("$old", DateTimeOffset.UtcNow.AddMinutes(-3).ToUnixTimeSeconds()));
    var user = U(ctx); var id = S(user, "id");
    var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 180;
    var admin = N(user, "is_admin") == 1;
    var rows = db.All(@"SELECT u.username,u.code,u.avatar,u.car,u.lat,u.lon,u.updated_at
      FROM users u WHERE u.share_location=1 AND u.lat IS NOT NULL AND u.updated_at>$t AND u.id<>$id
      AND ($admin=1 OR EXISTS (SELECT 1 FROM friendships f WHERE f.status='accepted'
      AND ((f.from_id=$id AND f.to_id=u.id) OR (f.from_id=u.id AND f.to_id=$id))))",
      ("$id", id), ("$t", now), ("$admin", admin ? 1 : 0));
    return Results.Ok(rows);
});
api.MapGet("/admin/users", (HttpContext ctx) =>
{
    if (N(U(ctx), "is_admin") != 1) return Bad("Nur Administrator", 403);
    return Results.Ok(db.All("SELECT username,code,car,avatar,share_location,updated_at FROM users ORDER BY username"));
});

var allowedReports = new[] { "police", "speedcam_mobile", "speedcam_fixed", "traffic", "hazard" };
api.MapGet("/reports", () =>
{
  db.Exec("DELETE FROM reports WHERE expires_at < $now", ("$now", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
  return Results.Ok(db.All(@"SELECT r.id,r.kind,r.lat,r.lon,r.heading,r.note,r.created_at,r.expires_at,u.username author
  FROM reports r JOIN users u ON r.user_id=u.id WHERE r.expires_at>$t ORDER BY r.created_at DESC LIMIT 300",
  ("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds())));
});
api.MapPost("/reports", (HttpContext ctx, NewReport req) =>
{
    if (!allowedReports.Contains(req.Kind) || !ValidPoint(req.Lat, req.Lon) || (req.Note?.Length ?? 0) > 240 ||
        req.Heading is < 0 or >= 360) return Bad("Ungültige Meldung");
    var uid = S(U(ctx), "id");
    var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    if (db.Number("SELECT COUNT(*) FROM reports WHERE user_id=$id AND created_at>$t", ("$id", uid), ("$t", now - 3600)) >= 15) return Bad("Meldungslimit erreicht", 429);
    var ttl = req.Kind == "speedcam_fixed" ? 30 * 86400 : req.Kind == "speedcam_mobile" || req.Kind == "police" ? 2 * 3600 : 4 * 3600;
    db.Exec(@"INSERT INTO reports(id,user_id,kind,lat,lon,heading,note,created_at,expires_at)
        VALUES($id,$uid,$kind,$lat,$lon,$heading,$note,$now,$exp)",
        ("$id", Guid.NewGuid().ToString("N")), ("$uid", uid), ("$kind", req.Kind), ("$lat", req.Lat), ("$lon", req.Lon),
        ("$heading", req.Heading), ("$note", req.Note?.Trim()), ("$now", now), ("$exp", now + ttl));
    return Results.Ok(new { success = true });
});
api.MapDelete("/reports/{id}", (HttpContext ctx, string id) =>
{
    var u = U(ctx);
    var deleted = db.Exec("DELETE FROM reports WHERE id=$id AND (user_id=$uid OR $admin=1)",
        ("$id", id), ("$uid", S(u, "id")), ("$admin", N(u, "is_admin")));
    return deleted == 0 ? Bad("Nicht gefunden", 404) : Results.NoContent();
});

api.MapGet("/meets", () => Results.Ok(db.All(@"SELECT m.*,u.username organizer,
   (SELECT COUNT(*) FROM meet_attendees a WHERE a.meet_id=m.id) participants FROM meets m
   JOIN users u ON u.id=m.owner_id WHERE m.starts_at>$now ORDER BY m.starts_at LIMIT 200",
   ("$now", DateTimeOffset.UtcNow.AddHours(-12).ToUnixTimeSeconds()))));
api.MapPost("/meets", (HttpContext ctx, NewMeet req) =>
{
    if (string.IsNullOrWhiteSpace(req.Title) || req.Title.Length > 100 || (req.Description?.Length ?? 0) > 1000 ||
        !ValidPoint(req.Lat, req.Lon) || !DateTimeOffset.TryParse(req.StartsAt, out var starts) ||
        starts < DateTimeOffset.UtcNow.AddMinutes(10) || starts > DateTimeOffset.UtcNow.AddYears(1)) return Bad("Ungültiges Treffen/Datum");
    db.Exec("INSERT INTO meets(id,owner_id,title,description,lat,lon,starts_at) VALUES($id,$owner,$title,$desc,$lat,$lon,$time)",
        ("$id", Guid.NewGuid().ToString("N")), ("$owner", S(U(ctx), "id")), ("$title", req.Title.Trim()),
        ("$desc", req.Description?.Trim()), ("$lat", req.Lat), ("$lon", req.Lon), ("$time", starts.ToUnixTimeSeconds()));
    return Results.Ok(new { success = true });
});
api.MapPost("/meets/{id}/join", (HttpContext ctx, string id) =>
{
    if (db.One("SELECT id FROM meets WHERE id=$id", ("$id", id)) is null) return Bad("Treffen nicht gefunden", 404);
    db.Exec("INSERT OR IGNORE INTO meet_attendees(meet_id,user_id) VALUES($m,$u)", ("$m", id), ("$u", S(U(ctx), "id")));
    return Results.Ok(new { success = true });
});
api.MapDelete("/meets/{id}/join", (HttpContext ctx, string id) =>
{
    db.Exec("DELETE FROM meet_attendees WHERE meet_id=$m AND user_id=$u", ("$m", id), ("$u", S(U(ctx), "id")));
    return Results.NoContent();
});
api.MapDelete("/meets/{id}", (HttpContext ctx, string id) =>
{
    var u = U(ctx); var changed = db.Exec("DELETE FROM meets WHERE id=$id AND (owner_id=$uid OR $admin=1)",
        ("$id", id), ("$uid", S(u, "id")), ("$admin", N(u, "is_admin")));
    return changed == 0 ? Bad("Nicht gefunden", 404) : Results.NoContent();
});

api.MapGet("/tracks", (HttpContext ctx) =>
{
    var user = U(ctx);
    return Results.Ok(db.All(@"SELECT t.*,u.username owner FROM tracks t JOIN users u ON u.id=t.owner_id
    WHERE t.owner_id=$id OR (t.visibility='friends' AND EXISTS (SELECT 1 FROM friendships f
    WHERE f.status='accepted' AND ((f.from_id=$id AND f.to_id=t.owner_id) OR (f.to_id=$id AND f.from_id=t.owner_id))))
    ORDER BY t.created_at DESC LIMIT 100", ("$id", S(user, "id"))));
});
api.MapPost("/tracks", (HttpContext ctx, NewTrack req) =>
{
    if (string.IsNullOrWhiteSpace(req.Title) || req.Title.Length > 100 || !ValidPoint(req.StartLat, req.StartLon) ||
        !ValidPoint(req.EndLat, req.EndLon) || req.Visibility is not ("private" or "friends") ||
        Geo.Meters(req.StartLat, req.StartLon, req.EndLat, req.EndLon) < 100) return Bad("Ungültige Strecke (mindestens 100 m)");
    db.Exec("INSERT INTO tracks(id,owner_id,title,start_lat,start_lon,end_lat,end_lon,visibility,created_at) VALUES($id,$owner,$title,$a,$b,$c,$d,$v,$t)",
        ("$id", Guid.NewGuid().ToString("N")), ("$owner", S(U(ctx), "id")), ("$title", req.Title.Trim()),
        ("$a", req.StartLat), ("$b", req.StartLon), ("$c", req.EndLat), ("$d", req.EndLon),
        ("$v", req.Visibility), ("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    return Results.Ok(new { success = true });
});
api.MapDelete("/tracks/{id}", (HttpContext ctx, string id) =>
{
    var changed = db.Exec("DELETE FROM tracks WHERE id=$id AND owner_id=$uid", ("$id", id), ("$uid", S(U(ctx), "id")));
    return changed == 0 ? Bad("Nicht gefunden", 404) : Results.NoContent();
});
api.MapGet("/runs", (HttpContext ctx) => Results.Ok(db.All(@"SELECT r.*,t.title FROM runs r JOIN tracks t ON r.track_id=t.id
    WHERE r.user_id=$u ORDER BY r.created_at DESC LIMIT 100", ("$u", S(U(ctx), "id")))));
api.MapPost("/runs", (HttpContext ctx, NewRun req) =>
{
    var uid = S(U(ctx), "id");
    var track = db.One(@"SELECT t.id FROM tracks t WHERE t.id=$id
        AND (t.owner_id=$uid OR (t.visibility='friends' AND EXISTS (
            SELECT 1 FROM friendships f WHERE f.status='accepted'
            AND ((f.from_id=$uid AND f.to_id=t.owner_id) OR (f.to_id=$uid AND f.from_id=t.owner_id)))))",
        ("$id", req.TrackId), ("$uid", uid));
    if (track is null) return Bad("Strecke nicht gefunden oder nicht freigegeben", 403);
    if (!(req.DurationSeconds >= 1 && req.DurationSeconds <= 86400) ||
        !(req.DistanceKm >= 0 && req.DistanceKm <= 2000) ||
        !(req.MaxKmh >= 0 && req.MaxKmh <= 500) || !(req.AvgKmh >= 0 && req.AvgKmh <= 500) ||
        !(req.MaxG >= 0 && req.MaxG <= 20)) return Bad("Ungültige Messung");
    db.Exec("INSERT INTO runs(id,track_id,user_id,duration_seconds,distance_km,max_kmh,avg_kmh,max_g,created_at) VALUES($id,$track,$uid,$seconds,$distance,$max,$avg,$g,$t)",
        ("$id", Guid.NewGuid().ToString("N")), ("$track", req.TrackId), ("$uid", S(U(ctx), "id")),
        ("$seconds", req.DurationSeconds), ("$distance", req.DistanceKm), ("$max", req.MaxKmh),
        ("$avg", req.AvgKmh), ("$g", req.MaxG), ("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    return Results.Ok(new { success = true, verified = false });
});

api.MapGet("/route", async (double fromLat, double fromLon, double toLat, double toLon, string? mode, IHttpClientFactory factory) =>
{
    if (!ValidPoint(fromLat, fromLon) || !ValidPoint(toLat, toLon)) return Bad("Ungültige Koordinaten");
    var baseUrl = (Environment.GetEnvironmentVariable("ROADFUN_ROUTING_URL") ?? "https://router.project-osrm.org").TrimEnd('/');
    if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http")) return Bad("Routing-Server ungültig", 503);
    var u = baseUrl + "/route/v1/driving/" + fromLon.ToString(CultureInfo.InvariantCulture) + "," + fromLat.ToString(CultureInfo.InvariantCulture) +
        ";" + toLon.ToString(CultureInfo.InvariantCulture) + "," + toLat.ToString(CultureInfo.InvariantCulture) + "?overview=full&geometries=geojson&alternatives=true&steps=true";
    try
    {
        var res = await factory.CreateClient("routing").GetAsync(u);
        if (!res.IsSuccessStatusCode) return Bad("Routing-Dienst nicht verfügbar", 502);
        using var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        if (!json.RootElement.TryGetProperty("routes", out var routes) || routes.GetArrayLength() == 0) return Bad("Keine Straßenroute gefunden", 404);
        var list = routes.EnumerateArray().Select(x =>
        {
            var coords = x.GetProperty("geometry").GetProperty("coordinates").EnumerateArray()
                .Select(c => new[] { c[0].GetDouble(), c[1].GetDouble() }).ToArray();
            var steps = x.GetProperty("legs").EnumerateArray()
                .SelectMany(leg => leg.GetProperty("steps").EnumerateArray())
                .Select(step =>
                {
                    var maneuver = step.GetProperty("maneuver");
                    var location = maneuver.GetProperty("location");
                    var kind = maneuver.GetProperty("type").GetString() ?? "continue";
                    var modifier = maneuver.TryGetProperty("modifier", out var m) ? m.GetString() : null;
                    var road = step.TryGetProperty("name", out var n) ? n.GetString() : null;
                    var exit = maneuver.TryGetProperty("exit", out var e) ? e.GetInt32() : (int?)null;
                    return new {
                        lat = location[1].GetDouble(), lon = location[0].GetDouble(),
                        type = kind, modifier, road, exit,
                        distanceMeters = step.GetProperty("distance").GetDouble()
                    };
                }).ToArray();
            return new { distanceKm = x.GetProperty("distance").GetDouble() / 1000, durationMin = x.GetProperty("duration").GetDouble() / 60,
                corners = Geo.Curves(coords), geometry = coords, steps };
        }).ToArray();
        var chosen = mode switch
        {
            "short" => list.OrderBy(x => x.distanceKm).First(),
            "eco" => list.OrderBy(x => x.distanceKm + x.corners * 0.008).First(),
            "fun" => list.OrderByDescending(x => x.corners / Math.Max(x.distanceKm, 1)).First(),
            _ => list.OrderBy(x => x.durationMin).First()
        };
        return Results.Ok(new { selectedMode = mode ?? "fast", alternatives = list.Length,
            chosen.distanceKm, chosen.durationMin, chosen.geometry, chosen.steps, note = "ETA ohne Live-Verkehr; Fun/Eco sind heuristisch. Navigationshinweise sind experimentell." });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException) { return Bad("Routing momentan nicht verfügbar", 502); }
});
api.MapGet("/elevation", async (string points, IHttpClientFactory factory) =>
{
    // Up to 30 points (lat,lon|lat,lon) per call. The external provider may enforce rate limits.
    var parts = points.Split('|', StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length is < 2 or > 30) return Bad("2–30 Punkte erforderlich");
    var locations = new List<string>();
    foreach (var part in parts)
    {
        var nums = part.Split(',');
        if (nums.Length != 2 || !double.TryParse(nums[0], CultureInfo.InvariantCulture, out var lat) ||
            !double.TryParse(nums[1], CultureInfo.InvariantCulture, out var lon) || !ValidPoint(lat, lon)) return Bad("Punkte ungültig");
        locations.Add(lat.ToString(CultureInfo.InvariantCulture) + "," + lon.ToString(CultureInfo.InvariantCulture));
    }
    var baseUrl = Environment.GetEnvironmentVariable("ROADFUN_ELEVATION_URL") ?? "https://api.opentopodata.org/v1/srtm90m";
    if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https") return Bad("Elevation-URL muss HTTPS sein", 503);
    try
    {
        var response = await factory.CreateClient("routing").GetAsync(baseUrl + "?locations=" + Uri.EscapeDataString(string.Join("|", locations)));
        if (!response.IsSuccessStatusCode) return Bad("Höhendaten nicht verfügbar", 502);
        using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var values = result.RootElement.GetProperty("results").EnumerateArray().Select(e =>
        {
            var v = e.GetProperty("elevation");
            return v.ValueKind == JsonValueKind.Null ? (double?)null : v.GetDouble();
        }).ToArray();
        return Results.Ok(new { elevations = values });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException)
    { return Bad("Höhendaten nicht verfügbar", 502); }
});
app.MapFallbackToFile("index.html");
app.Run();

IResult Bad(string error, int code = 400) => Results.Json(new { error }, statusCode: code);
Dictionary<string, object?> U(HttpContext c) => (Dictionary<string, object?>)c.Items["user"]!;
string S(Dictionary<string, object?> row, string key) => row.TryGetValue(key, out var value) ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "" : "";
long N(Dictionary<string, object?> row, string key) => row.TryGetValue(key, out var v) && v is not null ? Convert.ToInt64(v, CultureInfo.InvariantCulture) : 0;
bool ValidPoint(double lat, double lon) => double.IsFinite(lat) && double.IsFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
bool Friends(string a, string b) => db.One(@"SELECT id FROM friendships WHERE status='accepted'
    AND ((from_id=$a AND to_id=$b) OR (from_id=$b AND to_id=$a))", ("$a", a), ("$b", b)) is not null;
object Public(Dictionary<string, object?> x, bool self) => new
{
    username = S(x, "username"), code = S(x, "code"), car = S(x, "car"),
    age = x.GetValueOrDefault("age"), bio = S(x, "bio"), avatar = S(x, "avatar"),
    shareLocation = self && N(x, "share_location") == 1, isAdmin = self && N(x, "is_admin") == 1
};

record Register(string Username, string Password, string InviteCode);
record Login(string Username, string Password);
record ProfilePatch(string? Car, int? Age, string? Bio, bool? ShareLocation);
record FriendRequest(string Code);
record TextBody(string Body);
record Location(double Lat, double Lon, double? Accuracy);
record NewReport(string Kind, double Lat, double Lon, double? Heading, string? Note);
record NewMeet(string Title, string? Description, double Lat, double Lon, string StartsAt);
record NewTrack(string Title, double StartLat, double StartLon, double EndLat, double EndLon, string Visibility);
record NewRun(string TrackId, double DurationSeconds, double DistanceKm, double MaxKmh, double AvgKmh, double MaxG);

sealed class Store(string path)
{
    readonly string cs = new SqliteConnectionStringBuilder { DataSource = path, ForeignKeys = true, DefaultTimeout = 10 }.ToString();
    SqliteConnection Connect()
    {
        var conn = new SqliteConnection(cs); conn.Open(); return conn;
    }
    public int Exec(string sql, params (string key, object? val)[] args)
    {
        using var c = Connect(); using var cmd = Command(c, sql, args); return cmd.ExecuteNonQuery();
    }
    public Dictionary<string, object?>? One(string sql, params (string key, object? val)[] args) => All(sql, args).FirstOrDefault();
    public long Number(string sql, params (string key, object? val)[] args)
    {
        using var c = Connect(); using var cmd = Command(c, sql, args); return Convert.ToInt64(cmd.ExecuteScalar() ?? 0);
    }
    public List<Dictionary<string, object?>> All(string sql, params (string key, object? val)[] args)
    {
        using var c = Connect(); using var cmd = Command(c, sql, args); using var reader = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }
    static SqliteCommand Command(SqliteConnection c, string sql, (string key, object? val)[] args)
    {
        var cmd = c.CreateCommand(); cmd.CommandText = sql;
        foreach (var (key, val) in args) cmd.Parameters.AddWithValue(key, val ?? DBNull.Value);
        return cmd;
    }
    public void Init()
    {
        Exec("PRAGMA journal_mode=WAL;");
        Exec(@"
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
 code TEXT NOT NULL UNIQUE, age INTEGER, car TEXT, bio TEXT, avatar TEXT,
 share_location INTEGER NOT NULL DEFAULT 0, lat REAL, lon REAL, accuracy REAL, updated_at INTEGER, is_admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friendships(id TEXT PRIMARY KEY,from_id TEXT NOT NULL REFERENCES users(id),to_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,from_id TEXT NOT NULL REFERENCES users(id),to_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,lat REAL NOT NULL,lon REAL NOT NULL,heading REAL,note TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT,lat REAL NOT NULL,lon REAL NOT NULL,starts_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meet_attendees(meet_id TEXT NOT NULL REFERENCES meets(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(meet_id,user_id));
CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,start_lat REAL NOT NULL,start_lon REAL NOT NULL,end_lat REAL NOT NULL,end_lon REAL NOT NULL,visibility TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),duration_seconds REAL NOT NULL,distance_km REAL NOT NULL,max_kmh REAL NOT NULL,avg_kmh REAL NOT NULL,max_g REAL NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id,to_id,created_at);
CREATE INDEX IF NOT EXISTS idx_reports_expiry ON reports(expires_at);
CREATE INDEX IF NOT EXISTS idx_tracks_owner ON tracks(owner_id);
");
    }
}
static class Auth
{
    public static string Code() => Convert.ToHexString(RandomNumberGenerator.GetBytes(5));
    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var bytes = Rfc2898DeriveBytes.Pbkdf2(password, salt, 210_000, HashAlgorithmName.SHA256, 32);
        return "pbkdf2:210000:" + Convert.ToBase64String(salt) + ":" + Convert.ToBase64String(bytes);
    }
    public static bool Verify(string password, string saved)
    {
        var p = saved.Split(':');
        if (p.Length != 4 || p[0] != "pbkdf2" || !int.TryParse(p[1], out var iterations)) return false;
        try
        {
            var salt = Convert.FromBase64String(p[2]); var expected = Convert.FromBase64String(p[3]);
            return CryptographicOperations.FixedTimeEquals(Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length), expected);
        }
        catch (FormatException) { return false; }
    }
    public static bool Equal(string a, string b)
    {
        var aa = SHA256.HashData(Encoding.UTF8.GetBytes(a)); var bb = SHA256.HashData(Encoding.UTF8.GetBytes(b));
        return CryptographicOperations.FixedTimeEquals(aa, bb);
    }
    public static string TokenHash(string t) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(t)));
    public static object Session(Store db, string userId)
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var expiry = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeSeconds();
        db.Exec("DELETE FROM sessions WHERE expires_at<$now", ("$now", DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
        db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($h,$id,$exp)",
            ("$h", TokenHash(token)), ("$id", userId), ("$exp", expiry));
        return new { token, expiresAt = expiry };
    }
    public static bool ValidImage(byte[] b, int n, string ext) =>
        ext == ".png" ? n >= 8 && b.AsSpan(0, 8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10}) :
        ext == ".jpg" ? n >= 3 && b[0] == 255 && b[1] == 216 && b[2] == 255 :
        ext == ".webp" && n >= 12 && Encoding.ASCII.GetString(b,0,4)=="RIFF" && Encoding.ASCII.GetString(b,8,4)=="WEBP";
}
static class Geo
{
    public static double Meters(double a, double b, double c, double d)
    {
        var p = Math.PI / 180.0; var da=(c-a)*p; var db=(d-b)*p;
        var x = Math.Sin(da/2)*Math.Sin(da/2)+Math.Cos(a*p)*Math.Cos(c*p)*Math.Sin(db/2)*Math.Sin(db/2);
        return 12742000 * Math.Asin(Math.Min(1, Math.Sqrt(x)));
    }
    public static double Curves(double[][] pts)
    {
        double result=0;
        for(var i=2; i<pts.Length; i+=Math.Max(1,pts.Length/200))
        {
            var a=pts[i-2];var b=pts[i-1];var c=pts[i];
            double x1=b[0]-a[0], y1=b[1]-a[1], x2=c[0]-b[0], y2=c[1]-b[1];
            var mag=Math.Sqrt((x1*x1+y1*y1)*(x2*x2+y2*y2));
            if(mag>1e-12) result+=Math.Acos(Math.Clamp((x1*x2+y1*y2)/mag,-1,1));
        }
        return result;
    }
}
