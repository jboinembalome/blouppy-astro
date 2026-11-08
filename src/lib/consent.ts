import { site } from "./site";

// The reader's choice about the two services that set cookies: audience
// measurement (Google Analytics) and comments (Disqus). Neither loads before a
// choice is made, as French law requires for trackers that are not strictly
// necessary (CNIL guidelines). The choice is kept in localStorage, which needs
// no consent, and asked again after six months, as the CNIL recommends.
export interface Consent {
  analytics: boolean;
  comments: boolean;
  at: number;
}

const storageKey = "blouppy-consent";
const maxAge = 1000 * 60 * 60 * 24 * 182;

type Listener = () => void;
const listeners = new Set<Listener>();
let current: Consent | null | undefined;
let settingsOpen = false;

const read = (): Consent | null => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Consent | null;
    return value && Date.now() - value.at < maxAge ? value : null;
  } catch {
    return null;
  }
};

const emit = () => listeners.forEach((listener) => listener());

export const getConsent = (): Consent | null => {
  if (typeof window === "undefined") return null;
  if (current === undefined) current = read();
  return current;
};

export const isSettingsOpen = () => settingsOpen;

export const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const saveConsent = (choice: Pick<Consent, "analytics" | "comments">) => {
  current = { ...choice, at: Date.now() };
  try {
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch {
    // A browser that refuses storage asks again on the next page.
  }
  settingsOpen = false;
  applyConsent(current);
  emit();
};

export const openConsentSettings = () => {
  settingsOpen = true;
  emit();
};

// --- Google Analytics, loaded only after consent -----------------------------

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
    [key: `ga-disable-${string}`]: boolean;
  }
}

// The production site only, as before: local builds and previews count nothing.
const analyticsEnabled = import.meta.env.PROD;
let analyticsLoaded = false;

// One page view per page, the current one included when consent is given on it.
const loadAnalytics = () => {
  window[`ga-disable-${site.analyticsId}`] = false;
  if (analyticsLoaded) return;
  analyticsLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // gtag.js reads the arguments object itself, not an array.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", site.analyticsId);
  // Created by the site's own module: the Content Security Policy needs no
  // inline script for it.
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${site.analyticsId}`;
  document.head.appendChild(script);
};

// A withdrawn consent stops the measurement and deletes the cookies already
// set; the script itself stays until the next page.
const stopAnalytics = () => {
  window[`ga-disable-${site.analyticsId}`] = true;
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
  if (consent?.analytics) {
    if (analyticsEnabled) loadAnalytics();
  } else if (analyticsLoaded || document.cookie.includes("_ga")) {
    stopAnalytics();
  }
};
