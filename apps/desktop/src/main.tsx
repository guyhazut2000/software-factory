import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { StoreProvider } from "./lib/store";

const saved = localStorage.getItem("sf-theme");
document.documentElement.classList.toggle("dark", saved ? saved === "dark" : true);

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
