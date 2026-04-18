import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Sparkles,
  Search,
  ClipboardCheck,
  ClipboardList,
  Stethoscope,
  CreditCard,
  Heart,
  Activity,
  ShieldCheck,
  FileText,
  CheckCircle2,
  StickyNote,
  Flag,
  FlaskConical,
} from "lucide-react";
import { toast } from "sonner";
import type { DirectoryUser } from "./types";

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[12px] text-muted-foreground mb-1.5 block" style={{ fontWeight: 500 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[13px] hover:border-indigo-200 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition-all";
const selectClass =
  "w-full h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[13px] appearance-none hover:border-indigo-200 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition-all";

function capitalizeRoomType(value?: string) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function normalizeTemplateTypeInput(value?: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (normalized === "intake" || normalized === "checkin") return "checkin";
  if (normalized === "rooming") return "rooming";
  if (normalized === "clinician") return "clinician";
  if (normalized === "checkout") return "checkout";
  return "";
}

function toTemplateFieldKey(value: string, index: number) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || `field_${index}`;
}

type TemplateSectionStyle = {
  id: string;
  name: string;
  icon: string;
  color: string;
};

function createSectionId() {
  return `section_${Math.random().toString(36).slice(2, 10)}`;
}

const sectionIconOptions: Array<{
  value: string;
  label: string;
  icon: React.ElementType;
}> = [
  { value: "Clipboard", label: "Clipboard", icon: ClipboardList },
  { value: "Heart", label: "Heart", icon: Heart },
  { value: "Activity", label: "Activity", icon: Activity },
  { value: "Shield", label: "Shield", icon: ShieldCheck },
  { value: "File", label: "File", icon: FileText },
  { value: "Check", label: "Check", icon: CheckCircle2 },
  { value: "Notes", label: "Notes", icon: StickyNote },
  { value: "Flag", label: "Flag", icon: Flag },
  { value: "Lab", label: "Lab", icon: FlaskConical },
];

function getSectionIconConfig(value?: string) {
  return sectionIconOptions.find((entry) => entry.value === value) || sectionIconOptions[0]!;
}

const defaultTemplateSections: TemplateSectionStyle[] = [
  { id: createSectionId(), name: "General", icon: "Clipboard", color: "#6366f1" },
  { id: createSectionId(), name: "Vitals", icon: "Heart", color: "#ef4444" },
  { id: createSectionId(), name: "Assessment", icon: "File", color: "#0ea5e9" },
  { id: createSectionId(), name: "Review", icon: "Check", color: "#10b981" },
  { id: createSectionId(), name: "History", icon: "Activity", color: "#8b5cf6" },
  { id: createSectionId(), name: "Notes", icon: "Notes", color: "#64748b" },
];

type TemplateInputType =
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

const templateFieldTypeLabel: Record<TemplateInputType, string> = {
  text: "Short Text",
  textarea: "Long Text",
  number: "Number",
  checkbox: "Checkbox",
  select: "Dropdown",
  radio: "Single Choice",
  date: "Date",
  time: "Time",
  bloodPressure: "Blood Pressure",
  temperature: "Temperature",
  pulse: "Pulse",
  respirations: "Respirations",
  oxygenSaturation: "Oxygen Saturation",
  height: "Height",
  weight: "Weight",
  painScore: "Pain Score",
  yesNo: "Yes / No",
};

const templateTypeOptions: Array<{
  value: "checkin" | "rooming" | "clinician" | "checkout";
  label: string;
  helper: string;
  icon: React.ElementType;
}> = [
  {
    value: "checkin",
    label: "Check-In",
    helper: "Front desk intake",
    icon: ClipboardCheck,
  },
  {
    value: "rooming",
    label: "Rooming",
    helper: "MA room prep",
    icon: ClipboardList,
  },
  {
    value: "clinician",
    label: "Clinician",
    helper: "Provider workflow",
    icon: Stethoscope,
  },
  {
    value: "checkout",
    label: "Check-Out",
    helper: "Front desk closeout",
    icon: CreditCard,
  },
];

const templateSectionPresets: Record<
  "checkin" | "rooming" | "clinician" | "checkout",
  TemplateSectionStyle[]
> = {
  checkin: [
    { id: createSectionId(), name: "Registration", icon: "Clipboard", color: "#6366f1" },
    { id: createSectionId(), name: "History", icon: "Activity", color: "#8b5cf6" },
    { id: createSectionId(), name: "Flags", icon: "Flag", color: "#f59e0b" },
  ],
  rooming: [
    { id: createSectionId(), name: "Vitals", icon: "Heart", color: "#ef4444" },
    { id: createSectionId(), name: "Clinical Intake", icon: "Clipboard", color: "#2563eb" },
    { id: createSectionId(), name: "Safety Checks", icon: "Shield", color: "#10b981" },
  ],
  clinician: [
    { id: createSectionId(), name: "Assessment", icon: "File", color: "#0ea5e9" },
    { id: createSectionId(), name: "Plan", icon: "Check", color: "#14b8a6" },
    { id: createSectionId(), name: "Orders", icon: "Lab", color: "#8b5cf6" },
  ],
  checkout: [
    { id: createSectionId(), name: "Discharge", icon: "Clipboard", color: "#f97316" },
    { id: createSectionId(), name: "Billing", icon: "File", color: "#0ea5e9" },
    { id: createSectionId(), name: "Follow-Up", icon: "Notes", color: "#64748b" },
  ],
};

async function submitWithToast<T>(label: string, action: () => Promise<T>, onClose: () => void) {
  try {
    await action();
    toast.success(`${label} successful`);
    onClose();
  } catch (error) {
    toast.error(`${label} failed`, {
      description: (error as Error).message || "Please review the entered values and try again.",
    });
  }
}

function ModalActions({
  onClose,
  onSubmit,
  label,
  disabled,
}: {
  onClose: () => void;
  onSubmit: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <DialogFooter>
      <button
        onClick={onClose}
        className="h-9 px-4 rounded-lg border border-gray-200 text-[13px] text-gray-600 hover:bg-gray-50 transition-colors"
        style={{ fontWeight: 500 }}
      >
        Cancel
      </button>
      <button
        onClick={onSubmit}
        disabled={disabled}
        className="h-9 px-4 rounded-lg bg-indigo-600 text-white text-[13px] hover:bg-indigo-700 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ fontWeight: 500 }}
      >
        <Plus className="w-3.5 h-3.5" /> {label}
      </button>
    </DialogFooter>
  );
}

function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const clamp = (next: number) => {
    if (typeof min === "number" && next < min) return min;
    if (typeof max === "number" && next > max) return max;
    return next;
  };
  return (
    <div className="h-10 flex items-center rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
      <input
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value || 0)))}
        type="text"
        inputMode="numeric"
        data-step={step}
        onWheel={(event) => event.currentTarget.blur()}
        className="flex-1 h-full px-3 bg-transparent text-[13px] focus:outline-none"
      />
    </div>
  );
}

function channelLabel(channel: string) {
  if (channel === "in_app") return "App Notification";
  if (channel === "email") return "Email";
  if (channel === "sms") return "SMS";
  return channel;
}

export function AddClinicModal({
  open,
  onClose,
  rooms,
  lockRunModel,
  initialValues,
  title,
  submitLabel,
  description,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  rooms?: { id: string; name: string; roomNumber?: number; roomType?: string; status?: string }[];
  lockRunModel?: boolean;
  initialValues?: {
    name?: string;
    shortCode?: string;
    cardColor?: string;
    roomIds?: string[];
    maRun?: boolean;
  };
  title?: string;
  submitLabel?: string;
  description?: string;
  onSubmit: (payload: {
    name: string;
    shortCode: string;
    cardColor: string;
    roomIds: string[];
    maRun: boolean;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [cardColor, setCardColor] = useState("#6366f1");
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [runModel, setRunModel] = useState<"" | "ma" | "provider">("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialValues?.name || "");
    setShortCode(initialValues?.shortCode || "");
    setCardColor(initialValues?.cardColor || "#6366f1");
    setRoomIds(Array.isArray(initialValues?.roomIds) ? initialValues.roomIds : []);
    if (typeof initialValues?.maRun === "boolean") {
      setRunModel(initialValues.maRun ? "ma" : "provider");
    } else {
      setRunModel("");
    }
  }, [open, initialValues]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">{title || "Add Clinic"}</DialogTitle>
          <DialogDescription className="text-[12px]">{description || "Create a new clinic under this facility."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <FormField label="Clinic Name *">
            <input value={name} onChange={(event) => setName(event.target.value)} type="text" placeholder="e.g. Northside Primary Care" className={inputClass} />
          </FormField>
          <div className="grid grid-cols-1 gap-3">
            <FormField label="Short Code *">
              <input value={shortCode} onChange={(event) => setShortCode(event.target.value)} type="text" placeholder="e.g. NS" maxLength={4} className={inputClass} />
            </FormField>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <FormField label="Clinic Color">
              <div className="flex items-center gap-2">
                <input value={cardColor} onChange={(event) => setCardColor(event.target.value)} type="color" className="w-10 h-10 rounded-lg border border-gray-200 cursor-pointer" />
                <input value={cardColor} onChange={(event) => setCardColor(event.target.value)} type="text" className={inputClass} />
              </div>
            </FormField>
            <FormField label="Run Model *">
              <select
                value={runModel}
                onChange={(event) => setRunModel(event.target.value as "" | "ma" | "provider")}
                className={selectClass}
                disabled={Boolean(lockRunModel)}
              >
                <option value="">Select run model...</option>
                <option value="ma">MA Run</option>
                <option value="provider">Provider Run</option>
              </select>
              {lockRunModel && (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  Run model is fixed after creation.
                </p>
              )}
            </FormField>
          </div>
          <FormField label="Assigned Rooms">
            {rooms && rooms.length > 0 ? (
              <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
                {rooms.map((room) => (
                  <label key={room.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 cursor-pointer hover:border-indigo-200 transition-colors">
                    <input
                      type="checkbox"
                      checked={roomIds.includes(room.id)}
                      onChange={(event) =>
                        setRoomIds((prev) =>
                          event.target.checked
                            ? [...prev, room.id]
                            : prev.filter((id) => id !== room.id),
                        )
                      }
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600"
                    />
                    <span className="text-[13px]">
                      {room.name}
                      {room.roomNumber !== undefined ? ` (#${room.roomNumber})` : ""}
                      {room.roomType ? ` · ${capitalizeRoomType(room.roomType)}` : ""}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[12px] text-muted-foreground flex items-center">
                Add facility rooms first.
              </div>
            )}
          </FormField>
        </div>
        <ModalActions
          onClose={onClose}
          label={submitLabel || "Create Clinic"}
          disabled={!name.trim() || !shortCode.trim() || !runModel || submitting}
          onSubmit={() => {
            if (!name.trim() || !shortCode.trim() || !runModel) return;
            setSubmitting(true);
            submitWithToast(
              submitLabel || "Create Clinic",
              () =>
                onSubmit({
                  name: name.trim(),
                  shortCode: shortCode.trim(),
                  cardColor,
                  roomIds,
                  maRun: runModel === "ma",
                }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddFacilityModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { name: string; shortCode: string; address?: string; phone?: string; timezone: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setShortCode("");
    setAddress("");
    setPhone("");
    setTimezone("America/New_York");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">Add Facility</DialogTitle>
          <DialogDescription className="text-[12px]">Create a new location with isolated clinics, rooms, users, and encounters.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <FormField label="Facility Name *">
            <input value={name} onChange={(event) => setName(event.target.value)} type="text" placeholder="e.g. North Campus" className={inputClass} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Facility Code">
              <input value={shortCode} onChange={(event) => setShortCode(event.target.value)} type="text" placeholder="e.g. NC" maxLength={8} className={inputClass} />
            </FormField>
            <FormField label="Timezone">
              <select value={timezone} onChange={(event) => setTimezone(event.target.value)} className={selectClass}>
                <option>America/Los_Angeles</option>
                <option>America/Denver</option>
                <option>America/Chicago</option>
                <option>America/New_York</option>
              </select>
            </FormField>
          </div>
          <FormField label="Address">
            <input value={address} onChange={(event) => setAddress(event.target.value)} type="text" placeholder="Street, city, state, zip" className={inputClass} />
          </FormField>
          <FormField label="Phone">
            <input value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" placeholder="(555) 555-0100" className={inputClass} />
          </FormField>
        </div>
        <ModalActions
          onClose={onClose}
          label="Create Facility"
          disabled={!name.trim() || submitting}
          onSubmit={() => {
            if (!name.trim()) return;
            setSubmitting(true);
            submitWithToast(
              "Create Facility",
              () =>
                onSubmit({
                  name: name.trim(),
                  shortCode: shortCode.trim(),
                  address: address.trim() || undefined,
                  phone: phone.trim() || undefined,
                  timezone,
                }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ProvisionUserModal({
  open,
  onClose,
  facilities,
  onSearch,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  facilities: { id: string; name: string; shortCode?: string }[];
  onSearch: (query: string) => Promise<DirectoryUser[]>;
  onSubmit: (payload: {
    objectId: string;
    email: string;
    displayName: string;
    role: string;
    facilityIds: string[];
  }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<DirectoryUser | null>(null);
  const [role, setRole] = useState("");
  const [facilityIds, setFacilityIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setSelectedUser(null);
    setRole("");
    setFacilityIds([]);
  }, [open]);

  const handleSearch = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const nextResults = await onSearch(query.trim());
      setResults(nextResults);
      if (selectedUser && !nextResults.some((row) => row.objectId === selectedUser.objectId)) {
        setSelectedUser(null);
      }
    } finally {
      setSearching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">Provision Entra User</DialogTitle>
          <DialogDescription className="text-[12px]">
            Search Microsoft Entra, select an existing tenant member, then assign their Flow role and facilities.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <FormField label="Search Microsoft Entra *">
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="text"
                placeholder="Name, email, or user principal name"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => {
                  void handleSearch();
                }}
                disabled={query.trim().length < 2 || searching}
                className="h-10 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors flex items-center gap-1.5"
                style={{ fontWeight: 500 }}
              >
                <Search className="w-3.5 h-3.5" />
                {searching ? "Searching..." : "Search"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Only active tenant members are eligible for Flow provisioning.
            </p>
          </FormField>

          <div className="max-h-52 overflow-auto rounded-lg border border-gray-100 p-2 space-y-2">
            {results.length === 0 ? (
              <div className="px-2 py-3 text-[12px] text-muted-foreground">
                Search results will appear here.
              </div>
            ) : (
              results.map((user) => {
                const selected = selectedUser?.objectId === user.objectId;
                return (
                  <button
                    key={user.objectId}
                    type="button"
                    onClick={() => setSelectedUser(user)}
                    className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                      selected ? "border-indigo-300 bg-indigo-50" : "border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    <div className="text-[13px]" style={{ fontWeight: 600 }}>{user.displayName}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {user.email || user.userPrincipalName}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {user.userType} · {user.accountEnabled ? "Enabled" : "Disabled"}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Selected User">
              <div className="min-h-10 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-[13px] text-gray-700">
                {selectedUser ? selectedUser.displayName : "Choose a directory user"}
              </div>
            </FormField>
            <FormField label="Email / UPN">
              <div className="min-h-10 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-[13px] text-gray-700">
                {selectedUser ? selectedUser.email || selectedUser.userPrincipalName : "Will be sourced from Entra"}
              </div>
            </FormField>
          </div>

          <FormField label="Flow Role *">
            <select value={role} onChange={(event) => setRole(event.target.value)} className={selectClass}>
              <option value="">Select role...</option>
              <option>FrontDeskCheckIn</option>
              <option>MA</option>
              <option>Clinician</option>
              <option>FrontDeskCheckOut</option>
              <option>OfficeManager</option>
              <option>Admin</option>
              <option>RevenueCycle</option>
            </select>
          </FormField>

          <FormField label="Facility Assignment *">
            <div className="space-y-2 max-h-44 overflow-auto rounded-lg border border-gray-100 p-2">
              {facilities.map((facility) => (
                <label key={facility.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-gray-100 cursor-pointer hover:border-indigo-200 transition-colors">
                  <input
                    type="checkbox"
                    checked={facilityIds.includes(facility.id)}
                    onChange={(event) =>
                      setFacilityIds((prev) =>
                        event.target.checked
                          ? [...prev, facility.id]
                          : prev.filter((id) => id !== facility.id),
                      )
                    }
                    className="w-4 h-4 rounded border-gray-300 text-indigo-600"
                  />
                  <span className="text-[13px]">
                    {facility.name}
                    {facility.shortCode ? ` (${facility.shortCode})` : ""}
                  </span>
                </label>
              ))}
            </div>
          </FormField>
        </div>
        <ModalActions
          onClose={onClose}
          label="Provision User"
          disabled={!selectedUser || !role || facilityIds.length === 0 || submitting}
          onSubmit={() => {
            if (!selectedUser || !role || facilityIds.length === 0) return;
            setSubmitting(true);
            submitWithToast(
              "Provision User",
              () =>
                onSubmit({
                  objectId: selectedUser.objectId,
                  email: selectedUser.email || selectedUser.userPrincipalName,
                  displayName: selectedUser.displayName,
                  role,
                  facilityIds,
                }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddRoomModal({
  open,
  onClose,
  initialValues,
  title,
  description,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  initialValues?: {
    name?: string;
    roomType?: string;
  };
  title?: string;
  description?: string;
  submitLabel?: string;
  onSubmit: (payload: { name: string; roomType: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState("exam");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialValues?.name || "");
    setRoomType(initialValues?.roomType || "exam");
  }, [open, initialValues]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">{title || "Add Room"}</DialogTitle>
          <DialogDescription className="text-[12px]">{description || "Add a new room to this facility."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <FormField label="Room Name *"><input value={name} onChange={(event) => setName(event.target.value)} type="text" placeholder="e.g. Exam Room A" className={inputClass} /></FormField>
          <FormField label="Room #">
            <div className="h-10 px-3 rounded-lg border border-gray-200 bg-gray-100 text-[12px] text-muted-foreground flex items-center">
              Assigned automatically based on room order.
            </div>
          </FormField>
          <FormField label="Room Type *">
            <select value={roomType} onChange={(event) => setRoomType(event.target.value)} className={selectClass}>
              <option value="exam">Exam</option>
              <option value="procedure">Procedure</option>
              <option value="consult">Consult</option>
              <option value="triage">Triage</option>
              <option value="lab">Lab</option>
              <option value="other">Other</option>
            </select>
          </FormField>
        </div>
        <ModalActions
          onClose={onClose}
          label={submitLabel || "Add Room"}
          disabled={!name.trim() || !roomType.trim() || submitting}
          onSubmit={() => {
            if (!name.trim() || !roomType.trim()) return;
            setSubmitting(true);
            submitWithToast(
              submitLabel || "Add Room",
              () => onSubmit({ name: name.trim(), roomType: roomType.trim().toLowerCase() }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddReasonModal({
  open,
  onClose,
  clinics,
  initialValues,
  title,
  description,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  clinics: { id: string; name: string; shortCode?: string; status?: string }[];
  initialValues?: {
    name?: string;
    appointmentLengthMinutes?: number;
    clinicIds?: string[];
  };
  title?: string;
  description?: string;
  submitLabel?: string;
  onSubmit: (payload: { name: string; appointmentLengthMinutes: number; clinicIds: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [appointmentLengthMinutes, setAppointmentLengthMinutes] = useState(20);
  const [clinicIds, setClinicIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialValues?.name || "");
    setAppointmentLengthMinutes(initialValues?.appointmentLengthMinutes ?? 20);
    setClinicIds(Array.isArray(initialValues?.clinicIds) ? initialValues.clinicIds : []);
  }, [open, initialValues]);

  const selectableClinics = clinics.filter((clinic) => String(clinic.status || "active") !== "archived");

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">{title || "Add Visit Reason"}</DialogTitle>
          <DialogDescription className="text-[12px]">{description || "Configure appointment length and allowed clinics."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <FormField label="Reason Name *">
            <input value={name} onChange={(event) => setName(event.target.value)} type="text" placeholder="e.g. Urgent Care" className={inputClass} />
          </FormField>
          <FormField label="Appointment Length (minutes) *">
            <NumberStepper value={appointmentLengthMinutes} onChange={setAppointmentLengthMinutes} min={1} />
          </FormField>
          <FormField label="Allowed Clinics *">
            {selectableClinics.length > 0 ? (
              <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
                {selectableClinics.map((clinic) => (
                  <label key={clinic.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 cursor-pointer hover:border-indigo-200 transition-colors">
                    <input
                      type="checkbox"
                      checked={clinicIds.includes(clinic.id)}
                      onChange={(event) =>
                        setClinicIds((prev) =>
                          event.target.checked
                            ? [...prev, clinic.id]
                            : prev.filter((id) => id !== clinic.id),
                        )
                      }
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600"
                    />
                    <span className="text-[13px]">
                      {clinic.name}
                      {clinic.shortCode ? ` (${clinic.shortCode})` : ""}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[12px] text-muted-foreground flex items-center">
                Add clinics first.
              </div>
            )}
          </FormField>
        </div>
        <ModalActions
          onClose={onClose}
          label={submitLabel || "Save Visit Reason"}
          disabled={!name.trim() || appointmentLengthMinutes <= 0 || clinicIds.length === 0 || submitting}
          onSubmit={() => {
            if (!name.trim() || appointmentLengthMinutes <= 0 || clinicIds.length === 0) return;
            setSubmitting(true);
            submitWithToast(
              submitLabel || "Save Visit Reason",
              () => onSubmit({ name: name.trim(), appointmentLengthMinutes, clinicIds }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddTemplateModal({
  open,
  onClose,
  reasons,
  initialValues,
  title,
  description,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  reasons: { id: string; name: string; status?: string }[];
  initialValues?: {
    name?: string;
    type?: string;
    status?: "active" | "inactive";
    reasonIds?: string[];
    fields?: Array<{
      id?: string;
      key: string;
      label: string;
      type: TemplateInputType;
      required?: boolean;
      options?: string[];
      group?: string;
      icon?: string;
      color?: string;
    }>;
  };
  title?: string;
  description?: string;
  submitLabel?: string;
  onSubmit: (payload: {
    name: string;
    type: string;
    status: "active" | "inactive";
    reasonIds: string[];
    fields: Array<{
      id?: string;
      key: string;
      label: string;
      type: TemplateInputType;
      required?: boolean;
      options?: string[];
      group?: string;
      icon?: string;
      color?: string;
    }>;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [reasonIds, setReasonIds] = useState<string[]>([]);
  const [fields, setFields] = useState<
    Array<{
      id?: string;
      key: string;
      label: string;
      type: TemplateInputType;
      required?: boolean;
      options?: string[];
      group?: string;
      icon?: string;
      color?: string;
    }>
  >([]);
  const [sections, setSections] = useState<TemplateSectionStyle[]>(defaultTemplateSections);
  const [submitting, setSubmitting] = useState(false);
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});

  const reasonOptions = reasons.filter((reason) => String(reason.status || "active") !== "archived");

  useEffect(() => {
    if (!open) return;
    const starterField = {
      id: "field_1",
      key: "notes",
      label: "Notes",
      type: "textarea" as const,
      required: false,
      options: [],
      group: "General",
      icon: "Clipboard",
      color: "#6366f1",
    };
    setName(initialValues?.name || "");
    setType(normalizeTemplateTypeInput(initialValues?.type || ""));
    setStatus(initialValues?.status || "active");
    setReasonIds(Array.isArray(initialValues?.reasonIds) ? initialValues.reasonIds : []);
    const nextSections = defaultTemplateSections.map((section) => ({ ...section, id: createSectionId() }));
    const sectionByName = new Map(nextSections.map((section) => [section.name, section]));
    (initialValues?.fields || []).forEach((field) => {
      const group = String(field.group || "").trim();
      if (!group) return;
      const existing = sectionByName.get(group);
      if (existing) {
        if (field.icon && !existing.icon) existing.icon = field.icon;
        if (field.color && !existing.color) existing.color = field.color;
        return;
      }
      const created = {
        id: createSectionId(),
        name: group,
        icon: String(field.icon || "Clipboard"),
        color: String(field.color || "#6366f1"),
      };
      nextSections.push(created);
      sectionByName.set(created.name, created);
    });
    setSections(nextSections);
    setFields(
      initialValues?.fields && initialValues.fields.length > 0
        ? initialValues.fields.map((field, idx) => ({
            ...field,
            id: field.id || `field_${idx + 1}`,
            options: Array.isArray(field.options) ? field.options : [],
            group: field.group || "General",
            icon: field.icon,
            color: field.color,
          }))
        : [starterField],
    );
    setOptionDrafts({});
  }, [open, initialValues]);

  function updateField(index: number, update: Partial<(typeof fields)[number]>) {
    setFields((prev) => prev.map((field, idx) => (idx === index ? { ...field, ...update } : field)));
  }

  function addField() {
    const defaultSection = sections[0]?.name || "General";
    const sectionStyle =
      sections.find((section) => section.name === defaultSection) ||
      defaultTemplateSections[0];
    setFields((prev) => [
      ...prev,
      {
        id: `field_${prev.length + 1}`,
        key: `field_${prev.length + 1}`,
        label: `Field ${prev.length + 1}`,
        type: "text",
        required: false,
        options: [],
        group: defaultSection,
        icon: sectionStyle.icon,
        color: sectionStyle.color,
      },
    ]);
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, idx) => idx !== index));
  }

  function moveField(index: number, direction: -1 | 1) {
    setFields((prev) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const current = next[index];
      next[index] = next[nextIndex]!;
      next[nextIndex] = current!;
      return next;
    });
  }

  function updateSection(index: number, update: Partial<TemplateSectionStyle>) {
    setSections((prev) => prev.map((section, idx) => (idx === index ? { ...section, ...update } : section)));
  }

  function addSection() {
    const nextIndex = sections.length + 1;
    setSections((prev) => [...prev, { id: createSectionId(), name: `Section ${nextIndex}`, icon: "Clipboard", color: "#6366f1" }]);
  }

  function removeSection(index: number) {
    if (sections.length <= 1) return;
    const removedSection = sections[index];
    if (!removedSection) return;
    const fallbackSection = sections.find((_, idx) => idx !== index) || { ...defaultTemplateSections[0], id: createSectionId() };
    setSections((prev) => prev.filter((_, idx) => idx !== index));
    setFields((prev) =>
      prev.map((field) =>
        field.group === removedSection.name
          ? { ...field, group: fallbackSection.name, icon: fallbackSection.icon, color: fallbackSection.color }
          : field,
      ),
    );
  }

  function applyStarterSections(inputType?: string) {
    const normalized = normalizeTemplateTypeInput(inputType || type);
    if (!normalized) return;
    const starter = templateSectionPresets[normalized];
    if (!starter || starter.length === 0) return;
    const starterSections = starter.map((entry) => ({ ...entry, id: createSectionId() }));
    setSections(starterSections);
    setFields((prev) =>
      prev.map((field, fieldIndex) => {
        const section = starterSections[Math.min(fieldIndex, starterSections.length - 1)] || starterSections[0];
        return {
          ...field,
          group: section.name,
          icon: section.icon,
          color: section.color,
        };
      }),
    );
  }

  function fieldDraftKey(field: (typeof fields)[number], index: number) {
    return String(field.id || `field_${index + 1}`);
  }

  function addFieldOption(index: number) {
    const field = fields[index];
    if (!field) return;
    const key = fieldDraftKey(field, index);
    const draft = String(optionDrafts[key] || "").trim();
    if (!draft) return;
    setFields((prev) =>
      prev.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const options = Array.isArray(row.options) ? row.options : [];
        if (options.includes(draft)) return row;
        return { ...row, options: [...options, draft] };
      }),
    );
    setOptionDrafts((prev) => ({ ...prev, [key]: "" }));
  }

  function removeFieldOption(index: number, optionIndex: number) {
    setFields((prev) =>
      prev.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const options = Array.isArray(row.options) ? row.options : [];
        return { ...row, options: options.filter((_, idx) => idx !== optionIndex) };
      }),
    );
  }

  const sanitizedFields = fields
    .map((field) => {
      const type = field.type;
      const label = String(field.label || "").trim();
      const selectedSectionName = String(field.group || "General").trim() || "General";
      const selectedSection =
        sections.find((section) => section.name === selectedSectionName) ||
        defaultTemplateSections.find((section) => section.name === selectedSectionName) ||
        defaultTemplateSections[0];
      return {
        ...field,
        type,
        key: toTemplateFieldKey(label || field.key || "", Number(String(field.id || "").split("_")[1] || 1)),
        label,
        options:
          type === "select" || type === "radio"
            ? (Array.isArray(field.options) ? field.options : [])
                .map((entry) => String(entry ?? "").trim())
                .filter(Boolean)
            : undefined,
        group: selectedSectionName,
        icon: String(field.icon || selectedSection.icon || "Clipboard"),
        color: String(field.color || selectedSection.color || "#6366f1"),
      };
    });

  const keyCounts = sanitizedFields.reduce((acc, field) => {
    const key = field.key;
    if (!key) return acc;
    acc.set(key, (acc.get(key) || 0) + 1);
    return acc;
  }, new Map<string, number>());
  const duplicateKeys = Array.from(keyCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  const duplicateKeySet = new Set(duplicateKeys);

  const fieldErrorMap = sanitizedFields.map((field) => {
    const errors: {
      label?: string;
      options?: string;
      key?: string;
    } = {};
    if (!field.label) {
      errors.label = "Question label is required.";
    }
    if ((field.type === "select" || field.type === "radio") && (!field.options || field.options.length === 0)) {
      errors.options = "Add at least one option.";
    }
    if (duplicateKeySet.has(field.key)) {
      errors.key = `Field key "${field.key}" is duplicated.`;
    }
    return errors;
  });
  const fieldErrors = fieldErrorMap.flatMap((error, index) => {
    const rows: string[] = [];
    if (error.label) rows.push(`Field ${index + 1}: ${error.label}`);
    if (error.options) rows.push(`Field ${index + 1}: ${error.options}`);
    if (error.key) rows.push(`Field ${index + 1}: ${error.key}`);
    return rows;
  });
  const sectionNames = sections.map((section) => String(section.name || "").trim()).filter(Boolean);
  const duplicateSections = Array.from(
    sectionNames.reduce((acc, sectionName) => {
      acc.set(sectionName.toLowerCase(), (acc.get(sectionName.toLowerCase()) || 0) + 1);
      return acc;
    }, new Map<string, number>()).entries(),
  )
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  duplicateSections.forEach((name) => fieldErrors.push(`Duplicate section name: ${name}`));

  const validFields = sanitizedFields.filter((_, index) => {
    const error = fieldErrorMap[index];
    return !(error?.label || error?.options || error?.key);
  });

  const sectionFieldCounts = fields.reduce((acc, field) => {
    const sectionName = String(field.group || "General").trim() || "General";
    acc.set(sectionName, (acc.get(sectionName) || 0) + 1);
    return acc;
  }, new Map<string, number>());

  const previewGroups = validFields.reduce((acc, field) => {
    const group = String(field.group || "General").trim() || "General";
    if (!acc.has(group)) acc.set(group, []);
    acc.get(group)!.push(field);
    return acc;
  }, new Map<string, typeof validFields>());

  const normalizedType = normalizeTemplateTypeInput(type);
  const hasInvalidField = fieldErrors.length > 0 || validFields.length === 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[760px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[16px]">{title || "Create Template"}</DialogTitle>
          <DialogDescription className="text-[12px]">{description || "Build a workflow template and assign it to one or more visit reasons."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Template Name *">
              <input value={name} onChange={(event) => setName(event.target.value)} type="text" placeholder="e.g. Check-In Core Form" className={inputClass} />
            </FormField>
            <FormField label="Template Type *">
              <div className="grid grid-cols-2 gap-2">
                {templateTypeOptions.map((option) => {
                  const Icon = option.icon;
                  const selected = normalizedType === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setType(option.value);
                      }}
                      className={`h-12 rounded-lg border px-2.5 text-left transition-all focus:outline-none focus:ring-2 ${
                        selected
                          ? "border-indigo-300 bg-indigo-50 text-indigo-700 shadow-sm focus:ring-indigo-100"
                          : "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:bg-indigo-50/30 focus:ring-indigo-100"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon className="w-3.5 h-3.5" />
                        <span className="text-[11px]" style={{ fontWeight: 600 }}>
                          {option.label}
                        </span>
                      </div>
                      <div className="text-[10px] opacity-80 leading-tight">{option.helper}</div>
                    </button>
                  );
                })}
              </div>
            </FormField>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Template Status">
              <select value={status} onChange={(event) => setStatus(event.target.value === "inactive" ? "inactive" : "active")} className={selectClass}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </FormField>
          </div>
          <FormField label="Visit Reasons *">
            {reasonOptions.length > 0 ? (
              <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                {reasonOptions.map((reason) => (
                  <label key={reason.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 cursor-pointer hover:border-indigo-200 transition-colors">
                    <input
                      type="checkbox"
                      checked={reasonIds.includes(reason.id)}
                      onChange={(event) =>
                        setReasonIds((prev) =>
                          event.target.checked
                            ? [...prev, reason.id]
                            : prev.filter((id) => id !== reason.id),
                        )
                      }
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600"
                    />
                    <span className="text-[13px]">{reason.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[12px] text-muted-foreground flex items-center">
                Add visit reasons first.
              </div>
            )}
          </FormField>
          {normalizedType === "rooming" && (
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-3">
              <div className="text-[12px] text-emerald-800" style={{ fontWeight: 700 }}>
                Standard MA Rooming fields are always collected outside this template
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                {[
                  "Allergies changed",
                  "Medication reconciliation changed",
                  "Lab changed",
                  "Pharmacy changed",
                  "Blood pressure",
                  "Temperature",
                  "Pulse",
                  "Respirations",
                  "Oxygen saturation",
                  "Height",
                  "Weight",
                  "Pain score",
                ].map((label) => (
                  <div key={label} className="rounded-md bg-white border border-emerald-100 px-2.5 py-1.5 text-[11px] text-emerald-900">
                    {label}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-emerald-700 mt-2">
                Use template fields only for visit-reason-specific questions. Structured vital input types are available for additional clinical fields when needed.
              </p>
            </div>
          )}
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[12px]" style={{ fontWeight: 600 }}>Sections & Presentation</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => applyStarterSections()}
                  disabled={!normalizedType}
                  className="h-7 px-3 rounded-lg border border-indigo-200 text-[11px] text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ fontWeight: 500 }}
                >
                  Use Starter Layout
                </button>
                <button
                  type="button"
                  onClick={addSection}
                  className="h-7 px-3 rounded-lg border border-indigo-200 text-[11px] text-indigo-600 hover:bg-indigo-50 transition-colors flex items-center gap-1.5"
                  style={{ fontWeight: 500 }}
                >
                  <Plus className="w-3 h-3" /> Add Section
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Set section names, icon, and accent color first. Then place questions into each section.
            </p>
            <div className="space-y-2">
              {sections.map((section, index) => (
                <div key={section.id} className="rounded-lg border border-indigo-100 bg-white p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const iconConfig = getSectionIconConfig(section.icon);
                        const IconComponent = iconConfig.icon;
                        return (
                          <span
                            className="w-6 h-6 rounded-md shrink-0 border flex items-center justify-center"
                            style={{
                              borderColor: `${section.color}55`,
                              backgroundColor: `${section.color}18`,
                              color: section.color,
                            }}
                          >
                            <IconComponent className="w-3.5 h-3.5" />
                          </span>
                        );
                      })()}
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: section.color }}
                      />
                      <span className="text-[12px] truncate" style={{ fontWeight: 600 }}>
                        {section.name || `Section ${index + 1}`}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {sectionFieldCounts.get(section.name) || 0} fields
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSection(index)}
                      disabled={sections.length <= 1}
                      className="h-7 px-2.5 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ fontWeight: 500 }}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_120px_150px] gap-2 items-end">
                    <FormField label="Section Name">
                      <input
                        value={section.name}
                        onChange={(event) => {
                          const previousName = sections[index]?.name || "";
                          const nextName = event.target.value;
                          updateSection(index, { name: nextName });
                          setFields((prev) =>
                            prev.map((field) =>
                              field.group === previousName
                                ? { ...field, group: nextName || previousName }
                                : field,
                            ),
                          );
                        }}
                        type="text"
                        className={inputClass}
                      />
                    </FormField>
                    <FormField label="Icon">
                      <div className="grid grid-cols-3 gap-1.5">
                        {sectionIconOptions.map((iconOption) => {
                          const Icon = iconOption.icon;
                          const selected = section.icon === iconOption.value;
                          return (
                            <button
                              key={`${section.id}-${iconOption.value}`}
                              type="button"
                              onClick={() => updateSection(index, { icon: iconOption.value })}
                              className={`h-8 rounded-md border flex items-center justify-center transition-colors ${
                                selected
                                  ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                                  : "border-gray-200 text-gray-500 hover:bg-gray-50"
                              }`}
                              title={iconOption.label}
                            >
                              <Icon className="w-3.5 h-3.5" />
                            </button>
                          );
                        })}
                      </div>
                    </FormField>
                    <FormField label="Accent Color">
                      <div className="flex items-center gap-2">
                        <input
                          value={section.color}
                          onChange={(event) => updateSection(index, { color: event.target.value })}
                          type="color"
                          className="w-10 h-10 rounded-lg border border-gray-200 cursor-pointer"
                        />
                        <input
                          value={section.color}
                          onChange={(event) => updateSection(index, { color: event.target.value })}
                          type="text"
                          className={inputClass}
                        />
                      </div>
                    </FormField>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-indigo-100 bg-white px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground mb-2">Section Preview</div>
              <div className="flex flex-wrap gap-2">
                {sections.map((section) => {
                  const iconConfig = getSectionIconConfig(section.icon);
                  const Icon = iconConfig.icon;
                  return (
                  <div
                    key={`preview-${section.id}`}
                    className="h-7 px-2.5 rounded-full border flex items-center gap-1.5 text-[11px]"
                    style={{
                      borderColor: `${section.color}55`,
                      backgroundColor: `${section.color}14`,
                      color: section.color,
                      fontWeight: 500,
                    }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{section.name}</span>
                    <span className="text-[10px] opacity-75">({sectionFieldCounts.get(section.name) || 0})</span>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 600 }}>
                <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                Form Builder
              </div>
              <button
                type="button"
                onClick={addField}
                className="h-7 px-3 rounded-lg border border-indigo-200 text-[11px] text-indigo-600 hover:bg-indigo-50 transition-colors flex items-center gap-1.5"
                style={{ fontWeight: 500 }}
              >
                <Plus className="w-3 h-3" /> Add Question
              </button>
            </div>
            <div className="space-y-3">
              {fields.map((field, index) => {
                const fieldError = fieldErrorMap[index] || {};
                const hasFieldError = Boolean(fieldError.label || fieldError.options || fieldError.key);
                const derivedKey = toTemplateFieldKey(field.label || field.key || "", index + 1);
                return (
                <div
                  key={field.id || `${index}`}
                  className={`rounded-xl border p-3 space-y-2 transition-all ${
                    hasFieldError
                      ? "border-red-200 bg-red-50/40 shadow-sm"
                      : "border-gray-100 bg-white hover:border-indigo-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-[12px] text-muted-foreground flex items-center gap-2" style={{ fontWeight: 500 }}>
                      <span>Question {index + 1}</span>
                      <span className={`text-[10px] ${fieldError.key ? "text-red-600" : "text-gray-400"}`}>
                        Key: <code>{derivedKey}</code>
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveField(index, -1)}
                        disabled={index === 0}
                        className="w-7 h-7 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                        title="Move up"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveField(index, 1)}
                        disabled={index === fields.length - 1}
                        className="w-7 h-7 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                        title="Move down"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeField(index)}
                        disabled={fields.length <= 1}
                        className="h-7 px-2.5 rounded-lg border border-red-200 text-[11px] text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ fontWeight: 500 }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {fieldError.key && (
                    <p className="text-[10px] text-red-600 -mt-1">{fieldError.key}</p>
                  )}
                  <FormField label="Question Label *">
                    <input
                      value={field.label}
                      onChange={(event) => updateField(index, { label: event.target.value })}
                      type="text"
                      placeholder="e.g. Chief Complaint"
                      className={`${inputClass} ${fieldError.label ? "border-red-300 focus:border-red-400 focus:ring-red-100 bg-white" : ""}`}
                    />
                    {fieldError.label ? (
                      <p className="text-[10px] text-red-600 mt-1">{fieldError.label}</p>
                    ) : (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        This is what staff will see while completing the workflow.
                      </p>
                    )}
                  </FormField>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <FormField label="Input Type *">
                      <select
                        value={field.type}
                        onChange={(event) => updateField(index, {
                          type: event.target.value as typeof field.type,
                          options:
                            event.target.value === "select" || event.target.value === "radio"
                              ? field.options && field.options.length > 0
                                ? field.options
                                : ["Option 1"]
                              : [],
                        })}
                        className={`${selectClass} ${fieldError.options ? "border-red-300 focus:border-red-400 focus:ring-red-100 bg-white" : ""}`}
                      >
                        {(Object.keys(templateFieldTypeLabel) as Array<keyof typeof templateFieldTypeLabel>).map((fieldType) => (
                          <option key={fieldType} value={fieldType}>
                            {templateFieldTypeLabel[fieldType]}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <FormField label="Section">
                      <select
                        value={field.group || "General"}
                        onChange={(event) => {
                          const sectionName = event.target.value;
                          const selectedSection =
                            sections.find((section) => section.name === sectionName) ||
                            defaultTemplateSections.find((section) => section.name === sectionName) ||
                            defaultTemplateSections[0];
                          updateField(index, {
                            group: sectionName,
                            icon: selectedSection.icon,
                            color: selectedSection.color,
                          });
                        }}
                        className={selectClass}
                      >
                        {sections.map((section) => (
                          <option key={section.id} value={section.name}>
                            {getSectionIconConfig(section.icon).label} · {section.name}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <div className="flex items-end">
                      <div
                        className="h-10 w-full rounded-lg border px-3 flex items-center text-[12px]"
                        style={{
                          borderColor: `${field.color || "#cbd5e1"}`,
                          backgroundColor: `${field.color || "#cbd5e1"}22`,
                          color: field.color || "#334155",
                          fontWeight: 500,
                        }}
                      >
                        {(() => {
                          const iconConfig = getSectionIconConfig(field.icon || "Clipboard");
                          const Icon = iconConfig.icon;
                          return (
                            <>
                              <Icon className="w-3.5 h-3.5 mr-1.5" />
                              <span>{field.group || "General"}</span>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    <FormField label="Required">
                      <label className="h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[13px] flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(field.required)}
                          onChange={(event) => updateField(index, { required: event.target.checked })}
                          className="w-4 h-4 rounded border-gray-300 text-indigo-600"
                        />
                        <span>Required</span>
                      </label>
                    </FormField>
                  </div>
                  {(field.type === "select" || field.type === "radio") && (
                    <FormField label="Options *">
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                          {(field.options || []).map((option, optionIndex) => (
                            <span
                              key={`${field.id || index}-option-${optionIndex}`}
                              className="h-7 px-2.5 rounded-full border border-indigo-200 bg-indigo-50 text-[11px] text-indigo-700 inline-flex items-center gap-1.5"
                            >
                              {option}
                              <button
                                type="button"
                                onClick={() => removeFieldOption(index, optionIndex)}
                                className="text-indigo-500 hover:text-indigo-700"
                                aria-label={`Remove option ${option}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            value={optionDrafts[fieldDraftKey(field, index)] || ""}
                            onChange={(event) =>
                              setOptionDrafts((prev) => ({
                                ...prev,
                                [fieldDraftKey(field, index)]: event.target.value,
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                addFieldOption(index);
                              }
                            }}
                            type="text"
                            placeholder="Add option label"
                            className={`${inputClass} ${fieldError.options ? "border-red-300 focus:border-red-400 focus:ring-red-100 bg-white" : ""}`}
                          />
                          <button
                            type="button"
                            onClick={() => addFieldOption(index)}
                            className="h-10 px-3 rounded-lg border border-indigo-200 text-[12px] text-indigo-600 hover:bg-indigo-50 transition-colors"
                            style={{ fontWeight: 600 }}
                          >
                            Add
                          </button>
                        </div>
                        {fieldError.options ? (
                          <p className="text-[10px] text-red-600 mt-1">{fieldError.options}</p>
                        ) : (
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Add each answer choice one at a time. Press Enter to add quickly.
                          </p>
                        )}
                      </div>
                    </FormField>
                  )}
                </div>
              )})}
            </div>
          </div>
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/30 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-[12px]" style={{ fontWeight: 600 }}>Live Form Preview</span>
            </div>
            {previewGroups.size === 0 ? (
              <div className="rounded-lg border border-dashed border-emerald-200 bg-white/70 px-3 py-4 text-center">
                <p className="text-[12px] text-gray-600" style={{ fontWeight: 500 }}>
                  Form preview will appear here
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Add at least one complete question with a unique label.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from(previewGroups.entries()).map(([group, groupFields]) => {
                  const section =
                    sections.find((entry) => entry.name === group) ||
                    defaultTemplateSections.find((entry) => entry.name === group) ||
                    defaultTemplateSections[0];
                  return (
                    <div key={`preview-group-${group}`} className="rounded-lg border border-emerald-100 bg-white p-2.5">
                      <div
                        className="h-7 px-2.5 rounded-lg flex items-center text-[11px] mb-2"
                        style={{
                          backgroundColor: `${section.color}14`,
                          color: section.color,
                          fontWeight: 600,
                        }}
                      >
                        {(() => {
                          const iconConfig = getSectionIconConfig(section.icon);
                          const Icon = iconConfig.icon;
                          return (
                            <>
                              <Icon className="w-3.5 h-3.5 mr-1.5" />
                              <span>{group}</span>
                            </>
                          );
                        })()}
                      </div>
                      <div className="space-y-1.5">
                        {groupFields.map((field) => (
                          <div key={`preview-field-${group}-${field.key}`} className="flex items-center gap-2 text-[11px] text-gray-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />
                            <span className="flex-1 truncate">{field.label}</span>
                            <span className="text-[10px] text-muted-foreground">{templateFieldTypeLabel[field.type]}</span>
                            {field.required && (
                              <span className="text-[9px] text-red-500 uppercase tracking-wider" style={{ fontWeight: 600 }}>
                                Required
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {fieldErrors.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-700 space-y-1">
              <div className="text-[11px] uppercase tracking-wider text-amber-600" style={{ fontWeight: 700 }}>
                Fix Before Saving
              </div>
              {fieldErrors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          )}
        </div>
        <ModalActions
          onClose={onClose}
          label={submitLabel || "Save Template"}
          disabled={!name.trim() || !normalizedType || reasonIds.length === 0 || validFields.length === 0 || hasInvalidField || submitting}
          onSubmit={() => {
            if (!name.trim() || !normalizedType || reasonIds.length === 0 || validFields.length === 0 || hasInvalidField) {
              toast.error("Please fix invalid template fields before saving.");
              return;
            }
            setSubmitting(true);
            submitWithToast(
              submitLabel || "Save Template",
              () =>
                onSubmit({
                  name: name.trim(),
                  type: normalizedType,
                  status,
                  reasonIds,
                  fields: validFields.map((field) => ({
                    id: field.id,
                    key: field.key,
                    label: field.label,
                    type: field.type,
                    required: Boolean(field.required),
                    options:
                      field.type === "select" || field.type === "radio"
                        ? field.options
                        : undefined,
                    group: field.group,
                    icon: field.icon,
                    color: field.color,
                  })),
                }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddThresholdModal({
  open,
  onClose,
  clinics,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  clinics: { id: string; name: string; shortCode: string }[];
  onSubmit: (payload: {
    metric: "stage" | "overall_visit";
    status?: string;
    clinicId?: string;
    yellowMinutes: number;
    redMinutes: number;
  }) => Promise<void>;
}) {
  const [metric, setMetric] = useState<"stage" | "overall_visit">("stage");
  const [status, setStatus] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [yellowMinutes, setYellowMinutes] = useState(15);
  const [redMinutes, setRedMinutes] = useState(25);
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">Add Threshold Override</DialogTitle>
          <DialogDescription className="text-[12px]">Clinic-specific override for facility defaults.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="Metric *">
              <select value={metric} onChange={(event) => setMetric(event.target.value === "overall_visit" ? "overall_visit" : "stage")} className={selectClass}>
                <option value="stage">Stage</option>
                <option value="overall_visit">Overall Visit</option>
              </select>
            </FormField>
            <FormField label="Status *">
              {metric === "stage" ? (
                <select value={status} onChange={(event) => setStatus(event.target.value)} className={selectClass}>
                  <option value="">Select status...</option>
                  <option>Lobby</option>
                  <option>Rooming</option>
                  <option>ReadyForProvider</option>
                  <option>Optimizing</option>
                  <option>CheckOut</option>
                </select>
              ) : (
                <div className="h-10 px-3 rounded-lg border border-gray-200 bg-gray-50 text-[12px] text-muted-foreground flex items-center">
                  Overall Visit
                </div>
              )}
            </FormField>
            <FormField label="Clinic *">
              <select value={clinicId} onChange={(event) => setClinicId(event.target.value)} className={selectClass}>
                <option value="">All Clinics (default)</option>
                {clinics.map((clinic) => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
              </select>
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Yellow Threshold (min) *"><NumberStepper value={yellowMinutes} onChange={setYellowMinutes} min={1} /></FormField>
            <FormField label="Red Threshold (min) *"><NumberStepper value={redMinutes} onChange={setRedMinutes} min={1} /></FormField>
          </div>
        </div>
        <ModalActions
          onClose={onClose}
          label="Add Override"
          disabled={(metric === "stage" && !status) || yellowMinutes <= 0 || redMinutes <= 0 || submitting}
          onSubmit={() => {
            if ((metric === "stage" && !status) || yellowMinutes <= 0 || redMinutes <= 0) return;
            setSubmitting(true);
            submitWithToast(
              "Add Override",
              () =>
                onSubmit({
                  metric,
                  status: metric === "stage" ? status : undefined,
                  clinicId: clinicId || undefined,
                  yellowMinutes,
                  redMinutes,
                }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddNotificationPolicyModal({
  open,
  onClose,
  clinics,
  initialValues,
  title,
  description,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  clinics: { id: string; name: string; shortCode: string }[];
  initialValues?: {
    clinicId?: string;
    status?: string;
    severity?: string;
    recipients?: string[];
    channels?: string[];
    cooldownMinutes?: number;
  };
  title?: string;
  description?: string;
  submitLabel?: string;
  onSubmit: (payload: { clinicId: string; status: string; severity: string; recipients: string[]; channels: string[]; cooldownMinutes: number }) => Promise<void>;
}) {
  const [clinicId, setClinicId] = useState("");
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [cooldownMinutes, setCooldownMinutes] = useState(10);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setClinicId(initialValues?.clinicId || "");
    setStatus(initialValues?.status || "");
    setSeverity(initialValues?.severity || "");
    setRecipients(Array.isArray(initialValues?.recipients) ? initialValues.recipients : []);
    setChannels(Array.isArray(initialValues?.channels) ? initialValues.channels : []);
    setCooldownMinutes(initialValues?.cooldownMinutes ?? 10);
  }, [open, initialValues]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">{title || "Add Notification Policy"}</DialogTitle>
          <DialogDescription className="text-[12px]">{description || "Define alert routing and cooldown."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Clinic *">
              <select value={clinicId} onChange={(event) => setClinicId(event.target.value)} className={selectClass}>
                <option value="">Select...</option>
                {clinics.map((clinic) => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
              </select>
            </FormField>
            <FormField label="Status *">
              <select value={status} onChange={(event) => setStatus(event.target.value)} className={selectClass}>
                <option value="">Select...</option>
                <option>Lobby</option>
                <option>Rooming</option>
                <option>ReadyForProvider</option>
                <option>Optimizing</option>
                <option>CheckOut</option>
              </select>
            </FormField>
            <FormField label="Severity *">
              <select value={severity} onChange={(event) => setSeverity(event.target.value)} className={selectClass}>
                <option value="">Select...</option>
                <option>Yellow</option>
                <option>Red</option>
              </select>
            </FormField>
          </div>
          <FormField label="Recipients">
            <div className="flex flex-wrap gap-2">
              {["MA", "Admin", "Clinician", "FrontDeskCheckIn", "FrontDeskCheckOut", "OfficeManager"].map((role) => (
                <label key={role} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-100 cursor-pointer hover:border-indigo-200 transition-colors">
                  <input
                    type="checkbox"
                    checked={recipients.includes(role)}
                    onChange={(event) =>
                      setRecipients((prev) =>
                        event.target.checked
                          ? [...prev, role]
                          : prev.filter((entry) => entry !== role),
                      )
                    }
                    className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600"
                  />
                  <span className="text-[12px]">{role}</span>
                </label>
              ))}
            </div>
          </FormField>
          <FormField label="Channels">
            <div className="flex flex-wrap gap-2">
              {["in_app", "email", "sms"].map((channel) => (
                <label key={channel} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-100 cursor-pointer hover:border-indigo-200 transition-colors">
                  <input
                    type="checkbox"
                    checked={channels.includes(channel)}
                    onChange={(event) =>
                      setChannels((prev) =>
                        event.target.checked
                          ? [...prev, channel]
                          : prev.filter((entry) => entry !== channel),
                      )
                    }
                    className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600"
                  />
                  <span className="text-[12px]">{channelLabel(channel)}</span>
                </label>
              ))}
            </div>
          </FormField>
          <FormField label="Cooldown (minutes)">
            <NumberStepper value={cooldownMinutes} onChange={setCooldownMinutes} min={1} />
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Cooldown prevents duplicate alerts from firing repeatedly within this time window.
            </p>
          </FormField>
        </div>
        <ModalActions
          onClose={onClose}
          label={submitLabel || "Add Policy"}
          disabled={!clinicId || !status || !severity || recipients.length === 0 || channels.length === 0 || cooldownMinutes <= 0 || submitting}
          onSubmit={() => {
            if (!clinicId || !status || !severity || recipients.length === 0 || channels.length === 0 || cooldownMinutes <= 0) return;
            setSubmitting(true);
            submitWithToast(
              submitLabel || "Add Policy",
              () => onSubmit({ clinicId, status, severity, recipients, channels, cooldownMinutes }),
              onClose,
            ).finally(() => setSubmitting(false));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
