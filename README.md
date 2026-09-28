# Nepali Keyboard API

An independently deployable Cloudflare Worker for explicit keyboard transformations. It does not store message bodies and sends text to the configured AI provider only for `POST /v1/transform`.

Requires Node.js 22 or newer.

## Local development

```bash
cp .dev.vars.example .dev.vars
# Leave MOCK_AI=true for the deterministic local fake.
npm install
npm test
npm run dev
```

Test it:

```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/v1/transform \
  -H 'content-type: application/json' \
  -d '{"requestId":"demo-1","operation":"translate_to_english","input":"ma bholi aauna sakdina"}'
```

For local real responses with the configured Google Gemma model, set `MOCK_AI=false` and put `GOOGLE_AI_API_KEY` in `.dev.vars`. The committed Wrangler config keeps `MOCK_AI=true` so no external AI account is used if the Worker is accidentally deployed. Choose a separate production provider and key before enabling deployment. Never commit `.dev.vars` or an API key.

## GitHub Actions deployment

The workflow in `.github/workflows/deploy.yml` checks types and runs tests on pull requests and pushes to `main`. Deployment is disabled by default. When the production provider and Cloudflare account are ready, set the GitHub Actions repository variable `ENABLE_API_DEPLOYMENT=true` and configure both repository secrets below. Later pushes to `main` will deploy after the checks pass:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the Worker.
- `CLOUDFLARE_API_TOKEN`: a token scoped to that account with Workers edit permission.

Store the chosen production AI provider's key as a Cloudflare Worker runtime secret, not a GitHub Actions secret. The local `.dev.vars` is never published. Choose and configure the production provider before enabling deployment. Do not enable Cloudflare's Git integration for the same Worker alongside this workflow, because that would create a second deployment path.

Build a release APK against the deployed Worker by passing the HTTPS origin (without a trailing path):

```bash
cd ../android-keyboard
./gradlew assembleRelease -PAI_API_BASE_URL=https://nepali-keyboard-api.YOUR_SUBDOMAIN.workers.dev
```

`CLIENT_TOKEN` is optional for a closed preview but is not strong mobile authentication. Add Play Integrity/App Check and a durable rate limiter before a public beta.
