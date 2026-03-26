import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";

// Check for service worker updates every 60 seconds so deploys
// propagate without the user needing to close all tabs.
registerSW({
  onRegisteredSW(_swUrl, registration) {
    if (registration) {
      setInterval(() => { registration.update(); }, 60 * 1000);
    }
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
