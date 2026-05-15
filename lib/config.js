// Tab Triage AI — runtime config.
//
// To wire up billing:
//   1. Sign up at https://extensionpay.com
//   2. Create a new extension. The ID you choose becomes part of your
//      payment URL: https://extensionpay.com/extension/<EXTPAY_EXTENSION_ID>
//   3. Configure it as a one-time purchase at LIFETIME_PRICE_USD.
//   4. Replace the placeholder below with your chosen ID and reload the
//      unpacked extension in chrome://extensions
//
// You can keep the placeholder during local development — checkout
// buttons will simply 404 until a real ID is set.

export const EXTPAY_EXTENSION_ID = "tab-triage-ai";

// Set to true once you've actually registered the extension at extensionpay.com.
// When false, the UI labels the lifetime upsell as "launching soon"
// instead of opening a broken checkout link.
export const BILLING_ENABLED = true;

// One-time price shown in the upsell. The authoritative price still lives
// on the ExtensionPay dashboard — this is just for UI copy.
export const LIFETIME_PRICE_USD = 9.99;
