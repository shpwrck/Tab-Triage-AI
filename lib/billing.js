// Thin wrapper around ExtPay. Keeps the rest of the app free of ExtPay
// internals so we can swap providers later (Stripe direct, Paddle, etc).
//
// Plan resolution: ExtPay is the source of truth. We cache the result in
// settings.plan so that quota checks don't need a network call on every
// triage, but we refresh it any time the popup or options page opens.

import ExtPay from "./extpay.module.js";
import { EXTPAY_EXTENSION_ID, BILLING_ENABLED, LIFETIME_PRICE_USD } from "./config.js";
import { saveSettings } from "./storage.js";

let _extpay = null;

export function getExtPay() {
  if (!_extpay) _extpay = ExtPay(EXTPAY_EXTENSION_ID);
  return _extpay;
}

export function billingEnabled() {
  return BILLING_ENABLED;
}

export function lifetimePriceUsd() {
  return LIFETIME_PRICE_USD;
}

// Reads paid status from ExtPay and writes it through to local settings.
// Returns "lifetime" | "free". Falls back to "free" on any error so a
// flaky network never locks paying users out — quota checks still apply,
// but they're forgiving (5/week).
export async function refreshPlan() {
  if (!BILLING_ENABLED) {
    await saveSettings({ plan: "free" });
    return "free";
  }
  try {
    const user = await getExtPay().getUser();
    const plan = user?.paid ? "lifetime" : "free";
    await saveSettings({ plan });
    return plan;
  } catch (e) {
    console.warn("ExtPay getUser failed; defaulting to free", e);
    return "free";
  }
}

export async function openCheckout() {
  if (!BILLING_ENABLED) {
    alert("Lifetime checkout is launching soon — drop your email on the Settings page to be first in line.");
    return;
  }
  await getExtPay().openPaymentPage();
}

export async function openLogin() {
  if (!BILLING_ENABLED) return;
  await getExtPay().openLoginPage();
}
