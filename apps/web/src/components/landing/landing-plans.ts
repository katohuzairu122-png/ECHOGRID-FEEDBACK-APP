/** Public display only; not a checkout catalog or an entitlement source. */
export const LANDING_PLANS = [
  { key: 'free', monthlyCents: 0 },
  { key: 'starter', monthlyCents: 900 },
  { key: 'growth', monthlyCents: 2900 },
  { key: 'business', monthlyCents: 5900 },
  // The catalog's zero is a negotiated-price placeholder, never an advertised free plan.
  { key: 'enterprise', monthlyCents: null },
] as const;
