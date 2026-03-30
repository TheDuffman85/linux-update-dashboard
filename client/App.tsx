import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router";
import { useAuth } from "./context/AuthContext";

const Login = lazy(() => import("./pages/Login"));
const Setup = lazy(() => import("./pages/Setup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const SystemsList = lazy(() => import("./pages/SystemsList"));
const SystemDetail = lazy(() => import("./pages/SystemDetail"));
const Settings = lazy(() => import("./pages/Settings"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Credentials = lazy(() => import("./pages/Credentials"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <span className="spinner !w-8 !h-8 text-blue-500" />
    </div>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, setupRequired } = useAuth();

  if (loading) {
    return <PageLoader />;
  }

  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

export default function App() {
  const { loading, setupRequired, user } = useAuth();

  if (loading) {
    return <PageLoader />;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route
          path="/login"
          element={
            user ? <Navigate to="/dashboard" replace /> : <Login />
          }
        />
        <Route
          path="/setup"
          element={
            setupRequired ? <Setup /> : <Navigate to="/dashboard" replace />
          }
        />
        <Route
          path="/dashboard"
          element={
            <AuthGuard>
              <Dashboard />
            </AuthGuard>
          }
        />
        <Route
          path="/systems"
          element={
            <AuthGuard>
              <SystemsList />
            </AuthGuard>
          }
        />
        <Route
          path="/systems/:id"
          element={
            <AuthGuard>
              <SystemDetail />
            </AuthGuard>
          }
        />
        <Route
          path="/notifications"
          element={
            <AuthGuard>
              <Notifications />
            </AuthGuard>
          }
        />
        <Route
          path="/credentials"
          element={
            <AuthGuard>
              <Credentials />
            </AuthGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <AuthGuard>
              <Settings />
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
