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
