import { billingEnabled, lifetimePriceUsd } from "./billing.js";
import { checkQuota, tabLimit } from "./storage.js";

export async function getPlanQuotaSummary(settings) {
  const plan = settings?.plan === "lifetime" ? "lifetime" : "free";
  const normalizedSettings = { ...(settings ?? {}), plan };
  const quota = await checkQuota(normalizedSettings);

  return {
    plan,
    isLifetime: plan === "lifetime",
    quota,
    tabLimit: tabLimit(normalizedSettings),
    billingEnabled: billingEnabled(),
    lifetimePrice: lifetimePriceUsd(),
  };
}

export function formatLifetimePrice(price) {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return `$${numeric.toFixed(Number.isInteger(numeric) ? 0 : 2)}`;
}
