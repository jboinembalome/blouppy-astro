
// gatsby-remark-code-buttons' browser half: the "Copy" button of a code block
// calls window.copyToClipboard from its onclick attribute.
declare global {
  interface Window {
    copyToClipboard: (str: string, toasterId?: string) => void;
    showClipboardToaster: (toasterId: string) => void;
  }
}

window.copyToClipboard = (str, toasterId) => {
  const el = document.createElement("textarea");
  el.className = "gatsby-code-button-buffer";
  el.innerHTML = str;
  document.body.appendChild(el);
  const range = document.createRange();
  range.selectNode(el);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.execCommand("copy");
  (document.activeElement as HTMLElement | null)?.blur();
  setTimeout(() => {
    document.getSelection()?.removeAllRanges();
    document.body.removeChild(el);
  }, 100);

  if (toasterId) window.showClipboardToaster(toasterId);
};

window.showClipboardToaster = (toasterId) => {
  const textElem = document.querySelector<HTMLElement>(`[data-toaster-id="${toasterId}"]`);
  if (!textElem) return;

  const el = document.createElement("div");
  el.className = textElem.dataset.toasterClass ?? "";
  el.innerHTML = `
      <div class="${textElem.dataset.toasterTextClass}">
        ${textElem.dataset.toasterText}
      </div>
    `.trim();
  document.body.appendChild(el);
  setTimeout(() => document.body.removeChild(el), Number(textElem.dataset.toasterDuration));
};
export {};
