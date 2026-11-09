---
templateKey: 'blog-post'
title: 'Deploying .NET and Angular on one VM with Docker Compose and Caddy'
date: 2027-02-04T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to run a .NET and Angular SaaS on one server with Docker Compose and Caddy: automatic TLS, one Dockerfile for every host, gated migrations, health checks and backups.
tags:
  - Development
  - ASP.NET Core
  - PostgreSQL
---

A SaaS made of an Angular SPA, an API, an identity host and a gateway runs fine under Aspire on a laptop. To put it online, the options look either too small (`dotnet run` behind nginx, certificates renewed by hand) or too large (a Kubernetes cluster for four processes). In between sits one virtual machine with Docker Compose. For many products, it is enough for a long time.

The idea fits in one sentence: one container per process, one private network, and a single container with published ports. That is how [Blouppy Starter](https://starter.blouppy.com/) is deployed, from its `deploy/` folder: Caddy, PostgreSQL, RabbitMQ, Redis, a migration runner, three .NET hosts and the SPA's nginx image. The hosts listen on plain HTTP 8080 inside the network. Nothing but Caddy is reachable from outside.


## Caddy: TLS without a cron job
[Caddy](https://caddyserver.com/docs/automatic-https) obtains and renews Let's Encrypt certificates on its own, as soon as a site block names a public host, and redirects HTTP to HTTPS. The Starter's sites, trimmed to one of three:

```text
(common) {
	encode zstd gzip
	header -Server
}

(upstream) {
	header_up X-Forwarded-For {client_ip}
}

{$APP_DOMAIN} {
	import common
	reverse_proxy gateway:8080 {
		import upstream
	}
}
```

The application's name goes to the gateway, which serves the SPA and holds the browser's session (the [BFF pattern](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/)). The identity host and the API get their own names, the same way.

Caddy sets `X-Forwarded-Proto`, and `X-Forwarded-For` to a single address. The hosts must believe those headers from Caddy alone. Each one reads the network's subnet from `ForwardedHeaders__TrustedNetworks__0` and configures ASP.NET Core's [forwarded headers](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) with it. Without that, every request looks like plain HTTP from `172.30.0.x`, and the sign-in's redirect URIs are wrong.

Two more details matter. Caddy has no `depends_on` on the hosts: it starts at once and answers 502 for a host that is not up yet, instead of keeping the others offline. And its `caddy-data` volume keeps the certificates, so a restart does not hit Let's Encrypt's rate limits.


## One Dockerfile for every .NET host
The API, the identity host, the gateway and the migration runner share one solution. Four nearly identical Dockerfiles would drift, so `back/Dockerfile` takes the project as a build argument. Trimmed:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG PROJECT
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN test -n "${PROJECT}" || (echo "--build-arg PROJECT=... is required" && exit 1) \
    && case "${TARGETARCH}" in arm64) rid=linux-arm64 ;; *) rid=linux-x64 ;; esac \
    && dotnet publish "${PROJECT}/${PROJECT}.csproj" \
        --configuration Release --runtime "${rid}" --self-contained false \
        --output /app -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
ARG PROJECT
WORKDIR /app
COPY --from=build /app .
RUN printf '#!/bin/bash\nexec dotnet /app/%s.dll "$@"\n' "${PROJECT}" > /usr/local/bin/blouppy-host \
    && chmod 755 /usr/local/bin/blouppy-host
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/blouppy-host"]
```

`TARGETARCH`, set by BuildKit, picks the runtime, so the same file builds for amd64 and arm64 servers. The runtime image runs as the base image's non-root user.

The entry point is the subtle part. The exec form of `ENTRYPOINT` expands no variable, so a small script is written at build time. It runs through `bash` on purpose: `dash` drops environment variables whose names are not shell identifiers, and `ConnectionStrings__blouppy-db` is one of them. The real file also installs `curl`, for the health check.


## A startup order that means something
`depends_on` alone only waits for a container to *start*. Its conditions are what make the order useful. Here is the API's service, trimmed:

```yaml
migrations:
  restart: "no"
  build:
    context: ../back
    args:
      PROJECT: Blouppy.MigrationRunner
  depends_on:
    postgres:
      condition: service_healthy

api:
  healthcheck: *healthcheck
  depends_on:
    migrations:
      condition: service_completed_successfully
    rabbitmq:
      condition: service_healthy
    redis:
      condition: service_healthy
```

PostgreSQL, RabbitMQ and Redis each declare a health check, and `service_healthy` waits for them. The migration runner applies every EF Core migration and exits. `service_completed_successfully` starts the hosts only once it has exited `0`. A failed migration then leaves them stopped, instead of running against a half-migrated schema ([why a migration runner](/blog/2026-09-01-a-migration-runner-instead-of-migrate-at-startup/)). `restart: "no"` keeps Compose from restarting a container whose job is to finish.

The `*healthcheck` anchor calls each host's `/health` with `curl` every fifteen seconds. The body is the status alone, `Healthy` or `Unhealthy`, so it can be public without telling anyone which dependency failed.


## One .env file, and backups
Every .NET service has `env_file: .env`, so the whole file reaches every host. ASP.NET Core reads `__` as the section separator: `Email__Smtp__Host` becomes `Email:Smtp:Host`. A setting added there reaches the host that reads it without touching the compose file. The wiring between containers, connection strings and internal URLs, lives under `environment:` and wins over `.env`, so a typo in the file cannot break it.

The repository ships `.env.example` with every setting documented, and the deployment starts by copying it and running `chmod 600 .env`. That is a reasonable floor for one server, not a vault. A team that needs rotation or an audit trail moves the secrets to a secret manager.

A volume is not a backup. `deploy/backup.sh` runs `pg_dump --format=custom` through `docker compose exec` and keeps fourteen days of dumps. Run it nightly from cron and before every upgrade. Then copy the dumps off the server, keep the Data Protection certificate next to them (without it, a restored database cannot decrypt its own keys), and try a restore once, before the day it is needed.

The same stack runs on a laptop too. `docker-compose.local.yml`, layered over the main file, serves it on `*.localhost` with a local certificate authority.


## The limits of one machine
- **No zero-downtime deploys.** `docker compose up -d --build` stops each changed container and starts the new one. Caddy answers 502 for a few seconds in between.
- **A single point of failure.** When the machine goes, everything goes. Recovery time is how fast we restore a dump on a new server.
- **Mostly vertical scaling.** The hosts are stateless, and `--scale api=2` works. A second server needs a load balancer and files in an S3-compatible bucket.

It is time to move on when those seconds of 502 are no longer acceptable, or when one machine's outage costs more than a second machine. A PaaS such as Azure Container Apps gives rolling deploys and managed databases without running a cluster. Neither needs a rewrite: the images run anywhere, and the migration runner becomes a job the rollout waits for.


## References
- [Automatic HTTPS (Caddy)](https://caddyserver.com/docs/automatic-https) — how Caddy obtains and renews certificates.
- [Control startup order in Compose (Docker)](https://docs.docker.com/compose/how-tos/startup-order/) — `service_healthy` and `service_completed_successfully`.
- [Configure ASP.NET Core to work with proxy servers and load balancers (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) — forwarded headers and known networks.
- [pg_dump (PostgreSQL)](https://www.postgresql.org/docs/current/app-pgdump.html) — the custom format and `pg_restore`.
