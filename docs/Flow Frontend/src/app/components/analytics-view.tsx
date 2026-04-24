import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Clock,
  DollarSign,
  Layers3,
  ShieldAlert,
  Stethoscope,
  TrendingUp,
  Users,
  RefreshCw,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dashboards } from "./api-client";
import type { OwnerAnalyticsSnapshot } from "./types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";

function formatCurrency(cents: number | null | undefined) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format((Number(cents) || 0) / 100);
}

function formatPercent(value: number | null | undefined) {
  return `${Math.round(Number(value) || 0)}%`;
}

function formatDateLabel(dateKey: string) {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function humanizeLabel(value: string) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function SafePanel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="border-0 shadow-sm overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-slate-900 via-slate-700 to-slate-500" />
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] tracking-tight" style={{ fontWeight: 700 }}>
          {title}
        </CardTitle>
        {description ? <div className="text-[12px] text-muted-foreground">{description}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  subvalue,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  subvalue?: string;
  icon: React.ElementType;
  tone: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
          <div className="mt-2 text-[22px] text-slate-900" style={{ fontWeight: 700 }}>
            {value}
          </div>
          {subvalue ? <div className="mt-1 text-[12px] text-slate-500">{subvalue}</div> : null}
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${tone}`} aria-hidden="true">
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
    </div>
  );
}

export function AnalyticsView() {
  const [snapshot, setSnapshot] = useState<OwnerAnalyticsSnapshot | null>(null);
  const [lastGoodSnapshot, setLastGoodSnapshot] = useState<OwnerAnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const load = async (background = false, recompute = false) => {
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const data = await dashboards.ownerAnalytics({ recompute });
        if (!mounted) return;
        setSnapshot(data);
        setLastGoodSnapshot(data);
      } catch (loadError) {
        if (!mounted) return;
        setError((loadError as Error).message || "Unable to load analytics.");
      } finally {
        if (!mounted) return;
        setLoading(false);
        setRefreshing(false);
      }
    };

    load(false).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const data = snapshot || lastGoodSnapshot;

  const throughputDaily = useMemo(
    () =>
      (data?.throughput.daily || []).map((row) => ({
        ...row,
        dateLabel: formatDateLabel(row.dateKey),
      })),
    [data],
  );

  const revenueDaily = useMemo(
    () =>
      (data?.revenue.daily || []).map((row) => ({
        ...row,
        dateLabel: formatDateLabel(row.dateKey),
        expectedGrossK: Math.round((row.expectedGrossChargeCents || 0) / 1000) / 100,
        expectedNetK: Math.round((row.expectedNetReimbursementCents || 0) / 1000) / 100,
      })),
    [data],
  );

  const stageCounts = useMemo(
    () =>
      Object.entries(data?.throughput.stageCounts || {})
        .map(([label, count]) => ({ label: humanizeLabel(label), count: Number(count) || 0 }))
        .sort((a, b) => b.count - a.count),
    [data],
  );

  const stageDurations = useMemo(
    () =>
      (data?.throughput.stageDurations || []).map((row) => ({
        label: humanizeLabel(row.status),
        avgMinutes: Number(row.avgMinutes) || 0,
        count: Number(row.count) || 0,
      })),
    [data],
  );

  const hourOfDay = useMemo(
    () => (data?.throughput.hourOfDay || []).map((row) => ({ label: row.label, count: row.count })),
    [data],
  );

  const providerRows = useMemo(() => data?.providersAndStaff.providers || [], [data]);
  const staffRows = useMemo(() => data?.providersAndStaff.staff || [], [data]);
  const roomDaily = useMemo(
    () =>
      (data?.roomsAndCapacity.daily || []).map((row) => ({
        ...row,
        dateLabel: formatDateLabel(row.dateKey),
      })),
    [data],
  );

  if (loading && !data) {
    return (
      <div className="p-6 space-y-4">
        <div className="text-[20px] text-slate-900" style={{ fontWeight: 700 }}>
          Analytics
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-slate-500 shadow-sm">
          Loading clinic-owner analytics...
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 space-y-4">
        <div className="text-[20px] text-slate-900" style={{ fontWeight: 700 }}>
          Analytics
        </div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-[13px] text-rose-700 shadow-sm" role="alert">
          {error || "Analytics could not be loaded."}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-slate-500">
            <BarChart3 className="h-4 w-4" />
            Clinic Owner Analytics
          </div>
          <h1 className="mt-2 text-[24px] tracking-tight text-slate-900" style={{ fontWeight: 700 }}>
            Flow-controlled operations, projections, and risk in one view
          </h1>
          <p className="mt-2 max-w-[880px] text-[13px] text-slate-600">
            This cockpit shows what Flow can actively control today: encounter throughput, same-day collections, expected charges,
            expected reimbursement, staffing load, room capacity, and unresolved blockers. Athena-observed downstream results stay
            separate and optional.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start lg:self-auto">
          <Badge className="border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
            Flow-controlled primary
          </Badge>
          <Badge className="border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-50">
            {data.scope.from} to {data.scope.to}
          </Badge>
          {refreshing ? <Badge className="border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-50">Refreshing</Badge> : null}
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              dashboards.ownerAnalytics({ recompute: true })
                .then((next) => {
                  setSnapshot(next);
                  setLastGoodSnapshot(next);
                  setError(null);
                })
                .catch((refreshError) => {
                  setError((refreshError as Error).message || "Unable to refresh analytics.");
                })
                .finally(() => setRefreshing(false));
            }}
            disabled={refreshing}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[11px] text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Recompute
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-800 shadow-sm" role="status" aria-live="polite">
          Analytics refresh hit a problem, but the last good dataset is still on screen. {error}
        </div>
      ) : null}

      {data.warnings?.length ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-800 shadow-sm" role="status" aria-live="polite">
          Some analytics sections were loaded from safe fallbacks: {data.warnings.map((warning) => `${warning.section}: ${warning.message}`).join(" · ")}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Encounters In Scope"
          value={String(data.overview.encounterCount)}
          subvalue={`${data.overview.inProgressCount} currently active`}
          icon={Users}
          tone="bg-slate-900"
        />
        <MetricCard
          label="Average Cycle Time"
          value={`${data.overview.avgCycleTimeMins} min`}
          subvalue="Lobby + rooming + provider"
          icon={Clock}
          tone="bg-blue-600"
        />
        <MetricCard
          label="Expected Gross Charges"
          value={formatCurrency(data.overview.expectedGrossChargeCents)}
          subvalue={`Expected net ${formatCurrency(data.overview.expectedNetReimbursementCents)}`}
          icon={TrendingUp}
          tone="bg-emerald-600"
        />
        <MetricCard
          label="POS Collections Tracked"
          value={formatCurrency(data.overview.sameDayCollectionTrackedCents)}
          subvalue={`${formatPercent(data.overview.sameDayCollectionDollarRate)} of expected ${formatCurrency(data.overview.sameDayCollectionExpectedCents)}`}
          icon={DollarSign}
          tone="bg-amber-500"
        />
        <MetricCard
          label="Unresolved Blockers"
          value={String(data.overview.unresolvedBlockers)}
          subvalue={`${data.exceptionsAndRisk.documentationIncompleteCount} documentation blockers`}
          icon={AlertTriangle}
          tone="bg-rose-600"
        />
        <MetricCard
          label="Safety + Blocking Tasks"
          value={String((data.exceptionsAndRisk.activeSafetyCount || 0) + (data.exceptionsAndRisk.blockingTaskCount || 0))}
          subvalue={`${data.exceptionsAndRisk.activeSafetyCount} safety, ${data.exceptionsAndRisk.blockingTaskCount} blocking tasks`}
          icon={ShieldAlert}
          tone="bg-violet-600"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <SafePanel
          title="Throughput"
          description="Daily volume and cycle time trends, plus the current queue distribution and where the day is bunching up."
        >
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={throughputDaily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                  <RechartsTooltip />
                  <Legend />
                  <Bar yAxisId="left" dataKey="encounterCount" fill="#0f172a" radius={[6, 6, 0, 0]} name="Encounters" />
                  <Line yAxisId="right" type="monotone" dataKey="avgCycleTimeMins" stroke="#0ea5e9" strokeWidth={3} dot={false} name="Avg cycle mins" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stageCounts} layout="vertical" margin={{ left: 12, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={110} />
                  <RechartsTooltip />
                  <Bar dataKey="count" fill="#334155" radius={[0, 6, 6, 0]} name="Stage count" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stageDurations}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <RechartsTooltip />
                  <Bar dataKey="avgMinutes" fill="#8b5cf6" radius={[6, 6, 0, 0]} name="Avg minutes" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourOfDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <RechartsTooltip />
                  <Bar dataKey="count" fill="#14b8a6" radius={[6, 6, 0, 0]} name="Check-ins" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </SafePanel>

        <SafePanel
          title="Revenue Projections"
          description="Expected same-day cash, gross charges, net reimbursement, and the configuration gaps that keep projections from being complete."
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-700">Expected Gross</div>
                <div className="mt-2 text-[22px] text-emerald-900" style={{ fontWeight: 700 }}>
                  {formatCurrency(data.overview.expectedGrossChargeCents)}
                </div>
              </div>
              <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-blue-700">Expected Net</div>
                <div className="mt-2 text-[22px] text-blue-900" style={{ fontWeight: 700 }}>
                  {formatCurrency(data.overview.expectedNetReimbursementCents)}
                </div>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-amber-700">POS Tracked</div>
                <div className="mt-2 text-[22px] text-amber-900" style={{ fontWeight: 700 }}>
                  {formatCurrency(data.overview.sameDayCollectionTrackedCents)}
                </div>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-rose-700">Mapping Gaps</div>
                <div className="mt-2 text-[22px] text-rose-900" style={{ fontWeight: 700 }}>
                  {data.revenue.mappingGaps.missingChargeMappingCount + data.revenue.mappingGaps.missingReimbursementMappingCount}
                </div>
              </div>
            </div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={revenueDaily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <RechartsTooltip />
                  <Legend />
                  <Line type="monotone" dataKey="expectedGrossK" stroke="#059669" strokeWidth={3} dot={false} name="Gross ($K)" />
                  <Line type="monotone" dataKey="expectedNetK" stroke="#2563eb" strokeWidth={3} dot={false} name="Net ($K)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-[12px] text-slate-800" style={{ fontWeight: 600 }}>Missed collection reasons</div>
                <div className="mt-3 space-y-2">
                  {(data.revenue.missedCollectionReasons || []).slice(0, 5).map((row) => (
                    <div key={row.label} className="flex items-center justify-between text-[12px]">
                      <span className="text-slate-600">{humanizeLabel(row.label)}</span>
                      <span style={{ fontWeight: 600 }}>{row.count}</span>
                    </div>
                  ))}
                  {data.revenue.missedCollectionReasons.length === 0 ? <div className="text-[12px] text-slate-400">No missed collection reasons in range.</div> : null}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-[12px] text-slate-800" style={{ fontWeight: 600 }}>Collection outcomes</div>
                <div className="mt-3 space-y-2">
                  {(data.revenue.collectionOutcomes || []).slice(0, 5).map((row) => (
                    <div key={row.label} className="flex items-center justify-between text-[12px]">
                      <span className="text-slate-600">{humanizeLabel(row.label)}</span>
                      <span style={{ fontWeight: 600 }}>{row.count}</span>
                    </div>
                  ))}
                  {data.revenue.collectionOutcomes.length === 0 ? <div className="text-[12px] text-slate-400">No collection outcomes captured in range.</div> : null}
                </div>
              </div>
            </div>
          </div>
        </SafePanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        <SafePanel
          title="Providers & Staff"
          description="Who is carrying volume, how fast optimizing is moving, and where MA workload is clustering."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex items-center gap-2 text-[13px] text-slate-800" style={{ fontWeight: 600 }}>
                <Stethoscope className="h-4 w-4 text-slate-500" /> Providers
              </div>
              <div className="space-y-3">
                {providerRows.map((provider) => (
                  <div key={provider.providerName} className="rounded-xl border border-white bg-white p-3 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[13px] text-slate-900" style={{ fontWeight: 600 }}>{provider.providerName}</div>
                      <Badge className="border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-50">{provider.encounterCount} visits</Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
                      <div>Active<br /><span className="text-[13px] text-slate-900" style={{ fontWeight: 600 }}>{provider.activeCount}</span></div>
                      <div>Completed<br /><span className="text-[13px] text-slate-900" style={{ fontWeight: 600 }}>{provider.completedCount}</span></div>
                      <div>Optimizing avg<br /><span className="text-[13px] text-slate-900" style={{ fontWeight: 600 }}>{provider.avgOptimizingMins}m</span></div>
                    </div>
                  </div>
                ))}
                {providerRows.length === 0 ? <div className="text-[12px] text-slate-400">No provider activity in range.</div> : null}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex items-center gap-2 text-[13px] text-slate-800" style={{ fontWeight: 600 }}>
                <Users className="h-4 w-4 text-slate-500" /> Staff load
              </div>
              <div className="space-y-3">
                {staffRows.map((staff) => (
                  <div key={`${staff.role}-${staff.label}`} className="flex items-center justify-between rounded-xl border border-white bg-white px-3 py-3 shadow-sm text-[12px]">
                    <div>
                      <div className="text-slate-900" style={{ fontWeight: 600 }}>{staff.label}</div>
                      <div className="text-slate-500">{staff.role}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[16px] text-slate-900" style={{ fontWeight: 700 }}>{staff.encounterCount}</div>
                      <div className="text-slate-500">encounters</div>
                    </div>
                  </div>
                ))}
                {staffRows.length === 0 ? <div className="text-[12px] text-slate-400">No staff activity in range.</div> : null}
              </div>
            </div>
          </div>
        </SafePanel>

        <SafePanel
          title="Rooms & Capacity"
          description="Room inventory, turnover behavior, and room issues that affect clinic throughput capacity."
        >
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Rooms</div>
                <div className="mt-2 text-[20px] text-slate-900" style={{ fontWeight: 700 }}>{data.roomsAndCapacity.current.roomCount}</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Avg Occupied</div>
                <div className="mt-2 text-[20px] text-slate-900" style={{ fontWeight: 700 }}>{data.roomsAndCapacity.current.avgOccupiedMins}m</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Avg Turnover</div>
                <div className="mt-2 text-[20px] text-slate-900" style={{ fontWeight: 700 }}>{data.roomsAndCapacity.current.avgTurnoverMins}m</div>
              </div>
            </div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={roomDaily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <RechartsTooltip />
                  <Legend />
                  <Line type="monotone" dataKey="avgOccupiedMins" stroke="#0f766e" strokeWidth={3} dot={false} name="Avg occupied mins" />
                  <Line type="monotone" dataKey="avgTurnoverMins" stroke="#b45309" strokeWidth={3} dot={false} name="Avg turnover mins" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-[12px] text-slate-800" style={{ fontWeight: 600 }}>Issue mix</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {(data.roomsAndCapacity.issueTypes || []).map((issue) => (
                  <Badge key={issue.label} className="border border-slate-200 bg-white text-slate-700 hover:bg-white">
                    {humanizeLabel(issue.label)} · {issue.count}
                  </Badge>
                ))}
                {data.roomsAndCapacity.issueTypes.length === 0 ? <div className="text-[12px] text-slate-400">No room issues recorded in range.</div> : null}
              </div>
            </div>
          </div>
        </SafePanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <SafePanel
          title="Exceptions & Risk"
          description="The unresolved work and blockers most likely to turn into next-day rollover, rework, or clinic-owner headaches."
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-rose-700">Documentation Incomplete</div>
              <div className="mt-2 text-[22px] text-rose-900" style={{ fontWeight: 700 }}>{data.exceptionsAndRisk.documentationIncompleteCount}</div>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-amber-700">Provider Queries Open</div>
              <div className="mt-2 text-[22px] text-amber-900" style={{ fontWeight: 700 }}>{data.exceptionsAndRisk.providerQueriesOpen}</div>
            </div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-violet-700">Stale Unresolved</div>
              <div className="mt-2 text-[22px] text-violet-900" style={{ fontWeight: 700 }}>{data.exceptionsAndRisk.staleUnresolvedCount}</div>
            </div>
            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-blue-700">Blocking Tasks</div>
              <div className="mt-2 text-[22px] text-blue-900" style={{ fontWeight: 700 }}>{data.exceptionsAndRisk.blockingTaskCount}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-700">Active Safety</div>
              <div className="mt-2 text-[22px] text-slate-900" style={{ fontWeight: 700 }}>{data.exceptionsAndRisk.activeSafetyCount}</div>
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-700">Rolled Today</div>
              <div className="mt-2 text-[22px] text-emerald-900" style={{ fontWeight: 700 }}>{data.throughput.leakage.rolledCount}</div>
            </div>
          </div>
        </SafePanel>

        <SafePanel
          title="Rollover Drivers"
          description="What is actually pushing cases into next-day work, so owners can see whether the clinic needs staffing, training, or configuration fixes."
        >
          <div className="space-y-3">
            {(data.exceptionsAndRisk.rolloverReasons || []).slice(0, 8).map((row) => (
              <div key={row.label} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-[12px]">
                <div className="flex items-center gap-2 text-slate-600">
                  <Layers3 className="h-4 w-4 text-slate-400" />
                  {humanizeLabel(row.label)}
                </div>
                <div className="text-slate-900" style={{ fontWeight: 700 }}>{row.count}</div>
              </div>
            ))}
            {data.exceptionsAndRisk.rolloverReasons.length === 0 ? <div className="text-[12px] text-slate-400">No rollover reasons recorded in range.</div> : null}
          </div>
        </SafePanel>
      </div>
    </div>
  );
}
