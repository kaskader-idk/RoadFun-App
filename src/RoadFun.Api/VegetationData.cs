using System.Globalization;
using System.Net.Http.Headers;
using System.Collections.Concurrent;

// Fixed-query Overpass proxy. No arbitrary URLs or user-supplied Overpass syntax.
internal static class VegetationData
{
    private sealed record Cached(string Json, DateTimeOffset Expiry);
    private static readonly ConcurrentDictionary<string, Cached> Cache = new();
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly string[] Endpoints = {
        "https://overpass.private.coffee/api/interpreter",
        "https://overpass-api.de/api/interpreter"
    };

    internal static async Task<string> Query(double south, double west, double north, double east,
        IHttpClientFactory factory, CancellationToken cancellationToken)
    {
        if (!double.IsFinite(south) || !double.IsFinite(north) ||
            !double.IsFinite(west) || !double.IsFinite(east) ||
            south < -85 || north > 85 || west < -180 || east > 180 ||
            south >= north || west >= east ||
            north - south > 0.12 || east - west > 0.12)
            throw new ArgumentException("Baumdaten: Kartenausschnitt muss kleiner als 0,12° sein");

        string val(double x) => Math.Round(x, 4).ToString("F4", CultureInfo.InvariantCulture);
        var key = string.Join(",", val(south), val(west), val(north), val(east));
        if (Cache.TryGetValue(key, out var cached) && cached.Expiry > DateTimeOffset.UtcNow)
            return cached.Json;

        // Limit public Overpass queries to one concurrent fetch per RoadFun instance.
        if (!await Gate.WaitAsync(TimeSpan.FromSeconds(8), cancellationToken))
            throw new TimeoutException("Baumdaten-Anfrage ist beschäftigt");
        try
        {
            if (Cache.TryGetValue(key, out cached) && cached.Expiry > DateTimeOffset.UtcNow)
                return cached.Json;
            var bbox = string.Join(",", val(south), val(west), val(north), val(east));
            var query = "[out:json][timeout:22][maxsize:134217728];(" +
                "node[\"natural\"=\"tree\"](" + bbox + ");" +
                "way[\"landuse\"=\"forest\"](" + bbox + ");" +
                "way[\"natural\"=\"wood\"](" + bbox + ");" +
                "way[\"building\"](" + bbox + ");" +
                ");out geom 1200;";
            string? json = null;
            var failures = new List<string>();
            foreach (var endpoint in Endpoints)
            {
                try
                {
                    using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
                    {
                        Content = new FormUrlEncodedContent(new[]
                            { new KeyValuePair<string, string>("data", query) })
                    };
                    req.Headers.UserAgent.Add(new ProductInfoHeaderValue("RoadFun", "0.6"));
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    timeout.CancelAfter(TimeSpan.FromSeconds(23));
                    using var response = await factory.CreateClient("overpass")
                        .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                    if (!response.IsSuccessStatusCode)
                        throw new HttpRequestException("HTTP " + (int)response.StatusCode);
                    if (response.Content.Headers.ContentLength is > 8_000_000)
                        throw new InvalidOperationException("OSM-Datenmenge für Ausschnitt zu groß");
                    await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                    using var buffer = new MemoryStream();
                    var bytes = new byte[8192];
                    int count;
                    while ((count = await stream.ReadAsync(bytes.AsMemory(), timeout.Token)) > 0)
                    {
                        if (buffer.Length + count > 8_000_000)
                            throw new InvalidOperationException("OSM-Datenmenge zu groß");
                        buffer.Write(bytes, 0, count);
                    }
                    var body = System.Text.Encoding.UTF8.GetString(buffer.ToArray());
                    using var document = System.Text.Json.JsonDocument.Parse(body);
                    if (!document.RootElement.TryGetProperty("elements", out var elements) ||
                        elements.ValueKind != System.Text.Json.JsonValueKind.Array)
                        throw new InvalidOperationException("OSM-Datenquelle lieferte keine gültigen Elemente");
                    json = body;
                    break;
                }
                catch (Exception ex) when (ex is HttpRequestException or TimeoutException
                    or TaskCanceledException or InvalidOperationException
                    or System.Text.Json.JsonException)
                {
                    if (cancellationToken.IsCancellationRequested) throw;
                    failures.Add(ex.Message);
                }
            }
            if (json is null)
                throw new HttpRequestException("Alle OSM-Datenquellen ausgefallen: " + string.Join("; ", failures));
            // Cache bounded: do not fill disk or memory with unbounded provider responses.
            if (Cache.Count > 24)
                foreach (var k in Cache.OrderBy(x => x.Value.Expiry).Take(8))
                    Cache.TryRemove(k.Key, out _);
            Cache[key] = new Cached(json, DateTimeOffset.UtcNow.AddMinutes(30));
            return json;
        }
        finally { Gate.Release(); }
    }
}
