---
templateKey: 'blog-post'
title: 'SSRF-proof outgoing HTTP calls in .NET: resolve, check, then connect'
date: 2026-12-01T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

Sooner or later, a SaaS calls a URL that one of its users typed: a webhook endpoint, a file to import, a metadata document. The request leaves from **our** server, inside **our** network. So if the user types `https://169.254.169.254/latest/meta-data/`, `https://localhost:5432/` or `https://10.0.0.5/admin`, our server politely fetches the cloud metadata endpoint or an internal service for them. This is **Server-Side Request Forgery** (SSRF).

The usual fix, "check the URL before calling it", is not enough. A hostname can resolve to a public address when we check it and to a private one when we connect, and a public endpoint can answer with a redirect to `http://10.0.0.5/`.

In this article, we will build an `HttpClient` that refuses to dial anything but a public address, in three layers: a check at save time, a check at connect time inside `SocketsHttpHandler.ConnectCallback`, and no redirects, proxy or cookies.


## Why checking the hostname is the bug
Let's start with the version most of us write first:

```csharp
var uri = new Uri(url);
var addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, cancellationToken);

if (addresses.Any(IsPrivate))
{
    throw new InvalidOperationException("Private address.");
}

var response = await httpClient.PostAsync(uri, content, cancellationToken);
```

It looks right, but there are **two** DNS resolutions here: ours, and the one the socket does when `HttpClient` connects. We inspected the first one. The connection uses the second one, which nothing inspected.

This is a classic time-of-check to time-of-use (TOCTOU) race, and **DNS rebinding** exploits it on purpose: the attacker controls the DNS server of `evil.example`, answers our check with a public address and a very short TTL, then answers the socket's lookup with `127.0.0.1`. Our check passed, and we are now talking to our own loopback.

The same thing happens in time, not only in milliseconds: a webhook URL saved today with a public address can be repointed tomorrow to an internal one. Any check done "once, when the URL is saved" is a check of the past.

So the rule is simple: **resolve, check, then connect to the address we checked**. Never hand the hostname back to the socket.


## Judge address ranges, not hostnames
Before the handler, we need the check itself. A deny-list of hostnames (`localhost`, `metadata.google.internal`...) cannot work: `localhost`, `127.0.0.1`, `[::ffff:127.0.0.1]`, and any DNS name we do not own pointed at `127.0.0.1` are the same request. Only the **address** tells the truth, so we judge address ranges.

Here is the core of `PublicAddressGuard`, from the code base this comes from (`Blouppy.Aspire.ServiceDefaults/Security/Outbound/PublicAddressGuard.cs`):

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

`AddressRange` is a small private record that compares the first `PrefixLength` bits of the address bytes with the network's. A few points matter here:
- **IPv4-mapped addresses are unwrapped first.** `::ffff:10.0.0.1` is `10.0.0.1`, and it is judged as such.
- **IPv4 is a deny-list**: "this network", RFC 1918, loopback, CGNAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`, which holds the metadata endpoint `169.254.169.254`), the documentation and benchmarking ranges, and everything from `224.0.0.0/3` up (multicast, reserved, broadcast).
- **IPv6 is an allow-list**: only global unicast (`2000::/3`) passes, minus a few ranges inside it. Loopback, link-local, unique-local, NAT64 (`64:ff9b::/96`) and IPv4-compatible (`::/96`) are all outside `2000::/3`, so they are refused without being named. A range assigned later outside `2000::/3` is refused before anyone lists it.
- **Anything else** (not IPv4, not IPv6) is refused.

> **_Note:_**  The IPv6 side matters more than it looks. NAT64, 6to4 (`2002::/16`), Teredo (inside `2001::/32`) and IPv4-compatible addresses all **embed an IPv4 address** and can route to it. `64:ff9b::a9fe:a9fe` is the metadata endpoint wearing an IPv6 costume.

The unit tests read like a list of known escapes. Here are a few representative cases from `PublicAddressGuardTests`:

```csharp
[Theory]
[InlineData("64:ff9b::7f00:1")]
[InlineData("64:ff9b::a9fe:a9fe")]
[InlineData("::7f00:1")]
[InlineData("2002:a9fe:a9fe::1")]
[InlineData("2001::1")]
public void Should_refuse_the_address_when_it_embeds_an_IPv4_address(string address)
{
    // Act
    var isAllowed = PublicAddressGuard.IsAllowed(IPAddress.Parse(address));

    // Assert
    isAllowed
        .Should()
        .BeFalse();
}

[Fact]
public void Should_refuse_the_address_when_a_private_IPv4_address_is_mapped_to_IPv6()
{
    // Arrange
    var mapped = IPAddress.Parse("10.0.0.1").MapToIPv6();

    // Act
    var isAllowed = PublicAddressGuard.IsAllowed(mapped);

    // Assert
    isAllowed
        .Should()
        .BeFalse();
}
```

The tests also check the **edges** of each range on both sides: `172.16.0.0` and `172.31.255.255` are refused, while `172.15.255.255` and `172.32.0.0` are allowed. An off-by-one in a prefix length shows up immediately. 👍


## Layer 1: refuse the URL at save time
The first layer is not the one that protects us, but it is the one that helps the user. When someone saves a webhook, we want the form to say *why* the URL is refused, under the field. Let's look at `WebhookUrlPolicy` (`Blouppy.Infrastructure.Webhooks/WebhookUrlPolicy.cs`), behind the port `IWebhookUrlPolicy`:

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

Here is what it does:
- It refuses anything that is not an absolute `https` URL, which also rules out `file:///etc/passwd` and `ftp://`.
- It refuses credentials in the URL (`https://user:password@host/`).
- It resolves the host and refuses the URL if **any** address is private. A DNS answer mixing a public and a private address must not pass just because the first one looks fine.

A FluentValidation rule calls it from the webhook's validator, with a comment that says it all: *"Checked again at send time against the resolved address."* This layer is a courtesy. Everything we said about TOCTOU applies to it.


## Layer 2: check the address the socket connects to
Now the layer that matters. `SocketsHttpHandler` has a `ConnectCallback`: instead of letting the handler open the TCP connection, we open it ourselves. That is exactly where we can resolve, check and connect in one place. Here is the heart of `PublicOnlyHttpHandler.Create` (`Blouppy.Aspire.ServiceDefaults/Security/Outbound/PublicOnlyHttpHandler.cs`):

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

Let's go through it:
- `context.DnsEndPoint` gives us the host and port the request wants. A literal address is parsed, a name is resolved **once**, by us.
- The addresses are filtered through `PublicAddressGuard`. If none is left, the request fails with an `HttpRequestException`, like any other connection failure.
- `socket.ConnectAsync(allowed, port, ...)` takes the **array of checked addresses**, not the hostname. There is no second resolution, so there is nothing left for DNS rebinding to race.
- The `NetworkStream` owns the socket, and the socket is disposed if the connection fails.

> **_Note:_**  TLS still works as usual: the handler negotiates TLS on top of the stream we return, using the original hostname for SNI and certificate validation. We only replaced *how* the TCP connection is opened.

Since the check runs on every new connection, a webhook URL that resolved publicly yesterday and privately today is refused today. That is the property the save-time check could never give us.

`allowPrivateNetworkTargets` is a `Func<bool>`, read on each connection, so that options bound after the handler is built still apply. It exists so that a developer can point a webhook at a local receiver, and the registration forces it to `false` outside Development in a `PostConfigure`. A stray environment variable or an `appsettings` file copied from a laptop cannot turn a server into a proxy.


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

- `AllowAutoRedirect = false`: a public endpoint answering `302 Location: http://10.0.0.5/` would otherwise be followed. For a webhook, a redirect is simply a non-2xx answer.
- `UseProxy = false`: with a proxy, the proxy resolves and connects, and our `ConnectCallback` would only ever see the proxy.
- `UseCookies = false`: one shared cookie container across every user's endpoint makes no sense.
- `PooledConnectionLifetime`: the check runs when a connection is **opened**, not on each request reusing it. One minute bounds how long a repointed name can ride an old socket.

One last limit is outside the handler: the response body. The sender reads at most `WebhookRules.MaxStoredResponseLength` (64 KiB) with `ReadAtLeastAsync` on a fixed buffer, and no further. An endpoint that streams gigabytes back cannot exhaust our memory.

Here is how it is plugged into a typed client:

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

> **_Note:_**  Watch out for `ConfigureHttpClientDefaults`. If your host adds `AddStandardResilienceHandler()` and `AddServiceDiscovery()` to every client (as the Aspire service defaults template does), the webhook client inherits them. Service discovery would resolve a user-typed host against your own service names, a second resolver in front of ours, and the resilience handler would retry a `POST` the subscriber may already have acted on. `handlers.Clear()` removes both, and a unit test builds the pipeline to hold it down. 😉


## Conclusion
An outgoing call to a URL a user chose has to be checked where the connection is made, not where the URL is saved. Checking a hostname and then letting the socket resolve it again leaves a gap that DNS rebinding was invented for. With `SocketsHttpHandler.ConnectCallback`, we resolve the name once, filter the addresses, and connect to exactly those addresses.

The check itself judges address **ranges**, never hostnames: IPv4 as a deny-list, IPv6 as an allow-list of global unicast, with IPv4-mapped addresses unwrapped and the IPv6 forms that embed an IPv4 address refused. Around it, no redirects, no proxy, no cookies, short-lived pooled connections and a bounded response body close the side doors. The save-time check stays, but only to give the user a clear message.

This is how outgoing webhooks, and the identity server's fetches of client metadata documents and SSO configuration, are built in [Blouppy Starter](https://starter.blouppy.com/): one shared handler in the service defaults, so the next feature that calls a URL somebody else chose goes through the same code rather than a copy. The [webhooks module documentation](https://docs.starter.blouppy.com/modules/webhooks/) describes the rest of the delivery pipeline.

*Thanks for reading! 🙂*
