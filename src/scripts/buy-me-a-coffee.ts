// Added once the page has loaded, as gatsby-browser did after the first render:
// loading it from the <head> held the page back.
const addBuyMeACoffee = () => {
  const script = document.createElement("script");
  script.src = "https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js";
  script.async = true;
  script.setAttribute("data-name", "BMC-Widget");
  script.setAttribute("data-cfasync", "false");
  script.setAttribute("data-id", "blouppy");
  script.setAttribute("data-description", "Support me on Buy me a coffee!");
  script.setAttribute("data-message", "");
  script.setAttribute("data-color", "#ffcfb3");
  script.setAttribute("data-position", "Right");
  script.setAttribute("data-x_margin", "18");
  script.setAttribute("data-y_margin", "18");
  // The widget builds itself on DOMContentLoaded, long past by now.
  script.onload = () => window.dispatchEvent(new Event("DOMContentLoaded", { bubbles: false, cancelable: false }));
  document.body.appendChild(script);
};

if (document.readyState === "complete") addBuyMeACoffee();
else window.addEventListener("load", addBuyMeACoffee, { once: true });
