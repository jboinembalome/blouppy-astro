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

A SaaS made of an Angular SPA, an API, an identity host and a gateway runs fine under Aspire on a laptop. To put it on the internet, the options look either too small (`dotnet run` behind nginx, certificates renewed by hand) or too large (a Kubernetes cluster for four processes). Between the two sits one virtual machine with Docker Compose, and for many products it is enough for a long time.

In this article, we will put such an application on one VM: **Caddy** in front for TLS and routing, **one Dockerfile** for every .NET host, the **migration runner** as a one-shot service the hosts wait for, **health checks** that gate the startup order, **one `.env` file** passed to every host, then backups, a local variant on `*.localhost`, and the limits of a single machine.


## The shape of the stack
The idea fits in one sentence: one container per process, one private network, and one container with published ports. Everything else (PostgreSQL, RabbitMQ, Redis, the hosts) is reachable only from inside the network.

A minimal version, before the real one:

```yaml
services:
  proxy:
    image: caddy:2.11
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data

  db:
    image: postgres:17.5
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set it in .env}
    volumes:
      - db-data:/var/lib/postgresql/data

  api:
    build: ./back
    environment:
      ConnectionStrings__db: Host=db;Password=${POSTGRES_PASSWORD}

volumes:
  caddy-data:
  db-data:
```

- Only `proxy` publishes ports. The database is never on `5432` of the public interface.
- `${POSTGRES_PASSWORD:?...}` makes `docker compose up` fail when the variable is missing.
- The data lives in **named volumes**, so `docker compose down` and a rebuild keep it.

In [Blouppy Starter](https://starter.blouppy.com/), the real file is `deploy/docker-compose.yml`. It runs Caddy, PostgreSQL, RabbitMQ, Redis, the migration runner, the gateway, the identity host, the API and the SPA's nginx image. The three .NET hosts listen on plain HTTP 8080 inside the network, and Caddy terminates TLS for three public names.


## Caddy: TLS without a cron job
[Caddy](https://caddyserver.com/docs/automatic-https) obtains and renews certificates from Let's Encrypt on its own, as soon as a site block names a public host, and redirects HTTP to HTTPS. The Starter's sites, from `deploy/sites.caddy`:

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

# {$IDENTITY_DOMAIN} -> identity:8080, {$API_DOMAIN} -> api:8080, the same way
```

- The application's name goes to the **gateway**, which serves the SPA and holds the browser's session (the [BFF pattern](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/)). The identity host has its own name, and the API has one for scripts calling it with a [personal access token](/blog/2026-08-08-personal-access-tokens-in-aspnet-core/).
- `reverse_proxy` sets `X-Forwarded-Proto` and passes `Host` through unchanged. `X-Forwarded-For` is set to one address, `{client_ip}`, because the hosts trust one hop.
- The `Caddyfile` itself only holds the global options (`email {$ACME_EMAIL}` for expiry notices) and imports these sites, so the local variant can reuse them.

Two details of the compose file matter. First, Caddy has **no `depends_on`** on the hosts: it starts at once, gets the certificates, and answers 502 for a host that is not up yet instead of keeping the two others offline. Second, its `caddy-data` volume keeps the certificates, so a restart does not ask Let's Encrypt again and run into its rate limits.

The hosts must believe those headers from Caddy alone. Each one reads the network's subnet from `ForwardedHeaders__TrustedNetworks__0` and configures ASP.NET Core's [forwarded headers](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) with it; a header from any other address is ignored. Without it, every request looks like plain HTTP from `172.30.0.x`, and the sign-in's redirect URIs are wrong.

The compose file also gives Caddy **network aliases** for the three public names. The gateway and the API call the identity host at its public URL, the issuer OpenIddict publishes, and inside the network that name resolves to Caddy with the same certificate.


## One Dockerfile for every .NET host
Four .NET entry points (the API, the identity host, the gateway, the migration runner) share one solution. Four nearly identical Dockerfiles would drift, so `back/Dockerfile` takes the project as a build argument. Trimmed:

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
RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
RUN printf '#!/bin/bash\nexec dotnet /app/%s.dll "$@"\n' "${PROJECT}" > /usr/local/bin/blouppy-host \
    && chmod 755 /usr/local/bin/blouppy-host
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/blouppy-host"]
```

- The build fails early with a clear message when `PROJECT` is missing.
- `TARGETARCH`, set by BuildKit, picks the runtime identifier, so the same file builds for amd64 and arm64 servers. Publishing for one runtime also leaves out the native libraries of every other platform.
- The runtime image runs as the base image's **non-root user** (`$APP_UID`), and Kestrel listens on its default port, 8080.
- The entry point is a small script written at build time, because the exec form of `ENTRYPOINT` expands no variable. It goes through `bash` on purpose: `dash` drops environment variables whose names are not shell identifiers, and `ConnectionStrings__blouppy-db` is one of them.
- `curl` is the one extra package, for the health check.

Each service names its project under `build.args`, and an `image:` beside it (`${BLOUPPY_IMAGE_PREFIX:-blouppy}/api:${BLOUPPY_VERSION:-latest}`) lets a CI machine run `docker compose build && docker compose push` while the server only pulls.


## The startup order: health checks and a one-shot service
`depends_on` alone only waits for a container to *start*. Its conditions are what make the order mean something:

```yaml
x-healthcheck: &healthcheck
  test: ["CMD", "curl", "--fail", "--silent", "--output", "/dev/null", "http://127.0.0.1:8080/health"]
  interval: 15s
  timeout: 5s
  retries: 5
  start_period: 30s

services:
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

- `postgres` declares a `pg_isready` check, RabbitMQ `rabbitmq-diagnostics ping`, Redis `redis-cli ping`. `service_healthy` waits for them.
- The **migration runner** applies every EF Core migration and exits. `service_completed_successfully` starts the hosts only once it has exited `0`, and a failed migration leaves them stopped instead of running against a half-migrated schema. Why the runner exists at all is the subject of [a migration runner instead of Migrate() at startup](/blog/2026-09-01-a-migration-runner-instead-of-migrate-at-startup/).
- `restart: "no"` keeps Compose from restarting a container whose job is to finish.
- Each host maps `/health` (readiness: its database, its broker) and `/alive` (the process) in every environment. The body is the status alone, `Healthy` or `Unhealthy` with a `503`, so it can be public without telling anyone which dependency failed. The gateway waits for the SPA's container to be healthy too.

## Configuration: one .env for every host
Every .NET service has `env_file: .env`, so the whole file reaches every host. ASP.NET Core reads `__` as the section separator, and `Email__Smtp__Host` becomes `Email:Smtp:Host`. A setting added to `.env` reaches the host that reads it without touching the compose file.

The repository ships `.env.example`, with every setting documented, and the deployment starts with:

```bash
cd deploy
cp ../.env.example .env
chmod 600 .env
```

The UPPER_CASE values (`APP_DOMAIN`, `POSTGRES_PASSWORD`) are read by Compose itself, the UpperCamelCase ones by the hosts. The wiring between containers lives under `environment:` in the compose file, and it wins over `.env`, so the connection strings and the internal URLs cannot be broken by a typo in the file.

In this setup, `.env` holds the database and broker passwords, the OIDC client secret and the SMTP credentials, protected by file permissions on a machine only the operator can reach. The one file kept apart is the Data Protection certificate, mounted read-only from `deploy/secrets/` and owned by the containers' user. That is a reasonable floor for one server. It is not a vault: no rotation, no audit of who read what. A team that needs those moves the values to a secret manager and injects them at deploy time. And `$` stays out of the values, because Compose reads it as a variable.


## Volumes and backups
The volumes are `postgres-data`, `rabbitmq-data`, `caddy-data`, `caddy-config` and `files` (data exports and avatars, shared by the API and the identity host). Redis has none on purpose: it is a response cache, and a cold cache only makes the first requests slower.

A volume is not a backup. `deploy/backup.sh` writes a compressed dump and keeps fourteen days:

```bash
file="backups/blouppy-$(date +%Y%m%d-%H%M%S).dump"

docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$file"

find backups -name 'blouppy-*.dump' -mtime +14 -delete
```

It runs nightly from cron and before every upgrade. Three rules complete it: copy the dumps off the server (a backup on the same disk is not one), keep the Data Protection certificate and its password next to them (without it a restored database cannot decrypt its own keys), and try a restore with `pg_restore` into a scratch database once, before the day it is needed.


## The same stack on *.localhost
Before the server, `docker-compose.local.yml` runs the production stack on the developer's machine, layered over the main file:

```bash
cp local/local.env.example .env
./local/make-ca.sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Same images, same `Production` environment. Three things change. Caddy uses `local_certs` with a certificate authority generated by `make-ca.sh`, and every .NET container trusts it through `SSL_CERT_FILE`, since the hosts call each other at their `https://` names. MailPit catches the e-mail. And `Seed__Enabled=true` writes the sample users. Browsers resolve `*.localhost` to the loopback address, so no DNS entry is needed.


## The limits of one VM
This setup is cheap and readable, and it has real limits.

- **No zero-downtime deploys.** `docker compose up -d --build` stops each changed container and starts the new one. Caddy answers 502 in between, for seconds. Rolling updates and blue-green are not built in.
- **A single point of failure.** The disk, the kernel, the provider's zone: when the machine goes, everything goes, and recovery time is how fast we restore a dump on a new server.
- **Vertical scaling only, mostly.** The hosts are stateless, and `docker compose up -d --scale api=2` works for the API. A second server needs a load balancer that does what Caddy does here, and files in an S3-compatible bucket instead of a volume.
- **Operations are ours.** OS and Docker updates, disk space, and at least an uptime check on `/health`.

It is time to move on when a few seconds of 502 during a deploy are no longer acceptable, when one machine's outage costs more than a second machine, or when several teams deploy independently. A PaaS (Azure Container Apps, Fly.io, Render) gives rolling deploys and managed databases without running a cluster. Kubernetes makes sense when there is already someone to operate it. Neither needs a rewrite: the images run anywhere containers run, and the migration runner becomes a job the rollout waits for.

Until then, one VM with a nightly off-site backup is an honest production for a young product.


## Conclusion
Docker Compose and Caddy cover what a small SaaS needs on day one: automatic TLS, one entrance, a private network, and a startup order enforced by health checks and a one-shot migration service. One Dockerfile with `--build-arg PROJECT=` keeps four hosts on one recipe, and one `.env` file keeps configuration in one place. The price is downtime during deploys and a single machine to lose, which backups mitigate and only more machines remove.

This is how [Blouppy Starter](https://starter.blouppy.com/) is deployed. The `deploy/` folder holds the compose files, the Caddy sites, the backup script and a guide from an empty server to the application online.

## References
- [Automatic HTTPS (Caddy)](https://caddyserver.com/docs/automatic-https) — how Caddy obtains and renews certificates.
- [reverse_proxy directive (Caddy)](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) — upstreams and the headers Caddy sets.
- [Control startup order in Compose (Docker)](https://docs.docker.com/compose/how-tos/startup-order/) — `service_healthy` and `service_completed_successfully`.
- [Set environment variables in Compose (Docker)](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/) — `env_file`, `environment` and their precedence.
- [Multi-stage builds (Docker)](https://docs.docker.com/build/building/multi-stage/) — the SDK and runtime stages.
- [Configure ASP.NET Core to work with proxy servers and load balancers (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) — forwarded headers and known networks.
- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks) — `MapHealthChecks` and readiness versus liveness.
- [pg_dump (PostgreSQL)](https://www.postgresql.org/docs/current/app-pgdump.html) — the custom format and `pg_restore`.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the examples come from.
