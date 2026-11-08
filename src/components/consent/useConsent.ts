import { useSyncExternalStore } from "react";
import { getConsent, isSettingsOpen, subscribe } from "../../lib/consent";

// The server render and hydration see "not decided yet" and nothing open, so
// the banner and the comments appear only once the page runs in the browser.
export const useConsent = () => useSyncExternalStore(subscribe, getConsent, () => null);

export const useConsentSettingsOpen = () => useSyncExternalStore(subscribe, isSettingsOpen, () => false);

export const useHasDecided = () =>
  useSyncExternalStore(
    subscribe,
    () => getConsent() !== null,
    () => true,
  );
