import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { LandingPage } from "./LandingPage";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
    throw new Error("Missing root element");
}

const isDemo = window.location.pathname === "/demo" || window.location.pathname.startsWith("/demo/");
document.title =
    window.location.pathname === "/demo/evidence"
        ? "TEPA · Distribution evidence"
        : isDemo
          ? "TEPA · Guided demo"
          : "TEPA · Defined economic participation";

createRoot(root).render(<StrictMode>{isDemo ? <App /> : <LandingPage />}</StrictMode>);
