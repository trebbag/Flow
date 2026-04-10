import { Link } from "react-router";
import { ArrowLeft, AlertCircle } from "lucide-react";

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <AlertCircle className="w-16 h-16 text-gray-300 mb-4" />
      <h2 className="text-[20px] mb-2" style={{ fontWeight: 600 }}>Page not found</h2>
      <p className="text-[14px] text-muted-foreground mb-6 max-w-md">
        This page doesn't exist or you may not have permission to view it.
      </p>
      <Link
        to="/"
        className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-[13px] hover:bg-indigo-700 transition-colors"
        style={{ fontWeight: 500 }}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>
    </div>
  );
}
