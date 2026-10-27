using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

// Bounded Photon forward-geocoding proxy; no exposed arbitrary URL parameter.
// Public Photon is a demo service. Set ROADFUN_GEOCODER_URL for your own instance.
internal static class Geocoding
{
    private sealed record Cached(string Json, DateTimeOffset Expires);
    private static readonly ConcurrentDictionary<string,Cached> Cache=new();
    private static readonly SemaphoreSlim Gate=new(1,1);
    private static DateTimeOffset LastRequest=DateTimeOffset.MinValue;

    internal static async Task<string> Search(string query,double? lat,double? lon,
        IHttpClientFactory factory,CancellationToken ct)
    {
        query=query.Trim();
        if(query.Length<3||query.Length>120||query.Any(char.IsControl))
            throw new ArgumentException("Bitte mindestens drei Zeichen einer Adresse eingeben (max. 120)");
        if((lat.HasValue!=lon.HasValue)||(lat.HasValue&&
            (!double.IsFinite(lat.Value)||!double.IsFinite(lon!.Value)||
              Math.Abs(lat.Value)>90||Math.Abs(lon.Value)>180)))
            throw new ArgumentException("Ungültige Suchkoordinaten");
        var cacheKey=query.ToLowerInvariant()+"|"+lat?.ToString("F2",CultureInfo.InvariantCulture)+
            "|"+lon?.ToString("F2",CultureInfo.InvariantCulture);
        if(Cache.TryGetValue(cacheKey,out var hit)&&hit.Expires>DateTimeOffset.UtcNow)return hit.Json;
        if(!await Gate.WaitAsync(TimeSpan.FromSeconds(6),ct))
            throw new TimeoutException("Adresssuche gerade ausgelastet");
        try
        {
            if(Cache.TryGetValue(cacheKey,out hit)&&hit.Expires>DateTimeOffset.UtcNow)return hit.Json;
            var configured=Environment.GetEnvironmentVariable("ROADFUN_GEOCODER_URL") ??
                "https://photon.komoot.io";
            if(!Uri.TryCreate(configured,UriKind.Absolute,out var source) ||
                source.Scheme is not ("http" or "https"))
                throw new InvalidOperationException("Ungültige Geocoder-URL");
            // Respect public Photon fair use: one outgoing request at a time, >=1.1s apart.
            if(source.Host.Equals("photon.komoot.io",StringComparison.OrdinalIgnoreCase))
            {
                var delay=TimeSpan.FromMilliseconds(1100)-(DateTimeOffset.UtcNow-LastRequest);
                if(delay>TimeSpan.Zero)await Task.Delay(delay,ct);
                LastRequest=DateTimeOffset.UtcNow;
            }
            var url=configured.TrimEnd('/')+"/api?q="+Uri.EscapeDataString(query)+
                "&limit=5&lang=de";
            if(lat.HasValue)
                url+="&lat="+lat.Value.ToString(CultureInfo.InvariantCulture)+
                     "&lon="+lon!.Value.ToString(CultureInfo.InvariantCulture);
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(8));
            using var result=await factory.CreateClient("routing").GetAsync(url,timeout.Token);
            if(!result.IsSuccessStatusCode)
                throw new HttpRequestException("Photon meldet HTTP "+(int)result.StatusCode);
            var body=await result.Content.ReadAsStringAsync(timeout.Token);
            if(body.Length>500_000)throw new InvalidOperationException("Adresssuche: Antwort zu groß");
            using var data=JsonDocument.Parse(body);
            var list=new List<object>();
            if(data.RootElement.TryGetProperty("features",out var items)&&
                items.ValueKind==JsonValueKind.Array)
                foreach(var item in items.EnumerateArray().Take(5))
                {
                    if(!item.TryGetProperty("geometry",out var geom)||
                        !geom.TryGetProperty("coordinates",out var coords)||
                        coords.GetArrayLength()<2)continue;
                    var x=coords[0].GetDouble();var y=coords[1].GetDouble();
                    if(!double.IsFinite(x)||!double.IsFinite(y)||Math.Abs(x)>180||Math.Abs(y)>90)continue;
                    item.TryGetProperty("properties",out var prop);
                    string read(string name)=>prop.ValueKind==JsonValueKind.Object&&
                        prop.TryGetProperty(name,out var v)&&v.ValueKind==JsonValueKind.String?
                        v.GetString()??"":"";
                    var title=new[]{read("name"),read("street"),read("housenumber"),read("postcode"),
                        read("city"),read("state"),read("country")}
                        .Where(x=>!string.IsNullOrWhiteSpace(x)).Distinct().ToArray();
                    list.Add(new {label=string.Join(", ",title),lat=y,lon=x});
                }
            var json=JsonSerializer.Serialize(new {results=list});
            if(Cache.Count>160)
                foreach(var key in Cache.OrderBy(k=>k.Value.Expires).Take(35))
                    Cache.TryRemove(key.Key,out _);
            Cache[cacheKey]=new Cached(json,DateTimeOffset.UtcNow.AddMinutes(20));
            return json;
        }
        finally{Gate.Release();}
    }
}
