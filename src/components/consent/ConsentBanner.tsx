import { useEffect, useId, useState } from "react";
import { getConsent, saveConsent } from "../../lib/consent";
import { useConsentSettingsOpen, useHasDecided } from "./useConsent";

interface ToggleProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const Toggle = ({ label, description, checked, onChange }: ToggleProps) => {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-sm font-semibold text-heading">{label}</span>
        <span className="block text-sm text-muted">{description}</span>
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
          checked ? "border-transparent bg-fill" : "border-line bg-soft"
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 h-[1.125rem] w-[1.125rem] rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[1.375rem]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
};

// Refusing is as easy as accepting: the two buttons sit side by side with the
// same weight, and nothing loads until one of them is pressed.
export const ConsentBanner = () => {
  const decided = useHasDecided();
  const settingsOpen = useConsentSettingsOpen();
  const [customizing, setCustomizing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [comments, setComments] = useState(false);

  // Reopened from the footer: start from the choice already made.
  useEffect(() => {
    if (!settingsOpen) return;
    const consent = getConsent();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnalytics(Boolean(consent?.analytics));
    setComments(Boolean(consent?.comments));
    setCustomizing(true);
  }, [settingsOpen]);

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
        With your consent, Blouppy uses Google Analytics to count visits and Disqus to show comments. Both set cookies.
        You can change your mind at any time from the footer.
      </p>

      {customizing && (
        <div className="mt-3 divide-y divide-line border-y border-line">
          <Toggle
            label="Audience measurement"
            description="Google Analytics: which pages are read."
            checked={analytics}
            onChange={setAnalytics}
          />
          <Toggle
            label="Comments"
            description="Disqus, under each article."
            checked={comments}
            onChange={setComments}
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {customizing ? (
          <>
            <button
              type="button"
              className="btn-outline btn-sm flex-1"
              onClick={() => saveConsent({ analytics: false, comments: false })}
            >
              Refuse all
            </button>
            <button type="button" className="btn btn-sm flex-1" onClick={() => saveConsent({ analytics, comments })}>
              Save choices
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn-outline btn-sm flex-1"
              onClick={() => saveConsent({ analytics: false, comments: false })}
            >
              Refuse
            </button>
            <button
              type="button"
              className="btn btn-sm flex-1"
              onClick={() => saveConsent({ analytics: true, comments: true })}
            >
              Accept
            </button>
            <button
              type="button"
              className="w-full py-1 text-center text-sm font-medium text-muted underline-offset-2 hover:text-accent hover:underline"
              onClick={() => setCustomizing(true)}
            >
              Choose
            </button>
          </>
        )}
      </div>
    </section>
  );
};
