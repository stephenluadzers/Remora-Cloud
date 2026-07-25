/**
 * Stripe billing helpers. All functions no-op with a clear error when
 * STRIPE_SECRET_KEY isn't configured, so the engines stay usable without
 * Stripe while billing can be turned on later just by setting the env var.
 */
import Stripe from "stripe";

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

export function isStripeConfigured() {
  return !!stripe;
}

export async function ensureStripeCustomer(store, client) {
  if (!stripe) throw new Error("Stripe not configured (set STRIPE_SECRET_KEY)");
  if (client.stripe_customer_id) return client.stripe_customer_id;
  if (!client.email) throw new Error("client has no email on file, cannot create a Stripe customer");
  const customer = await stripe.customers.create({ name: client.name || undefined, email: client.email });
  store.updateClient(client.id, { stripe_customer_id: customer.id });
  return customer.id;
}

// Creates one Stripe invoice covering the given ledger entries for a client.
export async function invoiceLedgerEntries(store, client, entries) {
  if (!stripe) throw new Error("Stripe not configured (set STRIPE_SECRET_KEY)");
  if (!entries.length) throw new Error("no ledger entries to invoice");

  const customerId = await ensureStripeCustomer(store, client);

  for (const entry of entries) {
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: Math.round(entry.amount * 100),
      currency: "usd",
      description: `${entry.engine}: ${entry.description}`,
    });
  }

  const invoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: true,
    collection_method: "send_invoice",
    days_until_due: 14,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  store.markInvoiced(entries.map((e) => e.id), finalized.id);
  return finalized;
}
