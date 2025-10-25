# Job Poster

Job Poster ingests job listings from public URLs, lets you complete or adjust the structured data, and publishes the result to multiple downstream platforms. It combines a secure REST API, an interactive admin UI, and a queue that tracks every job that needs human attention before it can be published.

## Features

- 🔐 **API & admin authentication** – Protect programmatic access with an API key and gatekeep the admin console with HTTP Basic auth credentials supplied via environment variables.
- 🤖 **Automatic extraction** – Point the app to any job posting URL to pre-populate titles, descriptions, salaries, addresses, and more.
- 🧩 **Modular publishing targets** – Enable or disable publishers such as Google for Jobs or Indeed, each with documented requirements.
- 🧾 **Hold queue** – Automatically hold jobs that are missing required fields or credentials. Review the queue from the dashboard, complete the missing pieces, and publish in one click.
- 🧠 **Context-aware API** – Merge extracted fields with custom overrides, detect missing metadata, and either publish instantly or hold for review.

## Getting Started

### Requirements

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file or export the following variables before starting the server:

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No (default: `3000`) | Port to run the HTTP server on. |
| `ORIGIN` | No | Public base URL used when generating hosted job links. |
| `ADMIN_USERNAME` | **Yes** | Username for HTTP Basic auth protecting the admin console. |
| `ADMIN_PASSWORD` | **Yes** | Password for HTTP Basic auth protecting the admin console. |
| `API_KEY` | **Yes** | API key required in the `X-API-Key` header (or `api_key` query parameter) for every `/api/*` request. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | Google Indexing API service account JSON (optional, enables instant indexing). |
| `INDEED_CLIENT_ID` | No | Indeed API client ID for publishing directly to Indeed. |
| `INDEED_CLIENT_SECRET` | No | Indeed API client secret. |

### Running the Server

```bash
npm run dev
```

The server boots on `http://localhost:3000` by default. Visit that URL in a browser to access the dashboard, or call the REST API with your API key.

## Authentication Model

### Admin UI

- The `/admin/*` routes are protected by HTTP Basic authentication.
- Browsers prompt for credentials automatically; supply the configured `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

### REST API

- Every request to `/api/modules` and `/api/jobs` must provide the API key.
- Send the header `X-API-Key: $API_KEY` or append `?api_key=$API_KEY` to the request URL.
- Unauthenticated requests receive HTTP 401 responses.

## REST API Reference

### `GET /api/modules`

Lists the publishing platforms, their descriptions, and required fields.

```bash
curl -H "X-API-Key: $API_KEY" http://localhost:3000/api/modules
```

### `POST /api/jobs`

Ingests a job posting and either publishes immediately or places it in the review queue when fields/credentials are missing.

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "url": "https://example.com/jobs/123",
    "fields": {
      "title": "Senior Software Engineer",
      "hiringOrganization": { "name": "Example Inc" }
    },
    "modules": ["google", "indeed"],
    "holdIfIncomplete": true
  }' \
  http://localhost:3000/api/jobs
```

**Request fields**

- `url` *(optional)* – Source URL to extract data from.
- `fields` *(optional)* – Partial `JobPosting` overrides merged onto extracted content.
- `modules` *(optional)* – Array of publisher IDs or the string `"all"` to target every platform.
- `credentials` *(optional)* – Publisher credentials (e.g. `indeed.clientId`) scoped to this request.
- `holdIfIncomplete` *(default: `true`)* – When `true`, jobs missing required fields or credentials are held for review instead of attempting publication.

**Responses**

- `202 held` – Job is missing information. The JSON response includes a `jobId`, `missing` breakdown, and `reviewUrl`.
- `200 published` – Contains the `results` map keyed by module ID with per-platform publish details.
- `500 error` – Something went wrong during extraction or publication.

## Web UI Walkthrough

- **Dashboard** – Displays the ingestion form, API quick reference, platform catalog, and a live snapshot of the review queue.
- **Review Queue** – Located at `/admin/holds`, this table lists every held job, the target platforms, missing metadata, and quick actions.
- **Job Review** – After extraction (or from the queue) you can edit any field, toggle target platforms, and publish.

## Publishing Modules

Each module defines the fields and credentials it requires. The current modules include:

- **Google for Jobs** (`google`) – Hosts structured job pages and optionally triggers the Google Indexing API when `GOOGLE_SERVICE_ACCOUNT_JSON` is provided.
- **Indeed** (`indeed`) – Requires `indeed.clientId` and `indeed.clientSecret` credentials to push directly to Indeed.

Add new modules by implementing the `Publisher` interface in `src/modules/` and registering it in `PUBLISHERS`.

## Development Tips

- The `jobs/` directory stores hosted job artifacts generated during publication.
- Held jobs persist as JSON files under `src/data/holds/`; delete files to clear the queue while testing.
- Run `npm run build` to type-check and transpile the TypeScript sources.

