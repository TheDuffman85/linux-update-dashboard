import { Routes, Route, Navigate } from "react-router";
import { useAuth } from "./context/AuthContext";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import Dashboard from "./pages/Dashboard";
import SystemsList from "./pages/SystemsList";
import SystemDetail from "./pages/SystemDetail";
import Settings from "./pages/Settings";
import Notifications from "./pages/Notifications";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, setupRequired } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <span className="spinner !w-8 !h-8 text-blue-500" />
      </div>
    );
  }

  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

export default function App() {
  const { loading, setupRequired, user } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <span className="spinner !w-8 !h-8 text-blue-500" />
      </div>
    );
  }

  return (
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
        path="/settings"
        element={
          <AuthGuard>
            <Settings />
          </AuthGuard>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
