using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

// Fetch OSRM routes with an optional Valhalla fallback. Both return OSRM-compatible GeoJSON.
internal static class RoutingFallback
{
    internal sealed record Result(JsonDocument? Json, string Provider, string Reason, bool NoRoute = false);
    private sealed record CacheEntry(string Json, string Provider, DateTimeOffset ExpiresAt);
    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new();
    private static readonly SemaphoreSlim DemoGate = new(1, 1);
    private static DateTimeOffset LastDemoCall = DateTimeOffset.MinValue;

    public static async Task<Result> Fetch(
        HttpClient client, double fromLat, double fromLon, double toLat, double toLon,
        ILogger logger, CancellationToken requestCancellation)
    {
        var fmt = CultureInfo.InvariantCulture;
        var key = string.Join(":", new[] { fromLat, fromLon, toLat, toLon }
            .Select(n => Math.Round(n, 5).ToString("F5", fmt)));
        if (Cache.TryGetValue(key, out var hit) && hit.ExpiresAt > DateTimeOffset.UtcNow)
            return new Result(JsonDocument.Parse(hit.Json), hit.Provider + " (Cache)", "");

        var primary = (Environment.GetEnvironmentVariable("ROADFUN_ROUTING_URL") ?? "https://router.project-osrm.org").TrimEnd('/');
        var secondary = (Environment.GetEnvironmentVariable("ROADFUN_ROUTING_FALLBACK_URL") ?? "https://valhalla1.openstreetmap.de").TrimEnd('/');

        var errors = new List<string>();
        var missingRoads = 0;
        foreach (var (provider, url, fallback) in new[] { ("OSRM", primary, false), ("Valhalla", secondary, true) })
        {
            if (string.IsNullOrWhiteSpace(url) || url.Equals("disabled", StringComparison.OrdinalIgnoreCase))
                continue;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http"))
            {
                errors.Add(provider + ": ungültige Serverkonfiguration");
                continue;
            }

            // Public routing demo services request low traffic. Cache hits do not issue external calls.
            var demo = uri.Host is "router.project-osrm.org" or "routing.openstreetmap.de" or "valhalla1.openstreetmap.de";
            bool acquired = false;
            try
            {
                if (demo)
                {
                    acquired = await DemoGate.WaitAsync(TimeSpan.FromSeconds(5), requestCancellation);
                    if (!acquired)
                    {
                        errors.Add(provider + ": Anfragebegrenzung");
                        continue;
                    }
                    var pause = TimeSpan.FromMilliseconds(1100) - (DateTimeOffset.UtcNow - LastDemoCall);
                    if (pause > TimeSpan.Zero) await Task.Delay(pause, requestCancellation);
                    LastDemoCall = DateTimeOffset.UtcNow;
                }
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(requestCancellation);
                timeout.CancelAfter(TimeSpan.FromSeconds(9));
                using var request = fallback ? ValhallaRequest(uri, fromLat, fromLon, toLat, toLon)
                                             : OsrmRequest(uri, fromLat, fromLon, toLat, toLon);
                using var response = await client.SendAsync(request, timeout.Token);
                if (!response.IsSuccessStatusCode)
                {
                    errors.Add(provider + ": HTTP " + (int)response.StatusCode);
                    logger.LogWarning("RoadFun routing provider {Provider} returned HTTP {Status}", provider, (int)response.StatusCode);
                    if (response.StatusCode == HttpStatusCode.NotFound) missingRoads++;
                    continue;
                }
                var body = await response.Content.ReadAsStringAsync(timeout.Token);
                using var json = JsonDocument.Parse(body);
                if (!json.RootElement.TryGetProperty("routes", out var routes) ||
                    routes.ValueKind != JsonValueKind.Array || routes.GetArrayLength() == 0)
                {
                    var code = json.RootElement.TryGetProperty("code", out var property) ? property.GetString() : "NoRoute";
                    if (code == "NoRoute" || code == "NoSegment") missingRoads++;
                    errors.Add(provider + ": " + (code ?? "keine Route"));
                    continue;
                }
                // Avoid caching malformed or incompatible provider responses.
                var valid = routes.EnumerateArray().All(r =>
                    r.TryGetProperty("geometry", out var geo) &&
                    geo.ValueKind == JsonValueKind.Object &&
                    geo.TryGetProperty("coordinates", out var points) &&
                    points.ValueKind == JsonValueKind.Array &&
                    points.GetArrayLength() >= 2 &&
                    r.TryGetProperty("legs", out var legs) &&
                    legs.ValueKind == JsonValueKind.Array &&
                    legs.EnumerateArray().All(l => l.TryGetProperty("steps", out var steps) && steps.ValueKind == JsonValueKind.Array));
                if (!valid)
                {
                    errors.Add(provider + ": inkompatibles Antwortformat");
                    logger.LogWarning("RoadFun routing provider {Provider} returned unexpected geometry/steps", provider);
                    continue;
                }
                if (Cache.Count >= 250)
                {
                    foreach (var old in Cache.OrderBy(x => x.Value.ExpiresAt).Take(40))
                        Cache.TryRemove(old.Key, out _);
                }
                Cache[key] = new CacheEntry(body, provider, DateTimeOffset.UtcNow.AddMinutes(15));
                return new Result(JsonDocument.Parse(body), provider, "");
            }
            catch (OperationCanceledException) when (!requestCancellation.IsCancellationRequested)
            {
                errors.Add(provider + ": Zeitüberschreitung");
                logger.LogWarning("RoadFun routing provider {Provider} timed out", provider);
            }
            catch (HttpRequestException ex)
            {
                errors.Add(provider + ": Verbindungsfehler");
                logger.LogWarning(ex, "RoadFun routing provider {Provider} connection error", provider);
            }
            catch (JsonException ex)
            {
                errors.Add(provider + ": ungültiges JSON");
                logger.LogWarning(ex, "RoadFun routing provider {Provider} response invalid", provider);
            }
            finally
            {
                if (acquired) DemoGate.Release();
            }
        }
        return new Result(null, "", string.Join("; ", errors),
            missingRoads > 0 && missingRoads == errors.Count);
    }

    private static HttpRequestMessage OsrmRequest(Uri uri, double a, double b, double c, double d)
    {
        var f = CultureInfo.InvariantCulture;
        var path = "/route/v1/driving/" + b.ToString(f) + "," + a.ToString(f) +
                   ";" + d.ToString(f) + "," + c.ToString(f) +
                   "?overview=full&geometries=geojson&alternatives=true&steps=true";
        return Request(HttpMethod.Get, new Uri(uri.ToString().TrimEnd('/') + path), null);
    }

    private static HttpRequestMessage ValhallaRequest(Uri uri, double a, double b, double c, double d)
    {
        var json = JsonSerializer.Serialize(new
        {
            locations = new[] { new { lat = a, lon = b }, new { lat = c, lon = d } },
            costing = "auto", format = "osrm", shape_format = "geojson",
            alternates = 2, language = "de-DE"
        });
        return Request(HttpMethod.Post, new Uri(uri.ToString().TrimEnd('/') + "/route"), json);
    }

    private static HttpRequestMessage Request(HttpMethod method, Uri uri, string? body)
    {
        var req = new HttpRequestMessage(method, uri);
        req.Headers.TryAddWithoutValidation("X-Client-Id", "RoadFun-Private-PWA");
        req.Headers.UserAgent.Add(new ProductInfoHeaderValue("RoadFun", "0.2"));
        if (body is not null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return req;
    }
}
