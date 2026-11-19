import "./ws-bootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminPortal } from "./AdminPortal";
import { App } from "./App";
import { createRoomController } from "./room-controller";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root.");

const isAdmin =
  location.pathname === "/admin" || location.pathname === "/admin/";

if (isAdmin) {
  document.title = "Recording admin · Voice room";
  createRoot(container).render(
    <StrictMode>
      <AdminPortal />
    </StrictMode>,
  );
} else {
  const controller = createRoomController();
  document.title = `${controller.roomId} · Realtime`;
  createRoot(container).render(
    <StrictMode>
      <App controller={controller} />
    </StrictMode>,
  );
  // Resume belongs to page startup, not a component's mount/unmount cycle.
  controller.resume();
}
