import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ClipboardList, CheckCircle2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { tasks, type BackendTask } from "./api-client";
import { loadSession } from "./auth-session";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT, dispatchAdminRefresh } from "./app-events";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

function displayTaskState(task: BackendTask) {
  if (task.completedAt || String(task.status || "").toLowerCase() === "completed") return "completed";
  return "open";
}

export function TasksView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<BackendTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"open" | "completed">("open");
  const [notesByTask, setNotesByTask] = useState<Record<string, string>>({});
  const session = loadSession();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await tasks.list({ mine: true, includeCompleted: true });
      setRows(result || []);
      const nextNotes: Record<string, string> = {};
      result.forEach((row) => {
        if (row.notes) nextNotes[row.id] = row.notes;
      });
      setNotesByTask(nextNotes);
    } catch (error) {
      toast.error("Failed to load tasks", {
        description: (error as Error).message || "Unable to load tasks",
      });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

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

  const openTasks = useMemo(() => rows.filter((task) => displayTaskState(task) === "open"), [rows]);
  const completedTasks = useMemo(() => rows.filter((task) => displayTaskState(task) === "completed"), [rows]);
  const visibleRows = tab === "open" ? openTasks : completedTasks;

  return (
    <div className="p-6 space-y-5 max-w-[1080px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] tracking-tight flex items-center gap-2" style={{ fontWeight: 700 }}>
            <ClipboardList className="w-6 h-6 text-blue-600" />
            Tasks
          </h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            Your assigned and claimable role tasks
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

      <Tabs value={tab} onValueChange={(value) => setTab(value as "open" | "completed")}>
        <TabsList className="bg-white border border-gray-200 p-1 rounded-xl h-auto gap-1">
          <TabsTrigger value="open" className="text-[12px] rounded-lg px-3 py-2">
            Open <Badge className="ml-1.5 bg-blue-100 text-blue-700 border-0 text-[10px] h-5">{openTasks.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="completed" className="text-[12px] rounded-lg px-3 py-2">
            Completed <Badge className="ml-1.5 bg-emerald-100 text-emerald-700 border-0 text-[10px] h-5">{completedTasks.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          {visibleRows.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <CardContent className="p-8 text-center text-[13px] text-muted-foreground">
                {loading ? "Loading tasks..." : `No ${tab} tasks`}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {visibleRows.map((task) => {
                const createdAt = task.createdAt ? new Date(task.createdAt).toLocaleString() : "—";
                const acknowledgedAt = task.acknowledgedAt ? new Date(task.acknowledgedAt).toLocaleString() : "—";
                const completedAt = task.completedAt ? new Date(task.completedAt).toLocaleString() : "—";
                const notes = notesByTask[task.id] ?? "";

                return (
                  <Card key={task.id} className="border-0 shadow-sm">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge className="border-0 bg-blue-100 text-blue-700 text-[10px] h-5">{task.taskType}</Badge>
                            {task.blocking && <Badge className="border-0 bg-red-100 text-red-700 text-[10px] h-5">Blocking</Badge>}
                            <Badge className="border-0 bg-gray-100 text-gray-700 text-[10px] h-5">Priority {task.priority}</Badge>
                          </div>
                          <p className="text-[13px]" style={{ fontWeight: 600 }}>{task.description}</p>
                          <div className="text-[11px] text-muted-foreground mt-1">
                            Encounter {task.encounterId}
                            {task.encounter?.patientId ? ` · Patient ${task.encounter.patientId}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => navigate(`/encounter/${task.encounterId}`)}
                            className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 transition-colors"
                          >
                            View Encounter
                          </button>
                          {displayTaskState(task) === "open" && (
                            <button
                              onClick={async () => {
                                try {
                                  await tasks.update(task.id, {
                                    acknowledged: true,
                                    assignedToUserId: task.assignedToUserId || session?.userId,
                                    status: task.status === "open" ? "in_progress" : task.status,
                                  });
                                  toast.success("Task acknowledged");
                                  dispatchAdminRefresh();
                                  load().catch(() => undefined);
                                } catch (error) {
                                  toast.error("Unable to acknowledge task", { description: (error as Error).message });
                                }
                              }}
                              className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50 transition-colors"
                            >
                              Acknowledge
                            </button>
                          )}
                          {displayTaskState(task) === "open" && (
                            <button
                              onClick={async () => {
                                try {
                                  await tasks.update(task.id, {
                                    completed: true,
                                    notes: notes.trim() || undefined,
                                    status: "completed",
                                  });
                                  toast.success("Task completed");
                                  dispatchAdminRefresh();
                                  load().catch(() => undefined);
                                } catch (error) {
                                  toast.error("Unable to complete task", { description: (error as Error).message });
                                }
                              }}
                              className="h-8 px-3 rounded-lg bg-emerald-600 text-white text-[11px] hover:bg-emerald-700 transition-colors flex items-center gap-1.5"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Complete
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                        <div>Created: {createdAt}</div>
                        <div>Acknowledged: {acknowledgedAt}</div>
                        <div>Completed: {completedAt}</div>
                      </div>

                      <div className="flex items-start gap-2">
                        <textarea
                          value={notes}
                          onChange={(event) =>
                            setNotesByTask((prev) => ({
                              ...prev,
                              [task.id]: event.target.value,
                            }))
                          }
                          placeholder="Task notes..."
                          className="flex-1 min-h-[72px] px-3 py-2 rounded-lg border border-gray-200 text-[12px] bg-white focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                        />
                        <button
                          onClick={async () => {
                            try {
                              await tasks.update(task.id, { notes: notes.trim() || "" });
                              toast.success("Task notes saved");
                              dispatchAdminRefresh();
                              load().catch(() => undefined);
                            } catch (error) {
                              toast.error("Unable to save notes", { description: (error as Error).message });
                            }
                          }}
                          className="h-9 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          Save Notes
                        </button>
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
