import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  Settings,
  Building2,
  Users,
  Stethoscope,
  DoorOpen,
  FileText,
  Clock,
  Bell,
  Shield,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  ChevronDown,
  LayoutTemplate,
  Link2,
  UserCog,
  Building,
  ArrowRight,
  Search,
  RefreshCw,
  AlertTriangle,
  Power,
  Eye,
  EyeOff,
  History,
  Filter,
  ToggleLeft,
  Hash,
  Mail,
  Smartphone,
  Activity,
  GripVertical,
  Info,
  Minus,
  ChevronRight,
  Download,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ScrollArea } from "./ui/scroll-area";
import { Switch } from "./ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  AddFacilityModal,
  AddClinicModal,
  ProvisionUserModal,
  AddRoomModal,
  AddReasonModal,
  AddTemplateModal,
  AddThresholdModal,
  AddNotificationPolicyModal,
} from "./admin-modals";
import {
  admin,
  auth,
  events,
  incoming as incomingApi,
  incomingDispositionReasons,
  type IncomingDispositionReason,
  type TemporaryClinicAssignmentOverride,
} from "./api-client";
import { useEncounters } from "./encounter-context";
import { applySession, loadSession, saveSession } from "./auth-session";
import { labelUserName } from "./display-names";
import {
  ADMIN_REFRESH_EVENT,
  FACILITY_CONTEXT_CHANGED_EVENT,
  dispatchAdminRefresh,
  dispatchFacilityContextChanged,
} from "./app-events";

// ── Mock admin data matching backend DTOs ──

type Facility = {
  id: string;
  name: string;
  shortCode?: string;
  address?: string;
  phone?: string;
  timezone: string;
  status?: string;
};
type Clinic = { id: string; name: string; shortCode: string; maRun: boolean; status: string; color: string; roomIds: string[]; providerCount: number };
type AdminUser = {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  credential?: string;
  email: string;
  status: string;
  phone?: string;
  entraObjectId?: string | null;
  entraTenantId?: string | null;
  entraUserPrincipalName?: string | null;
  identityProvider?: string | null;
  directoryStatus?: string | null;
  directoryUserType?: string | null;
  directoryAccountEnabled?: boolean | null;
  lastDirectorySyncAt?: string | null;
  lastLogin: string;
  createdAt: string;
  activeFacilityId?: string | null;
  roles: { role: string; clinicId?: string | null; facilityId?: string | null }[];
};
type Room = {
  id: string;
  facilityId?: string;
  name: string;
  roomNumber: number;
  roomType: string;
  status: "active" | "inactive" | "archived";
  clinicIds: string[];
  encounterCount: number;
  occupied: boolean;
};
type TemplateFieldDefinition = {
  id?: string;
  key: string;
  label: string;
  type:
    | "text"
    | "textarea"
    | "number"
    | "checkbox"
    | "select"
    | "radio"
    | "date"
    | "time"
    | "bloodPressure"
    | "temperature"
    | "pulse"
    | "respirations"
    | "oxygenSaturation"
    | "height"
    | "weight"
    | "painScore"
    | "yesNo";
  required?: boolean;
  options?: string[];
  group?: string;
};
type Reason = {
  id: string;
  facilityId?: string;
  name: string;
  appointmentLengthMinutes: number;
  status: "active" | "inactive" | "archived";
  clinicIds: string[];
  // compatibility / derived fields used by existing UI
  active?: boolean;
  code?: string;
  templateCount?: number;
};
type Template = {
  id: string;
  facilityId?: string;
  name: string;
  type: "checkin" | "rooming" | "clinician" | "checkout";
  status: "active" | "inactive" | "archived";
  reasonIds: string[];
  fields: TemplateFieldDefinition[];
  jsonSchema: Record<string, any>;
  uiSchema: Record<string, any>;
  requiredFields: string[];
  createdAt?: string;
  updatedAt?: string;
  // compatibility / derived fields used by existing UI
  active?: boolean;
};
type Threshold = {
  id: string;
  facilityId?: string;
  clinicId: string | null;
  metric: "stage" | "overall_visit";
  status: string | null;
  yellowMinutes: number;
  redMinutes: number;
  isOverride: boolean;
};
type NotificationPolicy = { id: string; clinicId: string; status: string; severity: string; recipients: string[]; channels: string[]; cooldownMinutes: number; enabled: boolean; lastTriggered: string | null };
type ClinicAssignment = {
  id: string | null;
  clinicId: string;
  clinicName: string;
  clinicShortCode?: string | null;
  clinicStatus: string;
  maRun: boolean;
  providerUserId: string | null;
  providerUserName: string | null;
  providerUserStatus: string | null;
  maUserId: string | null;
  maUserName: string | null;
  maUserStatus: string | null;
  roomCount: number;
  isOperational: boolean;
};
type AuditEntry = { id: string; action: string; entity: string; entityName: string; user: string; timestamp: string };

const fallbackFacility: Facility = {
  id: "f1",
  name: "Westside Family Medicine",
  shortCode: "WFM",
  address: "1200 Health Park Dr, Suite 300, Portland, OR 97201",
  phone: "(503) 555-0142",
  timezone: "America/Los_Angeles",
  status: "active",
};
const fallbackClinics: Clinic[] = [];
const fallbackUsers: AdminUser[] = [];
const fallbackRooms: Room[] = [];
const fallbackReasons: Reason[] = [];
const fallbackTemplates: Template[] = [];
const fallbackThresholds: Threshold[] = [];
const fallbackNotificationPolicies: NotificationPolicy[] = [];
const fallbackAuditLog: AuditEntry[] = [];

const allRoles = ["FrontDeskCheckIn", "MA", "Clinician", "FrontDeskCheckOut", "OfficeManager", "Admin", "RevenueCycle"];

type AdminConsoleDataContextValue = {
  facility: Facility;
  facilityOptions: Facility[];
  clinics: Clinic[];
  users: AdminUser[];
  rooms: Room[];
  reasons: Reason[];
  templates: Template[];
  thresholds: Threshold[];
  notificationPolicies: NotificationPolicy[];
  assignments: ClinicAssignment[];
  auditLog: AuditEntry[];
  maUsers: AdminUser[];
  clinicianUsers: AdminUser[];
  reloadAdminData: () => Promise<void>;
};

const AdminConsoleDataContext = createContext<AdminConsoleDataContextValue | null>(null);

function useAdminConsoleData() {
  const context = useContext(AdminConsoleDataContext);
  if (!context) {
    throw new Error("useAdminConsoleData must be used within AdminConsole");
  }
  return context;
}

// ── Helper: relative time ──
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function colorFromText(input: string) {
  const palette = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#8b5cf6"];
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length] || "#6366f1";
}

function reasonCodeFromName(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
    .padEnd(2, "X")
    .slice(0, 4);
}

function splitUserDisplayName(name: string) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { firstName: "", lastName: "", credential: "" };
  const [namePart, credentialPart] = trimmed.split(/\s*,\s*/, 2);
  const words = String(namePart || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { firstName: "", lastName: "", credential: credentialPart || "" };
  if (words.length === 1) return { firstName: words[0]!, lastName: "", credential: credentialPart || "" };
  return {
    firstName: words[0]!,
    lastName: words.slice(1).join(" "),
    credential: credentialPart || ""
  };
}

function composeUserDisplayName(input: { firstName: string; lastName: string; credential?: string }) {
  const base = `${input.firstName} ${input.lastName}`.trim();
  const credential = String(input.credential || "").trim();
  return credential ? `${base}, ${credential}` : base;
}

function capitalizeRoomType(value?: string) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function channelLabel(channel: string) {
  if (channel === "in_app") return "App Notification";
  if (channel === "email") return "Email";
  if (channel === "sms") return "SMS";
  return channel;
}

const stageOrder: Array<string> = ["Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut"];
function stageSortRank(status: string | null) {
  if (!status) return 999;
  const idx = stageOrder.indexOf(status);
  return idx === -1 ? 500 : idx;
}

function isUuid(value?: string | null) {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  return value.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function csvCell(value: string) {
  const escaped = String(value).replace(/"/g, "\"\"");
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function normalizeScheduleImportText(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0] || "";
  const looksLikeTsv = firstLine.includes("\t") && !firstLine.includes(",");
  if (!looksLikeTsv) return trimmed;

  return lines
    .map((line) => line.split("\t").map((part) => csvCell(part.trim())).join(","))
    .join("\n");
}

function incomingDispositionLabel(reason: IncomingDispositionReason | string) {
  return String(reason || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveTemplateFieldsFromSchema(template: any): TemplateFieldDefinition[] {
  const fromFields = Array.isArray(template.fields)
    ? template.fields
    : Array.isArray(template.fieldsJson)
      ? template.fieldsJson
      : [];
  if (fromFields.length > 0) {
    return fromFields.map((field: any, index: number) => ({
      id: field.id || `field_${index + 1}`,
      key: String(field.key || field.name || `field_${index + 1}`),
      label: String(field.label || field.name || field.key || `Field ${index + 1}`),
      type:
        field.type === "textarea" ||
        field.type === "number" ||
        field.type === "checkbox" ||
        field.type === "select" ||
        field.type === "radio" ||
        field.type === "date" ||
        field.type === "time"
          ? field.type
          : "text",
      required: Boolean(field.required),
      options: Array.isArray(field.options) ? field.options : undefined,
      group: field.group ? String(field.group) : undefined,
      icon: field.icon ? String(field.icon) : undefined,
      color: field.color ? String(field.color) : undefined,
    }));
  }

  const properties = template?.jsonSchema?.properties && typeof template.jsonSchema.properties === "object"
    ? template.jsonSchema.properties
    : {};
  const required = new Set(Array.isArray(template.requiredFields) ? template.requiredFields : []);
  const derived = Object.entries(properties).map(([key, definition], index) => {
    const rawType = String((definition as any)?.type || "text");
    const enumValues = Array.isArray((definition as any)?.enum) ? (definition as any).enum : undefined;
    const mappedType =
      rawType === "boolean"
        ? "checkbox"
        : rawType === "number" || rawType === "integer"
          ? "number"
          : enumValues
            ? "select"
            : "text";
    return {
      id: `field_${index + 1}`,
      key,
      label: String((definition as any)?.title || key),
      type: mappedType as TemplateFieldDefinition["type"],
      required: required.has(key),
      options: enumValues ? enumValues.map((entry: unknown) => String(entry)) : undefined,
    };
  });
  return derived.length > 0 ? derived : [{ id: "field_1", key: "notes", label: "Notes", type: "textarea", required: false }];
}

function requestAdminRefresh() {
  dispatchAdminRefresh();
}

async function runAdminMutation(successMessage: string, action: () => Promise<unknown>) {
  try {
    await action();
    toast.success(successMessage);
    requestAdminRefresh();
  } catch (error) {
    toast.error("Update failed", {
      description: (error as Error).message || "Unable to update admin configuration",
    });
  }
}

// ── Reusable Sub-components ──

function SectionHeader({ icon: Icon, title, count, actionLabel, onAction, iconColor = "text-indigo-500", secondaryAction }: {
  icon: React.ElementType; title: string; count?: number; actionLabel?: string; onAction?: () => void; iconColor?: string;
  secondaryAction?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <Icon className={`w-4.5 h-4.5 ${iconColor}`} />
        <span className="text-[14px]" style={{ fontWeight: 600 }}>{title}</span>
        {count !== undefined && (
          <Badge className="bg-gray-100 text-gray-600 border-0 text-[10px] px-1.5 h-5">{count}</Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        {secondaryAction}
        {actionLabel && onAction && (
          <button onClick={onAction} className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-indigo-600 text-white text-[12px] hover:bg-indigo-700 transition-colors" style={{ fontWeight: 500 }}>
            <Plus className="w-3.5 h-3.5" /> {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function SearchInput({ value, onChange, placeholder = "Search..." }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-9 pr-3 w-full rounded-lg border border-gray-200 bg-white text-[12px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition-all"
      />
      {value && (
        <button onClick={() => onChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-white p-3 flex items-center gap-3">
      <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center shrink-0`}>
        <Icon className="w-4 h-4 text-white" />
      </div>
      <div>
        <div className="text-[16px]" style={{ fontWeight: 600 }}>{value}</div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      </div>
    </div>
  );
}

function NumberStepperControl({
  value,
  onChange,
  min = 0,
  step = 1,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
  className?: string;
}) {
  return (
    <div className={`h-8 rounded-lg border border-gray-200 bg-white flex items-center overflow-hidden ${className || ""}`}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, Number(value || 0) - step))}
        className="h-full w-8 inline-flex items-center justify-center text-gray-500 hover:bg-gray-50 border-r border-gray-100"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={String(Number.isFinite(value) ? value : min)}
        onChange={(event) => {
          const digits = event.target.value.replace(/[^\d]/g, "");
          if (!digits) {
            onChange(min);
            return;
          }
          onChange(Math.max(min, Number(digits)));
        }}
        className="h-full w-full text-center text-[12px] focus:outline-none"
      />
      <button
        type="button"
        onClick={() => onChange(Math.max(min, Number(value || 0) + step))}
        className="h-full w-8 inline-flex items-center justify-center text-gray-500 hover:bg-gray-50 border-l border-gray-100"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function EmptyState({ icon: Icon, message }: { icon: React.ElementType; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center mb-3">
        <Icon className="w-5 h-5 text-gray-400" />
      </div>
      <p className="text-[13px] text-muted-foreground">{message}</p>
    </div>
  );
}

function DeleteConfirmDialog({ open, onClose, onConfirm, entityName }: { open: boolean; onClose: () => void; onConfirm: () => void; entityName: string }) {
  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[15px] flex items-center gap-2">
            <AlertTriangle className="w-4.5 h-4.5 text-red-500" /> Confirm Deletion
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px]">
            Are you sure you want to delete <span style={{ fontWeight: 600 }}>{entityName}</span>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-9 text-[13px]">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="h-9 text-[13px] bg-red-600 hover:bg-red-700">
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Tab Wrapper for visual distinction ──
function TabPanel({ accentColor: _accentColor, children }: { accentColor: string; children: React.ReactNode }) {
  return (
    <div>
      {children}
    </div>
  );
}

// ── Tab: Facility & Rooms ──
function FacilityRoomsTab({
  onAddRoom,
  onAddFacility,
  onEditRoom,
  selectedFacilityId,
  onSaveFacility,
}: {
  onAddRoom: () => void;
  onAddFacility: () => void;
  onEditRoom: (room: Room) => void;
  selectedFacilityId: string;
  onSaveFacility: (facilityId: string) => Promise<void>;
}) {
  const { facility, facilityOptions, clinics: mockClinics, rooms: mockRooms, reloadAdminData } = useAdminConsoleData();
  const [editingFacility, setEditingFacility] = useState(false);
  const [editingActiveFacility, setEditingActiveFacility] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [draggingRoomId, setDraggingRoomId] = useState<string | null>(null);
  const [reorderingRooms, setReorderingRooms] = useState(false);
  const [pendingFacilityId, setPendingFacilityId] = useState(selectedFacilityId);
  const [facilityDraft, setFacilityDraft] = useState({
    name: facility.name,
    shortCode: facility.shortCode || facility.id,
    timezone: facility.timezone,
    address: facility.address,
    phone: facility.phone,
  });

  useEffect(() => {
    setPendingFacilityId(selectedFacilityId);
  }, [selectedFacilityId]);

  useEffect(() => {
    setFacilityDraft({
      name: facility.name,
      shortCode: facility.shortCode || facility.id,
      timezone: facility.timezone,
      address: facility.address,
      phone: facility.phone,
    });
  }, [facility.id, facility.name, facility.shortCode, facility.timezone, facility.address, facility.phone]);

  const nonArchivedRooms = mockRooms.filter((room) => room.status !== "archived");
  const archivedRooms = mockRooms.filter((room) => room.status === "archived");
  const roomTypes = [...new Set(nonArchivedRooms.map((room) => room.roomType))];
  const activeRooms = nonArchivedRooms.filter((room) => room.status === "active");
  const occupiedRooms = activeRooms.filter((room) => room.occupied).length;

  const filteredRooms = useMemo(() => {
    return nonArchivedRooms.filter((room) => {
      if (filterType !== "all" && room.roomType !== filterType) return false;
      if (!showInactive && room.status === "inactive") return false;
      return true;
    });
  }, [filterType, showInactive, nonArchivedRooms]);

  // Which clinics use each room
  const roomClinicMap: Record<string, Clinic[]> = {};
  mockRooms.forEach((room) => {
    roomClinicMap[room.id] = mockClinics.filter((clinic) => clinic.roomIds.includes(room.id));
  });

  const reorderRooms = async (draggedRoomId: string, targetRoomId: string) => {
    if (draggedRoomId === targetRoomId) return;
    const orderedIds = nonArchivedRooms
      .slice()
      .sort((a, b) => a.roomNumber - b.roomNumber)
      .map((room) => room.id);
    const fromIdx = orderedIds.indexOf(draggedRoomId);
    const toIdx = orderedIds.indexOf(targetRoomId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const next = [...orderedIds];
    const [moved] = next.splice(fromIdx, 1);
    if (!moved) return;
    next.splice(toIdx, 0, moved);

    setReorderingRooms(true);
    try {
      await admin.reorderRooms({
        facilityId: selectedFacilityId,
        roomIds: next,
      });
      await reloadAdminData();
      toast.success("Room order updated");
      requestAdminRefresh();
    } catch (error) {
      toast.error("Room reorder failed", {
        description: (error as Error).message || "Unable to persist room order",
      });
    } finally {
      setReorderingRooms(false);
    }
  };

  return (
    <TabPanel accentColor="bg-purple-500">
      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Rooms" value={mockRooms.length} icon={DoorOpen} color="bg-purple-500" />
          <StatCard label="Active Rooms" value={activeRooms.length} icon={Activity} color="bg-emerald-500" />
          <StatCard label="Occupied Now" value={occupiedRooms} icon={Users} color="bg-blue-500" />
          <StatCard label="Utilization" value={`${activeRooms.length > 0 ? Math.round((occupiedRooms / activeRooms.length) * 100) : 0}%`} icon={Activity} color="bg-amber-500" />
        </div>

        {/* Facility Profile */}
        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-purple-500 to-violet-400" />
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
                  <Building className="w-4 h-4 text-purple-600" />
                </div>
                <span className="text-[14px]" style={{ fontWeight: 600 }}>Facility Profile</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onAddFacility}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <Plus className="w-3.5 h-3.5" /> Add Facility
                </button>
                <button
                  onClick={() => {
                    if (!editingFacility) {
                      setEditingFacility(true);
                      return;
                    }
                    runAdminMutation("Facility profile updated", async () => {
                      await admin.updateFacility(facility.id, {
                        name: facilityDraft.name,
                        shortCode: facilityDraft.shortCode,
                        address: facilityDraft.address,
                        phone: facilityDraft.phone,
                        timezone: facilityDraft.timezone,
                      });
                    }).catch(() => undefined);
                    setEditingFacility(false);
                  }}
                  className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] transition-colors ${editingFacility ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}
                  style={{ fontWeight: 500 }}
                >
                  {editingFacility ? <><Check className="w-3.5 h-3.5" /> Save</> : <><Pencil className="w-3.5 h-3.5" /> Edit</>}
                </button>
              </div>
            </div>
            <div className="mb-4">
              <label className="text-[12px] text-muted-foreground mb-1.5 block" style={{ fontWeight: 500 }}>
                Active Facility
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={pendingFacilityId}
                  onChange={(event) => setPendingFacilityId(event.target.value)}
                  className="h-9 px-3 rounded-lg border border-gray-200 bg-white text-[12px] min-w-[280px] disabled:bg-gray-100 disabled:text-gray-500"
                  disabled={!editingActiveFacility}
                >
                  {facilityOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.shortCode ? `${row.shortCode} · ${row.name}` : row.name}
                    </option>
                  ))}
                </select>
                {!editingActiveFacility ? (
                  <button
                    onClick={() => setEditingActiveFacility(true)}
                    className="h-9 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-700 hover:bg-gray-50 transition-colors"
                    style={{ fontWeight: 500 }}
                  >
                    Change Active Facility
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        if (!pendingFacilityId || pendingFacilityId === selectedFacilityId) {
                          setEditingActiveFacility(false);
                          return;
                        }
                        runAdminMutation("Active facility updated", async () => {
                          await onSaveFacility(pendingFacilityId);
                        }).catch(() => undefined);
                        setEditingActiveFacility(false);
                      }}
                      className="h-9 px-3 rounded-lg bg-emerald-600 text-white text-[12px] hover:bg-emerald-700 transition-colors"
                      style={{ fontWeight: 500 }}
                    >
                      Save Facility
                    </button>
                    <button
                      onClick={() => {
                        setPendingFacilityId(selectedFacilityId);
                        setEditingActiveFacility(false);
                      }}
                      className="h-9 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors"
                      style={{ fontWeight: 500 }}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { label: "Facility Name", value: facilityDraft.name, field: "name" },
                { label: "Facility Code", value: facilityDraft.shortCode, field: "shortCode" },
                { label: "Address", value: facilityDraft.address, field: "address" },
                { label: "Phone", value: facilityDraft.phone, field: "phone" },
                { label: "Timezone", value: facilityDraft.timezone, field: "timezone" },
              ].map(item => (
                <div key={item.field} className="rounded-lg border border-purple-100/50 bg-purple-50/30 p-4">
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">{item.label}</div>
                  {editingFacility ? (
                    <input
                      type="text"
                      value={item.value || ""}
                      onChange={(event) =>
                        setFacilityDraft((prev) => ({ ...prev, [item.field]: event.target.value } as typeof prev))
                      }
                      className="w-full h-8 px-2 rounded border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-purple-300 focus:ring-2 focus:ring-purple-100"
                    />
                  ) : (
                    <div className="text-[14px] flex items-center gap-2" style={{ fontWeight: 500 }}>
                      {item.value || "—"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Rooms */}
        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-amber-500 to-orange-400" />
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                  <DoorOpen className="w-4 h-4 text-amber-600" />
                </div>
                <span className="text-[14px]" style={{ fontWeight: 600 }}>Facility Rooms</span>
                <Badge className="bg-gray-100 text-gray-600 border-0 text-[10px] px-1.5 h-5">{filteredRooms.length}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <select value={filterType} onChange={e => setFilterType(e.target.value)} className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]">
                  <option value="all">All Types</option>
                  {roomTypes.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                  <Switch checked={showInactive} onCheckedChange={setShowInactive} />
                  Show Inactive
                </label>
                <button onClick={onAddRoom} className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-amber-600 text-white text-[12px] hover:bg-amber-700 transition-colors" style={{ fontWeight: 500 }}>
                  <Plus className="w-3.5 h-3.5" /> Add Room
                </button>
              </div>
            </div>

            <p className="text-[12px] text-muted-foreground mb-4">
              These rooms belong to the facility. Each clinic can select which rooms it uses from this pool.
            </p>
            <p className="text-[11px] text-muted-foreground mb-3 flex items-center gap-1.5">
              <GripVertical className="w-3.5 h-3.5" />
              Drag and drop room cards to reorder Room # automatically.
              {reorderingRooms ? " Saving..." : ""}
            </p>

            {filteredRooms.length === 0 ? (
              <EmptyState icon={DoorOpen} message="No rooms match your filters" />
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                {filteredRooms.map((r) => {
                  const usedBy = roomClinicMap[r.id] || [];
                  const isActive = r.status === "active";
                  return (
                    <div
                      key={r.id}
                      draggable
                      onDragStart={() => setDraggingRoomId(r.id)}
                      onDragEnd={() => setDraggingRoomId(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!draggingRoomId) return;
                        reorderRooms(draggingRoomId, r.id).catch(() => undefined);
                        setDraggingRoomId(null);
                      }}
                      className={`rounded-lg border p-3 transition-colors cursor-grab active:cursor-grabbing ${
                        draggingRoomId === r.id
                          ? "border-amber-300 bg-amber-50/40"
                          : isActive
                            ? "border-gray-100 hover:border-amber-200"
                            : "border-gray-100 bg-gray-50 opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <GripVertical className="w-3.5 h-3.5 text-gray-400" />
                          <span className="text-[13px]" style={{ fontWeight: 500 }}>{r.name}</span>
                          {r.occupied && (
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Switch
                            checked={isActive}
                            onCheckedChange={(v) =>
                              runAdminMutation(`${r.name} ${v ? "activated" : "deactivated"}`, async () => {
                                await admin.updateRoom(r.id, { status: v ? "active" : "inactive" });
                              })
                            }
                            className="scale-75"
                          />
                          <button
                            onClick={() => onEditRoom(r)}
                            className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-gray-600"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget({ id: r.id, name: r.name })}
                            className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-red-500"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div className="text-[11px] text-muted-foreground">Room #{r.roomNumber}</div>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge className={`border-0 text-[9px] px-1.5 h-4 ${r.roomType === "exam" ? "bg-blue-100 text-blue-600" : r.roomType === "procedure" ? "bg-purple-100 text-purple-600" : "bg-gray-100 text-gray-500"}`}>
                          {capitalizeRoomType(r.roomType)}
                        </Badge>
                        {r.occupied && <Badge className="bg-blue-100 text-blue-600 border-0 text-[9px] px-1.5 h-4">Occupied</Badge>}
                        {!isActive && <Badge className="bg-gray-100 text-gray-500 border-0 text-[9px] px-1.5 h-4">Inactive</Badge>}
                        <span className="text-[9px] text-muted-foreground ml-auto">{r.encounterCount} encounters</span>
                      </div>
                      {/* Show which clinics use this room */}
                      {usedBy.length > 0 && (
                        <div className="flex items-center gap-1 mt-2 pt-2 border-t border-gray-100">
                          <span className="text-[9px] text-muted-foreground mr-1">Used by:</span>
                          {usedBy.map(cl => (
                            <Badge key={cl.id} className="border-0 text-[9px] px-1 h-4" style={{ backgroundColor: `${cl.color}15`, color: cl.color }}>{cl.shortCode}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-slate-500 to-slate-400" />
          <CardContent className="p-5">
            <SectionHeader icon={History} title="Archived Rooms" count={archivedRooms.length} iconColor="text-slate-500" />
            {archivedRooms.length === 0 ? (
              <EmptyState icon={History} message="No archived rooms in this facility" />
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                {archivedRooms.map((room) => (
                  <div key={room.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px]" style={{ fontWeight: 500 }}>
                        {room.name} (Archived)
                      </span>
                      <button
                        onClick={() =>
                          runAdminMutation(`${room.name} restored`, async () => {
                            await admin.restoreRoom(room.id);
                          })
                        }
                        className="h-6 px-2 rounded border border-emerald-200 text-[10px] text-emerald-600 hover:bg-emerald-50 transition-colors"
                        style={{ fontWeight: 500 }}
                      >
                        Restore
                      </button>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Room #{room.roomNumber} · {capitalizeRoomType(room.roomType)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-2">{room.encounterCount} historical encounters</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (!target) return;
            (async () => {
              try {
                const result = await admin.deleteRoom(target.id);
                await reloadAdminData();
                if (result.status === "archived") {
                  toast.success(`${target.name} archived`);
                } else {
                  toast.success(`${target.name} deleted`);
                }
                requestAdminRefresh();
              } catch (error) {
                toast.error("Delete failed", {
                  description: (error as Error).message || "Unable to delete room",
                });
              }
            })();
          }}
          entityName={deleteTarget?.name || ""}
        />
      </div>
    </TabPanel>
  );
}

// ── Tab: Clinics ──
function ClinicsTab({ onAddClinic, onEditClinic }: { onAddClinic: () => void; onEditClinic: (clinic: Clinic) => void }) {
  const {
    clinics: mockClinics,
    rooms: mockRooms,
    assignments: mockAssignments,
    reasons: mockReasons,
    reloadAdminData,
  } = useAdminConsoleData();
  const [expandedClinic, setExpandedClinic] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [draftRoomIdsByClinic, setDraftRoomIdsByClinic] = useState<Record<string, string[]>>({});

  const visibleClinics = mockClinics
    .filter((clinic) => clinic.status !== "archived")
    .sort((a, b) => {
      const aInactive = a.status === "inactive" ? 1 : 0;
      const bInactive = b.status === "inactive" ? 1 : 0;
      if (aInactive !== bInactive) return aInactive - bInactive;
      return a.name.localeCompare(b.name);
    });
  const archivedClinicRows = mockClinics.filter((clinic) => clinic.status === "archived");
  const assignableRooms = mockRooms.filter((room) => room.status !== "archived");

  const activeClinics = visibleClinics.filter((clinic) => clinic.status === "active").length;
  const inactiveClinics = visibleClinics.filter((clinic) => clinic.status === "inactive").length;
  const archivedClinics = archivedClinicRows.length;

  function roomIdsForClinic(clinic: Clinic) {
    return draftRoomIdsByClinic[clinic.id] || clinic.roomIds;
  }

  return (
    <TabPanel accentColor="bg-emerald-500">
      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Clinics" value={visibleClinics.length} icon={Building2} color="bg-emerald-500" />
          <StatCard label="Active" value={activeClinics} icon={Activity} color="bg-emerald-600" />
          <StatCard label="Inactive" value={inactiveClinics} icon={Power} color="bg-amber-500" />
          <StatCard label="Archived" value={archivedClinics} icon={History} color="bg-slate-500" />
        </div>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-emerald-500 to-teal-400" />
          <CardContent className="p-5">
            <SectionHeader icon={Building2} title="Clinics" count={visibleClinics.length} actionLabel="Add Clinic" onAction={onAddClinic} iconColor="text-emerald-500" />
            <p className="text-[12px] text-muted-foreground mb-4">
              Each clinic selects facility rooms it can use. Inactive clinics remain assignable to users but are blocked for new check-in and encounters.
            </p>
            <div className="space-y-2">
              {visibleClinics.map((clinic) => {
                const selectedRoomIds = roomIdsForClinic(clinic);
                const clinicRooms = assignableRooms.filter((room) => selectedRoomIds.includes(room.id));
                return (
                  <div key={clinic.id}>
                    <div
                      className="rounded-lg border border-gray-100 p-4 flex items-center gap-4 hover:border-emerald-200 transition-colors cursor-pointer"
                      onClick={() => setExpandedClinic(expandedClinic === clinic.id ? null : clinic.id)}
                    >
                      <div className="w-3 h-8 rounded-full" style={{ backgroundColor: clinic.color }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px]" style={{ fontWeight: 500 }}>{clinic.name}</span>
                          <Badge className="bg-gray-100 text-gray-500 border-0 text-[10px] h-5">{clinic.shortCode}</Badge>
                        </div>
                        <div className="text-[12px] text-muted-foreground mt-0.5 flex items-center gap-3">
                          <span>{clinic.maRun ? "MA Run Clinic" : "Provider Run Clinic"}</span>
                          <span className="flex items-center gap-1"><DoorOpen className="w-3 h-3" /> {clinic.roomIds.length} rooms</span>
                          <span className="flex items-center gap-1"><Stethoscope className="w-3 h-3" /> {clinic.providerCount} providers</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge className="bg-violet-100 text-violet-700 border-0 text-[10px] h-5">{clinic.maRun ? "MA Run" : "Provider Run"}</Badge>
                        <Badge className={`border-0 text-[10px] h-5 ${clinic.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>{clinic.status}</Badge>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${expandedClinic === clinic.id ? "rotate-180" : ""}`} />
                    </div>
                    {expandedClinic === clinic.id && (
                      <div className="ml-7 mt-1 mb-2 p-4 rounded-lg bg-emerald-50/40 border border-emerald-100/50 space-y-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <DoorOpen className="w-3.5 h-3.5 text-emerald-600" />
                            <span className="text-[12px]" style={{ fontWeight: 600 }}>Assigned Rooms</span>
                            <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[10px] h-5">{clinicRooms.length}</Badge>
                          </div>
                          {assignableRooms.length === 0 ? (
                            <div className="h-9 px-3 rounded-lg border border-gray-200 bg-white text-[12px] text-muted-foreground flex items-center">
                              Add facility rooms first.
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-1.5 max-h-44 overflow-y-auto pr-1">
                              {assignableRooms.map((room) => {
                                const checked = selectedRoomIds.includes(room.id);
                                return (
                                  <label key={room.id} className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-white px-2.5 py-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => {
                                        setDraftRoomIdsByClinic((prev) => {
                                          const current = prev[clinic.id] || clinic.roomIds;
                                          return {
                                            ...prev,
                                            [clinic.id]: event.target.checked
                                              ? [...current, room.id]
                                              : current.filter((id) => id !== room.id),
                                          };
                                        });
                                      }}
                                      className="w-4 h-4 rounded border-gray-300 text-emerald-600"
                                    />
                                    <span className="text-[11px]">{room.name} (#{room.roomNumber})</span>
                                    {room.status === "inactive" && (
                                      <Badge className="ml-auto bg-gray-100 text-gray-500 border-0 text-[9px] h-4">Inactive</Badge>
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                          <button
                            onClick={() =>
                              runAdminMutation(`Assigned rooms updated for ${clinic.name}`, async () => {
                                await admin.updateClinic(clinic.id, { roomIds: roomIdsForClinic(clinic) });
                              })
                            }
                            className="h-7 px-3 rounded-lg border border-emerald-200 text-[11px] text-emerald-700 hover:bg-emerald-50 transition-colors"
                            style={{ fontWeight: 500 }}
                          >
                            Save Assigned Rooms
                          </button>
                        </div>

                        <div className="flex items-center gap-3 pt-2 border-t border-emerald-100/50">
                          <label className="flex items-center gap-2 text-[12px]">
                            <Switch
                              checked={clinic.status === "active"}
                              onCheckedChange={(value) =>
                                runAdminMutation(`${clinic.name} ${value ? "activated" : "inactivated"}`, async () => {
                                  await admin.updateClinic(clinic.id, { status: value ? "active" : "inactive" });
                                })
                              }
                            />
                            <span>{clinic.status === "active" ? "Active" : "Inactive"}</span>
                          </label>
                        </div>

                        <div className="flex items-center gap-2 pt-2 border-t border-emerald-100/50">
                          <button
                            onClick={() => onEditClinic(clinic)}
                            className="h-7 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-white transition-colors flex items-center gap-1.5"
                            style={{ fontWeight: 500 }}
                          >
                            <Pencil className="w-3 h-3" /> Edit Details
                          </button>
                          <button
                            onClick={() => setDeleteTarget({ id: clinic.id, name: clinic.name })}
                            className="h-7 px-3 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1.5"
                            style={{ fontWeight: 500 }}
                          >
                            <Trash2 className="w-3 h-3" /> Delete Clinic
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-slate-500 to-slate-400" />
          <CardContent className="p-5">
            <SectionHeader icon={History} title="Archived Clinics" count={archivedClinicRows.length} iconColor="text-slate-500" />
            {archivedClinicRows.length === 0 ? (
              <EmptyState icon={History} message="No archived clinics in this facility" />
            ) : (
              <div className="space-y-2">
                {archivedClinicRows.map((clinic) => (
                  <div key={clinic.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-center justify-between">
                    <div>
                      <div className="text-[13px]" style={{ fontWeight: 500 }}>{clinic.name} (Archived)</div>
                      <div className="text-[11px] text-muted-foreground">{clinic.shortCode} · {clinic.providerCount} providers · {clinic.roomIds.length} rooms</div>
                    </div>
                    <button
                      onClick={() =>
                        runAdminMutation(`${clinic.name} restored`, async () => {
                          await admin.restoreClinic(clinic.id);
                        })
                      }
                      className="h-7 px-3 rounded-lg border border-emerald-200 text-[11px] text-emerald-700 hover:bg-emerald-50 transition-colors"
                      style={{ fontWeight: 500 }}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (!target) return;
            (async () => {
              try {
                const result = await admin.deleteClinic(target.id);
                await reloadAdminData();
                if (result.status === "archived") {
                  toast.success(`${target.name} archived`);
                } else {
                  toast.success(`${target.name} deleted`);
                }
                requestAdminRefresh();
              } catch (error) {
                toast.error("Delete failed", {
                  description: (error as Error).message || "Unable to delete clinic",
                });
              }
            })();
          }}
          entityName={deleteTarget?.name || ""}
        />
      </div>
    </TabPanel>
  );
}

// ── Tab: Users & Roles ──
function UsersRolesTab({ onAddUser, onOpenAssignments }: { onAddUser: () => void; onOpenAssignments: () => void; }) {
  const { users: mockUsers, clinics: mockClinics, facility, facilityOptions, reloadAdminData } = useAdminConsoleData();
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [pendingRoleByUser, setPendingRoleByUser] = useState<Record<string, string>>({});

  const filtered = useMemo(() => {
    return mockUsers.filter(u => {
      if (search && !u.name.toLowerCase().includes(search.toLowerCase()) && !u.email.toLowerCase().includes(search.toLowerCase())) return false;
      if (roleFilter !== "all" && !u.roles.some(r => r.role === roleFilter)) return false;
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      return true;
    });
  }, [search, roleFilter, statusFilter, mockUsers]);

  const roleStats = useMemo(() => {
    const counts: Record<string, number> = {};
    mockUsers.forEach(u => u.roles.forEach(r => { counts[r.role] = (counts[r.role] || 0) + 1; }));
    return counts;
  }, [mockUsers]);

  const facilityLabelById = useMemo(
    () =>
      new Map(
        facilityOptions.map((entry) => [
          entry.id,
          entry.shortCode ? `${entry.shortCode}` : entry.name,
        ]),
      ),
    [facilityOptions],
  );

  const roleScopeLabel = useCallback(
    (role: { clinicId?: string | null; facilityId?: string | null }) => {
      if (role.clinicId) {
        return mockClinics.find((clinic) => clinic.id === role.clinicId)?.shortCode || role.clinicId;
      }
      if (role.facilityId) {
        return facilityLabelById.get(role.facilityId) || role.facilityId;
      }
      return null;
    },
    [facilityLabelById, mockClinics],
  );

  return (
    <TabPanel accentColor="bg-blue-500">
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {Object.entries(roleStats).map(([role, count]) => (
          <div
            key={role}
            className={`rounded-lg border p-2.5 cursor-pointer transition-colors ${roleFilter === role ? "border-indigo-300 bg-indigo-50" : "border-gray-100 bg-white hover:border-gray-200"}`}
            onClick={() => setRoleFilter(roleFilter === role ? "all" : role)}
          >
            <div className="text-[15px]" style={{ fontWeight: 600 }}>{count}</div>
            <div className="text-[10px] text-muted-foreground truncate">{role}</div>
          </div>
        ))}
      </div>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-blue-500 to-indigo-400" />
        <CardContent className="p-5">
          <SectionHeader icon={Users} title="Users" count={filtered.length} actionLabel="Provision User" onAction={onAddUser} iconColor="text-blue-500" />
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="w-64">
              <SearchInput value={search} onChange={setSearch} placeholder="Search by name or email..." />
            </div>
            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]">
              <option value="all">All Roles</option>
              {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]">
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
            {(search || roleFilter !== "all" || statusFilter !== "all") && (
              <button onClick={() => { setSearch(""); setRoleFilter("all"); setStatusFilter("all"); }} className="text-[11px] text-indigo-600 hover:text-indigo-800" style={{ fontWeight: 500 }}>
                Clear Filters
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={Users} message="No users match your filters" />
          ) : (
            <div className="space-y-1">
              {filtered.map((u) => (
                <div key={u.id}>
                  <div
                    className={`rounded-lg border p-3 flex items-center gap-3 transition-colors cursor-pointer ${u.status === "suspended" ? "border-red-100 bg-red-50/30" : "border-gray-100 hover:border-gray-200"}`}
                    onClick={() => setExpandedUser(expandedUser === u.id ? null : u.id)}
                  >
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-[11px] shrink-0 ${u.status === "suspended" ? "bg-gray-400" : "bg-gradient-to-br from-indigo-400 to-purple-500"}`} style={{ fontWeight: 600 }}>
                      {u.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px]" style={{ fontWeight: 500 }}>{u.name}</span>
                        {u.status === "suspended" && <Badge className="bg-red-100 text-red-600 border-0 text-[9px] h-4">SUSPENDED</Badge>}
                        {u.identityProvider === "entra" && <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[9px] h-4">ENTRA LINKED</Badge>}
                      </div>
                      <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                        <span>{u.email}</span>
                        <span className="text-gray-300">|</span>
                        <span>{u.directoryStatus ? `Directory: ${u.directoryStatus}` : "Directory: pending"}</span>
                        <span className="text-gray-300">|</span>
                        <span>Last login: {timeAgo(u.lastLogin)}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {u.roles.map((r, i) => (
                        <Badge key={i} className="bg-indigo-50 text-indigo-600 border-0 text-[10px] px-1.5 h-5">
                          {r.role}
                          {roleScopeLabel(r) ? ` · ${roleScopeLabel(r)}` : ""}
                        </Badge>
                      ))}
                    </div>
                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${expandedUser === u.id ? "rotate-180" : ""}`} />
                  </div>
                  {expandedUser === u.id && (
                    <div className="ml-12 mt-1 mb-2 p-4 rounded-lg bg-gray-50 border border-gray-100 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-[12px] text-muted-foreground" style={{ fontWeight: 500 }}>Assigned Roles</div>
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                          <span>Created: {u.createdAt}</span>
                          <span>ID: <code className="bg-gray-200 px-1 rounded text-[10px]">{u.id}</code></span>
                        </div>
                      </div>
                      <div className="rounded-lg bg-white border border-gray-100 p-3">
                        <div className="text-[12px] text-muted-foreground mb-2" style={{ fontWeight: 500 }}>Microsoft Entra Identity</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-gray-600">
                          <div>
                            <span className="text-muted-foreground">Provider:</span>{" "}
                            <span style={{ fontWeight: 500 }}>{u.identityProvider || "Not linked"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Directory status:</span>{" "}
                            <span style={{ fontWeight: 500 }}>{u.directoryStatus || "Unknown"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">User type:</span>{" "}
                            <span style={{ fontWeight: 500 }}>{u.directoryUserType || "Unknown"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Account enabled:</span>{" "}
                            <span style={{ fontWeight: 500 }}>
                              {typeof u.directoryAccountEnabled === "boolean" ? (u.directoryAccountEnabled ? "Yes" : "No") : "Unknown"}
                            </span>
                          </div>
                          <div className="sm:col-span-2">
                            <span className="text-muted-foreground">Object ID:</span>{" "}
                            <code className="bg-gray-100 px-1 rounded text-[10px]">{u.entraObjectId || "Not linked"}</code>
                          </div>
                          <div className="sm:col-span-2">
                            <span className="text-muted-foreground">UPN:</span>{" "}
                            <span style={{ fontWeight: 500 }}>{u.entraUserPrincipalName || u.email}</span>
                          </div>
                          <div className="sm:col-span-2">
                            <span className="text-muted-foreground">Last sync:</span>{" "}
                            <span style={{ fontWeight: 500 }}>
                              {u.lastDirectorySyncAt ? new Date(u.lastDirectorySyncAt).toLocaleString() : "Not synced yet"}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        {u.roles.map((r, i) => (
                          <div key={i} className="flex items-center justify-between rounded-lg bg-white border border-gray-100 p-2.5">
                            <div className="flex items-center gap-2">
                              <Shield className="w-3.5 h-3.5 text-indigo-500" />
                              <span className="text-[12px]" style={{ fontWeight: 500 }}>{r.role}</span>
                              {roleScopeLabel(r) && <span className="text-[11px] text-muted-foreground">@ {roleScopeLabel(r)}</span>}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                runAdminMutation(`Removed ${r.role} role from ${u.name}`, async () => {
                                  await admin.removeRole(u.id, {
                                    role: r.role as any,
                                    clinicId: r.clinicId || undefined,
                                    facilityId: r.facilityId || undefined,
                                  });
                                }).catch(() => undefined);
                              }}
                              className="text-[10px] text-red-500 hover:text-red-700 transition-colors"
                              style={{ fontWeight: 500 }}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                        <select
                          className="h-8 px-2 rounded-lg border border-gray-200 bg-white text-[12px] flex-1"
                          value={pendingRoleByUser[u.id] || ""}
                          onChange={(event) =>
                            setPendingRoleByUser((prev) => ({ ...prev, [u.id]: event.target.value }))
                          }
                        >
                          <option value="">Add role...</option>
                          {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button
                          onClick={() => {
                            const role = pendingRoleByUser[u.id];
                            if (!role) {
                              toast.error("Select a role before assigning");
                              return;
                            }
                            runAdminMutation(`Role assigned to ${u.name}`, async () => {
                              await admin.assignRole(u.id, {
                                role: role as any,
                                facilityId: facility.id,
                              });
                              setPendingRoleByUser((prev) => ({ ...prev, [u.id]: "" }));
                            }).catch(() => undefined);
                          }}
                          className="h-8 px-3 rounded-lg bg-indigo-600 text-white text-[11px] hover:bg-indigo-700 transition-colors"
                          style={{ fontWeight: 500 }}
                        >
                          Assign
                        </button>
                      </div>
                      <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                        <button
                          onClick={() =>
                            runAdminMutation(`Microsoft Entra sync refreshed for ${u.name}`, async () => {
                              await admin.resyncUser(u.id);
                            }).catch(() => undefined)
                          }
                          className="h-7 px-3 rounded-lg border border-blue-200 text-[11px] text-blue-600 hover:bg-blue-50 transition-colors flex items-center gap-1.5"
                          style={{ fontWeight: 500 }}
                        >
                          <RefreshCw className="w-3 h-3" /> Resync Entra
                        </button>
                        {u.status === "active" ? (
                          <button
                            onClick={() =>
                              runAdminMutation(`${u.name} suspended`, async () => {
                                const updated = await admin.updateUser(u.id, { status: "suspended" });
                                const impact = (updated as any)?.impact;
                                if (impact?.impactedClinicCount) {
                                  const blocked = Number(impact.nonOperationalClinicCount || 0);
                                  const labels = Array.isArray(impact.clinics)
                                    ? impact.clinics
                                        .slice(0, 3)
                                        .map((clinic: any) =>
                                          clinic.clinicShortCode
                                            ? `${clinic.clinicShortCode} · ${clinic.clinicName}`
                                            : clinic.clinicName,
                                        )
                                        .join(", ")
                                    : "";
                                  if (blocked > 0) {
                                    toast.warning("Suspension affected clinic operations", {
                                      description: `${blocked} clinic(s) are now non-operational until reassigned.${labels ? ` ${labels}` : ""}`,
                                    });
                                    onOpenAssignments();
                                  }
                                }
                              }).catch(() => undefined)
                            }
                            className="h-7 px-3 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1.5"
                            style={{ fontWeight: 500 }}
                          >
                            <Power className="w-3 h-3" /> Suspend User
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              runAdminMutation(`${u.name} reactivated`, async () => {
                                const updated = await admin.updateUser(u.id, { status: "active" });
                                const impact = (updated as any)?.impact;
                                if (impact?.impactedClinicCount) {
                                  const blocked = Number(impact.nonOperationalClinicCount || 0);
                                  if (blocked > 0) {
                                    toast.warning("Some clinics still need reassignment", {
                                      description: `${blocked} impacted clinic(s) remain non-operational.`,
                                    });
                                    onOpenAssignments();
                                  } else {
                                    toast.success("Impacted clinics are operational.");
                                  }
                                }
                              }).catch(() => undefined)
                            }
                            className="h-7 px-3 rounded-lg border border-emerald-200 text-[11px] text-emerald-600 hover:bg-emerald-50 transition-colors flex items-center gap-1.5"
                            style={{ fontWeight: 500 }}
                          >
                            <RefreshCw className="w-3 h-3" /> Reactivate User
                          </button>
                        )}
                        {u.status === "suspended" && (
                          <button
                            onClick={() => {
                              if (!window.confirm(`Archive ${u.name}? This removes account access but preserves historical data.`)) {
                                return;
                              }
                              runAdminMutation(`${u.name} archived`, async () => {
                                await admin.deleteUser(u.id);
                              }).catch(() => undefined);
                            }}
                            className="h-7 px-3 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1.5"
                            style={{ fontWeight: 500 }}
                          >
                            <Trash2 className="w-3 h-3" /> Delete User
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
    </TabPanel>
  );
}

// ── Tab: Visit Reasons & Templates ──
function ReasonsTemplatesTab({
  onAddReason,
  onEditReason,
  onAddTemplate,
  onEditTemplate,
}: {
  onAddReason: () => void;
  onEditReason: (reason: Reason) => void;
  onAddTemplate: () => void;
  onEditTemplate: (template: Template) => void;
}) {
  const { reasons: mockReasons, templates: mockTemplates, facility, reloadAdminData } = useAdminConsoleData();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; kind: "reason" | "template" } | null>(null);
  const [templateTypeTab, setTemplateTypeTab] = useState<"checkin" | "rooming" | "clinician" | "checkout">("checkin");

  const activeReasons = mockReasons.filter((reason) => reason.status === "active");
  const inactiveReasons = mockReasons.filter((reason) => reason.status === "inactive");
  const archivedReasons = mockReasons.filter((reason) => reason.status === "archived");

  const activeTemplates = mockTemplates.filter((template) => template.status === "active");
  const inactiveTemplates = mockTemplates.filter((template) => template.status === "inactive");
  const archivedTemplates = mockTemplates.filter((template) => template.status === "archived");

  const visibleTemplates = mockTemplates.filter((template) => template.type === templateTypeTab && template.status !== "archived");
  const visibleArchivedTemplates = archivedTemplates.filter((template) => template.type === templateTypeTab);

  const typeLabel: Record<Template["type"], string> = {
    checkin: "Check-In",
    rooming: "Rooming",
    clinician: "Clinician",
    checkout: "Check-Out",
  };

  const typeBadgeClass: Record<Template["type"], string> = {
    checkin: "bg-sky-100 text-sky-700",
    rooming: "bg-purple-100 text-purple-700",
    clinician: "bg-amber-100 text-amber-700",
    checkout: "bg-emerald-100 text-emerald-700",
  };

  return (
    <TabPanel accentColor="bg-violet-500">
      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Active Reasons" value={activeReasons.length} icon={FileText} color="bg-violet-500" />
          <StatCard label="Active Templates" value={activeTemplates.length} icon={LayoutTemplate} color="bg-pink-500" />
          <StatCard label="Inactive Reasons" value={inactiveReasons.length} icon={EyeOff} color="bg-gray-400" />
          <StatCard label="Inactive Templates" value={inactiveTemplates.length} icon={EyeOff} color="bg-gray-400" />
        </div>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-violet-500 to-purple-400" />
          <CardContent className="p-5 space-y-4">
            <SectionHeader
              icon={FileText}
              title="Visit Reasons"
              count={mockReasons.filter((reason) => reason.status !== "archived").length}
              actionLabel="Add Visit"
              onAction={onAddReason}
              iconColor="text-violet-500"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {mockReasons
                .filter((reason) => reason.status !== "archived")
                .map((reason) => {
                  const templateCount = mockTemplates.filter((template) => template.reasonIds.includes(reason.id) && template.status !== "archived").length;
                  const isActive = reason.status === "active";
                  return (
                    <div key={reason.id} className={`rounded-lg border p-3 transition-colors ${isActive ? "border-gray-100 hover:border-gray-200" : "border-gray-100 bg-gray-50"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-2 h-2 rounded-full ${isActive ? "bg-emerald-500" : "bg-gray-400"}`} />
                          <span className="text-[13px] truncate" style={{ fontWeight: 500 }}>{reason.name}</span>
                          {!isActive && <Badge className="bg-gray-100 text-gray-500 border-0 text-[9px] h-4">INACTIVE</Badge>}
                        </div>
                        <Switch
                          checked={isActive}
                          onCheckedChange={(checked) =>
                            runAdminMutation(`${reason.name} ${checked ? "activated" : "inactivated"}`, async () => {
                              await admin.updateReason(reason.id, { status: checked ? "active" : "inactive" });
                              await reloadAdminData();
                            })
                          }
                          className="scale-75"
                        />
                      </div>
                      <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-2 mb-2">
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{reason.appointmentLengthMinutes} min</span>
                        <span className="text-gray-300">|</span>
                        <span>{reason.clinicIds.length} clinics</span>
                        <span className="text-gray-300">|</span>
                        <span>{templateCount} templates</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => onEditReason(reason)}
                          className="h-7 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                          style={{ fontWeight: 500 }}
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget({ id: reason.id, name: reason.name, kind: "reason" })}
                          className="h-7 px-3 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1.5"
                          style={{ fontWeight: 500 }}
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
            {archivedReasons.length > 0 && (
              <div className="pt-3 border-t border-gray-100">
                <div className="text-[12px] text-muted-foreground mb-2" style={{ fontWeight: 500 }}>Archived Visit Reasons</div>
                <div className="space-y-2">
                  {archivedReasons.map((reason) => (
                    <div key={reason.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 text-[12px] text-gray-600 flex items-center justify-between">
                      <span>{reason.name} (Archived)</span>
                      <span className="text-[11px] text-muted-foreground">{reason.appointmentLengthMinutes} min</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-pink-500 to-rose-400" />
          <CardContent className="p-5 space-y-4">
            <SectionHeader
              icon={LayoutTemplate}
              title="Templates"
              count={mockTemplates.filter((template) => template.status !== "archived").length}
              actionLabel="Create Template"
              onAction={onAddTemplate}
              iconColor="text-pink-500"
            />
            <Tabs value={templateTypeTab} onValueChange={(value) => setTemplateTypeTab(value as "checkin" | "rooming" | "clinician" | "checkout")} className="w-full">
              <TabsList className="bg-white border border-gray-200 p-1 rounded-xl h-auto w-full grid grid-cols-2 sm:grid-cols-4 gap-1">
                <TabsTrigger value="checkin" className="text-[11px] rounded-lg data-[state=active]:bg-sky-50 data-[state=active]:text-sky-700 data-[state=active]:border data-[state=active]:border-sky-200">Check-In</TabsTrigger>
                <TabsTrigger value="rooming" className="text-[11px] rounded-lg data-[state=active]:bg-purple-50 data-[state=active]:text-purple-700 data-[state=active]:border data-[state=active]:border-purple-200">Rooming</TabsTrigger>
                <TabsTrigger value="clinician" className="text-[11px] rounded-lg data-[state=active]:bg-amber-50 data-[state=active]:text-amber-700 data-[state=active]:border data-[state=active]:border-amber-200">Clinician</TabsTrigger>
                <TabsTrigger value="checkout" className="text-[11px] rounded-lg data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 data-[state=active]:border data-[state=active]:border-emerald-200">Check-Out</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="space-y-2">
              {visibleTemplates.length === 0 ? (
                <EmptyState icon={LayoutTemplate} message={`No ${typeLabel[templateTypeTab]} templates configured`} />
              ) : (
                visibleTemplates.map((template) => {
                  const reasonNames = template.reasonIds
                    .map((reasonId) => mockReasons.find((reason) => reason.id === reasonId)?.name || reasonId)
                    .join(", ");
                  const requiredCount = template.fields.filter((field) => field.required).length;
                  return (
                    <div key={template.id} className="rounded-lg border border-gray-100 p-3 flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${template.status === "active" ? "bg-pink-50" : "bg-gray-100"}`}>
                        <LayoutTemplate className={`w-4 h-4 ${template.status === "active" ? "text-pink-500" : "text-gray-400"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[13px]" style={{ fontWeight: 500 }}>{template.name}</span>
                          <Badge className={`border-0 text-[10px] h-5 ${typeBadgeClass[template.type]}`}>{typeLabel[template.type]}</Badge>
                          {template.status === "inactive" && <Badge className="bg-gray-100 text-gray-500 border-0 text-[9px] h-4">INACTIVE</Badge>}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Reasons: {reasonNames || "None"} · {template.fields.length} fields · {requiredCount} required
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={template.status === "active"}
                          onCheckedChange={(checked) =>
                            runAdminMutation(`${template.name} ${checked ? "activated" : "inactivated"}`, async () => {
                              await admin.updateTemplate(template.id, {
                                facilityId: template.facilityId || facility.id,
                                name: template.name,
                                type: template.type,
                                status: checked ? "active" : "inactive",
                                reasonIds: template.reasonIds,
                                fields: template.fields,
                              });
                            })
                          }
                          className="scale-75"
                        />
                        <button
                          onClick={() => onEditTemplate(template)}
                          className="h-7 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                          style={{ fontWeight: 500 }}
                        >
                          <Pencil className="w-3 h-3" /> Edit Template Settings
                        </button>
                        <button
                          onClick={() => setDeleteTarget({ id: template.id, name: template.name, kind: "template" })}
                          className="h-7 px-3 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1.5"
                          style={{ fontWeight: 500 }}
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {visibleArchivedTemplates.length > 0 && (
              <div className="pt-3 border-t border-gray-100">
                <div className="text-[12px] text-muted-foreground mb-2" style={{ fontWeight: 500 }}>
                  Archived {typeLabel[templateTypeTab]} Templates
                </div>
                <div className="space-y-2">
                  {visibleArchivedTemplates.map((template) => (
                    <div key={template.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 text-[12px] text-gray-600">
                      {template.name} (Archived)
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (!target) return;
            if (target.kind === "reason") {
              runAdminMutation(`${target.name} archived`, async () => {
                await admin.deleteReason(target.id);
                await reloadAdminData();
              }).catch(() => undefined);
              return;
            }
            runAdminMutation(`${target.name} archived`, async () => {
              await admin.deleteTemplate(target.id);
              await reloadAdminData();
            }).catch(() => undefined);
          }}
          entityName={deleteTarget?.name || ""}
        />
      </div>
    </TabPanel>
  );
}

// ── Tab: Thresholds ──
function ThresholdsTab({ onAddThreshold, facilityId }: { onAddThreshold: () => void; facilityId: string }) {
  const { thresholds: mockThresholds, clinics: mockClinics, reloadAdminData } = useAdminConsoleData();
  const defaults = mockThresholds
    .filter((t) => !t.isOverride)
    .sort((a, b) => {
      if (a.metric === "overall_visit" && b.metric !== "overall_visit") return 1;
      if (b.metric === "overall_visit" && a.metric !== "overall_visit") return -1;
      return stageSortRank(a.status) - stageSortRank(b.status);
    });
  const overrides = mockThresholds.filter(t => t.isOverride);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [editedByThresholdId, setEditedByThresholdId] = useState<Record<string, { yellow: number; red: number }>>({});
  const [savingAll, setSavingAll] = useState(false);

  function editedThreshold(threshold: Threshold) {
    return editedByThresholdId[threshold.id] || {
      yellow: threshold.yellowMinutes,
      red: threshold.redMinutes,
    };
  }

  function thresholdLabel(threshold: Threshold) {
    if (threshold.metric === "overall_visit") return "Overall Visit Length";
    return String(threshold.status || "")
      .replace(/([A-Z])/g, " $1")
      .trim();
  }

  const allThresholdRows = [...defaults, ...overrides];
  const hasPendingChanges = allThresholdRows.some((row) => {
    const edited = editedThreshold(row);
    return edited.yellow !== row.yellowMinutes || edited.red !== row.redMinutes;
  });

  const saveAllThresholds = async () => {
    if (!hasPendingChanges) {
      toast.info("No threshold changes to save");
      return;
    }
    setSavingAll(true);
    try {
      const resolvedFacilityId =
        (isUuid(facilityId) ? facilityId : "") ||
        (isUuid(allThresholdRows[0]?.facilityId || "") ? String(allThresholdRows[0]?.facilityId) : "");

      const payloadRows = allThresholdRows.map((row) => ({
        id: row.id,
        clinicId: row.clinicId,
        metric: row.metric,
        status: row.status,
        yellowAtMin: editedThreshold(row).yellow,
        redAtMin: editedThreshold(row).red,
      }));
      if (!isUuid(resolvedFacilityId)) {
        throw new Error("Select and save an active facility before saving thresholds.");
      }
      await admin.bulkUpdateThresholds({
        facilityId: resolvedFacilityId,
        rows: payloadRows,
      });
      toast.success("All thresholds saved");
      setEditedByThresholdId({});
      requestAdminRefresh();
    } catch (error) {
      toast.error("Threshold save failed", {
        description: (error as Error).message || "Unable to save threshold updates",
      });
    } finally {
      setSavingAll(false);
    }
  };

  return (
    <TabPanel accentColor="bg-orange-500">
    <div className="space-y-6">
      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-orange-500 to-amber-400" />
        <CardContent className="p-5">
          <SectionHeader
            icon={Clock}
            title="Facility Defaults"
            count={defaults.length}
            iconColor="text-orange-500"
            secondaryAction={
              <div className="flex items-center gap-2">
                <button onClick={() => toast.info("Reset all thresholds to system defaults")} className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors" style={{ fontWeight: 500 }}>
                  <RefreshCw className="w-3.5 h-3.5" /> Reset Defaults
                </button>
                <button
                  onClick={() => saveAllThresholds().catch(() => undefined)}
                  disabled={!hasPendingChanges || savingAll}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-orange-600 text-white text-[12px] hover:bg-orange-700 transition-colors disabled:opacity-50"
                  style={{ fontWeight: 500 }}
                >
                  <Check className="w-3.5 h-3.5" /> {savingAll ? "Saving..." : "Save All Thresholds"}
                </button>
              </div>
            }
          />
          <p className="text-[12px] text-muted-foreground mb-4">Configure when Yellow and Red alerts trigger per encounter status. These apply facility-wide unless overridden.</p>

          {/* Visual threshold preview */}
          <div className="space-y-2 mb-6">
            {defaults.map((t) => {
              const edited = editedThreshold(t);
              const isOverall = t.metric === "overall_visit";
              return (
              <div
                key={t.id}
                className={`rounded-lg border p-3 ${isOverall ? "border-violet-200 bg-violet-50/40 shadow-sm" : "border-gray-100"}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px]" style={{ fontWeight: 500 }}>{thresholdLabel(t)}</span>
                  {isOverall && (
                    <Badge className="border-0 text-[10px] h-5 bg-violet-100 text-violet-700">Overall</Badge>
                  )}
                </div>
                {/* Visual bar */}
                <div className="h-6 rounded-full bg-gray-100 flex items-center overflow-hidden mb-2 relative">
                  <div className="h-full bg-emerald-200 rounded-l-full" style={{ width: `${(edited.yellow / 50) * 100}%` }} />
                  <div className="h-full bg-amber-200" style={{ width: `${((edited.red - edited.yellow) / 50) * 100}%` }} />
                  <div className="h-full bg-red-200 flex-1 rounded-r-full" />
                  <div className="absolute left-0 top-0 h-full flex items-center pl-2 text-[10px] text-emerald-700" style={{ fontWeight: 600 }}>Green</div>
                  <div className="absolute h-full flex items-center text-[10px] text-amber-700" style={{ fontWeight: 600, left: `${(edited.yellow / 50) * 100}%`, paddingLeft: "4px" }}>{edited.yellow}m</div>
                  <div className="absolute h-full flex items-center text-[10px] text-red-700" style={{ fontWeight: 600, left: `${(edited.red / 50) * 100}%`, paddingLeft: "4px" }}>{edited.red}m</div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-amber-600" style={{ fontWeight: 500 }}>Yellow:</span>
                    <NumberStepperControl
                      value={edited.yellow}
                      min={1}
                      className="w-[108px]"
                      onChange={(nextValue) =>
                        setEditedByThresholdId((prev) => ({
                          ...prev,
                          [t.id]: { ...edited, yellow: nextValue },
                        }))
                      }
                    />
                    <span className="text-[10px] text-muted-foreground">min</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-red-600" style={{ fontWeight: 500 }}>Red:</span>
                    <NumberStepperControl
                      value={edited.red}
                      min={1}
                      className="w-[108px]"
                      onChange={(nextValue) =>
                        setEditedByThresholdId((prev) => ({
                          ...prev,
                          [t.id]: { ...edited, red: nextValue },
                        }))
                      }
                    />
                    <span className="text-[10px] text-muted-foreground">min</span>
                  </div>
                </div>
              </div>
            )})}
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-orange-400 to-red-400" />
        <CardContent className="p-5">
          <SectionHeader
            icon={Building2}
            title="Clinic Overrides"
            count={overrides.length}
            actionLabel="Add Override"
            onAction={onAddThreshold}
            iconColor="text-orange-500"
          />
          <p className="text-[12px] text-muted-foreground mb-4">Clinic-specific overrides take precedence over facility defaults.</p>
          {overrides.length === 0 ? (
            <EmptyState icon={Clock} message="No clinic-specific overrides configured" />
          ) : (
            <div className="rounded-lg border border-gray-100 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="text-left px-4 py-3 text-[11px] text-muted-foreground" style={{ fontWeight: 500 }}>Status</th>
                    <th className="text-left px-4 py-3 text-[11px] text-muted-foreground" style={{ fontWeight: 500 }}>Clinic</th>
                    <th className="text-center px-4 py-3 text-[11px] text-amber-600" style={{ fontWeight: 500 }}>Yellow (min)</th>
                    <th className="text-center px-4 py-3 text-[11px] text-red-600" style={{ fontWeight: 500 }}>Red (min)</th>
                    <th className="text-right px-4 py-3 text-[11px] text-muted-foreground" style={{ fontWeight: 500 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((t, i) => {
                    const clinic = t.clinicId ? mockClinics.find(c => c.id === t.clinicId) : null;
                    const edited = editedThreshold(t);
                    return (
                      <tr key={t.id} className={i < overrides.length - 1 ? "border-b border-gray-50" : ""}>
                        <td className="px-4 py-3"><span className="text-[13px]" style={{ fontWeight: 500 }}>{thresholdLabel(t)}</span></td>
                        <td className="px-4 py-3">
                          {clinic ? (
                            <Badge className="border-0 text-[10px] h-5" style={{ backgroundColor: `${clinic.color}15`, color: clinic.color }}>{clinic.name}</Badge>
                          ) : (
                            <Badge className="bg-gray-100 text-gray-600 border-0 text-[10px] h-5">All</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <NumberStepperControl
                            value={edited.yellow}
                            min={1}
                            className="w-[116px] mx-auto"
                            onChange={(nextValue) =>
                              setEditedByThresholdId((prev) => ({
                                ...prev,
                                [t.id]: { ...edited, yellow: nextValue },
                              }))
                            }
                          />
                        </td>
                        <td className="px-4 py-3 text-center">
                          <NumberStepperControl
                            value={edited.red}
                            min={1}
                            className="w-[116px] mx-auto"
                            onChange={(nextValue) =>
                              setEditedByThresholdId((prev) => ({
                                ...prev,
                                [t.id]: { ...edited, red: nextValue },
                              }))
                            }
                          />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setDeleteTarget({ id: t.id, name: `${thresholdLabel(t)} override for ${clinic?.shortCode || "clinic"}` })}
                              className="w-7 h-7 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          runAdminMutation(`${target.name} deleted`, async () => {
            await admin.deleteThreshold(target.id);
          }).catch(() => undefined);
        }}
        entityName={deleteTarget?.name || ""}
      />
    </div>
    </TabPanel>
  );
}

// ── Tab: Notifications ──
function NotificationsTab({
  onAddPolicy,
  onEditPolicy,
}: {
  onAddPolicy: () => void;
  onEditPolicy: (policy: NotificationPolicy) => void;
}) {
  const { notificationPolicies: mockNotificationPolicies, clinics: mockClinics, reloadAdminData } = useAdminConsoleData();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const enabledCount = mockNotificationPolicies.filter(p => p.enabled).length;

  return (
    <TabPanel accentColor="bg-rose-500">
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Policies" value={mockNotificationPolicies.length} icon={Bell} color="bg-rose-500" />
        <StatCard label="Enabled" value={enabledCount} icon={Activity} color="bg-emerald-500" />
        <StatCard label="Disabled" value={mockNotificationPolicies.length - enabledCount} icon={EyeOff} color="bg-gray-400" />
        <StatCard label="Channels" value={[...new Set(mockNotificationPolicies.flatMap(p => p.channels))].length} icon={Smartphone} color="bg-blue-500" />
      </div>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-rose-500 to-pink-400" />
        <CardContent className="p-5">
          <SectionHeader icon={Bell} title="Notification Policies" count={mockNotificationPolicies.length} actionLabel="Add Policy" onAction={onAddPolicy} iconColor="text-rose-500" />
          <p className="text-[12px] text-muted-foreground mb-4">Control who receives alerts, through which channels, with cooldown periods.</p>
          <div className="space-y-2">
            {mockNotificationPolicies.map((np) => {
              const clinic = mockClinics.find(c => c.id === np.clinicId);
              return (
                <div key={np.id} className={`rounded-lg border p-4 transition-colors ${np.enabled ? "border-gray-100 hover:border-gray-200" : "border-gray-100 bg-gray-50 opacity-70"}`}>
                  <div className="flex items-center gap-3 mb-3">
                    <Switch
                      checked={np.enabled}
                      onCheckedChange={(v) => toast.success(`Policy ${v ? "enabled" : "disabled"}`)}
                    />
                    <Badge className={`border-0 text-[10px] h-5 ${np.severity === "Red" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{np.severity}</Badge>
                    <span className="text-[13px]" style={{ fontWeight: 500 }}>{np.status.replace(/([A-Z])/g, " $1").trim()}</span>
                    {clinic && <Badge className="border-0 text-[10px] h-5" style={{ backgroundColor: `${clinic.color}15`, color: clinic.color }}>{clinic.shortCode}</Badge>}
                    {!np.enabled && <Badge className="bg-gray-200 text-gray-500 border-0 text-[9px] h-4">DISABLED</Badge>}
                    <span className="text-[11px] text-muted-foreground ml-auto flex items-center gap-1">
                      Cooldown: {np.cooldownMinutes}m
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="w-3 h-3 text-gray-400" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-[11px] max-w-[260px]">
                            Cooldown prevents duplicate notifications for the same trigger until the timer expires.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-[12px]">
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">Recipients:</span>
                      <div className="flex gap-1">{np.recipients.map(r => <Badge key={r} className="bg-indigo-50 text-indigo-600 border-0 text-[10px] h-5">{r}</Badge>)}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">Channels:</span>
                      <div className="flex gap-1">{np.channels.map(ch => (
                        <Badge key={ch} className="bg-gray-100 text-gray-600 border-0 text-[10px] h-5 flex items-center gap-1">
                          {ch === "sms" && <Smartphone className="w-2.5 h-2.5" />}
                          {ch === "email" && <Mail className="w-2.5 h-2.5" />}
                          {ch === "in_app" && <Bell className="w-2.5 h-2.5" />}
                          {channelLabel(ch)}
                        </Badge>
                      ))}</div>
                    </div>
                    {np.lastTriggered && (
                      <span className="text-[11px] text-muted-foreground">Last fired: {timeAgo(np.lastTriggered)}</span>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2 mt-3">
                    <button
                      onClick={async () => {
                        try {
                          const result = await admin.testNotificationPolicy(np.id);
                          const delivered = result.results.filter((entry) => entry.status === "sent");
                          const skipped = result.results.filter((entry) => entry.status === "skipped");
                          toast.success("Notification policy test completed", {
                            description: [
                              ...delivered.map((entry) => `${channelLabel(entry.channel)}: ${entry.recipientCount} recipient${entry.recipientCount === 1 ? "" : "s"}`),
                              ...skipped.map((entry) => `${channelLabel(entry.channel)}: ${entry.message}`),
                            ].join(" · "),
                          });
                          reloadAdminData().catch(() => undefined);
                          requestAdminRefresh();
                        } catch (error) {
                          toast.error("Notification policy test failed", {
                            description: (error as Error).message || "Unable to run notification test",
                          });
                        }
                      }}
                      className="h-7 px-3 rounded-lg border border-blue-200 text-[11px] text-blue-600 hover:bg-blue-50 transition-colors flex items-center gap-1"
                      style={{ fontWeight: 500 }}
                    >
                      <Bell className="w-3 h-3" /> Test
                    </button>
                    <button
                      onClick={() => onEditPolicy(np)}
                      className="w-7 h-7 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget({ id: np.id, name: `${np.severity} ${np.status} policy` })}
                      className="w-7 h-7 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          runAdminMutation(`${target.name} deleted`, async () => {
            await admin.deleteNotificationPolicy(target.id);
          }).catch(() => undefined);
        }}
        entityName={deleteTarget?.name || ""}
      />
    </div>
    </TabPanel>
  );
}

// ── Tab: Assignments ──
function AssignmentsTab() {
  const {
    facility,
    clinics: mockClinics,
    assignments: mockAssignments,
    maUsers,
    clinicianUsers,
    reloadAdminData,
  } = useAdminConsoleData();
  const [draftProviderByClinic, setDraftProviderByClinic] = useState<Record<string, string>>({});
  const [draftMaByClinic, setDraftMaByClinic] = useState<Record<string, string>>({});
  const [assignmentVersion, setAssignmentVersion] = useState(0);
  const [savingClinicId, setSavingClinicId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<TemporaryClinicAssignmentOverride[]>([]);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState({
    userId: "",
    role: "MA" as "MA" | "Clinician",
    clinicId: "",
    startsAt: "",
    endsAt: "",
    reason: "",
  });

  const loadOverrides = useCallback(async () => {
    setOverrideLoading(true);
    try {
      const rows = await admin.listAssignmentOverrides({ facilityId: facility.id, state: "all" });
      setOverrides(rows || []);
    } catch (error) {
      toast.error("Unable to load temporary coverage", {
        description: (error as Error).message || "Assignment overrides could not be loaded",
      });
    } finally {
      setOverrideLoading(false);
    }
  }, [facility.id]);

  useEffect(() => {
    loadOverrides().catch(() => undefined);
  }, [loadOverrides]);

  const assignmentRows = useMemo(() => {
    return mockClinics
      .filter((clinic) => clinic.status !== "archived")
      .map((clinic) => {
        const assignment = mockAssignments.find((entry) => entry.clinicId === clinic.id);
        return {
          clinicId: clinic.id,
          clinicName: clinic.name,
          clinicShortCode: clinic.shortCode,
          clinicColor: clinic.color,
          clinicStatus: clinic.status,
          maRun: clinic.maRun,
          providerUserId: assignment?.providerUserId || null,
          providerUserName: assignment?.providerUserName || null,
          providerUserStatus: assignment?.providerUserStatus || null,
          maUserId: assignment?.maUserId || null,
          maUserName: assignment?.maUserName || null,
          maUserStatus: assignment?.maUserStatus || null,
          roomCount: assignment?.roomCount ?? clinic.roomIds.length,
          isOperational: assignment?.isOperational || false,
        };
      })
      .sort((a, b) => a.clinicName.localeCompare(b.clinicName));
  }, [mockClinics, mockAssignments, assignmentVersion]);

  const availableMas = maUsers.filter((user) => String(user.status || "").toLowerCase() === "active");
  const availableProviders = clinicianUsers.filter((user) => String(user.status || "").toLowerCase() === "active");
  const overrideUsers = overrideDraft.role === "MA" ? availableMas : availableProviders;

  async function saveTemporaryOverride() {
    if (!overrideDraft.userId || !overrideDraft.clinicId || !overrideDraft.startsAt || !overrideDraft.endsAt || !overrideDraft.reason.trim()) {
      toast.error("Temporary coverage needs user, clinic, start/end, and reason");
      return;
    }
    const startsAt = new Date(overrideDraft.startsAt);
    const endsAt = new Date(overrideDraft.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      toast.error("Temporary coverage end must be after the start");
      return;
    }
    setOverrideSaving(true);
    try {
      await admin.createAssignmentOverride({
        userId: overrideDraft.userId,
        role: overrideDraft.role,
        clinicId: overrideDraft.clinicId,
        facilityId: facility.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: overrideDraft.reason.trim(),
      });
      toast.success("Temporary coverage added");
      setOverrideDraft({ userId: "", role: overrideDraft.role, clinicId: "", startsAt: "", endsAt: "", reason: "" });
      await loadOverrides();
      requestAdminRefresh();
    } catch (error) {
      toast.error("Unable to add temporary coverage", {
        description: (error as Error).message || "Please verify the user has the selected role in this facility.",
      });
    } finally {
      setOverrideSaving(false);
    }
  }

  async function revokeOverride(row: TemporaryClinicAssignmentOverride) {
    setSavingClinicId(row.id);
    try {
      await admin.revokeAssignmentOverride(row.id);
      toast.success("Temporary coverage revoked");
      await loadOverrides();
      requestAdminRefresh();
    } catch (error) {
      toast.error("Unable to revoke coverage", {
        description: (error as Error).message || "The temporary override could not be revoked.",
      });
    } finally {
      setSavingClinicId(null);
    }
  }

  return (
    <TabPanel accentColor="bg-cyan-500">
      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Clinics" value={assignmentRows.length} icon={Building2} color="bg-cyan-500" />
          <StatCard label="Operational" value={assignmentRows.filter((row) => row.isOperational).length} icon={Check} color="bg-emerald-500" />
          <StatCard
            label="Needs Assignment"
            value={assignmentRows.filter((row) => {
              const maReady = !!row.maUserId && row.maUserStatus === "active";
              const providerReady = row.maRun || (!!row.providerUserId && row.providerUserStatus === "active");
              return !maReady || !providerReady;
            }).length}
            icon={AlertTriangle}
            color="bg-amber-500"
          />
          <StatCard label="No Active Rooms" value={assignmentRows.filter((row) => row.roomCount <= 0).length} icon={DoorOpen} color="bg-rose-500" />
        </div>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-cyan-500 to-teal-400" />
          <CardContent className="p-5">
            <SectionHeader icon={Link2} title="Clinic Assignments" count={assignmentRows.length} iconColor="text-cyan-500" />
            <p className="text-[12px] text-muted-foreground mb-4">Assign one MA to every clinic and one provider for non-MA-run clinics.</p>
            <div className="space-y-2">
              {assignmentRows.map((row) => {
                const draftProviderId = draftProviderByClinic[row.clinicId] ?? row.providerUserId ?? "";
                const draftMaId = draftMaByClinic[row.clinicId] ?? row.maUserId ?? "";
                const providerRequired = !row.maRun;
                const isInactiveClinic = row.clinicStatus === "inactive";
                const providerIsInactive = !!row.providerUserId && row.providerUserStatus !== "active";
                const maIsInactive = !!row.maUserId && row.maUserStatus !== "active";

                return (
                  <div
                    key={row.clinicId}
                    className={`rounded-lg border p-3 transition-colors ${
                      isInactiveClinic
                        ? "border-amber-200 bg-amber-50/40"
                        : "border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: row.clinicColor }} />
                        <span className="text-[13px]" style={{ fontWeight: 600 }}>
                          {row.clinicName}
                        </span>
                      </div>
                      {row.clinicShortCode && (
                        <Badge
                          className="border-0 text-[10px] h-5"
                          style={{ backgroundColor: `${row.clinicColor}20`, color: row.clinicColor }}
                        >
                          {row.clinicShortCode}
                        </Badge>
                      )}
                      {row.maRun && <Badge className="bg-violet-100 text-violet-700 border-0 text-[10px] h-5">MA Run</Badge>}
                      {isInactiveClinic && (
                        <Badge className="border-0 text-[10px] h-5 bg-amber-100 text-amber-700 flex items-center gap-1">
                          <Power className="w-3 h-3" /> Inactive Clinic
                        </Badge>
                      )}
                      <Badge className={`border-0 text-[10px] h-5 ${row.isOperational ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                        {row.isOperational ? "Operational" : "Not Operational"}
                      </Badge>
                      {providerIsInactive && (
                        <Badge className="border-0 text-[10px] h-5 bg-red-100 text-red-700">Provider Inactive</Badge>
                      )}
                      {maIsInactive && (
                        <Badge className="border-0 text-[10px] h-5 bg-red-100 text-red-700">MA Inactive</Badge>
                      )}
                      <span className="text-[11px] text-muted-foreground">Rooms: {row.roomCount}</span>
                    </div>
                    <div className="mb-2 text-[11px] text-muted-foreground">
                      Provider: {row.maRun ? "Not required (MA Run)" : labelUserName(row.providerUserName || "", row.providerUserStatus) || "Unassigned"}
                      {" · "}
                      MA: {labelUserName(row.maUserName || "", row.maUserStatus) || "Unassigned"}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {!row.maRun && (
                        <div>
                          <label className="text-[11px] text-muted-foreground mb-1.5 block">Provider *</label>
                          <select
                            value={draftProviderId}
                            onChange={(event) =>
                              setDraftProviderByClinic((prev) => ({ ...prev, [row.clinicId]: event.target.value }))
                            }
                            className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                          >
                            <option value="">Select provider...</option>
                            {availableProviders.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div>
                        <label className="text-[11px] text-muted-foreground mb-1.5 block">MA *</label>
                        <select
                          value={draftMaId}
                          onChange={(event) =>
                            setDraftMaByClinic((prev) => ({ ...prev, [row.clinicId]: event.target.value }))
                          }
                          className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                        >
                          <option value="">Select MA...</option>
                          {availableMas.map((ma) => (
                            <option key={ma.id} value={ma.id}>
                              {ma.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-end">
                        <button
                          onClick={async () => {
                            if (!draftMaId) {
                              toast.error("MA assignment is required");
                              return;
                            }
                            if (providerRequired && !draftProviderId) {
                              toast.error("Provider assignment is required for this clinic");
                              return;
                            }
                            setSavingClinicId(row.clinicId);
                            try {
                              await admin.updateAssignment(row.clinicId, {
                                providerUserId: row.maRun ? null : (draftProviderId || null),
                                maUserId: draftMaId || null,
                              });
                              await reloadAdminData();
                              setAssignmentVersion((value) => value + 1);
                              toast.success(`${row.clinicName} assignment updated`);
                              requestAdminRefresh();
                            } catch (error) {
                              toast.error("Update failed", {
                                description: (error as Error).message || "Unable to update clinic assignment",
                              });
                            } finally {
                              setSavingClinicId(null);
                            }
                          }}
                          className="h-9 px-3 rounded-lg bg-cyan-600 text-white text-[12px] hover:bg-cyan-700 transition-colors"
                          style={{ fontWeight: 500 }}
                          disabled={savingClinicId === row.clinicId}
                        >
                          {savingClinicId === row.clinicId ? "Saving..." : "Save Assignment"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-blue-500 to-indigo-400" />
          <CardContent className="p-5">
            <SectionHeader icon={History} title="Temporary Coverage" count={overrides.length} iconColor="text-blue-500" />
            <p className="text-[12px] text-muted-foreground mb-4">
              Grant a time-bounded clinic assignment for an MA or clinician without changing their permanent clinic.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-6 gap-3 rounded-xl border border-blue-100 bg-blue-50/40 p-3 mb-4">
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Role</label>
                <select
                  value={overrideDraft.role}
                  onChange={(event) =>
                    setOverrideDraft((current) => ({ ...current, role: event.target.value as "MA" | "Clinician", userId: "" }))
                  }
                  className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                >
                  <option value="MA">MA</option>
                  <option value="Clinician">Clinician</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">User</label>
                <select
                  value={overrideDraft.userId}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, userId: event.target.value }))}
                  className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                >
                  <option value="">Select user...</option>
                  {overrideUsers.map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Clinic</label>
                <select
                  value={overrideDraft.clinicId}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, clinicId: event.target.value }))}
                  className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                >
                  <option value="">Select clinic...</option>
                  {assignmentRows.filter((row) => row.clinicStatus === "active").map((row) => (
                    <option key={row.clinicId} value={row.clinicId}>{row.clinicName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Starts</label>
                <input
                  type="datetime-local"
                  value={overrideDraft.startsAt}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, startsAt: event.target.value }))}
                  className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Ends</label>
                <input
                  type="datetime-local"
                  value={overrideDraft.endsAt}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, endsAt: event.target.value }))}
                  className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Reason</label>
                <input
                  value={overrideDraft.reason}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, reason: event.target.value }))}
                  className="h-9 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                  placeholder="Coverage reason"
                />
              </div>
              <div className="lg:col-span-6 flex justify-end">
                <button
                  onClick={() => saveTemporaryOverride().catch(() => undefined)}
                  disabled={overrideSaving}
                  className="h-9 px-4 rounded-lg bg-blue-600 text-white text-[12px] hover:bg-blue-700 transition-colors disabled:opacity-50"
                  style={{ fontWeight: 600 }}
                >
                  {overrideSaving ? "Adding..." : "Add Temporary Coverage"}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {overrideLoading ? (
                <div className="text-[12px] text-muted-foreground">Loading temporary coverage...</div>
              ) : overrides.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 p-4 text-[12px] text-muted-foreground">
                  No temporary coverage rules have been added.
                </div>
              ) : (
                overrides.map((row) => (
                  <div key={row.id} className="rounded-lg border border-gray-100 p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px]" style={{ fontWeight: 700 }}>{row.userName}</span>
                        <Badge className="border-0 bg-blue-100 text-blue-700 text-[10px] h-5">{row.role}</Badge>
                        <Badge className={`border-0 text-[10px] h-5 ${row.state === "active" ? "bg-emerald-100 text-emerald-700" : row.state === "upcoming" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}>{row.state}</Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {row.clinicName} · {formatDateTime(row.startsAt)} to {formatDateTime(row.endsAt)}
                      </div>
                      <div className="text-[11px] text-gray-600 mt-1">{row.reason}</div>
                    </div>
                    {!row.revokedAt && row.state !== "expired" && (
                      <button
                        onClick={() => revokeOverride(row).catch(() => undefined)}
                        disabled={savingClinicId === row.id}
                        className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50"
                      >
                        {savingClinicId === row.id ? "Revoking..." : "Revoke"}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </TabPanel>
  );
}

function IncomingIntegrationsTab({ selectedFacilityId }: { selectedFacilityId: string }) {
  const { clinics: mockClinics } = useAdminConsoleData();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dateOfService, setDateOfService] = useState(todayIsoDate());
  const [selectedClinicId, setSelectedClinicId] = useState("");
  const [source, setSource] = useState<"manual" | "csv" | "fhir" | "ehr">("csv");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [pendingIssues, setPendingIssues] = useState<any[]>([]);
  const [reference, setReference] = useState<any | null>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [editingPendingId, setEditingPendingId] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<{
    clinicId: string;
    patientId: string;
    dateOfService: string;
    appointmentTime: string;
    providerLastName: string;
    reasonText: string;
  }>({
    clinicId: "",
    patientId: "",
    dateOfService: "",
    appointmentTime: "",
    providerLastName: "",
    reasonText: "",
  });
  const [retryingPendingId, setRetryingPendingId] = useState<string | null>(null);
  const [athenaEnabled, setAthenaEnabled] = useState(false);
  const [athenaConfig, setAthenaConfig] = useState<{
    baseUrl: string;
    practiceId: string;
    departmentIds: string;
    authType: "none" | "api_key" | "basic" | "oauth2";
    username: string;
    password: string;
    apiKey: string;
    apiKeyHeader: string;
    apiKeyPrefix: string;
    clientId: string;
    clientSecret: string;
    timeoutMs: number;
    retryCount: number;
    retryBackoffMs: number;
    testPath: string;
    previewPath: string;
  }>({
    baseUrl: "",
    practiceId: "",
    departmentIds: "",
    authType: "none",
    username: "",
    password: "",
    apiKey: "",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer",
    clientId: "",
    clientSecret: "",
    timeoutMs: 7000,
    retryCount: 2,
    retryBackoffMs: 400,
    testPath: "/",
    previewPath: "/",
  });
  const [athenaSecretsConfigured, setAthenaSecretsConfigured] = useState<{
    password: boolean;
    apiKey: boolean;
    clientSecret: boolean;
    accessToken: boolean;
    refreshToken: boolean;
  }>({
    password: false,
    apiKey: false,
    clientSecret: false,
    accessToken: false,
    refreshToken: false,
  });
  const [athenaMapping, setAthenaMapping] = useState<Record<string, string>>({
    patientId: "patientId",
    appointmentTime: "appointmentTime",
    providerLastName: "providerLastName",
    reasonForVisit: "reasonForVisit",
    clinic: "clinic",
  });
  const [athenaStatus, setAthenaStatus] = useState<{
    lastTestStatus?: string | null;
    lastTestAt?: string | null;
    lastTestMessage?: string | null;
    lastSyncStatus?: string | null;
    lastSyncAt?: string | null;
    lastSyncMessage?: string | null;
  }>({});
  const [savingAthena, setSavingAthena] = useState(false);
  const [testingAthena, setTestingAthena] = useState(false);
  const [syncPreviewingAthena, setSyncPreviewingAthena] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [rowDraft, setRowDraft] = useState<{
    patientId: string;
    dateOfService: string;
    appointmentTime: string;
    providerLastName: string;
    reasonText: string;
  }>({
    patientId: "",
    dateOfService: "",
    appointmentTime: "",
    providerLastName: "",
    reasonText: "",
  });
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [dispositionRowId, setDispositionRowId] = useState<string | null>(null);
  const [dispositionReason, setDispositionReason] = useState<IncomingDispositionReason>("no_show");
  const [dispositionNote, setDispositionNote] = useState("");
  const [disposingRowId, setDisposingRowId] = useState<string | null>(null);

  const activeClinics = useMemo(
    () =>
      mockClinics
        .filter((clinic) => clinic.status === "active")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [mockClinics],
  );

  const pendingFieldErrors = (errors: string[]) => {
    const map: Record<"clinicId" | "patientId" | "dateOfService" | "appointmentTime" | "providerLastName" | "reasonText", string[]> = {
      clinicId: [],
      patientId: [],
      dateOfService: [],
      appointmentTime: [],
      providerLastName: [],
      reasonText: [],
    };
    errors.forEach((raw) => {
      const msg = String(raw || "");
      const normalized = msg.toLowerCase();
      if (normalized.includes("clinic")) map.clinicId.push(msg);
      else if (normalized.includes("patient")) map.patientId.push(msg);
      else if (normalized.includes("date") || normalized.includes("service day") || normalized.includes("past")) map.dateOfService.push(msg);
      else if (normalized.includes("appointment") || normalized.includes("time")) map.appointmentTime.push(msg);
      else if (normalized.includes("provider")) map.providerLastName.push(msg);
      else if (normalized.includes("reason") || normalized.includes("visit")) map.reasonText.push(msg);
    });
    return map;
  };

  useEffect(() => {
    if (selectedClinicId && !activeClinics.some((clinic) => clinic.id === selectedClinicId)) {
      setSelectedClinicId("");
    }
  }, [activeClinics, selectedClinicId]);

  const refreshSchedule = async () => {
    setLoading(true);
    setReferenceLoading(true);
    try {
      const [incomingRows, importBatches, pendingRows, referencePayload, athenaConnector] = await Promise.all([
        incomingApi.list({
          clinicId: selectedClinicId || undefined,
          date: dateOfService,
          includeCheckedIn: true,
          includeInvalid: true,
        }),
        incomingApi.listBatches({
          clinicId: selectedClinicId || undefined,
          date: dateOfService,
        }),
        incomingApi.listPending({
          facilityId: selectedFacilityId,
          clinicId: selectedClinicId || undefined,
          date: dateOfService,
        }),
        incomingApi.reference({
          facilityId: selectedFacilityId,
          clinicId: selectedClinicId || undefined,
        }),
        admin.getAthenaOneConnector(selectedFacilityId),
      ]);
      setRows(incomingRows as any[]);
      setBatches(importBatches as any[]);
      setPendingIssues(pendingRows as any[]);
      setReference(referencePayload);
      const connectorConfig = (athenaConnector as any)?.config || {};
      const secretState = (connectorConfig as any)?.secretsConfigured || {};
      setAthenaEnabled(Boolean((athenaConnector as any)?.enabled));
      setAthenaConfig({
        baseUrl: String(connectorConfig.baseUrl || ""),
        practiceId: String(connectorConfig.practiceId || ""),
        departmentIds: Array.isArray(connectorConfig.departmentIds)
          ? connectorConfig.departmentIds.join(", ")
          : String(connectorConfig.departmentIds || ""),
        authType: (["none", "api_key", "basic", "oauth2"].includes(String(connectorConfig.authType))
          ? String(connectorConfig.authType)
          : "none") as "none" | "api_key" | "basic" | "oauth2",
        username: String(connectorConfig.username || ""),
        password: String(connectorConfig.password || ""),
        apiKey: String(connectorConfig.apiKey || ""),
        apiKeyHeader: String(connectorConfig.apiKeyHeader || "Authorization"),
        apiKeyPrefix: String(connectorConfig.apiKeyPrefix || "Bearer"),
        clientId: String(connectorConfig.clientId || ""),
        clientSecret: String(connectorConfig.clientSecret || ""),
        timeoutMs: Number(connectorConfig.timeoutMs || 7000),
        retryCount: Number(connectorConfig.retryCount || 2),
        retryBackoffMs: Number(connectorConfig.retryBackoffMs || 400),
        testPath: String(connectorConfig.testPath || "/"),
        previewPath: String(connectorConfig.previewPath || "/"),
      });
      setAthenaSecretsConfigured({
        password: Boolean(secretState.password),
        apiKey: Boolean(secretState.apiKey),
        clientSecret: Boolean(secretState.clientSecret),
        accessToken: Boolean(secretState.accessToken),
        refreshToken: Boolean(secretState.refreshToken),
      });
      setAthenaMapping(
        typeof (athenaConnector as any)?.mapping === "object" && (athenaConnector as any)?.mapping
          ? ((athenaConnector as any).mapping as Record<string, string>)
          : {
              patientId: "patientId",
              appointmentTime: "appointmentTime",
              providerLastName: "providerLastName",
              reasonForVisit: "reasonForVisit",
              clinic: "clinic",
            },
      );
      setAthenaStatus({
        lastTestStatus: (athenaConnector as any)?.lastTestStatus || null,
        lastTestAt: (athenaConnector as any)?.lastTestAt || null,
        lastTestMessage: (athenaConnector as any)?.lastTestMessage || null,
        lastSyncStatus: (athenaConnector as any)?.lastSyncStatus || null,
        lastSyncAt: (athenaConnector as any)?.lastSyncAt || null,
        lastSyncMessage: (athenaConnector as any)?.lastSyncMessage || null,
      });
    } catch (error) {
      toast.error("Failed to load incoming schedule", {
        description: (error as Error).message || "Unable to load incoming schedule data",
      });
    } finally {
      setLoading(false);
      setReferenceLoading(false);
    }
  };

  useEffect(() => {
    refreshSchedule().catch(() => undefined);
  }, [dateOfService, selectedClinicId, selectedFacilityId]);

  useEffect(() => {
    const onRefresh = () => {
      refreshSchedule().catch(() => undefined);
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
  }, [dateOfService, selectedClinicId, selectedFacilityId]);

  const validCount = rows.filter((row) => row.isValid).length;
  const invalidCount = pendingIssues.length;
  const checkedInCount = rows.filter((row) => Boolean(row.checkedInAt)).length;

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    const content = await selected.text();
    setFileName(selected.name);
    setCsvText(content);
    if (event.target) {
      event.target.value = "";
    }
    toast.success(`Loaded ${selected.name}`, {
      description: "Review or edit the data below, then import.",
    });
  };

  const submitImport = async () => {
    const normalized = normalizeScheduleImportText(csvText);
    if (!normalized) {
      toast.error("Paste or upload schedule data first");
      return;
    }

    setImporting(true);
    try {
      const created = await incomingApi.importSchedule({
        clinicId: selectedClinicId || undefined,
        facilityId: selectedFacilityId,
        dateOfService,
        csvText: normalized,
        fileName: fileName || undefined,
        source,
      });

      if (created.acceptedCount === 0 && created.pendingCount > 0) {
        toast.warning("No rows were accepted", {
          description: `${created.pendingCount} row${created.pendingCount === 1 ? "" : "s"} moved to Pending Review for correction.`,
        });
      } else {
        toast.success(
          `Accepted ${created.acceptedCount} schedule row${created.acceptedCount === 1 ? "" : "s"}`,
          {
            description:
              created.pendingCount > 0
                ? `${created.pendingCount} row${created.pendingCount === 1 ? "" : "s"} moved to Pending Review.`
                : "Incoming patient schedule has been updated for the selected day.",
          },
        );
      }

      if (created.acceptedCount > 0) {
        setCsvText("");
        setFileName("");
      }
      requestAdminRefresh();
      await refreshSchedule();
    } catch (error) {
      toast.error("Schedule import failed", {
        description: (error as Error).message || "Unable to import incoming schedule",
      });
    } finally {
      setImporting(false);
    }
  };

  const startRowEdit = (row: any) => {
    setEditingRowId(row.id);
    setDispositionRowId((current) => (current === row.id ? null : current));
    setRowDraft({
      patientId: String(row.patientId || ""),
      dateOfService: String(row.dateOfService || "").slice(0, 10),
      appointmentTime: String(row.appointmentTime || ""),
      providerLastName: String(row.providerLastName || row.provider?.name || ""),
      reasonText: String(row.reasonText || row.reason?.name || ""),
    });
  };

  const cancelRowEdit = () => {
    setEditingRowId(null);
    setRowDraft({
      patientId: "",
      dateOfService: "",
      appointmentTime: "",
      providerLastName: "",
      reasonText: "",
    });
  };

  const saveRowEdit = async () => {
    if (!editingRowId) return;
    const patientId = rowDraft.patientId.trim();
    if (!patientId) {
      toast.error("Patient ID is required");
      return;
    }

    setSavingRowId(editingRowId);
    try {
      const updated = await incomingApi.updateRow(editingRowId, {
        patientId,
        dateOfService: rowDraft.dateOfService.trim() || undefined,
        appointmentTime: rowDraft.appointmentTime.trim() || null,
        providerLastName: rowDraft.providerLastName.trim() || null,
        reasonText: rowDraft.reasonText.trim() || null,
      });

      setRows((prev) => prev.map((row) => (row.id === editingRowId ? { ...row, ...updated } : row)));
      toast.success("Incoming row updated");
      cancelRowEdit();
      requestAdminRefresh();
      await refreshSchedule();
    } catch (error) {
      toast.error("Unable to update incoming row", {
        description: (error as Error).message || "Please review row values and try again",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  const startDisposition = (row: any) => {
    setDispositionRowId(row.id);
    setEditingRowId((current) => (current === row.id ? null : current));
    setDispositionReason("no_show");
    setDispositionNote("");
  };

  const cancelDisposition = () => {
    setDispositionRowId(null);
    setDispositionReason("no_show");
    setDispositionNote("");
  };

  const submitDisposition = async () => {
    if (!dispositionRowId) return;
    setDisposingRowId(dispositionRowId);
    try {
      const response = await incomingApi.dispositionRow(dispositionRowId, {
        reason: dispositionReason,
        note: dispositionNote.trim() || undefined,
      });
      toast.success("Incoming row dispositioned", {
        description: `Encounter ${response.encounterId} closed as ${incomingDispositionLabel(response.closureType)}.`,
      });

      setRows((prev) =>
        prev.map((row) =>
          row.id === dispositionRowId
            ? {
                ...row,
                dispositionAt: new Date().toISOString(),
                dispositionType: dispositionReason,
                dispositionNote: dispositionNote.trim() || null,
                dispositionEncounterId: response.encounterId,
              }
            : row,
        ),
      );
      cancelDisposition();
      requestAdminRefresh();
      await refreshSchedule();
    } catch (error) {
      toast.error("Unable to disposition incoming row", {
        description: (error as Error).message || "Please review and try again",
      });
    } finally {
      setDisposingRowId(null);
    }
  };

  const startPendingEdit = (issue: any) => {
    const normalized = (issue.normalizedJson || {}) as Record<string, unknown>;
    setEditingPendingId(issue.id);
    setPendingDraft({
      clinicId: String(issue.clinicId || normalized.clinicId || ""),
      patientId: String(normalized.patientId || issue.rawPayloadJson?.patientId || ""),
      dateOfService: String(
        normalized.dateOfService ||
          issue.rawPayloadJson?.appointmentDate ||
          issue.rawPayloadJson?.apptDate ||
          issue.rawPayloadJson?.date ||
          issue.rawPayloadJson?.serviceDate ||
          issue.rawPayloadJson?.dos ||
          issue.dateOfService ||
          "",
      ).slice(0, 10),
      appointmentTime: String(normalized.appointmentTime || issue.rawPayloadJson?.appointmentTime || ""),
      providerLastName: String(normalized.providerLastName || issue.rawPayloadJson?.providerLastName || issue.rawPayloadJson?.providerName || ""),
      reasonText: String(normalized.reasonText || issue.rawPayloadJson?.reasonForVisit || issue.rawPayloadJson?.reason || ""),
    });
  };

  const cancelPendingEdit = () => {
    setEditingPendingId(null);
    setPendingDraft({
      clinicId: "",
      patientId: "",
      dateOfService: "",
      appointmentTime: "",
      providerLastName: "",
      reasonText: "",
    });
  };

  const retryPendingIssue = async (issueId: string) => {
    setRetryingPendingId(issueId);
    try {
      const result = await incomingApi.retryPending(issueId, {
        clinicId: pendingDraft.clinicId || undefined,
        patientId: pendingDraft.patientId || undefined,
        dateOfService: pendingDraft.dateOfService || undefined,
        appointmentTime: pendingDraft.appointmentTime || null,
        providerLastName: pendingDraft.providerLastName || null,
        reasonText: pendingDraft.reasonText || null,
      });
      if (result.status === "accepted") {
        toast.success("Pending row accepted and moved into day schedule.");
      } else {
        toast.error("Pending row still has validation errors.");
      }
      cancelPendingEdit();
      requestAdminRefresh();
      await refreshSchedule();
    } catch (error) {
      toast.error("Retry failed", {
        description: (error as Error).message || "Unable to retry pending row",
      });
    } finally {
      setRetryingPendingId(null);
    }
  };

  const saveAthenaConfig = async () => {
    setSavingAthena(true);
    try {
      await admin.upsertAthenaOneConnector({
        facilityId: selectedFacilityId,
        enabled: athenaEnabled,
        config: {
          baseUrl: athenaConfig.baseUrl.trim(),
          practiceId: athenaConfig.practiceId.trim(),
          departmentIds: athenaConfig.departmentIds
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          authType: athenaConfig.authType,
          username: athenaConfig.username.trim(),
          password: athenaConfig.password,
          apiKey: athenaConfig.apiKey,
          apiKeyHeader: athenaConfig.apiKeyHeader.trim(),
          apiKeyPrefix: athenaConfig.apiKeyPrefix.trim(),
          clientId: athenaConfig.clientId.trim(),
          clientSecret: athenaConfig.clientSecret,
          timeoutMs: athenaConfig.timeoutMs,
          retryCount: athenaConfig.retryCount,
          retryBackoffMs: athenaConfig.retryBackoffMs,
          testPath: athenaConfig.testPath.trim() || "/",
          previewPath: athenaConfig.previewPath.trim() || "/",
        },
        mapping: athenaMapping,
      });
      toast.success("AthenaOne connector settings saved");
      await refreshSchedule();
    } catch (error) {
      toast.error("Unable to save AthenaOne settings", {
        description: (error as Error).message || "Save failed",
      });
    } finally {
      setSavingAthena(false);
    }
  };

  const testAthenaConfig = async () => {
    setTestingAthena(true);
    try {
      const result = await admin.testAthenaOneConnector({
        facilityId: selectedFacilityId,
        enabled: athenaEnabled,
        config: {
          baseUrl: athenaConfig.baseUrl.trim(),
          practiceId: athenaConfig.practiceId.trim(),
          departmentIds: athenaConfig.departmentIds
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          authType: athenaConfig.authType,
          username: athenaConfig.username.trim(),
          password: athenaConfig.password,
          apiKey: athenaConfig.apiKey,
          apiKeyHeader: athenaConfig.apiKeyHeader.trim(),
          apiKeyPrefix: athenaConfig.apiKeyPrefix.trim(),
          clientId: athenaConfig.clientId.trim(),
          clientSecret: athenaConfig.clientSecret,
          timeoutMs: athenaConfig.timeoutMs,
          retryCount: athenaConfig.retryCount,
          retryBackoffMs: athenaConfig.retryBackoffMs,
          testPath: athenaConfig.testPath.trim() || "/",
          previewPath: athenaConfig.previewPath.trim() || "/",
        },
        mapping: athenaMapping,
      });
      toast[result.ok ? "success" : "error"](result.message);
      await refreshSchedule();
    } catch (error) {
      toast.error("AthenaOne connection test failed", {
        description: (error as Error).message || "Unable to run connection test",
      });
    } finally {
      setTestingAthena(false);
    }
  };

  const previewAthenaSync = async () => {
    setSyncPreviewingAthena(true);
    try {
      const preview = await admin.athenaOneSyncPreview({
        facilityId: selectedFacilityId,
        clinicId: selectedClinicId || undefined,
        dateOfService,
      });
      if (preview.ok) {
        toast.success(`Sync preview returned ${preview.rowCount} row${preview.rowCount === 1 ? "" : "s"}.`);
      } else {
        toast.error(preview.message || "Sync preview failed");
      }
      await refreshSchedule();
    } catch (error) {
      toast.error("AthenaOne sync preview failed", {
        description: (error as Error).message || "Unable to preview sync",
      });
    } finally {
      setSyncPreviewingAthena(false);
    }
  };

  return (
    <TabPanel accentColor="bg-sky-500">
      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Rows Loaded" value={rows.length} icon={FileText} color="bg-sky-500" />
          <StatCard label="Valid Rows" value={validCount} icon={Check} color="bg-emerald-500" />
          <StatCard label="Needs Review" value={invalidCount} icon={AlertTriangle} color="bg-amber-500" />
          <StatCard label="Checked In" value={checkedInCount} icon={Activity} color="bg-violet-500" />
        </div>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-sky-500 to-cyan-400" />
          <CardContent className="p-5 space-y-4">
            <SectionHeader
              icon={Upload}
              title="Incoming Patient Upload & EHR Integrations"
              iconColor="text-sky-500"
              secondaryAction={
                <button
                  onClick={() => refreshSchedule().catch(() => undefined)}
                  className="h-8 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                  style={{ fontWeight: 500 }}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
                </button>
              }
            />
            <p className="text-[12px] text-muted-foreground">
              Upload CSV files, paste copied schedule grids, or import EHR/FHIR feed exports into the day’s incoming schedule.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Date of Service</label>
                <input
                  type="date"
                  value={dateOfService}
                  onChange={(event) => setDateOfService(event.target.value)}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Clinic Scope</label>
                <select
                  value={selectedClinicId}
                  onChange={(event) => setSelectedClinicId(event.target.value)}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                >
                  <option value="">Auto-detect from CSV clinic column</option>
                  {activeClinics.map((clinic) => (
                    <option key={clinic.id} value={clinic.id}>
                      {clinic.name} ({clinic.shortCode})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Import Source</label>
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value as "manual" | "csv" | "fhir" | "ehr")}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                >
                  <option value="csv">CSV Upload</option>
                  <option value="manual">Manual Copy/Paste</option>
                  <option value="ehr">EHR Integration Feed</option>
                  <option value="fhir">FHIR Integration Feed</option>
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px] text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                  style={{ fontWeight: 500 }}
                >
                  <Upload className="w-3.5 h-3.5" /> Upload CSV
                </button>
                <button
                  onClick={() => setCsvText("")}
                  className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px] text-gray-700 hover:bg-gray-50 transition-colors"
                  style={{ fontWeight: 500 }}
                  disabled={!csvText.trim()}
                >
                  Clear
                </button>
                {fileName && (
                  <Badge className="bg-sky-100 text-sky-700 border-0 text-[10px] h-5">
                    {fileName}
                  </Badge>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv,.txt"
                className="hidden"
                onChange={handleFileImport}
              />
              <textarea
                value={csvText}
                onChange={(event) => setCsvText(event.target.value)}
                rows={9}
                className="mt-3 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[12px] font-mono focus:outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                placeholder={[
                  "clinic,patientId,appointmentDate,appointmentTime,providerLastName,reasonForVisit",
                  "Downtown Clinic (DT),PT-1045,2026-03-06,08:30,Chen,Follow-up",
                  "ES,PT-2046,2026-03-07,09:15,Patel,Sick Visit",
                ].join("\n")}
              />
              <div className="mt-2 space-y-2">
                <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-[11px] text-sky-800">
                  <span style={{ fontWeight: 700 }}>Expected column order:</span>{" "}
                  clinic, patientId, appointmentDate, appointmentTime, providerLastName, reasonForVisit
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Required headers and accepted aliases:
                </div>
                <div className="flex flex-wrap gap-2">
                  {(reference?.requiredHeaders || []).map((header: any) => (
                    <Tooltip key={header.key}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="h-6 px-2 rounded-md border border-sky-200 bg-sky-50 text-sky-700 text-[10px] hover:bg-sky-100 transition-colors"
                          style={{ fontWeight: 600 }}
                        >
                          {header.key}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="text-[11px] max-w-[280px] space-y-1">
                          <div style={{ fontWeight: 600 }}>{header.label}</div>
                          <div>Format: {header.format}</div>
                          <div>Aliases: {(header.aliases || []).join(", ")}</div>
                          <div>Required: {header.required ? "Yes" : "No"}</div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Live examples:
                  {" "}
                  Clinics: {(reference?.samples?.clinics || []).slice(0, 4).map((clinic: any) => {
                    const aliases = Array.isArray(clinic.aliases) ? clinic.aliases.filter(Boolean) : [];
                    const preferredAlias = aliases.find((entry) => String(entry).includes("(")) || aliases[0];
                    return preferredAlias || (clinic.shortCode ? `${clinic.name} (${clinic.shortCode})` : clinic.name);
                  }).join(", ") || "—"}
                  {" · "}
                  Providers: {(reference?.samples?.providerLastNames || []).slice(0, 6).join(", ") || "—"}
                  {" · "}
                  Reasons: {(reference?.samples?.reasonNames || []).slice(0, 6).join(", ") || "—"}
                  {referenceLoading ? " · Loading..." : ""}
                </div>
                {Array.isArray(reference?.samples?.clinics) && reference.samples.clinics.length > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    Accepted clinic aliases:
                    {" "}
                    {reference.samples.clinics
                      .slice(0, 3)
                      .map((clinic: any) => {
                        const aliases = Array.isArray(clinic.aliases) ? clinic.aliases.filter(Boolean).slice(0, 3) : [];
                        return aliases.length > 0 ? aliases.join(" / ") : clinic.name;
                      })
                      .join(" · ")}
                  </div>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => submitImport().catch(() => undefined)}
                  className="h-9 px-4 rounded-lg bg-sky-600 text-white text-[12px] hover:bg-sky-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  style={{ fontWeight: 500 }}
                  disabled={importing || !csvText.trim() || !dateOfService}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  {importing ? "Importing..." : "Import to Day Schedule"}
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-400" />
          <CardContent className="p-5 space-y-4">
            <SectionHeader icon={Link2} title="AthenaOne Connector (Config + Sync Hooks)" iconColor="text-indigo-500" />
            <p className="text-[12px] text-muted-foreground">
              Configure facility-level AthenaOne integration settings, validate connector shape, and run non-destructive sync preview hooks.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Base URL</label>
                <input
                  type="text"
                  value={athenaConfig.baseUrl}
                  onChange={(event) => setAthenaConfig((prev) => ({ ...prev, baseUrl: event.target.value }))}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                  placeholder="https://api.athenahealth.com"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Practice ID</label>
                <input
                  type="text"
                  value={athenaConfig.practiceId}
                  onChange={(event) => setAthenaConfig((prev) => ({ ...prev, practiceId: event.target.value }))}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                  placeholder="Practice identifier"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Department IDs (comma-separated)</label>
                <input
                  type="text"
                  value={athenaConfig.departmentIds}
                  onChange={(event) => setAthenaConfig((prev) => ({ ...prev, departmentIds: event.target.value }))}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                  placeholder="1001, 1002"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Auth Type</label>
                <select
                  value={athenaConfig.authType}
                  onChange={(event) =>
                    setAthenaConfig((prev) => ({
                      ...prev,
                      authType: (event.target.value as "none" | "api_key" | "basic" | "oauth2"),
                    }))
                  }
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                >
                  <option value="none">None</option>
                  <option value="api_key">API Key</option>
                  <option value="basic">Basic</option>
                  <option value="oauth2">OAuth2</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Username</label>
                <input
                  type="text"
                  value={athenaConfig.username}
                  onChange={(event) => setAthenaConfig((prev) => ({ ...prev, username: event.target.value }))}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Password</label>
                <input
                  type="password"
                  value={athenaConfig.password}
                  onChange={(event) => setAthenaConfig((prev) => ({ ...prev, password: event.target.value }))}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                />
                <div className="text-[10px] text-muted-foreground mt-1">
                  Saved in vault: {athenaSecretsConfigured.password ? "Yes" : "No"}
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">API Key</label>
                <input
                  type="password"
                  value={athenaConfig.apiKey}
                  onChange={(event) => setAthenaConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
                  className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                />
                <div className="text-[10px] text-muted-foreground mt-1">
                  Saved in vault: {athenaSecretsConfigured.apiKey ? "Yes" : "No"}
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Client ID / Secret</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={athenaConfig.clientId}
                    onChange={(event) => setAthenaConfig((prev) => ({ ...prev, clientId: event.target.value }))}
                    className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                    placeholder="Client ID"
                  />
                  <input
                    type="password"
                    value={athenaConfig.clientSecret}
                    onChange={(event) => setAthenaConfig((prev) => ({ ...prev, clientSecret: event.target.value }))}
                    className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                    placeholder="Client Secret"
                  />
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Saved in vault: {athenaSecretsConfigured.clientSecret ? "Yes" : "No"}
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">API Key Header / Prefix</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={athenaConfig.apiKeyHeader}
                    onChange={(event) => setAthenaConfig((prev) => ({ ...prev, apiKeyHeader: event.target.value }))}
                    className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                    placeholder="Authorization"
                  />
                  <input
                    type="text"
                    value={athenaConfig.apiKeyPrefix}
                    onChange={(event) => setAthenaConfig((prev) => ({ ...prev, apiKeyPrefix: event.target.value }))}
                    className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                    placeholder="Bearer"
                  />
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Timeout / Retry</label>
                <div className="grid grid-cols-3 gap-2">
                  <NumberStepperControl
                    value={athenaConfig.timeoutMs}
                    min={500}
                    step={250}
                    onChange={(nextValue) => setAthenaConfig((prev) => ({ ...prev, timeoutMs: nextValue }))}
                    className="h-9"
                  />
                  <NumberStepperControl
                    value={athenaConfig.retryCount}
                    min={0}
                    onChange={(nextValue) => setAthenaConfig((prev) => ({ ...prev, retryCount: nextValue }))}
                    className="h-9"
                  />
                  <NumberStepperControl
                    value={athenaConfig.retryBackoffMs}
                    min={0}
                    step={100}
                    onChange={(nextValue) => setAthenaConfig((prev) => ({ ...prev, retryBackoffMs: nextValue }))}
                    className="h-9"
                  />
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block">Test Path / Preview Path</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={athenaConfig.testPath}
                    onChange={(event) => setAthenaConfig((prev) => ({ ...prev, testPath: event.target.value }))}
                    className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                    placeholder="/"
                  />
                  <input
                    type="text"
                    value={athenaConfig.previewPath}
                    onChange={(event) => setAthenaConfig((prev) => ({ ...prev, previewPath: event.target.value }))}
                    className="h-9 w-full px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
                    placeholder="/"
                  />
                </div>
              </div>
            </div>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={athenaEnabled}
                onChange={(event) => setAthenaEnabled(event.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600"
              />
              Enable AthenaOne connector for this facility
            </label>
            <div className="text-[11px] text-muted-foreground">
              Last test: {athenaStatus.lastTestStatus || "—"} {athenaStatus.lastTestAt ? `· ${formatDateTime(athenaStatus.lastTestAt)}` : ""}
              {athenaStatus.lastTestMessage ? ` · ${athenaStatus.lastTestMessage}` : ""}
              <br />
              Last preview sync: {athenaStatus.lastSyncStatus || "—"} {athenaStatus.lastSyncAt ? `· ${formatDateTime(athenaStatus.lastSyncAt)}` : ""}
              {athenaStatus.lastSyncMessage ? ` · ${athenaStatus.lastSyncMessage}` : ""}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => saveAthenaConfig().catch(() => undefined)}
                className="h-9 px-3 rounded-lg bg-indigo-600 text-white text-[12px] hover:bg-indigo-700 transition-colors"
                style={{ fontWeight: 500 }}
                disabled={savingAthena}
              >
                {savingAthena ? "Saving..." : "Save Connector"}
              </button>
              <button
                onClick={() => testAthenaConfig().catch(() => undefined)}
                className="h-9 px-3 rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 text-[12px] hover:bg-indigo-100 transition-colors"
                style={{ fontWeight: 500 }}
                disabled={testingAthena}
              >
                {testingAthena ? "Testing..." : "Test Connection"}
              </button>
              <button
                onClick={() => previewAthenaSync().catch(() => undefined)}
                className="h-9 px-3 rounded-lg border border-violet-200 text-violet-700 bg-violet-50 text-[12px] hover:bg-violet-100 transition-colors"
                style={{ fontWeight: 500 }}
                disabled={syncPreviewingAthena}
              >
                {syncPreviewingAthena ? "Previewing..." : "Sync Preview"}
              </button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-cyan-500 to-sky-400" />
          <CardContent className="p-5">
            <SectionHeader icon={Clock} title="Day Schedule Rows" count={rows.length} iconColor="text-cyan-500" />
            {rows.length === 0 ? (
              <EmptyState icon={FileText} message="No incoming schedule rows found for the selected date." />
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {rows.map((row) => {
                  const validationErrors = Array.isArray(row.validationErrors)
                    ? row.validationErrors.join("; ")
                    : "";
                  const isFinalized = Boolean(row.checkedInAt || row.dispositionAt);
                  const isEditing = editingRowId === row.id;
                  const isDispositioning = dispositionRowId === row.id;
                  return (
                    <div key={row.id} className="rounded-lg border border-gray-100 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px]" style={{ fontWeight: 600 }}>
                          {row.patientId}
                        </span>
                        <Badge className="bg-gray-100 text-gray-600 border-0 text-[10px] h-5">
                          {row.appointmentTime || "No time"}
                        </Badge>
                        {row.clinic?.shortCode && (
                          <Badge className="bg-sky-100 text-sky-700 border-0 text-[10px] h-5">
                            {row.clinic.shortCode}
                          </Badge>
                        )}
                        <Badge
                          className={`border-0 text-[10px] h-5 ${
                            row.isValid ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {row.isValid ? "Valid" : "Needs Review"}
                        </Badge>
                        {row.checkedInAt && <Badge className="bg-violet-100 text-violet-700 border-0 text-[10px] h-5">Checked In</Badge>}
                        {row.dispositionAt && (
                          <Badge className="bg-gray-200 text-gray-700 border-0 text-[10px] h-5">
                            Dispositioned
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1.5">
                        {String(row.dateOfService || "").slice(0, 10) || "No date"} · {row.appointmentTime || "No time"} · Provider: {row.providerLastName || row.provider?.name || "—"} · Visit Reason: {row.reasonText || row.reason?.name || "—"}
                      </div>
                      {row.checkedInAt && (
                        <div className="text-[11px] text-violet-700 mt-1">
                          Checked in at {formatDateTime(row.checkedInAt)}
                        </div>
                      )}
                      {row.dispositionAt && (
                        <div className="text-[11px] text-gray-600 mt-1">
                          Disposition: {incomingDispositionLabel(row.dispositionType || "other")} · {formatDateTime(row.dispositionAt)}
                          {row.dispositionNote ? ` · ${row.dispositionNote}` : ""}
                        </div>
                      )}
                      {!row.isValid && validationErrors && (
                        <div className="text-[11px] text-amber-700 mt-1.5">
                          {validationErrors}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {!isFinalized && (
                          <>
                            <button
                              onClick={() => (isEditing ? cancelRowEdit() : startRowEdit(row))}
                              className="h-7 px-2.5 rounded-lg border border-gray-200 bg-white text-[11px] text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-1"
                              style={{ fontWeight: 500 }}
                              disabled={Boolean(savingRowId) || Boolean(disposingRowId)}
                            >
                              <Pencil className="w-3 h-3" />
                              {isEditing ? "Cancel Edit" : "Edit Row"}
                            </button>
                            <button
                              onClick={() => (isDispositioning ? cancelDisposition() : startDisposition(row))}
                              className="h-7 px-2.5 rounded-lg border border-amber-200 bg-amber-50 text-[11px] text-amber-700 hover:bg-amber-100 transition-colors"
                              style={{ fontWeight: 500 }}
                              disabled={Boolean(savingRowId) || Boolean(disposingRowId)}
                            >
                              {isDispositioning ? "Cancel Disposition" : "Disposition"}
                            </button>
                          </>
                        )}
                        {isFinalized && (
                          <span className="text-[11px] text-muted-foreground">
                            Row is finalized and cannot be edited.
                          </span>
                        )}
                      </div>

                      {isEditing && (
                        <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50/60 p-3 space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Patient ID</label>
                              <input
                                type="text"
                                value={rowDraft.patientId}
                                onChange={(event) =>
                                  setRowDraft((prev) => ({ ...prev, patientId: event.target.value }))
                                }
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Appointment Time</label>
                              <input
                                type="text"
                                value={rowDraft.appointmentTime}
                                onChange={(event) =>
                                  setRowDraft((prev) => ({ ...prev, appointmentTime: event.target.value }))
                                }
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                                placeholder="HH:mm"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Appointment Date</label>
                              <input
                                type="date"
                                value={rowDraft.dateOfService}
                                onChange={(event) =>
                                  setRowDraft((prev) => ({ ...prev, dateOfService: event.target.value }))
                                }
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Provider Last Name</label>
                              <input
                                type="text"
                                value={rowDraft.providerLastName}
                                onChange={(event) =>
                                  setRowDraft((prev) => ({ ...prev, providerLastName: event.target.value }))
                                }
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Visit Reason</label>
                              <input
                                type="text"
                                value={rowDraft.reasonText}
                                onChange={(event) =>
                                  setRowDraft((prev) => ({ ...prev, reasonText: event.target.value }))
                                }
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                              />
                            </div>
                          </div>
                          <button
                            onClick={() => saveRowEdit().catch(() => undefined)}
                            className="h-8 px-3 rounded-lg bg-sky-600 text-white text-[11px] hover:bg-sky-700 transition-colors"
                            style={{ fontWeight: 500 }}
                            disabled={savingRowId === row.id}
                          >
                            {savingRowId === row.id ? "Saving..." : "Save Row"}
                          </button>
                        </div>
                      )}

                      {isDispositioning && (
                        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Disposition Reason</label>
                              <select
                                value={dispositionReason}
                                onChange={(event) => setDispositionReason(event.target.value as IncomingDispositionReason)}
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                              >
                                {incomingDispositionReasons.map((reason) => (
                                  <option key={reason} value={reason}>
                                    {incomingDispositionLabel(reason)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Note (Optional)</label>
                              <input
                                type="text"
                                value={dispositionNote}
                                onChange={(event) => setDispositionNote(event.target.value)}
                                className="h-8 w-full px-2.5 rounded-lg border border-gray-200 bg-white text-[12px]"
                                placeholder="Add disposition note"
                              />
                            </div>
                          </div>
                          <button
                            onClick={() => submitDisposition().catch(() => undefined)}
                            className="h-8 px-3 rounded-lg bg-amber-600 text-white text-[11px] hover:bg-amber-700 transition-colors"
                            style={{ fontWeight: 500 }}
                            disabled={disposingRowId === row.id}
                          >
                            {disposingRowId === row.id ? "Saving..." : "Save Disposition"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-amber-500 to-orange-400" />
          <CardContent className="p-5">
            <SectionHeader icon={AlertTriangle} title="Pending Review" count={pendingIssues.length} iconColor="text-amber-500" />
            {pendingIssues.length === 0 ? (
              <EmptyState icon={Check} message="No pending rows. All imports are accepted." />
            ) : (
              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                {pendingIssues.map((issue) => {
                  const errors = Array.isArray(issue.validationErrors) ? issue.validationErrors : [];
                  const fieldErrors = pendingFieldErrors(errors);
                  const isEditing = editingPendingId === issue.id;
                  return (
                    <div key={issue.id} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge className="bg-amber-100 text-amber-700 border-0 text-[10px] h-5">Pending</Badge>
                        <span className="text-[12px]" style={{ fontWeight: 500 }}>
                          {issue.clinic?.name || "Unresolved clinic"}
                        </span>
                        {issue.batch?.fileName && (
                          <span className="text-[11px] text-muted-foreground">· {issue.batch.fileName}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-amber-800">
                        {errors.join("; ") || "Validation mismatch"}
                      </div>
                      {!isEditing ? (
                        <button
                          onClick={() => startPendingEdit(issue)}
                          className="mt-2 h-7 px-2.5 rounded-lg border border-amber-300 bg-white text-[11px] text-amber-700 hover:bg-amber-100 transition-colors"
                          style={{ fontWeight: 500 }}
                        >
                          Edit & Retry
                        </button>
                      ) : (
                        <div className="mt-2 rounded-lg border border-amber-200 bg-white p-3 space-y-2">
                          <p className="text-[11px] text-amber-800">
                            Correct highlighted fields and retry. Valid values stay pre-filled.
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Clinic</label>
                              <select
                                value={pendingDraft.clinicId}
                                onChange={(event) => setPendingDraft((prev) => ({ ...prev, clinicId: event.target.value }))}
                                className={`h-8 w-full px-2.5 rounded-lg bg-white text-[12px] ${
                                  fieldErrors.clinicId.length > 0 ? "border border-red-300" : "border border-gray-200"
                                }`}
                              >
                                <option value="">Select clinic...</option>
                                {activeClinics.map((clinic) => (
                                  <option key={clinic.id} value={clinic.id}>
                                    {clinic.name} ({clinic.shortCode})
                                  </option>
                                ))}
                              </select>
                              {fieldErrors.clinicId.length > 0 && (
                                <p className="text-[10px] text-red-600 mt-1">{fieldErrors.clinicId[0]}</p>
                              )}
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Patient ID</label>
                              <input
                                type="text"
                                value={pendingDraft.patientId}
                                onChange={(event) => setPendingDraft((prev) => ({ ...prev, patientId: event.target.value }))}
                                className={`h-8 w-full px-2.5 rounded-lg bg-white text-[12px] ${
                                  fieldErrors.patientId.length > 0 ? "border border-red-300" : "border border-gray-200"
                                }`}
                              />
                              {fieldErrors.patientId.length > 0 && (
                                <p className="text-[10px] text-red-600 mt-1">{fieldErrors.patientId[0]}</p>
                              )}
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Appointment Date</label>
                              <input
                                type="date"
                                value={pendingDraft.dateOfService}
                                onChange={(event) => setPendingDraft((prev) => ({ ...prev, dateOfService: event.target.value }))}
                                className={`h-8 w-full px-2.5 rounded-lg bg-white text-[12px] ${
                                  fieldErrors.dateOfService.length > 0 ? "border border-red-300" : "border border-gray-200"
                                }`}
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">
                                Use today or a future date in YYYY-MM-DD format.
                              </p>
                              {fieldErrors.dateOfService.length > 0 && (
                                <p className="text-[10px] text-red-600 mt-1">{fieldErrors.dateOfService[0]}</p>
                              )}
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Appointment Time</label>
                              <input
                                type="text"
                                value={pendingDraft.appointmentTime}
                                onChange={(event) => setPendingDraft((prev) => ({ ...prev, appointmentTime: event.target.value }))}
                                className={`h-8 w-full px-2.5 rounded-lg bg-white text-[12px] ${
                                  fieldErrors.appointmentTime.length > 0 ? "border border-red-300" : "border border-gray-200"
                                }`}
                                placeholder="HH:mm"
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">
                                Expected format: HH:mm. Example: 08:30
                              </p>
                              {fieldErrors.appointmentTime.length > 0 && (
                                <p className="text-[10px] text-red-600 mt-1">{fieldErrors.appointmentTime[0]}</p>
                              )}
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-1">Provider Last Name</label>
                              <input
                                type="text"
                                value={pendingDraft.providerLastName}
                                onChange={(event) => setPendingDraft((prev) => ({ ...prev, providerLastName: event.target.value }))}
                                className={`h-8 w-full px-2.5 rounded-lg bg-white text-[12px] ${
                                  fieldErrors.providerLastName.length > 0 ? "border border-red-300" : "border border-gray-200"
                                }`}
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">
                                Known clinician last names: {(reference?.samples?.providerLastNames || []).slice(0, 4).join(", ") || "—"}
                              </p>
                              {fieldErrors.providerLastName.length > 0 && (
                                <p className="text-[10px] text-red-600 mt-1">{fieldErrors.providerLastName[0]}</p>
                              )}
                            </div>
                            <div className="sm:col-span-2">
                              <label className="text-[10px] text-muted-foreground block mb-1">Visit Reason</label>
                              <input
                                type="text"
                                value={pendingDraft.reasonText}
                                onChange={(event) => setPendingDraft((prev) => ({ ...prev, reasonText: event.target.value }))}
                                className={`h-8 w-full px-2.5 rounded-lg bg-white text-[12px] ${
                                  fieldErrors.reasonText.length > 0 ? "border border-red-300" : "border border-gray-200"
                                }`}
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">
                                Known reasons: {(reference?.samples?.reasonNames || []).slice(0, 4).join(", ") || "—"}
                              </p>
                              {fieldErrors.reasonText.length > 0 && (
                                <p className="text-[10px] text-red-600 mt-1">{fieldErrors.reasonText[0]}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => retryPendingIssue(issue.id).catch(() => undefined)}
                              className="h-8 px-3 rounded-lg bg-amber-600 text-white text-[11px] hover:bg-amber-700 transition-colors"
                              style={{ fontWeight: 500 }}
                              disabled={retryingPendingId === issue.id}
                            >
                              {retryingPendingId === issue.id ? "Retrying..." : "Retry Row"}
                            </button>
                            <button
                              onClick={cancelPendingEdit}
                              className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 transition-colors"
                              style={{ fontWeight: 500 }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-indigo-500 to-blue-400" />
          <CardContent className="p-5">
            <SectionHeader icon={History} title="Import Batches" count={batches.length} iconColor="text-indigo-500" />
            {batches.length === 0 ? (
              <EmptyState icon={History} message="No import batches for the selected day." />
            ) : (
              <div className="space-y-2">
                {batches.map((batch) => (
                  <div key={batch.id} className="rounded-lg border border-gray-100 p-3 flex flex-wrap items-center gap-2">
                    <Badge className="bg-indigo-100 text-indigo-700 border-0 text-[10px] h-5 uppercase">
                      {batch.source}
                    </Badge>
                    <span className="text-[12px]" style={{ fontWeight: 500 }}>
                      {batch.rowCount} rows
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatDateTime(batch.createdAt)}
                    </span>
                    {batch.fileName && (
                      <span className="text-[11px] text-muted-foreground">
                        · {batch.fileName}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TabPanel>
  );
}

// ── Tab: Audit Log ──
function AuditLogTab() {
  const { auditLog: mockAuditLog } = useAdminConsoleData();
  const [filterEntity, setFilterEntity] = useState("all");
  const entities = [...new Set(mockAuditLog.map(a => a.entity))];

  const filtered = filterEntity === "all" ? mockAuditLog : mockAuditLog.filter(a => a.entity === filterEntity);

  const actionColor = (action: string) => {
    switch (action) {
      case "Created": return "bg-emerald-100 text-emerald-700";
      case "Updated": return "bg-blue-100 text-blue-700";
      case "Deleted": return "bg-red-100 text-red-700";
      case "Deactivated": return "bg-amber-100 text-amber-700";
      default: return "bg-gray-100 text-gray-600";
    }
  };

  return (
    <TabPanel accentColor="bg-gray-500">
    <Card className="border-0 shadow-sm overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-gray-500 to-slate-400" />
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <History className="w-4.5 h-4.5 text-gray-500" />
            <span className="text-[14px]" style={{ fontWeight: 600 }}>Audit Log</span>
            <Badge className="bg-gray-100 text-gray-600 border-0 text-[10px] px-1.5 h-5">{filtered.length}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <select value={filterEntity} onChange={e => setFilterEntity(e.target.value)} className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]">
              <option value="all">All Entities</option>
              {entities.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
            <button onClick={() => toast.info("Exporting audit log...")} className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors" style={{ fontWeight: 500 }}>
              <Download className="w-3.5 h-3.5" /> Export
            </button>
          </div>
        </div>
        <p className="text-[12px] text-muted-foreground mb-4">Track all configuration changes made to the system.</p>
        {filtered.length === 0 ? (
          <EmptyState icon={History} message="No audit entries yet." />
        ) : (
          <div className="space-y-1">
            {filtered.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-gray-100 p-3 flex items-center gap-3 hover:border-gray-200 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                  <History className="w-3.5 h-3.5 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge className={`border-0 text-[10px] h-5 ${actionColor(entry.action)}`}>{entry.action}</Badge>
                    <span className="text-[12px]" style={{ fontWeight: 500 }}>{entry.entity}</span>
                    <span className="text-[12px] text-muted-foreground">"{entry.entityName}"</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    by {entry.user} &middot; {new Date(entry.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
    </TabPanel>
  );
}

// ── Modal type state ──
type ModalType = null | "facility" | "clinic" | "user" | "room" | "reason" | "template" | "threshold" | "notification";

// ── Main Admin Console ──
export function AdminConsole() {
  const [activeTab, setActiveTab] = useState("facility");
  const [openModal, setOpenModal] = useState<ModalType>(null);
  const [editingClinic, setEditingClinic] = useState<Clinic | null>(null);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [editingReason, setEditingReason] = useState<Reason | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [editingNotification, setEditingNotification] = useState<NotificationPolicy | null>(null);
  const [selectedFacilityId, setSelectedFacilityId] = useState("");
  const [facility, setFacility] = useState<Facility>(fallbackFacility);
  const [facilityOptions, setFacilityOptions] = useState<Facility[]>([fallbackFacility]);
  const [clinics, setClinics] = useState<Clinic[]>(fallbackClinics);
  const [users, setUsers] = useState<AdminUser[]>(fallbackUsers);
  const [rooms, setRooms] = useState<Room[]>(fallbackRooms);
  const [reasons, setReasons] = useState<Reason[]>(fallbackReasons);
  const [templates, setTemplates] = useState<Template[]>(fallbackTemplates);
  const [thresholds, setThresholds] = useState<Threshold[]>(fallbackThresholds);
  const [notificationPolicies, setNotificationPolicies] = useState<NotificationPolicy[]>(fallbackNotificationPolicies);
  const [assignments, setAssignments] = useState<ClinicAssignment[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>(fallbackAuditLog);
  const [lastSyncIso, setLastSyncIso] = useState<string | null>(null);
  const { encounters: liveEncounters, isLiveMode, syncError } = useEncounters();
  const loadAdminDataRef = useRef<() => Promise<void>>(async () => undefined);
  const reloadAdminData = useCallback(async () => {
    await loadAdminDataRef.current();
  }, []);
  const maUsers = useMemo(
    () => users.filter((user) => user.roles.some((role) => role.role === "MA")),
    [users],
  );
  const clinicianUsers = useMemo(
    () => users.filter((user) => user.roles.some((role) => role.role === "Clinician")),
    [users],
  );
  const close = () => {
    setOpenModal(null);
    setEditingClinic(null);
    setEditingRoom(null);
    setEditingReason(null);
    setEditingTemplate(null);
    setEditingNotification(null);
  };

  const requireActiveFacilityId = () => {
    const activeId =
      (isUuid(selectedFacilityId) ? selectedFacilityId : "") ||
      (isUuid(facility.id) ? facility.id : "");
    if (!activeId) {
      throw new Error("Select and save an active facility before saving changes.");
    }
    return activeId;
  };
  const activeFacilityId =
    (isUuid(selectedFacilityId) ? selectedFacilityId : "") ||
    (isUuid(facility.id) ? facility.id : "");

  const setFacilitySession = async (facilityId: string) => {
    await auth.setActiveFacility(facilityId);
    const session = loadSession();
    if (session) {
      const updated = { ...session, facilityId };
      saveSession(updated);
      applySession(updated);
    }
    setSelectedFacilityId(facilityId);
    await reloadAdminData();
    dispatchFacilityContextChanged();
    requestAdminRefresh();
  };

  const createFacility = async (payload: { name: string; shortCode: string; address?: string; phone?: string; timezone: string }) => {
    await admin.createFacility({
      name: payload.name,
      shortCode: payload.shortCode || undefined,
      address: payload.address || undefined,
      phone: payload.phone || undefined,
      timezone: payload.timezone,
    });
    await reloadAdminData();
    toast.success("Facility created. Use Change Active Facility to switch.");
    requestAdminRefresh();
  };

  const createClinic = async (payload: {
    name: string;
    shortCode: string;
    cardColor: string;
    roomIds: string[];
    maRun: boolean;
  }) => {
    const facilityId = requireActiveFacilityId();
    await admin.createClinic({
      facilityId,
      name: payload.name,
      shortCode: payload.shortCode,
      cardColor: payload.cardColor,
      roomIds: payload.roomIds,
      maRun: payload.maRun,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const updateClinicDetails = async (payload: {
    name: string;
    shortCode: string;
    cardColor: string;
    roomIds: string[];
    maRun: boolean;
  }) => {
    if (!editingClinic) {
      throw new Error("Clinic to edit was not found.");
    }
    await admin.updateClinic(editingClinic.id, {
      name: payload.name,
      shortCode: payload.shortCode,
      cardColor: payload.cardColor,
      roomIds: payload.roomIds,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const createUser = async (payload: {
    objectId: string;
    email: string;
    displayName: string;
    role: string;
    facilityIds: string[];
  }) => {
    await admin.provisionUser({
      objectId: payload.objectId,
      role: payload.role as any,
      facilityIds: payload.facilityIds,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const searchDirectoryUsers = async (query: string) => {
    return admin.searchDirectoryUsers(query);
  };

  const createRoom = async (payload: { name: string; roomType: string }) => {
    const facilityId = requireActiveFacilityId();
    await admin.createRoom({
      facilityId,
      name: payload.name,
      roomType: payload.roomType,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const updateRoomDetails = async (payload: { name: string; roomType: string }) => {
    if (!editingRoom) {
      throw new Error("Room to edit was not found.");
    }
    await admin.updateRoom(editingRoom.id, {
      name: payload.name,
      roomType: payload.roomType,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const createReason = async (payload: { name: string; appointmentLengthMinutes: number; clinicIds: string[] }) => {
    const facilityId = requireActiveFacilityId();
    await admin.createReason({
      facilityId,
      name: payload.name,
      appointmentLengthMinutes: payload.appointmentLengthMinutes,
      clinicIds: payload.clinicIds,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const updateReasonDetails = async (payload: { name: string; appointmentLengthMinutes: number; clinicIds: string[] }) => {
    if (!editingReason) {
      throw new Error("Visit reason to edit was not found.");
    }
    await admin.updateReason(editingReason.id, {
      name: payload.name,
      appointmentLengthMinutes: payload.appointmentLengthMinutes,
      clinicIds: payload.clinicIds,
      status: editingReason.status === "archived" ? "inactive" : editingReason.status,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const createTemplate = async (payload: {
    name: string;
    type: string;
    status: "active" | "inactive";
    reasonIds: string[];
    fields: TemplateFieldDefinition[];
  }) => {
    const facilityId = requireActiveFacilityId();
    await admin.createTemplate({
      facilityId,
      name: payload.name,
      type: payload.type,
      status: payload.status,
      reasonIds: payload.reasonIds,
      fields: payload.fields,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const updateTemplateDetails = async (payload: {
    name: string;
    type: string;
    status: "active" | "inactive";
    reasonIds: string[];
    fields: TemplateFieldDefinition[];
  }) => {
    const facilityId = requireActiveFacilityId();
    if (!editingTemplate) {
      throw new Error("Template to edit was not found.");
    }
    await admin.updateTemplate(editingTemplate.id, {
      facilityId,
      name: payload.name,
      type: payload.type,
      status: payload.status,
      reasonIds: payload.reasonIds,
      fields: payload.fields,
    });
    await reloadAdminData();
    requestAdminRefresh();
  };

  const createThreshold = async (payload: {
    metric: "stage" | "overall_visit";
    status?: string;
    clinicId?: string;
    yellowMinutes: number;
    redMinutes: number;
  }) => {
    const facilityId = requireActiveFacilityId();
    await admin.createThreshold({
      facilityId,
      clinicId: payload.clinicId || null,
      metric: payload.metric,
      status: payload.metric === "stage" ? (payload.status as any) : null,
      yellowAtMin: payload.yellowMinutes,
      redAtMin: payload.redMinutes,
    } as any);
    await reloadAdminData();
    requestAdminRefresh();
  };

  const createNotificationPolicy = async (payload: { clinicId: string; status: string; severity: string; recipients: string[]; channels: string[]; cooldownMinutes: number }) => {
    await admin.createNotificationPolicy({
      clinicId: payload.clinicId,
      status: payload.status as any,
      severity: payload.severity as any,
      recipients: payload.recipients as any[],
      channels: payload.channels as any[],
      cooldownMinutes: payload.cooldownMinutes,
      ackRequired: false,
    } as any);
    await reloadAdminData();
    requestAdminRefresh();
  };

  const updateNotificationPolicy = async (payload: { clinicId: string; status: string; severity: string; recipients: string[]; channels: string[]; cooldownMinutes: number }) => {
    if (!editingNotification) {
      throw new Error("Notification policy to edit was not found.");
    }
    await admin.updateNotificationPolicy(editingNotification.id, {
      clinicId: payload.clinicId,
      status: payload.status as any,
      severity: payload.severity as any,
      recipients: payload.recipients as any[],
      channels: payload.channels as any[],
      cooldownMinutes: payload.cooldownMinutes,
      ackRequired: false,
    } as any);
    await reloadAdminData();
    requestAdminRefresh();
  };


  useEffect(() => {
    let mounted = true;

    const loadAdminData = async () => {
      try {
        const [authContext, facilityRows] = await Promise.all([auth.getContext(), admin.listFacilities()]);
        if (!mounted) return;

        const scopedFacilities = (facilityRows as any[]).map((row) => ({
          id: row.id,
          name: row.name,
          shortCode: row.shortCode || undefined,
          timezone: row.timezone || fallbackFacility.timezone,
          status: row.status || "active",
          address: row.address || fallbackFacility.address,
          phone: row.phone || fallbackFacility.phone,
        })) as Facility[];

        const nextFacilityOptions = scopedFacilities.length > 0 ? scopedFacilities : [fallbackFacility];
        setFacilityOptions(nextFacilityOptions);
        const selectableFacilityIds = new Set(nextFacilityOptions.map((row) => row.id));

        let activeFacilityId =
          (selectedFacilityId && selectableFacilityIds.has(selectedFacilityId) ? selectedFacilityId : undefined) ||
          (authContext.activeFacilityId && selectableFacilityIds.has(authContext.activeFacilityId) ? authContext.activeFacilityId : undefined) ||
          nextFacilityOptions[0]?.id ||
          fallbackFacility.id;

        if (!selectedFacilityId || selectedFacilityId !== activeFacilityId) {
          setSelectedFacilityId(activeFacilityId);
        }

        const [
          clinicRowsResult,
          roomRowsResult,
          reasonRowsResult,
          templateRowsResult,
          thresholdRowsResult,
          notificationRowsResult,
          userRowsResult,
          assignmentRowsResult,
          auditRowsResult,
        ] = await Promise.allSettled([
          admin.listClinics({ facilityId: activeFacilityId, includeInactive: true, includeArchived: true }),
          admin.listRooms({ facilityId: activeFacilityId, includeInactive: true, includeArchived: true }),
          admin.listReasons({ facilityId: activeFacilityId, includeInactive: true, includeArchived: true }),
          admin.listTemplates({ facilityId: activeFacilityId, includeInactive: true, includeArchived: true }),
          admin.listThresholds(activeFacilityId),
          admin.listNotificationPolicies(activeFacilityId),
          admin.listUsers(activeFacilityId),
          admin.listAssignments(activeFacilityId),
          events.listAudit({ limit: 200, facilityId: activeFacilityId }),
        ]);

        if (!mounted) return;

        const activeFacility = nextFacilityOptions.find((row) => row.id === activeFacilityId) || nextFacilityOptions[0] || fallbackFacility;
        setFacility({
          id: activeFacility.id,
          name: activeFacility.name,
          shortCode: activeFacility.shortCode || fallbackFacility.shortCode,
          address: activeFacility.address || fallbackFacility.address,
          phone: activeFacility.phone || fallbackFacility.phone,
          timezone: activeFacility.timezone || fallbackFacility.timezone,
          status: activeFacility.status || "active",
        });

        const activeRoomNameSet = new Set(
          liveEncounters
            .filter((encounter) => encounter.status !== "Optimized" && encounter.roomNumber)
            .map((encounter) => encounter.roomNumber),
        );

        if (roomRowsResult.status === "fulfilled") {
          const roomRowsSafe = (roomRowsResult.value as any[]).map((room) => ({
            id: room.id,
            facilityId: room.facilityId,
            name: room.name,
            roomNumber: Number(room.roomNumber ?? room.sortOrder ?? 0),
            roomType: String(room.roomType || "exam"),
            status: (room.status || (room.active === false ? "inactive" : "active")) as "active" | "inactive" | "archived",
            encounterCount: Number(room.encounterCount || 0),
            clinicIds: Array.isArray(room.clinicIds) ? room.clinicIds : [],
          }));
          setRooms(
            roomRowsSafe
              .map((room) => ({
                id: room.id,
                facilityId: room.facilityId,
                name: room.name,
                roomNumber: room.roomNumber,
                roomType: room.roomType,
                status: room.status,
                clinicIds: room.clinicIds,
                encounterCount: room.encounterCount,
                occupied: activeRoomNameSet.has(room.name),
              }))
              .sort((a, b) => a.roomNumber - b.roomNumber),
          );
        }

        if (clinicRowsResult.status === "fulfilled") {
          const clinicRowsSafe = clinicRowsResult.value as any[];
          const roomRowsSafe =
            roomRowsResult.status === "fulfilled"
              ? (roomRowsResult.value as any[]).map((room) => ({
                  id: room.id,
                  clinicIds: Array.isArray(room.clinicIds) ? room.clinicIds : [],
                }))
              : [];
          setClinics(
            clinicRowsSafe.map((clinic) => ({
              id: clinic.id,
              name: clinic.name,
              shortCode: clinic.shortCode || clinic.name.slice(0, 2).toUpperCase(),
              maRun: clinic.maRun ?? true,
              status: clinic.status || "active",
              color: clinic.cardColor || colorFromText(clinic.name || clinic.id),
              roomIds: Array.isArray(clinic.roomIds)
                ? clinic.roomIds
                : roomRowsSafe
                    .filter((room) => room.clinicIds.includes(clinic.id))
                    .map((room) => room.id),
              providerCount: Number(clinic.staffing?.providerCount || 0),
            })),
          );
        }

        if (userRowsResult.status === "fulfilled") {
          setUsers(
            (userRowsResult.value as any[]).map((user) => {
              const parsed = splitUserDisplayName(String(user.name || ""));
              return {
                id: user.id,
                name: user.name,
                firstName: parsed.firstName || undefined,
                lastName: parsed.lastName || undefined,
                credential: parsed.credential || undefined,
                email: user.email,
                status: user.status || "active",
                phone: user.phone || undefined,
                entraObjectId: user.entraObjectId || null,
                entraTenantId: user.entraTenantId || null,
                entraUserPrincipalName: user.entraUserPrincipalName || null,
                identityProvider: user.identityProvider || null,
                directoryStatus: user.directoryStatus || null,
                directoryUserType: user.directoryUserType || null,
                directoryAccountEnabled:
                  typeof user.directoryAccountEnabled === "boolean" ? user.directoryAccountEnabled : null,
                lastDirectorySyncAt: user.lastDirectorySyncAt || null,
                lastLogin: user.updatedAt || user.createdAt || new Date().toISOString(),
                createdAt: String(user.createdAt || new Date().toISOString()).slice(0, 10),
                activeFacilityId: user.activeFacilityId || null,
                roles: Array.isArray(user.roles)
                  ? user.roles.map((role: any) => ({
                      role: role.role,
                      clinicId: role.clinicId,
                      facilityId: role.facilityId,
                    }))
                  : [],
              };
            }),
          );
        }

        if (assignmentRowsResult.status === "fulfilled") {
          setAssignments(
            (assignmentRowsResult.value as any[]).map((row) => ({
              id: row.id || null,
              clinicId: row.clinicId,
              clinicName: row.clinicName,
              clinicShortCode: row.clinicShortCode || null,
              clinicStatus: row.clinicStatus || "active",
              maRun: Boolean(row.maRun),
              providerUserId: row.providerUserId || null,
              providerUserName: labelUserName(row.providerUserName || null, row.providerUserStatus || null) || null,
              providerUserStatus: row.providerUserStatus || null,
              maUserId: row.maUserId || null,
              maUserName: labelUserName(row.maUserName || null, row.maUserStatus || null) || null,
              maUserStatus: row.maUserStatus || null,
              roomCount: Number(row.roomCount || 0),
              isOperational: Boolean(row.isOperational),
            })),
          );
        }

        if (reasonRowsResult.status === "fulfilled" || templateRowsResult.status === "fulfilled") {
          const templateRowsSafe = templateRowsResult.status === "fulfilled" ? (templateRowsResult.value as any[]) : [];
          const templateCountByReason = new Map<string, number>();
          templateRowsSafe.forEach((template) => {
            const mappedReasonIds: string[] = Array.isArray(template.reasonIds)
              ? template.reasonIds
              : template.reasonForVisitId
                ? [template.reasonForVisitId]
                : [];
            mappedReasonIds.forEach((reasonId) => {
              templateCountByReason.set(reasonId, (templateCountByReason.get(reasonId) || 0) + 1);
            });
          });

          if (reasonRowsResult.status === "fulfilled") {
            setReasons(
              (reasonRowsResult.value as any[]).map((reason) => ({
                id: reason.id,
                facilityId: reason.facilityId,
                name: reason.name,
                appointmentLengthMinutes: Number(reason.appointmentLengthMinutes || reason.durationMinutes || 20),
                status:
                  reason.status ||
                  (reason.active === false ? "inactive" : "active"),
                clinicIds: Array.isArray(reason.clinicIds)
                  ? reason.clinicIds
                  : reason.clinicId
                    ? [reason.clinicId]
                    : [],
                active: (reason.status || (reason.active === false ? "inactive" : "active")) === "active",
                code: reason.code || reasonCodeFromName(reason.name),
                templateCount: templateCountByReason.get(reason.id) || 0,
              })),
            );
          }

          if (templateRowsResult.status === "fulfilled") {
            setTemplates(
              templateRowsSafe.map((template) => ({
                id: template.id,
                facilityId: template.facilityId,
                name: template.name || "Template",
                type: template.type === "intake" ? "checkin" : template.type,
                status: template.status || (template.active === false ? "inactive" : "active"),
                reasonIds: Array.isArray(template.reasonIds)
                  ? template.reasonIds
                  : template.reasonForVisitId
                    ? [template.reasonForVisitId]
                    : [],
                fields: deriveTemplateFieldsFromSchema(template),
                active: (template.status || (template.active === false ? "inactive" : "active")) === "active",
                jsonSchema: (template.jsonSchema || {}) as Record<string, any>,
                uiSchema: (template.uiSchema || {}) as Record<string, any>,
                requiredFields: Array.isArray(template.requiredFields) ? template.requiredFields : [],
                createdAt: template.createdAt,
                updatedAt: template.updatedAt,
              })),
            );
          }
        }

        if (thresholdRowsResult.status === "fulfilled") {
          setThresholds(
            (thresholdRowsResult.value as any[]).map((threshold) => ({
              id: threshold.id,
              facilityId: threshold.facilityId || activeFacilityId,
              clinicId: threshold.clinicId || null,
              metric: threshold.metric === "overall_visit" ? "overall_visit" : "stage",
              status: threshold.status || null,
              yellowMinutes: Number(threshold.yellowAtMin ?? threshold.yellowMinutes ?? 0),
              redMinutes: Number(threshold.redAtMin ?? threshold.redMinutes ?? 0),
              isOverride: Boolean(threshold.clinicId),
            })),
          );
        }

        if (notificationRowsResult.status === "fulfilled") {
          setNotificationPolicies(
            (notificationRowsResult.value as any[]).map((policy) => ({
              id: policy.id,
              clinicId: policy.clinicId,
              status: policy.status,
              severity: policy.severity,
              recipients: Array.isArray(policy.recipients)
                ? policy.recipients
                : Array.isArray(policy.recipientsJson)
                  ? policy.recipientsJson
                  : [],
              channels: Array.isArray(policy.channels)
                ? policy.channels
                : Array.isArray(policy.channelsJson)
                  ? policy.channelsJson
                  : [],
              cooldownMinutes: Number(policy.cooldownMinutes || 0),
              enabled: policy.enabled !== false,
              lastTriggered: policy.lastTriggeredAt || policy.updatedAt || null,
            })),
          );
        }

        if (auditRowsResult.status === "fulfilled") {
          setAuditLog(
            (auditRowsResult.value as any[]).map((entry) => {
              const method = String(entry.method || "").toUpperCase();
              const route = String(entry.route || "");
              const entity = String(entry.entityType || "Request");
              const action =
                method === "POST"
                  ? "Created"
                  : method === "PATCH" || method === "PUT"
                    ? "Updated"
                    : method === "DELETE"
                      ? "Deleted"
                      : "Requested";
              return {
                id: entry.id,
                action,
                entity,
                entityName: entry.entityId || route || "system",
                user: entry.actorRole || entry.actorUserId || "System",
                timestamp: entry.occurredAt,
              } satisfies AuditEntry;
            }),
          );
        }

        setLastSyncIso(new Date().toISOString());
      } catch (error) {
        toast.error("Admin data refresh failed", {
          description: (error as Error).message || "Unable to refresh admin data",
        });
      }
    };

    loadAdminDataRef.current = loadAdminData;

    loadAdminData().catch(() => undefined);

    const interval = setInterval(() => {
      loadAdminData().catch(() => undefined);
    }, 45000);

    const onRefresh = () => {
      loadAdminData().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }

    return () => {
      mounted = false;
      clearInterval(interval);
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, [liveEncounters, selectedFacilityId]);

  const adminDataContextValue = useMemo<AdminConsoleDataContextValue>(
    () => ({
      facility,
      facilityOptions,
      clinics,
      users,
      rooms,
      reasons,
      templates,
      thresholds,
      notificationPolicies,
      assignments,
      auditLog,
      maUsers,
      clinicianUsers,
      reloadAdminData,
    }),
    [
      facility,
      facilityOptions,
      clinics,
      users,
      rooms,
      reasons,
      templates,
      thresholds,
      notificationPolicies,
      assignments,
      auditLog,
      maUsers,
      clinicianUsers,
      reloadAdminData,
    ],
  );

  return (
    <AdminConsoleDataContext.Provider value={adminDataContextValue}>
    <TooltipProvider>
      <div className="p-4 sm:p-6 space-y-6 max-w-[1200px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-900 flex items-center justify-center">
              <Settings className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-[20px] tracking-tight" style={{ fontWeight: 700 }}>Admin Console</h1>
              <p className="text-[12px] text-muted-foreground">
                Manage facility, clinics, users, assignments, rooms, templates, thresholds, and notification policies
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => setActiveTab("incoming")} className="w-9 h-9 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors">
                  <Upload className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent><p className="text-[11px]">Incoming Uploads</p></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => toast.info("Exporting all configuration...")} className="w-9 h-9 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors">
                  <Download className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent><p className="text-[11px]">Export Config</p></TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] ${isLiveMode ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>
          <Activity className="w-3.5 h-3.5" />
          <span style={{ fontWeight: 500 }}>{isLiveMode ? "Live Admin Data" : "Live workflow sync degraded"}</span>
          <span className={isLiveMode ? "text-emerald-600/70" : "text-amber-700/80"}>
            &middot; Last sync:{" "}
            {lastSyncIso
              ? new Date(lastSyncIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
              : "--:--:--"}
            {syncError ? ` · ${syncError}` : ""}
          </span>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="bg-white border border-gray-200 p-1.5 rounded-xl h-auto flex-wrap gap-1 shadow-sm">
            <TabsTrigger value="facility" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-purple-50 data-[state=active]:text-purple-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-purple-200 transition-all"><Building className="w-3.5 h-3.5 mr-1.5" /> Facility & Rooms</TabsTrigger>
            <TabsTrigger value="clinics" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-emerald-200 transition-all"><Building2 className="w-3.5 h-3.5 mr-1.5" /> Clinics</TabsTrigger>
            <TabsTrigger value="users" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-blue-200 transition-all"><Users className="w-3.5 h-3.5 mr-1.5" /> Users & Roles</TabsTrigger>
            <TabsTrigger value="assignments" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-cyan-50 data-[state=active]:text-cyan-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-cyan-200 transition-all"><Link2 className="w-3.5 h-3.5 mr-1.5" /> Assignments</TabsTrigger>
            <TabsTrigger value="incoming" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-sky-50 data-[state=active]:text-sky-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-sky-200 transition-all"><Upload className="w-3.5 h-3.5 mr-1.5" /> Incoming Uploads</TabsTrigger>
            <TabsTrigger value="templates" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-violet-200 transition-all"><LayoutTemplate className="w-3.5 h-3.5 mr-1.5" /> Reasons & Templates</TabsTrigger>
            <TabsTrigger value="thresholds" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-orange-50 data-[state=active]:text-orange-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-orange-200 transition-all"><Clock className="w-3.5 h-3.5 mr-1.5" /> Thresholds</TabsTrigger>
            <TabsTrigger value="notifications" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-rose-50 data-[state=active]:text-rose-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-rose-200 transition-all"><Bell className="w-3.5 h-3.5 mr-1.5" /> Notifications</TabsTrigger>
            <TabsTrigger value="audit" className="text-[12px] rounded-lg px-3 py-2 data-[state=active]:bg-gray-100 data-[state=active]:text-gray-700 data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-gray-300 transition-all"><History className="w-3.5 h-3.5 mr-1.5" /> Audit Log</TabsTrigger>
          </TabsList>

          <div className="mt-5">
            <TabsContent value="facility">
              <FacilityRoomsTab
                onAddRoom={() => {
                  setEditingRoom(null);
                  setOpenModal("room");
                }}
                onAddFacility={() => setOpenModal("facility")}
                onEditRoom={(room) => {
                  setEditingRoom(room);
                  setOpenModal("room");
                }}
                selectedFacilityId={activeFacilityId || facility.id}
                onSaveFacility={(facilityId) => {
                  setFacilitySession(facilityId).catch((error) => {
                    toast.error("Failed to switch facility", {
                      description: (error as Error).message || "Unable to switch facility context",
                    });
                  });
                }}
              />
            </TabsContent>
            <TabsContent value="clinics">
              <ClinicsTab
                onAddClinic={() => {
                  setEditingClinic(null);
                  setOpenModal("clinic");
                }}
                onEditClinic={(clinic) => {
                  setEditingClinic(clinic);
                  setOpenModal("clinic");
                }}
              />
            </TabsContent>
            <TabsContent value="users">
              <UsersRolesTab
                onAddUser={() => setOpenModal("user")}
                onOpenAssignments={() => setActiveTab("assignments")}
              />
            </TabsContent>
            <TabsContent value="assignments"><AssignmentsTab /></TabsContent>
            <TabsContent value="incoming">
              <IncomingIntegrationsTab selectedFacilityId={activeFacilityId || facility.id} />
            </TabsContent>
            <TabsContent value="templates">
              <ReasonsTemplatesTab
                onAddReason={() => {
                  setEditingReason(null);
                  setOpenModal("reason");
                }}
                onEditReason={(reason) => {
                  setEditingReason(reason);
                  setOpenModal("reason");
                }}
                onAddTemplate={() => {
                  setEditingTemplate(null);
                  setOpenModal("template");
                }}
                onEditTemplate={(template) => {
                  setEditingTemplate(template);
                  setOpenModal("template");
                }}
              />
            </TabsContent>
            <TabsContent value="thresholds"><ThresholdsTab onAddThreshold={() => setOpenModal("threshold")} facilityId={activeFacilityId || ""} /></TabsContent>
            <TabsContent value="notifications">
              <NotificationsTab
                onAddPolicy={() => {
                  setEditingNotification(null);
                  setOpenModal("notification");
                }}
                onEditPolicy={(policy) => {
                  setEditingNotification(policy);
                  setOpenModal("notification");
                }}
              />
            </TabsContent>
            <TabsContent value="audit"><AuditLogTab /></TabsContent>
          </div>
        </Tabs>

        {/* ── All Modals ── */}
        <AddFacilityModal open={openModal === "facility"} onClose={close} onSubmit={createFacility} />
        <AddClinicModal
          open={openModal === "clinic"}
          onClose={close}
          rooms={rooms.filter((room) => room.status !== "archived")}
          initialValues={
            editingClinic
              ? {
                  name: editingClinic.name,
                  shortCode: editingClinic.shortCode,
                  cardColor: editingClinic.color,
                  roomIds: editingClinic.roomIds,
                  maRun: editingClinic.maRun,
                }
              : undefined
          }
          lockRunModel={Boolean(editingClinic)}
          title={editingClinic ? "Edit Clinic" : "Add Clinic"}
          submitLabel={editingClinic ? "Save Clinic" : "Create Clinic"}
          description={editingClinic ? "Update clinic details and assigned rooms." : "Create a new clinic under this facility."}
          onSubmit={editingClinic ? updateClinicDetails : createClinic}
        />
        <ProvisionUserModal
          open={openModal === "user"}
          onClose={close}
          facilities={facilityOptions}
          onSearch={searchDirectoryUsers}
          onSubmit={createUser}
        />
        <AddRoomModal
          open={openModal === "room"}
          onClose={close}
          initialValues={
            editingRoom
              ? {
                  name: editingRoom.name,
                  roomType: editingRoom.roomType,
                }
              : undefined
          }
          title={editingRoom ? "Edit Room" : "Add Room"}
          submitLabel={editingRoom ? "Save Room" : "Add Room"}
          description={editingRoom ? "Update room details for this facility." : "Add a new room to this facility."}
          onSubmit={editingRoom ? updateRoomDetails : createRoom}
        />
        <AddReasonModal
          open={openModal === "reason"}
          onClose={close}
          clinics={clinics.filter((clinic) => clinic.status !== "archived")}
          initialValues={
            editingReason
              ? {
                  name: editingReason.name,
                  appointmentLengthMinutes: editingReason.appointmentLengthMinutes,
                  clinicIds: editingReason.clinicIds,
                }
              : undefined
          }
          title={editingReason ? "Edit Visit Reason" : "Add Visit Reason"}
          submitLabel={editingReason ? "Save Visit Reason" : "Add Visit Reason"}
          description={editingReason ? "Update visit reason details." : "Add a new visit reason for this facility."}
          onSubmit={editingReason ? updateReasonDetails : createReason}
        />
        <AddTemplateModal
          open={openModal === "template"}
          onClose={close}
          reasons={reasons}
          initialValues={
            editingTemplate
              ? {
                  name: editingTemplate.name,
                  type: editingTemplate.type,
                  status: editingTemplate.status === "inactive" ? "inactive" : "active",
                  reasonIds: editingTemplate.reasonIds,
                  fields: editingTemplate.fields,
                }
              : undefined
          }
          title={editingTemplate ? "Edit Template Settings" : "Create Template"}
          submitLabel={editingTemplate ? "Save Template" : "Create Template"}
          description={editingTemplate ? "Update template settings and field definitions." : "Create a workflow template tied to one or more visit reasons."}
          onSubmit={editingTemplate ? updateTemplateDetails : createTemplate}
        />
        <AddThresholdModal open={openModal === "threshold"} onClose={close} clinics={clinics} onSubmit={createThreshold} />
        <AddNotificationPolicyModal
          open={openModal === "notification"}
          onClose={close}
          clinics={clinics}
          initialValues={
            editingNotification
              ? {
                  clinicId: editingNotification.clinicId,
                  status: editingNotification.status,
                  severity: editingNotification.severity,
                  recipients: editingNotification.recipients,
                  channels: editingNotification.channels,
                  cooldownMinutes: editingNotification.cooldownMinutes,
                }
              : undefined
          }
          title={editingNotification ? "Edit Notification Policy" : "Add Notification Policy"}
          submitLabel={editingNotification ? "Save Policy" : "Add Policy"}
          description="Define alert routing and cooldown."
          onSubmit={editingNotification ? updateNotificationPolicy : createNotificationPolicy}
        />
      </div>
    </TooltipProvider>
    </AdminConsoleDataContext.Provider>
  );
}
