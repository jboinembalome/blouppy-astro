import { site } from "../lib/site";

// Google Analytics (gtag.js), as gatsby-plugin-google-gtag set it up: one page
// view per page. Loaded from the site's own module, so the Content Security
// Policy needs no inline script for it.
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

window.dataLayer = window.dataLayer || [];
window.gtag = function gtag() {
  // gtag.js reads the arguments object itself, not an array.
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer.push(arguments);
};
window.gtag("js", new Date());
window.gtag("config", site.analyticsId);

const script = document.createElement("script");
script.async = true;
script.src = `https://www.googletagmanager.com/gtag/js?id=${site.analyticsId}`;
document.head.appendChild(script);
