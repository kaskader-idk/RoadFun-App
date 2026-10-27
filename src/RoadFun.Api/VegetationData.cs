using System.Globalization;
using System.Net.Http.Headers;
using System.Collections.Concurrent;

// Fixed-query Overpass proxy. No arbitrary URLs or user-supplied Overpass syntax.
internal static class VegetationData
{
    private sealed record Cached(string Json, DateTimeOffset Expiry);
    private static readonly ConcurrentDictionary<string, Cached> Cache = new();
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private const string Endpoint = "https://overpass.private.coffee/api/interpreter";

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
            var query = "[out:json][timeout:12][maxsize:2097152];(" +
                "node[\"natural\"=\"tree\"](" + bbox + ");" +
                "way[\"landuse\"=\"forest\"](" + bbox + ");" +
                "way[\"natural\"=\"wood\"](" + bbox + ");" +
                ");out geom 550;";
            using var req = new HttpRequestMessage(HttpMethod.Post, Endpoint)
            {
                Content = new FormUrlEncodedContent(new[]
                    { new KeyValuePair<string, string>("data", query) })
            };
            req.Headers.UserAgent.Add(new ProductInfoHeaderValue("RoadFun", "0.4"));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(16));
            using var response = await factory.CreateClient("routing")
                .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException("Baumdatenquelle HTTP " + (int)response.StatusCode);
            if (response.Content.Headers.ContentLength is > 2_100_000)
                throw new InvalidOperationException("Baumdaten für diesen Ausschnitt zu umfangreich");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var bytes = new byte[8192];
            int count;
            while ((count = await stream.ReadAsync(bytes.AsMemory(), timeout.Token)) > 0)
            {
                if (buffer.Length + count > 2_100_000)
                    throw new InvalidOperationException("Baumdaten für diesen Ausschnitt zu umfangreich");
                buffer.Write(bytes, 0, count);
            }
            var json = System.Text.Encoding.UTF8.GetString(buffer.ToArray());
            using var document = System.Text.Json.JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("elements", out var elements) ||
                elements.ValueKind != System.Text.Json.JsonValueKind.Array)
                throw new InvalidOperationException("Baumdatenquelle lieferte keine gültigen OSM-Elemente");
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
