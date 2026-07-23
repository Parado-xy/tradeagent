import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";

const queryClient = new QueryClient();

function App() {
  const [token, setToken] = useState(localStorage.getItem("token"));

  const handleLogin = (newToken: string) => {
    localStorage.setItem("token", newToken);
    setToken(newToken);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    setToken(null);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-50">
        {!token ? (
          <Login onLogin={handleLogin} />
        ) : (
          <Dashboard token={token} onLogout={handleLogout} />
        )}
      </div>
    </QueryClientProvider>
  );
}

export default App;
