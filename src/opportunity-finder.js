/**
 * Autonomous "go find money" loop for the RFP engine.
 *
 * The RFP engine only ever ran when something POSTed data to it — nothing
 * looked for opportunities on its own. This polls SAM.gov's public
 * Get Opportunities API (free, self-service key at sam.gov/data-services)
 * on an interval, matches results against Remora's capabilities, and
 * auto-drafts a proposal for anything that matches — so there's a stack of
 * drafts waiting instead of an empty inbox.
 *
 * Deliberately NOT wired into the client billing ledger: this is Remora
 * sourcing its own leads, not doing billable work for a client.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const fmtDate = (d) => `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}/${d.getFullYear()}`;

export function startOpportunityFinder({ dataDir, reportsDir, matchCapabilities, draftProposal }) {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    console.log(
      "[opportunity-finder] OFF — no SAM_GOV_API_KEY set. Get a free key at " +
      "https://sam.gov/data-services (Get Started -> Request Public API Key), " +
      "then set SAM_GOV_API_KEY on Render to turn this on."
    );
    return { pollOnce: async () => ({ skipped: true, reason: "SAM_GOV_API_KEY not set" }) };
  }

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const seenPath = join(dataDir, "rfp_seen.json");
  if (!existsSync(seenPath)) writeFileSync(seenPath, "[]");
  const opportunitiesPath = join(dataDir, "rfp_opportunities.jsonl");
  if (!existsSync(opportunitiesPath)) writeFileSync(opportunitiesPath, "");

  const keywords = (process.env.SAM_GOV_KEYWORDS || "artificial intelligence,automation,software development,data analytics")
    .split(",").map((k) => k.trim()).filter(Boolean);
  const lookbackDays = parseInt(process.env.SAM_GOV_LOOKBACK_DAYS || "7", 10);

  async function pollOnce() {
    const seen = new Set(JSON.parse(readFileSync(seenPath, "utf8")));
    const today = new Date();
    const from = new Date(today.getTime() - lookbackDays * 24 * 3600 * 1000);
    let found = 0;
    let drafted = 0;

    for (const keyword of keywords) {
      try {
        const url = `https://api.sam.gov/opportunities/v2/search?api_key=${apiKey}&limit=25` +
          `&postedFrom=${fmtDate(from)}&postedTo=${fmtDate(today)}&keyword=${encodeURIComponent(keyword)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) {
          console.error(`[opportunity-finder] SAM.gov returned ${response.status} for "${keyword}"`);
          continue;
        }
        const data = await response.json();
        const opportunities = data.opportunitiesData || [];

        for (const opp of opportunities) {
          if (!opp.noticeId || seen.has(opp.noticeId)) continue;
          seen.add(opp.noticeId);
          found++;

          const rfpText = [opp.title, opp.solicitationNumber, opp.fullParentPathName, opp.description]
            .filter(Boolean).join("\n");
          const rfp_data = {
            solicitation_number: opp.solicitationNumber || opp.noticeId,
            title: opp.title,
            naics: opp.naicsCode,
            deadline: opp.responseDeadLine,
            set_aside: opp.typeOfSetAsideDescription,
            agency: opp.fullParentPathName,
            capabilities_matched: matchCapabilities(rfpText),
            source_url: opp.uiLink,
            parsed_at: new Date().toISOString(),
          };

          const record = { found_at: new Date().toISOString(), keyword, opportunity: rfp_data, draft: null };

          if (rfp_data.capabilities_matched.length > 0) {
            record.draft = draftProposal(rfp_data);
            drafted++;
            writeFileSync(
              join(reportsDir, `opportunity_${rfp_data.solicitation_number}_${Date.now()}.json`),
              JSON.stringify(record, null, 2)
            );
          }

          appendFileSync(opportunitiesPath, JSON.stringify(record) + "\n");
        }
      } catch (err) {
        console.error(`[opportunity-finder] error polling "${keyword}": ${err.message}`);
      }
    }

    writeFileSync(seenPath, JSON.stringify([...seen]));
    console.log(`[opportunity-finder] poll complete: ${found} new opportunities, ${drafted} auto-drafted`);
    return { found, drafted };
  }

  const intervalHours = parseFloat(process.env.SAM_POLL_INTERVAL_HOURS || "6");
  console.log(`[opportunity-finder] ON — polling every ${intervalHours}h for: ${keywords.join(", ")}`);
  pollOnce();
  setInterval(pollOnce, intervalHours * 3600 * 1000);

  return { pollOnce };
}

export function readOpportunities(dataDir, { onlyDrafted } = {}) {
  const opportunitiesPath = join(dataDir, "rfp_opportunities.jsonl");
  if (!existsSync(opportunitiesPath)) return [];
  const raw = readFileSync(opportunitiesPath, "utf8").trim();
  if (!raw) return [];
  const records = raw.split("\n").map((line) => JSON.parse(line));
  return onlyDrafted ? records.filter((r) => r.draft) : records;
}
