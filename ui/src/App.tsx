import { Routes, Route, Navigate } from "react-router";
import AuthLayout from "@/layouts/AuthLayout";
import DashboardLayout from "@/layouts/DashboardLayout";
import Login from "@/pages/login";
import Setup from "@/pages/setup";
import Dashboard from "@/pages/dashboard/index";
import Connect from "@/pages/dashboard/connect";
import Keys from "@/pages/dashboard/keys";
import Audit from "@/pages/dashboard/audit";
import McpSetup from "@/pages/dashboard/mcp-setup";
import McpKeySetup from "@/pages/dashboard/mcp-key-setup";
import Schema from "@/pages/dashboard/schema";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      <Route element={<AuthLayout />}>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
      </Route>

      <Route element={<DashboardLayout />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/dashboard/connect" element={<Connect />} />
        <Route path="/dashboard/keys" element={<Keys />} />
        <Route path="/dashboard/audit" element={<Audit />} />
        <Route path="/dashboard/setup" element={<McpSetup />} />
        <Route path="/dashboard/setup/:keyId" element={<McpKeySetup />} />
        <Route path="/dashboard/connections/:id/schema" element={<Schema />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
