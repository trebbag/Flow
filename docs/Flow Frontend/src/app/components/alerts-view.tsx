import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Bell, CheckCircle2, ShieldAlert, Timer, ClipboardList, ArchiveRestore, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { alerts as alertsApi, type AlertInboxItem } from "./api-client";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT, dispatchAdminRefresh } from "./app-events";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

function kindIcon(kind: AlertInboxItem["kind"]) {
  if (kind === "safety") return ShieldAlert;
  if (kind === "task") return ClipboardList;
  return Timer;
}

export function AlertsView() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [rows, setRows] = useState<AlertInboxItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await alertsApi.list({ tab, limit: 200 });
      setRows(response.items || []);
      setTotal(response.total || 0);
    } catch (error) {
      toast.error("Failed to load alerts", {
        description: (error as Error).message || "Unable to load alerts",
      });
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const onRefresh = () => {
      load().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, [load]);

  const activeCount = useMemo(() => rows.filter((row) => row.status === "active").length, [rows]);

  return (
    <div className="p-6 space-y-5 max-w-[980px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] tracking-tight flex items-center gap-2" style={{ fontWeight: 700 }}>
            <Bell className="w-6 h-6 text-red-500" />
            Alerts
          </h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            Threshold, safety, and task alerts for your assigned scope
          </p>
        </div>
        <button
          onClick={() => load().catch(() => undefined)}
          className="h-9 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as "active" | "archived")}>
        <TabsList className="bg-white border border-gray-200 p-1 rounded-xl h-auto gap-1">
          <TabsTrigger value="active" className="text-[12px] rounded-lg px-3 py-2">
            Active <Badge className="ml-1.5 bg-red-100 text-red-700 border-0 text-[10px] h-5">{tab === "active" ? total : activeCount}</Badge>
          </TabsTrigger>
          <TabsTrigger value="archived" className="text-[12px] rounded-lg px-3 py-2">
            Archive
          </TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          {rows.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <CardContent className="p-8 text-center text-[13px] text-muted-foreground">
                {loading ? "Loading alerts..." : `No ${tab} alerts`}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => {
                const Icon = kindIcon(row.kind);
                const encounterId = String((row.payload as any)?.encounterId || "");
                return (
                  <Card key={row.id} className="border-0 shadow-sm">
                    <CardContent className="p-4 flex items-start gap-3">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                          row.kind === "safety"
                            ? "bg-red-100 text-red-600"
                            : row.kind === "task"
                              ? "bg-blue-100 text-blue-600"
                              : "bg-amber-100 text-amber-600"
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge className="border-0 text-[10px] h-5 bg-gray-100 text-gray-700">{row.kind.toUpperCase()}</Badge>
                          <span className="text-[11px] text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="text-[13px]" style={{ fontWeight: 600 }}>{row.title}</p>
                        <p className="text-[12px] text-muted-foreground mt-0.5">{row.message}</p>
                      </div>
                      <div className="flex flex-col gap-2">
                        {encounterId && (
                          <button
                            onClick={() => navigate(`/encounter/${encounterId}`)}
                            className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 transition-colors"
                          >
                            View Encounter
                          </button>
                        )}
                        {tab === "active" ? (
                          <button
                            onClick={async () => {
                              try {
                                await alertsApi.acknowledge(row.id);
                                toast.success("Alert archived");
                                dispatchAdminRefresh();
                                load().catch(() => undefined);
                              } catch (error) {
                                toast.error("Unable to archive alert", { description: (error as Error).message });
                              }
                            }}
                            className="h-8 px-3 rounded-lg bg-gray-900 text-white text-[11px] hover:bg-black transition-colors flex items-center gap-1.5"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Acknowledge
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              try {
                                await alertsApi.unarchive(row.id);
                                toast.success("Alert restored to active");
                                dispatchAdminRefresh();
                                load().catch(() => undefined);
                              } catch (error) {
                                toast.error("Unable to restore alert", { description: (error as Error).message });
                              }
                            }}
                            className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                          >
                            <ArchiveRestore className="w-3.5 h-3.5" />
                            Unarchive
                          </button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
