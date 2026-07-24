/**
 * Flat-file persistence for clients (API key holders) and the billing ledger.
 * Lives alongside the existing queue/reports dirs under DATA_DIR.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export function initStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const clientsPath = join(dataDir, "clients.json");
  const ledgerPath = join(dataDir, "ledger.jsonl");
  if (!existsSync(clientsPath)) writeFileSync(clientsPath, "{}");
  if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, "");

  function loadClients() {
    return JSON.parse(readFileSync(clientsPath, "utf8"));
  }

  function saveClients(clients) {
    writeFileSync(clientsPath, JSON.stringify(clients, null, 2));
  }

  function createClient({ name, email, stripe_customer_id }) {
    const clients = loadClients();
    const id = randomUUID();
    const api_key = `rk_${randomBytes(24).toString("hex")}`;
    const client = {
      id,
      name: name || null,
      email: email || null,
      api_key,
      stripe_customer_id: stripe_customer_id || null,
      created_at: new Date().toISOString(),
    };
    clients[id] = client;
    saveClients(clients);
    return client;
  }

  function findClientByApiKey(apiKey) {
    const clients = loadClients();
    return Object.values(clients).find((c) => c.api_key === apiKey) || null;
  }

  function getClient(id) {
    const clients = loadClients();
    return clients[id] || null;
  }

  function updateClient(id, patch) {
    const clients = loadClients();
    if (!clients[id]) return null;
    clients[id] = { ...clients[id], ...patch };
    saveClients(clients);
    return clients[id];
  }

  function listClients() {
    return Object.values(loadClients());
  }

  function appendLedgerEntry(entry) {
    const record = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      invoiced: false,
      invoice_id: null,
      ...entry,
    };
    appendFileSync(ledgerPath, JSON.stringify(record) + "\n");
    return record;
  }

  function readLedger() {
    const raw = readFileSync(ledgerPath, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line));
  }

  function rewriteLedger(entries) {
    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  }

  function markInvoiced(ids, invoiceId) {
    const entries = readLedger();
    const idSet = new Set(ids);
    for (const entry of entries) {
      if (idSet.has(entry.id)) {
        entry.invoiced = true;
        entry.invoice_id = invoiceId;
      }
    }
    rewriteLedger(entries);
    return entries.filter((e) => idSet.has(e.id));
  }

  return {
    createClient,
    findClientByApiKey,
    getClient,
    updateClient,
    listClients,
    saveClients,
    loadClients,
    appendLedgerEntry,
    readLedger,
    markInvoiced,
  };
}
