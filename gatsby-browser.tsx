import React from 'react';
import type { GatsbyBrowser } from "gatsby"
import '@fontsource-variable/inter';
import './src/styles/site.scss';
import { Layout } from './src/components/layout';
import { pageKindOf } from './src/components/layout/Layout';

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
  script.onload = function () {
    const evt = new Event("DOMContentLoaded", { "bubbles": false, "cancelable": false });
    window.dispatchEvent(evt);
  };

  document.body.appendChild(script);
}

require("prismjs/plugins/line-numbers/prism-line-numbers.css")
require("prismjs/plugins/command-line/prism-command-line.css")
require("prismjs/themes/prism-tomorrow.css")

export const wrapPageElement: GatsbyBrowser["wrapPageElement"] = ({ element, props }) => {
    return <Layout kind={pageKindOf(props.location.pathname)}>{element}</Layout>;
}

export const onInitialClientRender: GatsbyBrowser["onInitialClientRender"] = () => {
  // Add "buy me a coffee" when the initial rendering of the Gatsby application is done 
  // on the client because in the gatsby-ssr onRenderBody, the loading is too long. 
  // (white screen for 0.5 or 1s during rendering)
  addBuyMeACoffee();
}