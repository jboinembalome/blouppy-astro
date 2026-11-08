import { applyConsent, getConsent, openConsentSettings } from "../lib/consent";

// On every page: start what the reader agreed to (nothing before a choice),
// and let the footer's "Cookie settings" reopen the banner.
applyConsent(getConsent());

document.addEventListener("click", (event) => {
  if ((event.target as Element | null)?.closest("[data-consent-settings]")) openConsentSettings();
});
