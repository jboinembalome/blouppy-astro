import { saveConsent } from "../../lib/consent";
import { useConsent, useConsentSettingsOpen, useHasDecided } from "./useConsent";

// Refusing is as easy as accepting: the two buttons sit side by side with the
// same weight, and nothing loads until one of them is pressed. Reopened from
// the footer, the banner says which choice stands.
export const ConsentBanner = () => {
  const decided = useHasDecided();
  const settingsOpen = useConsentSettingsOpen();
  const consent = useConsent();

  if (decided && !settingsOpen) return null;

  return (
    <section
      aria-labelledby="consent-title"
      className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-lg rounded-xl border border-line bg-card p-5 shadow-lg sm:inset-x-auto sm:bottom-4 sm:left-4 sm:max-w-md"
    >
      <h2 id="consent-title" className="text-base font-semibold text-heading">
        Cookies
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        With your consent, Blouppy uses Google Analytics to count visits, which sets cookies. You can change your mind
        at any time from the footer.
      </p>
      {consent && (
        <p className="mt-1.5 text-sm font-medium text-heading">
          You have {consent.analytics ? "accepted" : "refused"} audience measurement.
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button type="button" className="btn-outline btn-sm flex-1" onClick={() => saveConsent({ analytics: false })}>
          Refuse
        </button>
        <button type="button" className="btn btn-sm flex-1" onClick={() => saveConsent({ analytics: true })}>
          Accept
        </button>
      </div>
    </section>
  );
};
