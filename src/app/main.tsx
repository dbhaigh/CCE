import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing application root");
}
createRoot(root).render(<ErrorBoundary><App /></ErrorBoundary>);
