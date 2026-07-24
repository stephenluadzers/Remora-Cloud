# Remora Cloud — Deployment Guide

## What This Is
A single $7/month Render instance that runs all three business engines 24/7:
- Parcel Invoice Auditor (FedEx/UPS refund recovery)
- Freight Brokerage Matchmaker (load matching + FMCSA screening)
- RFP Responder (government contract proposal generator)
- Lead Enrichment (email finding for no-website leads)

## Deployment Steps (5 minutes)

### Option A: GitHub + Render (recommended)
1. Push the `/app/remora-cloud` folder to a GitHub repo
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Render will auto-detect render.yaml
5. Click Create
6. Your server is live at `https://remora-cloud.onrender.com`

### Option B: Render CLI
```bash
npm i -g @render/cli
render deploy
```

## API Endpoints

### Health
GET /health

### Parcel Audit
POST /parcel/audit — { invoices: [...], carrier: "fedex" }
POST /parcel/claims/generate — { tracking_number, carrier, finding, claimant_info }
GET /parcel/reports

### Freight Broker
POST /freight/screen-carrier — { usdot: "1234567" }
POST /freight/match — { loads: [...], carriers: [...] }
POST /freight/rate-confirm — { match, load, carrier }

### RFP Responder
POST /rfp/parse — { rfp_text: "..." }
POST /rfp/generate — { rfp_data, capabilities, company_info }
GET /rfp/capabilities

### Lead Enrichment
POST /leads/enrich — { company_name, city }

## Cost
$7/month (Render Starter plan)
Runs 24/7 — your Mac can be off.

## Auth & Billing

Every engine route (`/parcel/*`, `/freight/*`, `/rfp/*`, `/leads/*`) now
requires an `x-api-key` header tied to a client. `/health` stays open.

### Required env vars
- `ADMIN_KEY` — required to use any `/admin/*` or `/billing/*` route. Without
  it, those routes are disabled (fail closed).
- `STRIPE_SECRET_KEY` — optional. Without it, engines still work and the
  billing ledger still tracks what's owed, but `/billing/invoice` returns
  what it *would* invoice instead of actually charging.
- `SERPAPI_KEY` — optional. Without it, `/leads/enrich` scrapes Google
  directly, which datacenter IPs get CAPTCHA'd on fairly often. Set this for
  reliable lead enrichment (the response's `blocked: true` flag tells you
  when the raw scrape got blocked).

### Creating a client
```bash
curl -X POST https://remora-cloud.onrender.com/admin/clients \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Acme Shipping","email":"ops@acme.com"}'
# => { id, name, email, api_key, ... }  -- give the client's api_key to whatever calls the engines for them
```

### How billing works
Billable engine calls (a generated parcel claim, a confirmed freight match,
a generated RFP proposal, a successful lead enrichment) append a pending
entry to a ledger — nothing is charged automatically, since e.g. a parcel
refund contingency fee is only actually owed once the carrier pays out.

```bash
# see what's owed by a client
curl "https://remora-cloud.onrender.com/billing/ledger?client_id=$CLIENT_ID&invoiced=false" \
  -H "x-admin-key: $ADMIN_KEY"

# invoice all pending entries for a client via Stripe (requires STRIPE_SECRET_KEY)
curl -X POST https://remora-cloud.onrender.com/billing/invoice \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$CLIENT_ID\"}"
```

Pricing knobs (`PARCEL_CONTINGENCY_RATE`, `RFP_FLAT_FEE`, `LEAD_PRICE`) are
env vars — see `render.yaml`.
