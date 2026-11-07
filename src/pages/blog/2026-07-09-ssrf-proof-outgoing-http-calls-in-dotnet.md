---
templateKey: 'blog-post'
title: 'SSRF-proof outgoing HTTP calls in .NET: resolve, check, then connect'
date: 2026-07-09T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/ssrf-proof-outgoing-http-calls-in-dotnet.jpg
description: >-
  Learn how to call URLs your users type (webhooks, imports, metadata documents) without letting them reach your own network, with a SocketsHttpHandler that checks the address it actually connects to.
tags:
  - Development
  - C#
  - ASP.NET Core
  - .NET
  - Security
---

Sooner or later, a SaaS calls a URL that one of its users typed: a webhook endpoint, a file to import, a metadata document. The request leaves from **our** server, inside **our** network. If the user types `https://169.254.169.254/latest/meta-data/` or `https://10.0.0.5/admin`, our server fetches the cloud metadata endpoint or an internal service for them. This is [Server-Side Request Forgery](https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/) (SSRF).

"Check the URL before calling it" is not enough. A hostname can resolve to a public address when we check it and to a private one when we connect, and a public endpoint can answer with a redirect to `http://10.0.0.5/`.

In this article, we will build an `HttpClient` that dials only public addresses, in three layers: a check at save time, a check at connect time in `SocketsHttpHandler.ConnectCallback`, and no redirects, proxy or cookies.


## Why checking the hostname is the bug
Here is the version most of us write first:

```csharp
var uri = new Uri(url);
var addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, cancellationToken);

if (addresses.Any(IsPrivate))
{
    throw new InvalidOperationException("Private address.");
}

var response = await httpClient.PostAsync(uri, content, cancellationToken);
```

There are **two** DNS resolutions here: ours, and the socket's when `HttpClient` connects. We inspected the first; the connection uses the second. This time-of-check to time-of-use (TOCTOU) race is what **DNS rebinding** exploits: the attacker's DNS server answers our check with a public address and a very short TTL, then answers the socket's lookup with `127.0.0.1`. The same happens over days: a URL saved today with a public address can be repointed tomorrow.

So the rule is: **resolve, check, then connect to the address we checked**. Never hand the hostname back to the socket.


## Judge address ranges, not hostnames
A deny-list of hostnames cannot work: `localhost`, `127.0.0.1`, `[::ffff:127.0.0.1]` and any DNS name pointed at `127.0.0.1` are the same request. Only the **address** tells the truth, so the [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) recommends judging the resolved IP. Here is the core of `PublicAddressGuard` (`Blouppy.Aspire.ServiceDefaults/Security/Outbound/PublicAddressGuard.cs`):

```csharp
public static class PublicAddressGuard
{
    private static readonly AddressRange[] DeniedIPv4Ranges =
    [
        AddressRange.Parse("0.0.0.0/8"),
        AddressRange.Parse("10.0.0.0/8"),
        AddressRange.Parse("172.16.0.0/12"),
        AddressRange.Parse("192.168.0.0/16"),
        AddressRange.Parse("100.64.0.0/10"),
        AddressRange.Parse("127.0.0.0/8"),
        AddressRange.Parse("169.254.0.0/16"),
        // ... documentation, benchmarking and 6to4 relay ranges
        AddressRange.Parse("224.0.0.0/3")
    ];

    private static readonly AddressRange GlobalUnicast = AddressRange.Parse("2000::/3");

    private static readonly AddressRange[] DeniedIPv6Ranges =
    [
        AddressRange.Parse("2001::/23"),
        AddressRange.Parse("2001:db8::/32"),
        AddressRange.Parse("3fff::/20"),
        AddressRange.Parse("2002::/16")
    ];

    public static bool IsAllowed(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        return address.AddressFamily switch
        {
            AddressFamily.InterNetwork => !DeniedIPv4Ranges.Any(range => range.Contains(address)),
            AddressFamily.InterNetworkV6 => GlobalUnicast.Contains(address)
                                            && !DeniedIPv6Ranges.Any(range => range.Contains(address)),
            _ => false
        };
    }
}
```

`AddressRange` is a small private record that compares the first `PrefixLength` bits of the address with the network's.
- **IPv4-mapped addresses are unwrapped first**: `::ffff:10.0.0.1` is judged as `10.0.0.1`.
- **IPv4 is a deny-list** of the [special-purpose ranges](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml): "this network", [RFC 1918](https://www.rfc-editor.org/rfc/rfc1918), loopback, CGNAT, link-local (`169.254.0.0/16`, which holds the metadata endpoint), documentation and benchmarking ranges, and everything from `224.0.0.0` up.
- **IPv6 is an allow-list**: only global unicast (`2000::/3`) passes, minus a few ranges inside it. Loopback, link-local, unique-local, NAT64 (`64:ff9b::/96`) and IPv4-compatible (`::/96`) addresses fall outside `2000::/3`, so they are refused without being named, and so is any range assigned later outside it.
- **Any other address family** is refused.

> **_Note:_**  NAT64 ([RFC 6052](https://www.rfc-editor.org/rfc/rfc6052)), 6to4 (`2002::/16`), Teredo (inside `2001::/32`) and IPv4-compatible addresses all **embed an IPv4 address** and can route to it. `64:ff9b::a9fe:a9fe` is the metadata endpoint in an IPv6 costume.

The unit tests, `PublicAddressGuardTests`, read like a list of known escapes (`64:ff9b::7f00:1`, `::7f00:1`, `2002:a9fe:a9fe::1`, `2001::1`, a private IPv4 mapped to IPv6), and they check the **edges** of each range on both sides: `172.16.0.0` and `172.31.255.255` are refused, `172.15.255.255` and `172.32.0.0` are allowed, so an off-by-one in a prefix length shows up at once.


## Layer 1: refuse the URL at save time
The first layer does not protect us; it helps the user. When someone saves a webhook, the form should say *why* the URL is refused. Here is `WebhookUrlPolicy` (`Blouppy.Infrastructure.Webhooks/WebhookUrlPolicy.cs`), trimmed:

```csharp
public async Task<string?> TryGetRejectionReasonAsync(
    string url,
    CancellationToken cancellationToken = default)
{
    if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
    {
        return "Enter a complete URL, including the scheme.";
    }

    if (uri.Scheme != Uri.UriSchemeHttps
        && !(uri.Scheme == Uri.UriSchemeHttp && _options.AllowInsecureTransport))
    {
        return "The URL must use HTTPS.";
    }

    if (!string.IsNullOrEmpty(uri.UserInfo))
    {
        return "The URL cannot contain credentials.";
    }

    // ... resolve uri.DnsSafeHost (or parse it as a literal address)

    // Every address, not the first: a mixed public/private answer would get the private one dialled.
    if (addresses.Any(address => !PublicAddressGuard.IsAllowed(address)))
    {
        return "This address is not reachable from Blouppy. Use a publicly routable URL.";
    }

    return null;
}
```

It refuses anything that is not an absolute `https` URL (which rules out `file:///etc/passwd`), credentials in the URL, and any host that resolves to **at least one** private address. A FluentValidation rule calls it from the webhook's validator, with the comment *"Checked again at send time against the resolved address."* This layer is a courtesy: everything said about TOCTOU applies to it.


## Layer 2: check the address the socket connects to
Now the layer that matters. [`SocketsHttpHandler.ConnectCallback`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.connectcallback) lets us open the TCP connection ourselves, so we can resolve, check and connect in one place. Here is the heart of `PublicOnlyHttpHandler.Create` (`Blouppy.Aspire.ServiceDefaults/Security/Outbound/PublicOnlyHttpHandler.cs`):

```csharp
ConnectCallback = async (context, cancellationToken) =>
{
    var host = context.DnsEndPoint.Host;
    var port = context.DnsEndPoint.Port;

    IPAddress[] addresses = IPAddress.TryParse(host, out var literal)
        ? [literal]
        : await Dns.GetHostAddressesAsync(host, cancellationToken);

    var allowed = allowPrivateNetworkTargets()
        ? addresses
        : addresses.Where(PublicAddressGuard.IsAllowed).ToArray();

    if (allowed.Length == 0)
    {
        throw new HttpRequestException(
            $"'{host}' resolves to an address Blouppy will not connect to.");
    }

    var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };

    try
    {
        // Connect to the checked addresses, never the hostname, which would resolve again unchecked.
        await socket.ConnectAsync(allowed, port, cancellationToken);

        return new NetworkStream(socket, ownsSocket: true);
    }
    catch
    {
        socket.Dispose();

        throw;
    }
}
```

- A literal address is parsed; a name is resolved **once**, by us. The addresses are filtered through `PublicAddressGuard`, and if none is left the request fails with an `HttpRequestException`, like any connection failure.
- [`socket.ConnectAsync(allowed, port, ...)`](https://learn.microsoft.com/dotnet/api/system.net.sockets.socket.connectasync) takes the **array of checked addresses**, not the hostname. There is no second resolution left for DNS rebinding to race.
- The `NetworkStream` owns the socket, and the socket is disposed if the connection fails.

TLS still works: the handler negotiates it on top of the returned stream, with the original hostname for SNI and certificate validation. And since the check runs on every new connection, a URL repointed to a private address is refused from then on.

`allowPrivateNetworkTargets`, a `Func<bool>` read on each connection, lets a developer point a webhook at a local receiver; the registration forces it to `false` outside Development in a `PostConfigure`, so a stray setting cannot turn a server into a proxy.


## Layer 3: no redirects, no proxy, no cookies
The rest of the handler closes the side doors:

```csharp
return new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    UseProxy = false,
    UseCookies = false,
    ConnectTimeout = connectTimeout,
    // The check is not re-run on pooled connections, so keep them short-lived.
    PooledConnectionLifetime = TimeSpan.FromMinutes(1),
    ConnectCallback = ...
};
```

- `AllowAutoRedirect = false`: a public endpoint answering `302 Location: http://10.0.0.5/` would otherwise be followed. For a webhook, a redirect is a non-2xx answer.
- `UseProxy = false`: through a proxy, the proxy resolves and connects, and `ConnectCallback` only ever sees the proxy.
- `UseCookies = false`: one cookie container shared across every user's endpoint makes no sense.
- [`PooledConnectionLifetime`](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines): the check runs when a connection is **opened**, not on each request reusing it, so one minute bounds how long a repointed name can ride an old socket.

One limit sits outside the handler: the sender reads at most `WebhookRules.MaxStoredResponseLength` (64 KiB) of the response body with `ReadAtLeastAsync` on a fixed buffer, so an endpoint that streams gigabytes back cannot exhaust memory.

The handler is plugged into a typed client as its primary handler:

```csharp
services
    .AddHttpClient<IWebhookSender, HttpWebhookSender>(HttpWebhookSender.HttpClientName)
    .ConfigureAdditionalHttpMessageHandlers((handlers, _) => handlers.Clear())
    .ConfigurePrimaryHttpMessageHandler(provider =>
    {
        var options = provider.GetRequiredService<IOptions<WebhookOptions>>();

        return PublicOnlyHttpHandler.Create(
            () => options.Value.AllowPrivateNetworkTargets,
            WebhookRules.ConnectTimeout);
    });
```

> **_Note:_**  `handlers.Clear()` matters. If your host adds `AddStandardResilienceHandler()` and `AddServiceDiscovery()` to every client through `ConfigureHttpClientDefaults`, as the Aspire service defaults do, the webhook client inherits them. Service discovery would resolve a user-typed host against your own service names, a second resolver in front of ours, and the resilience handler would retry a `POST` the subscriber may already have acted on.


## Conclusion
An outgoing call to a URL a user chose must be checked where the connection is made, not where the URL is saved. With `SocketsHttpHandler.ConnectCallback`, we resolve the name once, filter the addresses by **range** (IPv4 as a deny-list, IPv6 as an allow-list of global unicast) and connect to exactly those. No redirects, no proxy, no cookies, short-lived pooled connections and a bounded response body close the side doors.

This is how outgoing webhooks, and the identity host's fetches of client metadata documents and SSO configuration, are built in [Blouppy Starter](https://starter.blouppy.com/): one shared handler in the service defaults, so the next feature that calls a URL somebody else chose reuses it rather than a copy.


## References
- [Server Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) (OWASP) — allow-lists, IP validation, DNS rebinding and redirects.
- [A10:2021 Server-Side Request Forgery](https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/) (OWASP Top 10) — the risk and its common scenarios.
- [`SocketsHttpHandler.ConnectCallback`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.connectcallback) (API reference) — opening the connection yourself.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines) (Microsoft Learn) — pooled connections and `PooledConnectionLifetime`.
- [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IPv6 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) — the ranges the guard denies.
- [RFC 1918](https://www.rfc-editor.org/rfc/rfc1918) — private IPv4 address space.
- [RFC 6052](https://www.rfc-editor.org/rfc/rfc6052) — IPv6 addressing of IPv4/IPv6 translators (NAT64).
- [Webhooks](https://docs.starter.blouppy.com/modules/webhooks/) (Blouppy Starter docs) — the delivery pipeline that uses this handler.
