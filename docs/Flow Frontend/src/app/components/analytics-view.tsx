import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  TrendingUp,
  Clock,
  Users,
  Activity,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { defaultThresholds } from "./mock-data";
import { useEncounters } from "./encounter-context";
import { dashboards } from "./api-client";

type WeeklyTrendPoint = {
  day: string;
  cycleTime: number;
  encounters: number;
  sla: number;
};

type DailyHistoryPoint = {
  date: string;
  queueByStatus: Record<string, number>;
  alertsByLevel: Record<string, number>;
  encounterCount: number;
  avgLobbyWaitMins: number;
  avgRoomingWaitMins: number;
  avgProviderVisitMins: number;
  stageRollups: Array<{ status: string; count: number; avgMinutes: number }>;
  providerRollups: Array<{
    providerName: string;
    encounterCount: number;
    activeCount: number;
    completedCount: number;
    stageAverages: Record<string, number>;
  }>;
};

const STAGE_ORDER = ["Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut"] as const;

const STAGE_LABELS: Record<string, string> = {
  Lobby: "Lobby",
  Rooming: "Rooming",
  ReadyForProvider: "Ready",
  Optimizing: "Optimizing",
  CheckOut: "Checkout",
};

function isoDateDaysAgo(daysAgo: number) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function shortDayName(dateIso: string) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });
}

function hourLabelFromCheckin(checkinTime: string) {
  const [hourRaw] = checkinTime.split(":");
  const hour = Number(hourRaw);
  if (!Number.isFinite(hour)) return "Unknown";
  const ampm = hour >= 12 ? "PM" : "AM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour} ${ampm}`;
}

export function AnalyticsView() {
  const { encounters } = useEncounters();
  const [weeklyTrend, setWeeklyTrend] = useState<WeeklyTrendPoint[]>([]);
  const [historicalDaily, setHistoricalDaily] = useState<DailyHistoryPoint[]>([]);

  useEffect(() => {
    let mounted = true;

    const loadWeeklyTrend = async () => {
      try {
        const to = isoDateDaysAgo(0);
        const from = isoDateDaysAgo(4);
        const history = (await dashboards.officeManagerHistory({ from, to })) as any;
        const days = Array.isArray(history?.daily) ? (history.daily as DailyHistoryPoint[]) : [];

        const points = days.map((day) => {
          const encounterCount = Number(day.encounterCount || 0);
          const cycleTime =
            Number(day.avgLobbyWaitMins || 0) +
            Number(day.avgRoomingWaitMins || 0) +
            Number(day.avgProviderVisitMins || 0);
          const alertCount =
            Number(day.alertsByLevel?.Yellow || 0) + Number(day.alertsByLevel?.Red || 0);
          const sla =
            encounterCount > 0
              ? Math.max(0, Math.min(100, Math.round((1 - alertCount / encounterCount) * 100)))
              : 100;

          return {
            day: shortDayName(day.date),
            cycleTime: Math.round(cycleTime),
            encounters: encounterCount,
            sla,
          };
        });

        if (mounted) {
          setHistoricalDaily(days);
          setWeeklyTrend(points);
        }
      } catch {
        const active = encounters.filter((encounter) => encounter.status !== "Incoming");
        const avgCycle = active.length
          ? Math.round(
              active.reduce((sum, encounter) => sum + Math.max(0, encounter.minutesInStage), 0) /
                active.length,
            )
          : 0;
        const breached = active.filter((encounter) => {
          const threshold = defaultThresholds.find((item) => item.status === encounter.status);
          return threshold ? encounter.minutesInStage > threshold.redMinutes : false;
        }).length;
        const fallbackSla =
          active.length > 0
            ? Math.max(0, Math.round(((active.length - breached) / active.length) * 100))
            : 100;

        if (mounted) {
          setHistoricalDaily([]);
          setWeeklyTrend([
            {
              day: "Today",
              cycleTime: avgCycle,
              encounters: active.length,
              sla: fallbackSla,
            },
          ]);
        }
      }
    };

    loadWeeklyTrend().catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [encounters]);

  const activeEncounters = useMemo(
    () => encounters.filter((encounter) => encounter.status !== "Incoming"),
    [encounters],
  );

  const stageMetrics = useMemo(
    () => {
      const latestDaily = historicalDaily[historicalDaily.length - 1];
      if (latestDaily?.stageRollups?.length) {
        return STAGE_ORDER.map((status) => {
          const rollup = latestDaily.stageRollups.find((entry) => entry.status === status);
          const threshold = defaultThresholds.find((item) => item.status === status);
          return {
            stage: STAGE_LABELS[status],
            avgMinutes: Number(rollup?.avgMinutes || 0),
            target: threshold?.yellowMinutes || 0,
            count: Number(rollup?.count || 0),
            slaCompliance:
              Number(rollup?.count || 0) > 0 && threshold
                ? Math.max(
                    0,
                    Math.min(
                      100,
                      Math.round(
                        ((Number(rollup?.count || 0) - Number(latestDaily.alertsByLevel?.Red || 0)) /
                          Number(rollup?.count || 1)) *
                          100,
                      ),
                    ),
                  )
                : 100,
          };
        });
      }

      return STAGE_ORDER.map((status) => {
        const rows = encounters.filter((encounter) => encounter.status === status);
        const avgMinutes =
          rows.length > 0
            ? Math.round(
                rows.reduce((sum, encounter) => sum + Math.max(0, encounter.minutesInStage), 0) /
                  rows.length,
              )
            : 0;
        const threshold = defaultThresholds.find((item) => item.status === status);
        const withinTarget =
          threshold
            ? rows.filter((encounter) => encounter.minutesInStage <= threshold.yellowMinutes).length
            : rows.length;
        const slaCompliance =
          rows.length > 0 ? Math.round((withinTarget / rows.length) * 100) : 100;

        return {
          stage: STAGE_LABELS[status],
          avgMinutes,
          target: threshold?.yellowMinutes || 0,
          count: rows.length,
          slaCompliance,
        };
      });
    },
    [encounters, historicalDaily],
  );

  const providerComparison = useMemo(() => {
    if (historicalDaily.length > 0) {
      const aggregate = new Map<
        string,
        { encounterCount: number; activeCount: number; completedCount: number; cycleTotal: number; cycleCount: number }
      >();

      historicalDaily.forEach((day) => {
        (day.providerRollups || []).forEach((provider) => {
          const providerName = String(provider.providerName || "").trim() || "Unassigned";
          if (!aggregate.has(providerName)) {
            aggregate.set(providerName, {
              encounterCount: 0,
              activeCount: 0,
              completedCount: 0,
              cycleTotal: 0,
              cycleCount: 0,
            });
          }
          const row = aggregate.get(providerName)!;
          row.encounterCount += Number(provider.encounterCount || 0);
          row.activeCount += Number(provider.activeCount || 0);
          row.completedCount += Number(provider.completedCount || 0);
          const stageValues = Object.values(provider.stageAverages || {}).filter((value) => Number(value) > 0);
          if (stageValues.length > 0) {
            row.cycleTotal += stageValues.reduce((sum, value) => sum + Number(value), 0);
            row.cycleCount += stageValues.length;
          }
        });
      });

      return Array.from(aggregate.entries())
        .map(([providerName, row]) => {
          const initials = providerName
            .split(/\s+/)
            .filter(Boolean)
            .slice(-2)
            .map((part) => part[0]?.toUpperCase() || "")
            .join("");
          return {
            name: initials || providerName.slice(0, 2).toUpperCase(),
            fullName: providerName,
            cycleTime: row.cycleCount > 0 ? Math.round(row.cycleTotal / row.cycleCount) : 0,
            utilization:
              row.encounterCount > 0 ? Math.round((row.activeCount / row.encounterCount) * 100) : 0,
            completed: row.completedCount,
          };
        })
        .sort((a, b) => b.completed - a.completed || a.fullName.localeCompare(b.fullName));
    }

    const grouped = new Map<
      string,
      {
        name: string;
        cycleMinutesTotal: number;
        count: number;
        activeCount: number;
        completedCount: number;
      }
    >();

    activeEncounters.forEach((encounter) => {
      const key = encounter.provider || "Unassigned";
      if (!grouped.has(key)) {
        grouped.set(key, {
          name: key,
          cycleMinutesTotal: 0,
          count: 0,
          activeCount: 0,
          completedCount: 0,
        });
      }
      const row = grouped.get(key)!;
      row.cycleMinutesTotal += Math.max(0, encounter.minutesInStage);
      row.count += 1;
      if (["ReadyForProvider", "Optimizing", "CheckOut"].includes(encounter.status)) row.activeCount += 1;
      if (encounter.status === "Optimized") row.completedCount += 1;
    });

    return Array.from(grouped.values())
      .map((row) => {
        const initials = row.name
          .split(/\s+/)
          .filter(Boolean)
          .slice(-2)
          .map((part) => part[0]?.toUpperCase() || "")
          .join("");
        const avgCycle = row.count > 0 ? Math.round(row.cycleMinutesTotal / row.count) : 0;
        return {
          name: initials || row.name.slice(0, 2).toUpperCase(),
          fullName: row.name,
          cycleTime: avgCycle,
          utilization: row.count > 0 ? Math.round((row.activeCount / row.count) * 100) : 0,
          completed: row.completedCount,
        };
      })
      .sort((a, b) => b.completed - a.completed || a.fullName.localeCompare(b.fullName));
  }, [activeEncounters, historicalDaily]);

  const bottleneckData = useMemo(() => {
    const rows = new Map<
      string,
      { hour: string; lobby: number; rooming: number; ready: number; checkout: number }
    >();

    encounters.forEach((encounter) => {
      const label = hourLabelFromCheckin(encounter.checkinTime);
      if (!rows.has(label)) {
        rows.set(label, { hour: label, lobby: 0, rooming: 0, ready: 0, checkout: 0 });
      }
      const target = rows.get(label)!;
      if (encounter.status === "Lobby") target.lobby += 1;
      if (encounter.status === "Rooming") target.rooming += 1;
      if (encounter.status === "ReadyForProvider" || encounter.status === "Optimizing") target.ready += 1;
      if (encounter.status === "CheckOut" || encounter.status === "Optimized") target.checkout += 1;
    });

    return Array.from(rows.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  }, [encounters]);

  const radarData = useMemo(
    () =>
      stageMetrics.map((metric) => ({
        stage: metric.stage,
        current: metric.slaCompliance,
        target: 95,
      })),
    [stageMetrics],
  );

  const avgDailyVolume = activeEncounters.length;
  const avgCycleTime = stageMetrics.length
    ? Math.round(
        stageMetrics.reduce((sum, metric) => sum + metric.avgMinutes, 0) / stageMetrics.length,
      )
    : 0;
  const slaCompliance = stageMetrics.length
    ? Math.round(
        stageMetrics.reduce((sum, metric) => sum + metric.slaCompliance, 0) / stageMetrics.length,
      )
    : 100;
  const providerUtilization = providerComparison.length
    ? Math.round(
        providerComparison.reduce((sum, provider) => sum + provider.utilization, 0) /
          providerComparison.length,
      )
    : 0;

  return (
    <div className="p-6 space-y-6 max-w-[1440px] mx-auto">
      <div>
        <h1 className="text-[22px] tracking-tight" style={{ fontWeight: 700 }}>
          <BarChart3 className="w-6 h-6 inline-block mr-2 text-cyan-500 -mt-1" />
          Analytics
        </h1>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          Live operational analytics aggregated from current encounter data
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
              <Activity className="w-5 h-5 text-indigo-500" />
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Active Volume</p>
              <p className="text-[20px]" style={{ fontWeight: 700, lineHeight: 1.2 }}>{avgDailyVolume}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Avg Stage Time</p>
              <p className="text-[20px]" style={{ fontWeight: 700, lineHeight: 1.2 }}>{avgCycleTime}m</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">SLA Compliance</p>
              <p className="text-[20px]" style={{ fontWeight: 700, lineHeight: 1.2 }}>{slaCompliance}%</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <Users className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Provider Utilization</p>
              <p className="text-[20px]" style={{ fontWeight: 700, lineHeight: 1.2 }}>{providerUtilization}%</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-[14px] flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-indigo-500" />
              Daily Trend
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weeklyTrend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <RechartsTooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                  <Line type="monotone" dataKey="cycleTime" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 4, fill: "#6366f1" }} name="Cycle Time (min)" />
                  <Line type="monotone" dataKey="sla" stroke="#10b981" strokeWidth={2} strokeDasharray="4 4" dot={false} name="SLA %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-[14px] flex items-center gap-2">
              <Users className="w-4 h-4 text-amber-500" />
              Provider Comparison
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={providerComparison} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <RechartsTooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                  <Bar dataKey="cycleTime" fill="#6366f1" radius={[4, 4, 0, 0]} name="Cycle Time" />
                  <Bar dataKey="utilization" fill="#10b981" radius={[4, 4, 0, 0]} name="Utilization %" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-[14px] flex items-center gap-2">
              <Clock className="w-4 h-4 text-red-500" />
              Bottleneck Analysis (Volume by Hour)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bottleneckData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <RechartsTooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="lobby" stackId="a" fill="#6366f1" name="Lobby" />
                  <Bar dataKey="rooming" stackId="a" fill="#8b5cf6" name="Rooming" />
                  <Bar dataKey="ready" stackId="a" fill="#f59e0b" name="Ready/In Visit" />
                  <Bar dataKey="checkout" stackId="a" fill="#10b981" name="Checkout/Done" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-[14px] flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-500" />
              SLA Compliance by Stage
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
                  <PolarGrid stroke="#e2e8f0" />
                  <PolarAngleAxis dataKey="stage" tick={{ fontSize: 11, fill: "#64748b" }} />
                  <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 9, fill: "#94a3b8" }} />
                  <Radar name="Current" dataKey="current" stroke="#6366f1" fill="#6366f1" fillOpacity={0.3} strokeWidth={2} />
                  <Radar name="Target" dataKey="target" stroke="#10b981" fill="none" strokeDasharray="4 4" strokeWidth={1.5} />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
