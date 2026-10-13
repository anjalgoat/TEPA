import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { LandingPage } from "./LandingPage";
import { StaticDemoNotice } from "./StaticDemoNotice";
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

// A production build without an API (for example a static Vercel deployment) cannot run the demo.
const apiConfigured = import.meta.env.DEV || typeof import.meta.env.VITE_API_URL === "string";

createRoot(root).render(
    <StrictMode>{isDemo ? apiConfigured ? <App /> : <StaticDemoNotice /> : <LandingPage />}</StrictMode>,
);
