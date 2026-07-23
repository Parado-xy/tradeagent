import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "../config";
import { LogOut } from "lucide-react";

interface DashboardProps {
  token: string;
  onLogout: () => void;
}

export default function Dashboard({ token, onLogout }: DashboardProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/tenants/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load dashboard");
      return res.json();
    },
  });

  if (isLoading) return <div className="p-8">Loading dashboard...</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-semibold text-gray-900">
            TradeAgent OS
          </h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{data?.tenant?.name}</span>
            <button
              onClick={onLogout}
              className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700"
            >
              <LogOut size={16} /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Stats Cards */}
          <div className="bg-white p-6 rounded-xl shadow-sm">
            <h3 className="text-sm text-gray-500">Active Jobs</h3>
            <p className="text-4xl font-semibold mt-2">
              {data?.stats?.activeJobs || 0}
            </p>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm">
            <h3 className="text-sm text-gray-500">Available Techs</h3>
            <p className="text-4xl font-semibold mt-2">
              {data?.stats?.availableTechs || 0}
            </p>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm">
            <h3 className="text-sm text-gray-500">Open Threads</h3>
            <p className="text-4xl font-semibold mt-2">
              {data?.stats?.openThreads || 0}
            </p>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="mt-8">
          <h2 className="text-lg font-medium mb-4">Recent Invoices</h2>
          {/* Add table or cards here */}
        </div>
      </main>
    </div>
  );
}
