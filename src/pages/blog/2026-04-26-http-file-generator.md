---
templateKey: 'blog-post'
title: 'Introducing HTTP File Generator: Generate .http Files from OpenAPI Specifications'
date: 2026-04-26T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Next.js
topic: 'Tooling'
illustration: 1
categorycolor: bg-blue-100 text-blue-800
featuredpost: true
featuredimage: /img/http-file-generator.jpg
description: >-
  Turn an OpenAPI specification into ready-to-run .http files in the browser: what the tool generates, how to use it and how to run it locally.
tags:
  - Development
  - TypeScript
  - Next.js
  - OpenAPI
  - REST API
---

Testing a REST API is a daily task. Postman and Insomnia are popular, but a plain-text `.http` file does the same job and lives in the repository, next to the code it calls. Visual Studio, Rider and the REST Client extension for VS Code all run it.

**HTTP File Generator** writes those files for you. You upload an [OpenAPI](https://spec.openapis.org/oas/latest.html) specification, pick the endpoints you need, preview the result and download a ZIP archive. Everything runs in your browser: the specification never leaves your machine.


## What is a .http file?

A `.http` file holds one or more HTTP requests, separated by `###`. Each request has a method, a URL, headers and an optional body. Lines that start with `@` declare variables, which the requests reference with `{{name}}`:

```http
@baseUrl = https://api.example.com
@token = your_token_here

### Get all products
GET {{baseUrl}}/products
Authorization: Bearer {{token}}

### Create a product
POST {{baseUrl}}/products
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "name": "Widget",
  "price": 9.99
}
```

You can send these requests from [Visual Studio](https://learn.microsoft.com/aspnet/core/test/http-files), from [Rider](https://www.jetbrains.com/help/rider/Http_client_in__product__code_editor.html) or from VS Code with the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension: open the file and click **Send Request** above a request.


## Why generate them?

A specification can describe hundreds of endpoints. Writing a request for each one by hand is slow, and the hand-written copy drifts from the API. HTTP File Generator:

- **parses the specification for you**: OpenAPI 3.x in `.json`, `.yaml` or `.yml`, uploaded or loaded from a URL;
- **shows a live preview** that follows your selection;
- **builds a ZIP archive** with one `.http` file per tag, split by path, so the files mirror the structure of the API.


## How to use it

### Step 1: load the specification
Open [HTTP File Generator](https://http-file-generator.blouppy.com/) and drop your specification on the upload area, or click **Browse files**. The **URL** tab loads a specification from a public address instead; the server that hosts it must allow [cross-origin requests](https://developer.mozilla.org/docs/Web/HTTP/Guides/CORS), because the browser fetches it directly.

The file is parsed and its `$ref`s resolved in the browser with [`@apidevtools/swagger-parser`](https://apidevtools.com/swagger-parser/). **The specification is never sent to a server.**

### Step 2: select the endpoints
The selection screen lists the operations grouped by tag, with the method, the path and the summary of each one. You can:

- filter by HTTP method or by tag;
- search by keyword, with the list narrowing as you type;
- select or clear a whole tag, or every endpoint at once;
- expand an endpoint to inspect its parameters, request body, responses and referenced schemas.

The preview panel updates each time you toggle an endpoint.

### Step 3: download
Click **Download** to get the ZIP archive, or **Copy** to put the preview on your clipboard.

Here is what the tool generates for two endpoints of the [Swagger Petstore](https://petstore3.swagger.io/) specification:

```http
# Petstore v1.0.0
# Base URL: https://petstore3.swagger.io/api/v3

@baseUrl = https://petstore3.swagger.io/api/v3
@token = your_token_here

### Add a new pet to the store
POST https://petstore3.swagger.io/api/v3/pet
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "id": 1,
  "name": "doggie",
  "status": "available",
  "photoUrls": [
    "photoUrls1",
    "photoUrls2"
  ]
}

### Find pet by ID
@petId = 1
GET https://petstore3.swagger.io/api/v3/pet/{{petId}}
Authorization: Bearer {{token}}
```

- The header declares the first server URL and a `@token` placeholder: replace `your_token_here` with a real token before you send anything.
- Path and query parameters become variables, with a default taken from the specification (`example`, `default`, the first `enum` value) or from the parameter's type.
- A JSON body is built from the schema's `example`, or from its properties when there is none.

The repository's [format reference](https://github.com/Blouppy/http-file-generator/blob/master/docs/http-file-format.md) lists every rule.


## Tech stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/docs/app) (App Router), React 19 |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS 4 |
| UI components | [shadcn/ui](https://ui.shadcn.com/) |
| OpenAPI parsing | `@apidevtools/swagger-parser`, `yaml` |
| ZIP generation | [JSZip](https://stuk.github.io/jszip/), `file-saver` |
| Unit tests | [Jest](https://jestjs.io/docs/getting-started), Testing Library |
| End-to-end tests | [Playwright](https://playwright.dev/docs/intro) |

The interface is available in English and French, with light, dark and system themes.


## Running it locally

You need Node.js 20.9 or later, the minimum Next.js 16 supports:

```bash
git clone https://github.com/Blouppy/http-file-generator.git
cd http-file-generator
npm install
npm run dev
```

The development server listens on `http://localhost:3000`. `npm test` runs the unit tests and `npm run lint` the linter. For the end-to-end tests, download the browser once with `npx playwright install chromium`, then run `npm run test:e2e`: Playwright builds the application and starts it before the tests.


## Conclusion

HTTP File Generator removes the chore of writing `.http` files by hand. Drop in a specification, choose the endpoints and get files you can commit next to your code.

The project is open source on GitHub: [Blouppy/http-file-generator](https://github.com/Blouppy/http-file-generator).


## References

- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) — the format the tool reads.
- [Use .http files in Visual Studio](https://learn.microsoft.com/aspnet/core/test/http-files) — Microsoft Learn: syntax, variables and sending requests.
- [HTTP Client in Rider](https://www.jetbrains.com/help/rider/Http_client_in__product__code_editor.html) — JetBrains: the same format in Rider.
- [REST Client for VS Code](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) — the extension that runs `.http` files in VS Code.
- [Cross-Origin Resource Sharing (CORS)](https://developer.mozilla.org/docs/Web/HTTP/Guides/CORS) — MDN: why loading a specification from a URL needs the host's consent.
- [Swagger Parser](https://apidevtools.com/swagger-parser/) — parsing, validating and dereferencing the specification.
- [JSZip](https://stuk.github.io/jszip/) — building the archive in the browser.
- [Next.js App Router](https://nextjs.org/docs/app) — the framework the application is built on.
- [Blouppy/http-file-generator](https://github.com/Blouppy/http-file-generator) — the source code, with the [generated format reference](https://github.com/Blouppy/http-file-generator/blob/master/docs/http-file-format.md).
