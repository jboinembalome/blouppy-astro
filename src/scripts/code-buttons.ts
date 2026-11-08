// gatsby-remark-code-buttons' browser half: the "Copy" button above a code
// block carries the code in `data-code` (see src/lib/markdown/vendor/code-buttons),
// and one listener for the whole page copies it, then shows the toaster.

const showToaster = (container: HTMLElement) => {
  const { toasterClass = "", toasterTextClass = "", toasterText, toasterDuration } = container.dataset;
  if (!toasterText) return;
  const toaster = document.createElement("div");
  toaster.className = toasterClass;
  const text = document.createElement("div");
  text.className = toasterTextClass;
  text.textContent = toasterText;
  toaster.appendChild(text);
  document.body.appendChild(toaster);
  setTimeout(() => toaster.remove(), Number(toasterDuration));
};

const copy = (code: string) => {
  // A selection copied with execCommand, as the plugin did: it also works where
  // the asynchronous Clipboard API is not allowed.
  const buffer = document.createElement("textarea");
  buffer.className = "gatsby-code-button-buffer";
  buffer.value = code;
  document.body.appendChild(buffer);
  buffer.select();
  document.execCommand("copy");
  (document.activeElement as HTMLElement | null)?.blur();
  setTimeout(() => {
    document.getSelection()?.removeAllRanges();
    buffer.remove();
  }, 100);
};

document.addEventListener("click", (event) => {
  const container = (event.target as Element | null)?.closest<HTMLElement>(".gatsby-code-button-container[data-code]");
  if (!container) return;
  copy(container.dataset.code ?? "");
  showToaster(container);
});

export {};
