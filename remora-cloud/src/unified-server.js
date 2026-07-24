/**
 * Remora Cloud — Unified 24/7 Server
 * 
 * Combines all three business engines into one Express app:
 * - /parcel/* — Parcel Invoice Auditing
 * - /freight/* — Freight Brokerage Matchmaker  
 * - /rfp/* — RFP Responder
 * - /leads/* — Lead scraping & enrichment
 * 
 * Deploy to Render: $7/month, runs 24/7, no local computer needed.
 */

import express from "express";
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const app = express();
app.use(express.json({ limit: "10mb" }));

const DATA_DIR = process.env.DATA_DIR || "/data";
const QUEUE_DIR = join(DATA_DIR, "queue");
const REPORTS_DIR = join(DATA_DIR, "reports");
[QUEUE_DIR, REPORTS_DIR].forEach((d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", (req, res) => res.json({
  status: "ok",
  service: "remora-cloud",
  engines: ["parcel", "freight", "rfp"],
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
}));

// ============================================
// PARCEL AUDIT ENGINE
// ============================================

// SLA guarantees by carrier
const CARRIER_SLAS = {
  fedex: {
    "PRIORITY_OVERNIGHT": { cutoff_hour: 10.5, guaranteed: true },
    "STANDARD_OVERNIGHT": { cutoff_hour: 15, guaranteed: true },
    "2DAY_AM": { cutoff_hour: 10.5, guaranteed: true },
    "2DAY": { cutoff_hour: 20, guaranteed: true },
    "EXPRESS_SAVER": { cutoff_hour: 20, guaranteed: true },
    "GROUND": { guaranteed: false },
    "HOME_DELIVERY": { guaranteed: false },
    "SMARTPOST": { guaranteed: false },
  },
  ups: {
    "NEXT_DAY_AIR_EARLY": { cutoff_hour: 8, guaranteed: true },
    "NEXT_DAY_AIR": { cutoff_hour: 10.5, guaranteed: true },
    "NEXT_DAY_AIR_SAVER": { cutoff_hour: 15, guaranteed: true },
    "2ND_DAY_AIR_AM": { cutoff_hour: 10.5, guaranteed: true },
    "2ND_DAY_AIR": { cutoff_hour: 23.59, guaranteed: true },
    "3_DAY_SELECT": { cutoff_hour: 23.59, guaranteed: true },
    "GROUND": { guaranteed: false },
    "SUREPOST": { guaranteed: false },
  }
};

// Audit a single invoice record
function auditInvoice(record, carrier) {
  const findings = [];
  const sla = CARRIER_SLAS[carrier]?.[record.service_type?.toUpperCase()];
  
  // Late delivery check
  if (sla?.guaranteed && record.delivery_date && record.scheduled_delivery) {
    const delivered = new Date(record.delivery_date);
    const promised = new Date(record.scheduled_delivery);
    if (delivered > promised) {
      const hoursLate = (delivered - promised) / 3600000;
      findings.push({
        type: "LATE_DELIVERY",
        severity: hoursLate > 24 ? "HIGH" : "MEDIUM",
        description: `Delivered ${hoursLate.toFixed(1)} hours after guaranteed time`,
        refund_estimate: parseFloat(record.charge_amount || 0),
        evidence: { promised, delivered, service_type: record.service_type },
      });
    }
  }

  // Dimensional weight check
  if (record.length && record.width && record.height && record.billed_weight) {
    const dimWeight = (record.length * record.width * record.height) / 139;
    if (dimWeight > parseFloat(record.billed_weight) * 1.1) {
      findings.push({
        type: "DIM_WEIGHT_ERROR",
        severity: "MEDIUM",
        description: `Billed weight ${record.billed_weight} exceeds dim weight ${dimWeight.toFixed(1)}`,
        refund_estimate: parseFloat(record.charge_amount || 0) * 0.15,
      });
    }
  }

  // Duplicate charge check
  if (record.tracking_number && record.charge_amount) {
    // Would check against other records in batch
  }

  return {
    tracking_number: record.tracking_number,
    carrier,
    findings,
    total_refund_estimate: findings.reduce((sum, f) => sum + (f.refund_estimate || 0), 0),
  };
}

// Parcel routes
app.post("/parcel/audit", (req, res) => {
  const { invoices, carrier } = req.body;
  if (!invoices?.length) return res.status(400).json({ error: "invoices array required" });
  
  const results = invoices.map(inv => auditInvoice(inv, carrier || inv._carrier || "fedex"));
  const totalRefund = results.reduce((sum, r) => sum + r.total_refund_estimate, 0);
  
  res.json({
    audited: results.length,
    findings_count: results.reduce((s, r) => s + r.findings.length, 0),
    total_refund_estimate: totalRefund.toFixed(2),
    results,
  });
});

app.post("/parcel/claims/generate", (req, res) => {
  const { tracking_number, carrier, finding, claimant_info } = req.body;
  
  const claimLetter = generateClaimLetter(tracking_number, carrier, finding, claimant_info);
  const claimPath = join(REPORTS_DIR, `claim_${tracking_number}_${Date.now()}.txt`);
  writeFileSync(claimPath, claimLetter);
  
  res.json({ generated: true, letter: claimLetter, path: claimPath });
});

function generateClaimLetter(tracking, carrier, finding, info) {
  return `REMORA DEVELOPMENT LLC
Parcel Audit Claim Letter

Date: ${new Date().toLocaleDateString()}
Carrier: ${carrier.toUpperCase()}
Tracking: ${tracking}

Claim Type: ${finding.type}
Severity: ${finding.severity}
Description: ${finding.description}

Claimant:
${info?.name || "N/A"}
${info?.company || "N/A"}
${info?.address || "N/A"}

Refund Amount Requested: $${(finding.refund_estimate || 0).toFixed(2)}

Evidence:
${JSON.stringify(finding.evidence || {}, null, 2)}

This claim is filed pursuant to ${carrier.toUpperCase()}'s money-back guarantee for guaranteed service types. The shipment referenced above was delivered outside the guaranteed delivery commitment.

Please process this refund within 30 days.

Sincerely,
Remora Development LLC
stephen@remora-development.com`;
}

app.get("/parcel/reports", (req, res) => {
  const files = readdirSync(REPORTS_DIR).filter(f => f.startsWith("claim_"));
  res.json({ reports: files.length, files });
});

// ============================================
// FREIGHT BROKERAGE ENGINE
// ============================================

// State-pair distance estimation (miles)
const STATE_DISTANCES = {
  "AL-FL": 350, "AL-GA": 200, "AL-TN": 250, "AL-MS": 200,
  "AZ-CA": 400, "AZ-NV": 300, "AZ-NM": 350, "AZ-TX": 500,
  "AR-LA": 300, "AR-MO": 250, "AR-OK": 250, "AR-TN": 350, "AR-TX": 350,
  "CA-OR": 600, "CA-NV": 400, "CA-AZ": 400,
  "CO-KS": 350, "CO-NE": 300, "CO-UT": 400, "CO-WY": 200,
  "FL-GA": 300, "FL-AL": 350,
  "GA-SC": 200, "GA-TN": 250, "GA-FL": 300, "GA-AL": 200,
  "IL-IN": 150, "IL-MO": 300, "IL-WI": 200, "IL-IA": 250, "IL-MI": 250,
  "IN-OH": 150, "IN-MI": 200, "IN-KY": 150,
  "KS-MO": 200, "KS-OK": 250, "KS-CO": 350,
  "KY-TN": 200, "KY-OH": 200, "KY-IN": 150,
  "LA-TX": 300, "LA-MS": 200, "LA-AR": 300,
  "MA-NY": 200, "MA-CT": 100, "MA-RI": 50,
  "MD-VA": 150, "MD-DC": 40, "MD-PA": 150, "MD-DE": 50,
  "MI-OH": 200, "MI-IN": 200,
  "MN-WI": 250, "MN-IA": 250, "MN-ND": 250, "MN-SD": 250,
  "MO-IA": 200, "MO-KS": 200, "MO-IL": 200, "MO-AR": 250, "MO-OK": 250,
  "NC-SC": 150, "NC-VA": 200, "NC-GA": 300, "NC-TN": 250,
  "NJ-NY": 100, "NJ-PA": 100, "NJ-DE": 50,
  "NY-PA": 200, "NY-CT": 100, "NY-NJ": 100, "NY-MA": 150,
  "OH-PA": 200, "OH-WV": 150, "OH-IN": 150, "OH-MI": 200, "OH-KY": 150,
  "OK-TX": 250, "OK-KS": 250, "OK-MO": 250, "OK-AR": 250,
  "OR-WA": 200, "OR-CA": 350, "OR-ID": 400, "OR-NV": 500,
  "PA-NY": 200, "PA-NJ": 100, "PA-OH": 250, "PA-WV": 150, "PA-MD": 150,
  "SC-NC": 150, "SC-GA": 200,
  "TN-KY": 200, "TN-NC": 250, "TN-GA": 250, "TN-AL": 250, "TN-AR": 300, "TN-MS": 250, "TN-VA": 300,
  "TX-LA": 300, "TX-OK": 300, "TX-NM": 350, "TX-AR": 350,
  "VA-NC": 200, "VA-MD": 150, "VA-DC": 100, "VA-WV": 200,
  "WA-OR": 200, "WA-ID": 300, "WA-CA": 600,
  "WI-MN": 250, "WI-IL": 200, "WI-IA": 250, "WI-MI": 300,
};

const MARKET_RATES = {
  flatbed: 2.75, reefer: 3.10, dry_van: 2.50, step_deck: 3.25,
  power_only: 2.00, container: 2.40, tanker: 3.50, other: 2.50,
};

function getDistance(originState, destState) {
  if (originState === destState) return 150;
  return STATE_DISTANCES[`${originState}-${destState}`] || STATE_DISTANCES[`${destState}-${originState}`] || 1000;
}

// FMCSA carrier screening
async function screenCarrierFMCSA(usdotOrMC) {
  const identifier = usdotOrMC.replace(/\s/g, "");
  try {
    const url = `https://safer.fmcsa.dot.gov/query/query.aspx?search=DOT:${identifier}&searchType=ANY`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`FMCSA returned ${response.status}`);
    const html = await response.text();
    
    function extract(label) {
      const regex = new RegExp(`<td[^>]*>${label}\\s*</td>\\s*<td[^>]*>(.*?)</td>`, "is");
      const match = html.match(regex);
      return match ? match[1].replace(/<[^>]*>/g, "").trim() : null;
    }
    
    const carrier = {
      identifier,
      legal_name: extract("Entity Legal Name"),
      usdot: extract("USDOT Number"),
      mc_number: extract("MC/MX/FF Number"),
      safety_rating: extract("Safety Rating"),
      authority_status: extract("Operating Authority Status"),
      insurance_status: extract("Insurance Status"),
      power_units: extract("Power Units"),
      drivers: extract("Drivers"),
      verified: !!extract("USDOT Number"),
      warnings: [],
      blocks: [],
      screened_at: new Date().toISOString(),
    };
    
    if (carrier.safety_rating?.toLowerCase().includes("unsatisfactory")) {
      carrier.blocks.push("SAFETY_UNSATISFACTORY");
    }
    if (carrier.authority_status?.toLowerCase().match(/not authorized|revoked|inactive/)) {
      carrier.blocks.push("AUTHORITY_NOT_ACTIVE");
    }
    if (carrier.insurance_status?.toLowerCase().match(/none|not on file|expired/)) {
      carrier.blocks.push("NO_INSURANCE");
    }
    
    carrier.is_blocked = carrier.blocks.length > 0;
    carrier.is_clear = !carrier.is_blocked;
    return carrier;
  } catch (err) {
    return { identifier, verified: false, error: err.message, is_blocked: true, is_clear: false };
  }
}

// Freight routes
app.post("/freight/screen-carrier", async (req, res) => {
  const { usdot, mc_number } = req.body;
  if (!usdot && !mc_number) return res.status(400).json({ error: "usdot or mc_number required" });
  const result = await screenCarrierFMCSA(usdot || mc_number);
  res.json(result);
});

app.post("/freight/match", (req, res) => {
  const { loads, carriers } = req.body;
  if (!loads?.length || !carriers?.length) return res.status(400).json({ error: "loads and carriers required" });
  
  const cleared = carriers.filter(c => c.is_clear !== false);
  const matches = [];
  
  for (const load of loads) {
    for (const carrier of cleared) {
      // Equipment compat check
      if (carrier.equipment_type && load.equipment_type) {
        const compat = {
          flatbed: ["flatbed", "step_deck"],
          reefer: ["reefer", "dry_van"],
          dry_van: ["dry_van"],
          step_deck: ["step_deck", "flatbed"],
          power_only: ["power_only", "container"],
          container: ["container", "power_only", "dry_van"],
          tanker: ["tanker"],
        };
        const allowed = compat[carrier.equipment_type] || [carrier.equipment_type];
        if (!allowed.includes(load.equipment_type)) continue;
      }
      
      const distance = getDistance(load.origin_state, load.dest_state);
      const marketRate = MARKET_RATES[load.equipment_type] || MARKET_RATES.other;
      const estimatedRate = distance * marketRate;
      const brokerMargin = 0.12;
      
      let score = 50;
      if (carrier.safety_rating?.toLowerCase().includes("satisfactory")) score += 20;
      if (parseInt(carrier.power_units || 0) > 5) score += 10;
      if (parseInt(carrier.drivers || 0) > 3) score += 10;
      if (carrier.insurance_status?.toLowerCase().includes("active")) score += 10;
      
      matches.push({
        load, carrier,
        distance_miles: distance,
        market_rate_per_mile: marketRate,
        estimated_total_rate: estimatedRate,
        carrier_pay: estimatedRate * (1 - brokerMargin),
        broker_commission: estimatedRate * brokerMargin,
        match_score: Math.min(score, 100),
      });
    }
  }
  
  matches.sort((a, b) => b.match_score - a.match_score);
  res.json({ matched: matches.length, top_matches: matches.slice(0, 10) });
});

app.post("/freight/rate-confirm", (req, res) => {
  const { match, load, carrier } = req.body;
  const conf = {
    confirmation_number: `RC-${Date.now().toString().slice(-8)}`,
    created_at: new Date().toISOString(),
    load: { shipper: load.shipper_name, commodity: load.commodity, equipment: load.equipment_type,
            origin: `${load.origin_city}, ${load.origin_state}`, destination: `${load.dest_city}, ${load.dest_state}`,
            pickup_date: load.pickup_date, delivery_date: load.delivery_date },
    carrier: { name: carrier.legal_name, usdot: carrier.usdot, mc_number: carrier.mc_number },
    rate: { total: match.estimated_total_rate?.toFixed(2), carrier_pay: match.carrier_pay?.toFixed(2),
            commission: match.broker_commission?.toFixed(2), miles: match.distance_miles,
            per_mile: match.market_rate_per_mile?.toFixed(2) },
    status: "PENDING_CARRIER_ACCEPTANCE",
  };
  writeFileSync(join(REPORTS_DIR, `${conf.confirmation_number}.json`), JSON.stringify(conf, null, 2));
  res.json(conf);
});

// ============================================
// RFP RESPONDER ENGINE
// ============================================

// Capability RAG store (keyword-based)
const CAPABILITIES = [
  { keywords: ["ai", "artificial intelligence", "machine learning", "ml", "llm", "chatbot", "agent"],
    title: "AI/ML Agent Development", desc: "Custom AI agents, chatbots, and ML pipelines" },
  { keywords: ["web", "website", "frontend", "application", "portal", "dashboard"],
    title: "Web Application Development", desc: "Full-stack web apps, dashboards, and portals" },
  { keywords: ["automation", "workflow", "integration", "api", "pipeline"],
    title: "Process Automation", desc: "Automated workflows, API integrations, and data pipelines" },
  { keywords: ["data", "analytics", "reporting", "intelligence", "insights"],
    title: "Data Analytics & Intelligence", desc: "Data pipelines, analytics dashboards, market intelligence" },
  { keywords: ["voice", "transcription", "whisper", "speech", "audio"],
    title: "Voice/Audio Processing", desc: "Speech-to-text, voice agents, audio processing" },
  { keywords: ["security", "compliance", "privacy", "hipaa"],
    title: "Security & Compliance", desc: "Secure architecture, privacy-first design, compliance frameworks" },
  { keywords: ["scraping", "lead", "data collection", "mining"],
    title: "Lead Generation & Data Collection", desc: "Automated lead discovery, web scraping, data enrichment" },
  { keywords: ["coding", "development tool", "ide", "code assistance"],
    title: "Developer Tools", desc: "AI-powered coding assistants and development environments" },
];

function matchCapabilities(rfpText) {
  const lower = rfpText.toLowerCase();
  const matches = [];
  for (const cap of CAPABILITIES) {
    const score = cap.keywords.filter(kw => lower.includes(kw)).length;
    if (score > 0) matches.push({ ...cap, score });
  }
  return matches.sort((a, b) => b.score - a.score);
}

app.post("/rfp/parse", (req, res) => {
  const { rfp_text } = req.body;
  if (!rfp_text) return res.status(400).json({ error: "rfp_text required" });
  
  // Extract key fields
  const text = rfp_text;
  const extractPattern = (patterns) => {
    for (const p of patterns) {
      const match = text.match(p);
      if (match) return match[1].trim();
    }
    return null;
  };
  
  const parsed = {
    solicitation_number: extractPattern([/Solicitation[:\s]+([A-Z0-9-]+)/i, /Solicitation\s+Number[:\s]+([A-Z0-9-]+)/i]),
    title: extractPattern([/Title[:\s]+(.+)/i, /Subject[:\s]+(.+)/i]),
    naics: extractPattern([/NAICS[:\s]+([0-9]+)/i, /NAICS Code[:\s]+([0-9]+)/i]),
    deadline: extractPattern([/Deadline[:\s]+(.+)/i, /Due Date[:\s]+(.+)/i, /Response Due[:\s]+(.+)/i]),
    set_aside: extractPattern([/Set[ -]Aside[:\s]+(.+)/i, /Type[:\s]+(.+)/i]),
    agency: extractPattern([/Agency[:\s]+(.+)/i, /Department[:\s]+(.+)/i]),
    capabilities_matched: matchCapabilities(text),
    parsed_at: new Date().toISOString(),
  };
  
  res.json(parsed);
});

app.post("/rfp/generate", (req, res) => {
  const { rfp_data, capabilities, company_info } = req.body;
  
  const proposal = {
    company: company_info || {
      name: "Remora Development LLC",
      uei: "CU97CJ3VGJU6",
      email: "stephen@remora-development.com",
    },
    sections: {
      executive_summary: `Remora Development LLC is pleased to submit this proposal in response to ${rfp_data?.solicitation_number || "the referenced solicitation"}. We specialize in ${rfp_data?.capabilities_matched?.map(c => c.title).join(", ") || "AI-driven software solutions"} and have demonstrated capability in delivering secure, scalable solutions for government and enterprise clients.`,
      technical_approach: `Our approach leverages our core capabilities in ${rfp_data?.capabilities_matched?.map(c => c.desc).join("; ") || "AI/ML, automation, and web development"} to meet the requirements outlined in this solicitation. We will deliver using an agile methodology with weekly milestones and continuous integration.`,
      past_performance: "Remora Development LLC has developed and deployed multiple AI-driven products including: Shadow Insight (market intelligence platform), Shadow Flow Pro (offline voice-to-text), and automated lead generation pipelines processing 1,800+ prospects. Our SAM.gov UEI is CU97CJ3VGJU6.",
      management_approach: "Our project management follows a flat, efficient structure with direct owner involvement. We use automated CI/CD pipelines, comprehensive testing, and continuous monitoring to ensure delivery quality and timeline adherence.",
      price_volume: "Pricing provided separately upon request. We offer competitive rates aligned with GSA schedule pricing for comparable services.",
    },
    generated_at: new Date().toISOString(),
  };
  
  const proposalPath = join(REPORTS_DIR, `proposal_${rfp_data?.solicitation_number || "draft"}_${Date.now()}.json`);
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
  
  res.json(proposal);
});

app.get("/rfp/capabilities", (req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

// ============================================
// LEAD ENRICHMENT (calls Base44)
// ============================================

app.post("/leads/enrich", async (req, res) => {
  const { company_name, city } = req.body;
  if (!company_name) return res.status(400).json({ error: "company_name required" });
  
  // Try to find the company website via search
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(company_name + " " + (city || ""))}`;
    const response = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await response.text();
    
    // Extract emails from results
    const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const validEmails = emailMatches.filter(e => 
      !e.includes("google.") && !e.includes("facebook.") && !e.includes("sentry.") &&
      !e.match(/\.(png|jpg|css|js|woff)/) && !e.match(/^[0-9a-f]{8,}@/)
    );
    
    res.json({ company_name, city, emails_found: [...new Set(validEmails)].slice(0, 3) });
  } catch (err) {
    res.json({ company_name, city, emails_found: [], error: err.message });
  }
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Remora Cloud running on :${PORT}`);
  console.log(`Engines: /parcel, /freight, /rfp, /leads`);
  console.log(`Data dir: ${DATA_DIR}`);
});
