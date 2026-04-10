import { Bell, ShieldAlert, Clock, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { alerts } from "./mock-data";

export function AlertsView() {
  const sorted = [...alerts].sort((a, b) => {
    const priority = { safety: 0, Red: 1, Yellow: 2 };
    return (priority[a.type] ?? 3) - (priority[b.type] ?? 3);
  });

  return (
    <div className="p-6 space-y-6 max-w-[900px] mx-auto">
      <div>
        <h1 className="text-[22px] tracking-tight" style={{ fontWeight: 700 }}>
          <Bell className="w-6 h-6 inline-block mr-2 text-red-500 -mt-1" />
          Alerts
        </h1>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          Monitor and respond to time-in-status and safety alerts
        </p>
      </div>

      <div className="space-y-3">
        {sorted.map((a) => (
          <Card key={a.id} className={`border-0 shadow-sm ${a.acknowledged ? "opacity-60" : ""}`}>
            <CardContent className="p-4 flex items-start gap-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                a.type === "safety" ? "bg-red-100" : a.type === "Red" ? "bg-orange-100" : "bg-amber-100"
              }`}>
                {a.type === "safety" ? (
                  <ShieldAlert className="w-5 h-5 text-red-600" />
                ) : a.type === "Red" ? (
                  <Clock className="w-5 h-5 text-orange-600" />
                ) : (
                  <Clock className="w-5 h-5 text-amber-600" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Badge className={`border-0 text-[10px] px-1.5 h-5 ${
                    a.type === "safety" ? "bg-red-100 text-red-700" : a.type === "Red" ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700"
                  }`}>
                    {a.type === "safety" ? "SAFETY" : a.type.toUpperCase()}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">{a.timestamp}</span>
                  {a.acknowledged && <Badge className="bg-gray-100 text-gray-500 border-0 text-[9px] h-4">Acknowledged</Badge>}
                </div>
                <p className="text-[13px]" style={{ fontWeight: 500 }}>{a.message}</p>
                <p className="text-[11px] text-muted-foreground mt-1">Encounter: {a.encounterId}</p>
              </div>
              {!a.acknowledged && (
                <button className="px-3 py-1.5 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors shrink-0" style={{ fontWeight: 500 }}>
                  Acknowledge
                </button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}