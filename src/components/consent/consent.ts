import { useSyncExternalStore } from "react";

// The reader's choice about the two services that set cookies: audience
// measurement (Google Analytics) and comments (Disqus). Nothing of either is
// loaded before a choice is made. The choice itself is kept in localStorage,
// which needs no consent, and is asked again after six months, as the CNIL
// recommends.
export interface Consent {
  analytics: boolean;
  comments: boolean;
  at: number;
}

const storageKey = "blouppy-consent";
const maxAge = 1000 * 60 * 60 * 24 * 182;
export const analyticsId = "G-RDNQF6X1VT";

type Listener = () => void;
const listeners = new Set<Listener>();
let current: Consent | null | undefined;
let settingsOpen = false;

const read = (): Consent | null => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Consent | null;
    return value && Date.now() - value.at < maxAge ? value : null;
  } catch (_) {
    return null;
  }
};

const emit = () => listeners.forEach((listener) => listener());

export const getConsent = (): Consent | null => {
  if (typeof window === "undefined") return null;
  if (current === undefined) current = read();
  return current;
};

export const saveConsent = (choice: Pick<Consent, "analytics" | "comments">) => {
  const measuredBefore = Boolean(current?.analytics);
  current = { ...choice, at: Date.now() };
  try {
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch (_) {
    // A browser that refuses storage asks again on the next visit.
  }
  settingsOpen = false;
  applyConsent(current);
  // The page the reader accepted on is counted too, not only the next ones.
  if (current.analytics && !measuredBefore) trackPageView(window.location.pathname);
  emit();
};

export const openConsentSettings = () => {
  settingsOpen = true;
  emit();
};

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Server render and hydration see "not decided yet" and nothing open, so the
// banner and the comments appear only once the page runs in the browser.
export const useConsent = () =>
  useSyncExternalStore(subscribe, getConsent, () => null);

export const useConsentSettingsOpen = () =>
  useSyncExternalStore(subscribe, () => settingsOpen, () => false);

export const useHasDecided = () =>
  useSyncExternalStore(subscribe, () => getConsent() !== null, () => true);

// --- Google Analytics, loaded only after consent -----------------------------

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
    [key: `ga-disable-${string}`]: boolean;
  }
}

let analyticsLoaded = false;

const loadAnalytics = () => {
  window[`ga-disable-${analyticsId}`] = false;
  if (analyticsLoaded) return;
  analyticsLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // gtag.js reads the arguments object itself, not an array.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  // Page views are sent on every route change, from gatsby-browser.
  window.gtag("config", analyticsId, { send_page_view: false });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${analyticsId}`;
  document.head.appendChild(script);
};

// A withdrawn consent stops the measurement and removes the cookies already
// set; the script itself stays until the next page load.
const stopAnalytics = () => {
  window[`ga-disable-${analyticsId}`] = true;
  const domain = window.location.hostname.split(".").slice(-2).join(".");
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0].trim();
    if (name === "_ga" || name.startsWith("_ga_") || name === "_gid") {
      for (const scope of ["", `; domain=${domain}`, `; domain=.${domain}`]) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${scope}`;
      }
    }
  });
};

export const applyConsent = (consent: Consent | null) => {
  if (consent?.analytics) loadAnalytics();
  else if (analyticsLoaded || document.cookie.includes("_ga")) stopAnalytics();
};

export const trackPageView = (path: string) => {
  if (!getConsent()?.analytics || !window.gtag) return;
  window.gtag("event", "page_view", { page_path: path, page_location: window.location.href, page_title: document.title });
};
