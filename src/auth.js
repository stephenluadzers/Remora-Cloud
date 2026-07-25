/**
 * API-key auth for the billable engine routes, and a separate admin key
 * for client/billing management. Without ADMIN_KEY set, admin routes are
 * disabled entirely (fail closed, not open).
 *
 * ADMIN_KEY also works as an api key (via x-api-key) and is treated as an
 * "operator" client — so the person running this doesn't need to create a
 * client for themselves just to call their own engines.
 */
export function requireApiKey(store) {
  return (req, res, next) => {
    const key = req.get("x-api-key");
    if (!key) return res.status(401).json({ error: "x-api-key header required" });

    if (process.env.ADMIN_KEY && key === process.env.ADMIN_KEY) {
      req.client = { id: "operator", name: "Operator (admin key)" };
      return next();
    }

    const client = store.findClientByApiKey(key);
    if (!client) return res.status(401).json({ error: "invalid api key" });
    req.client = client;
    next();
  };
}

export function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: "admin routes disabled: ADMIN_KEY not configured" });
  }
  const provided = req.get("x-admin-key");
  if (provided !== adminKey) {
    return res.status(401).json({ error: "invalid admin key" });
  }
  next();
}
