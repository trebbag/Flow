// ── Mock Data for Flow — Clinical Operations ──
// These types and data power the Figma Make prototype UI.
// Types here are VIEW-MODEL shapes (denormalized for display).
// Canonical backend-aligned types live in ./types.ts
// API client for wiring to real backend lives in ./api-client.ts
//
// ── Type re-exports from canonical types ──
// The mock Encounter interface below is a VIEW-MODEL (EncounterView)
// that includes denormalized display fields. When wiring to the real
// backend, map EncounterBase → EncounterView using lookup maps for
// clinics, providers, reasons, and staff.

export type { EncounterStatus, AlertLevel, RevenueCycleStatus } from "./types";
import type { EncounterStatus, AlertLevel, RevenueCycleStatus } from "./types";

export interface Encounter {
  id: string;
  patientId: string;
  patientInitials: string;
  clinicId: string;
  clinicName: string;
  clinicShortCode: string;
  clinicColor: string;
  provider: string;
  providerInitials: string;
  visitType: string;
  status: EncounterStatus;
  version: number;
  checkinTime: string;
  appointmentTime?: string;
  currentStageStart: string;
  checkInAtIso?: string;
  currentStageStartAtIso?: string;
  completedAtIso?: string;
  minutesInStage: number;
  alertLevel: AlertLevel;
  assignedMA?: string;
  maColor?: string;
  safetyActive?: boolean;
  roomNumber?: string;
  walkIn?: boolean;
  insuranceVerified?: boolean;
  arrivalNotes?: string;
  intakeData?: Record<string, unknown> | null;
  roomingData?: Record<string, unknown> | null;
  clinicianData?: Record<string, unknown> | null;
  checkoutData?: Record<string, unknown> | null;
  statusEvents?: Array<{
    fromStatus?: EncounterStatus | null;
    toStatus: EncounterStatus;
    changedAt: string;
    reasonCode?: string | null;
  }>;
  closureType?: string;
  cardTags?: string[];
}

export interface Provider {
  name: string;
  initials: string;
  specialty: string;
  activeEncounters: number;
  completedToday: number;
  avgCycleTime: number;
  utilization: number;
  avatarColor: string;
}

export interface StageMetric {
  stage: string;
  avgMinutes: number;
  target: number;
  count: number;
  slaCompliance: number;
  color: string;
}

export interface HourlyVolume {
  hour: string;
  checkins: number;
  completed: number;
  inProgress: number;
}

export interface Alert {
  id: string;
  type: "Yellow" | "Red" | "safety";
  message: string;
  encounterId: string;
  timestamp: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
}

export interface Room {
  id: string;
  clinicId: string;
  clinicName: string;
  name: string;
  active: boolean;
  occupied: boolean;
  encounterId?: string;
  patientId?: string;
  status?: EncounterStatus;
  providerName?: string;
  assignedMaName?: string;
  alertLevel?: AlertLevel;
  safetyActive: boolean;
}

export interface RevenueCycleRow {
  encounterId: string;
  patientId: string;
  clinicName: string;
  clinicColor: string;
  providerName: string;
  status: RevenueCycleStatus;
  assigneeName: string | null;
  dueAt: string | null;
  priority: number;
  notes: string | null;
  holdReason: string | null;
  reviewedAt: string | null;
  optimizedAt: string;
  providerQueryOpenCount: number;
}

export interface CloseoutRow {
  encounterId: string;
  patientId: string;
  clinicName: string;
  clinicColor: string;
  currentStatus: EncounterStatus;
  version: number;
  providerName: string;
  assignedMaName: string | null;
  roomName: string | null;
  alertLevel: AlertLevel;
  enteredStatusAt: string;
  statusElapsedMs: number;
  safetyActive: boolean;
}

export const encounters: Encounter[] = [
  { id: "E-1042", patientId: "PT-8821", patientInitials: "MJ", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Chen", providerInitials: "LC", visitType: "Follow-up", status: "Lobby", version: 2, checkinTime: "08:12", currentStageStart: "08:12", minutesInStage: 18, alertLevel: "Yellow", assignedMA: "Sarah K.", maColor: "#6366f1", insuranceVerified: true },
  { id: "E-1043", patientId: "PT-4419", patientInitials: "RB", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Patel", providerInitials: "SP", visitType: "Annual Physical", status: "Rooming", version: 3, checkinTime: "08:05", currentStageStart: "08:20", minutesInStage: 10, alertLevel: "Green", roomNumber: "Room 3", assignedMA: "Mike T.", maColor: "#f59e0b" },
  { id: "E-1044", patientId: "PT-2203", patientInitials: "AL", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Chen", providerInitials: "LC", visitType: "Sick Visit", status: "ReadyForProvider", version: 4, checkinTime: "07:55", currentStageStart: "08:15", minutesInStage: 15, alertLevel: "Green", roomNumber: "Room 1", assignedMA: "Sarah K.", maColor: "#6366f1" },
  { id: "E-1045", patientId: "PT-7701", patientInitials: "DP", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Martinez", providerInitials: "JM", visitType: "Follow-up", status: "Optimizing", version: 5, checkinTime: "08:00", currentStageStart: "08:10", minutesInStage: 20, alertLevel: "Yellow", roomNumber: "Room 5", assignedMA: "Mike T.", maColor: "#f59e0b" },
  { id: "E-1046", patientId: "PT-3382", patientInitials: "KW", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Patel", providerInitials: "SP", visitType: "New Patient", status: "CheckOut", version: 6, checkinTime: "07:30", currentStageStart: "08:25", minutesInStage: 5, alertLevel: "Green", roomNumber: "Room 2" },
  { id: "E-1047", patientId: "PT-5590", patientInitials: "TN", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Martinez", providerInitials: "JM", visitType: "Procedure", status: "Lobby", version: 2, checkinTime: "08:20", currentStageStart: "08:20", minutesInStage: 10, alertLevel: "Green", assignedMA: "Lisa R.", maColor: "#10b981", walkIn: true },
  { id: "E-1048", patientId: "PT-1128", patientInitials: "SH", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Chen", providerInitials: "LC", visitType: "Follow-up", status: "Incoming", version: 1, checkinTime: "08:30", currentStageStart: "08:30", minutesInStage: 0, alertLevel: "Green" },
  { id: "E-1049", patientId: "PT-6654", patientInitials: "BF", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Patel", providerInitials: "SP", visitType: "Sick Visit", status: "Rooming", version: 3, checkinTime: "08:10", currentStageStart: "08:22", minutesInStage: 8, alertLevel: "Green", roomNumber: "Room 4", assignedMA: "Lisa R.", maColor: "#10b981" },
  { id: "E-1050", patientId: "PT-9907", patientInitials: "CG", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Martinez", providerInitials: "JM", visitType: "Annual Physical", status: "Optimized", version: 7, checkinTime: "07:00", currentStageStart: "07:55", minutesInStage: 0, alertLevel: "Green" },
  { id: "E-1051", patientId: "PT-4421", patientInitials: "JR", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Chen", providerInitials: "LC", visitType: "Follow-up", status: "Optimized", version: 7, checkinTime: "07:15", currentStageStart: "08:05", minutesInStage: 0, alertLevel: "Green" },
  { id: "E-1052", patientId: "PT-3310", patientInitials: "EV", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Patel", providerInitials: "SP", visitType: "Sick Visit", status: "Optimized", version: 7, checkinTime: "07:20", currentStageStart: "08:10", minutesInStage: 0, alertLevel: "Green" },
  { id: "E-1053", patientId: "PT-1199", patientInitials: "WM", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Martinez", providerInitials: "JM", visitType: "Follow-up", status: "Lobby", version: 2, checkinTime: "08:25", currentStageStart: "08:25", minutesInStage: 5, alertLevel: "Green" },
  { id: "E-1054", patientId: "PT-8832", patientInitials: "NH", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Chen", providerInitials: "LC", visitType: "New Patient", status: "Rooming", version: 3, checkinTime: "08:02", currentStageStart: "08:18", minutesInStage: 12, alertLevel: "Green", roomNumber: "Room 6", assignedMA: "Sarah K.", maColor: "#6366f1", safetyActive: true },
  { id: "E-1055", patientId: "PT-2287", patientInitials: "FT", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Patel", providerInitials: "SP", visitType: "Follow-up", status: "Incoming", version: 1, checkinTime: "08:45", currentStageStart: "08:45", minutesInStage: 0, alertLevel: "Green" },
  { id: "E-1058", patientId: "PT-6102", patientInitials: "DR", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Martinez", providerInitials: "JM", visitType: "Sick Visit", status: "ReadyForProvider", version: 4, checkinTime: "07:40", currentStageStart: "07:58", minutesInStage: 32, alertLevel: "Red", roomNumber: "Room 9", assignedMA: "Lisa R.", maColor: "#10b981" },
  { id: "E-1056", patientId: "PT-7744", patientInitials: "GS", clinicId: "c2", clinicName: "Eastside Family Care", clinicShortCode: "ES", clinicColor: "#10b981", provider: "Dr. Martinez", providerInitials: "JM", visitType: "Sick Visit", status: "CheckOut", version: 6, checkinTime: "07:45", currentStageStart: "08:28", minutesInStage: 2, alertLevel: "Green", roomNumber: "Room 7" },
  { id: "E-1057", patientId: "PT-5512", patientInitials: "LB", clinicId: "c1", clinicName: "Downtown Clinic", clinicShortCode: "DT", clinicColor: "#6366f1", provider: "Dr. Chen", providerInitials: "LC", visitType: "Sick Visit", status: "Optimizing", version: 5, checkinTime: "07:50", currentStageStart: "08:15", minutesInStage: 15, alertLevel: "Green", roomNumber: "Room 8", assignedMA: "Mike T.", maColor: "#f59e0b" },
];

export const clinics = [
  { id: "c1", name: "Downtown Clinic", shortCode: "DT", color: "#6366f1" },
  { id: "c2", name: "Eastside Family Care", shortCode: "ES", color: "#10b981" },
];

export const providers: Provider[] = [
  { name: "Dr. Lisa Chen", initials: "LC", specialty: "Family Medicine", activeEncounters: 3, completedToday: 5, avgCycleTime: 42, utilization: 88, avatarColor: "#6366f1" },
  { name: "Dr. Sanjay Patel", initials: "SP", specialty: "Internal Medicine", activeEncounters: 2, completedToday: 4, avgCycleTime: 48, utilization: 76, avatarColor: "#10b981" },
  { name: "Dr. Juan Martinez", initials: "JM", specialty: "Family Medicine", activeEncounters: 2, completedToday: 3, avgCycleTime: 55, utilization: 65, avatarColor: "#f59e0b" },
];

// ── Staff users (for assignedToUserId picker) ──

export type StaffUser = {
  id: string;
  name: string;
  initials: string;
  role: "MA" | "FrontDesk" | "Clinician" | "Admin";
  clinicId: string;
  color: string;
};

export const staffUsers: StaffUser[] = [
  { id: "u1", name: "Sarah K.", initials: "SK", role: "MA", clinicId: "c1", color: "#6366f1" },
  { id: "u2", name: "Mike T.", initials: "MT", role: "MA", clinicId: "c1", color: "#f59e0b" },
  { id: "u3", name: "Lisa R.", initials: "LR", role: "MA", clinicId: "c2", color: "#10b981" },
  { id: "u4", name: "Janet W.", initials: "JW", role: "FrontDesk", clinicId: "c1", color: "#ec4899" },
  { id: "u5", name: "Carlos D.", initials: "CD", role: "FrontDesk", clinicId: "c2", color: "#0ea5e9" },
  { id: "u6", name: "Dr. Lisa Chen", initials: "LC", role: "Clinician", clinicId: "c1", color: "#6366f1" },
  { id: "u7", name: "Dr. Sanjay Patel", initials: "SP", role: "Clinician", clinicId: "c2", color: "#10b981" },
  { id: "u8", name: "Dr. Juan Martinez", initials: "JM", role: "Clinician", clinicId: "c1", color: "#f59e0b" },
];

export const stageMetrics: StageMetric[] = [
  { stage: "Lobby", avgMinutes: 12, target: 15, count: 3, slaCompliance: 87, color: "#6366f1" },
  { stage: "Rooming", avgMinutes: 10, target: 12, count: 3, slaCompliance: 92, color: "#8b5cf6" },
  { stage: "Ready", avgMinutes: 8, target: 10, count: 1, slaCompliance: 78, color: "#f59e0b" },
  { stage: "Optimizing", avgMinutes: 22, target: 25, count: 2, slaCompliance: 85, color: "#a78bfa" },
  { stage: "Checkout", avgMinutes: 6, target: 8, count: 2, slaCompliance: 95, color: "#10b981" },
];

export const hourlyVolume: HourlyVolume[] = [
  { hour: "7 AM", checkins: 4, completed: 3, inProgress: 1 },
  { hour: "8 AM", checkins: 8, completed: 2, inProgress: 7 },
  { hour: "9 AM", checkins: 6, completed: 5, inProgress: 8 },
  { hour: "10 AM", checkins: 5, completed: 6, inProgress: 7 },
  { hour: "11 AM", checkins: 3, completed: 4, inProgress: 6 },
  { hour: "12 PM", checkins: 2, completed: 3, inProgress: 5 },
  { hour: "1 PM", checkins: 5, completed: 4, inProgress: 6 },
  { hour: "2 PM", checkins: 4, completed: 5, inProgress: 5 },
  { hour: "3 PM", checkins: 3, completed: 4, inProgress: 4 },
  { hour: "4 PM", checkins: 2, completed: 3, inProgress: 3 },
];

export const alerts: Alert[] = [
  { id: "A-1", type: "Yellow", message: "PT-8821 in Lobby for 18 min (threshold: 15 min)", encounterId: "E-1042", timestamp: "08:27", acknowledged: false },
  { id: "A-2", type: "Yellow", message: "PT-7701 in Optimizing for 20 min (threshold: 15 min)", encounterId: "E-1045", timestamp: "08:25", acknowledged: false },
  { id: "A-3", type: "safety", message: "Safety Assist activated for PT-8832 in Room 6", encounterId: "E-1054", timestamp: "08:24", acknowledged: false },
  { id: "A-4", type: "Red", message: "PT-2203 total cycle time exceeding 90 min target", encounterId: "E-1044", timestamp: "08:20", acknowledged: true, acknowledgedBy: "Sarah K." },
];

export const rooms: Room[] = [
  { id: "r1", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 1", active: true, occupied: true, encounterId: "E-1044", patientId: "PT-2203", status: "ReadyForProvider", providerName: "Dr. Chen", assignedMaName: "Sarah K.", alertLevel: "Green", safetyActive: false },
  { id: "r2", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 2", active: true, occupied: true, encounterId: "E-1046", patientId: "PT-3382", status: "CheckOut", providerName: "Dr. Patel", alertLevel: "Green", safetyActive: false },
  { id: "r3", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 3", active: true, occupied: true, encounterId: "E-1043", patientId: "PT-4419", status: "Rooming", providerName: "Dr. Patel", assignedMaName: "Mike T.", alertLevel: "Green", safetyActive: false },
  { id: "r4", clinicId: "c2", clinicName: "Eastside Family Care", name: "Room 4", active: true, occupied: true, encounterId: "E-1049", patientId: "PT-6654", status: "Rooming", providerName: "Dr. Patel", assignedMaName: "Lisa R.", alertLevel: "Green", safetyActive: false },
  { id: "r5", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 5", active: true, occupied: true, encounterId: "E-1045", patientId: "PT-7701", status: "Optimizing", providerName: "Dr. Martinez", assignedMaName: "Mike T.", alertLevel: "Yellow", safetyActive: false },
  { id: "r6", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 6", active: true, occupied: true, encounterId: "E-1054", patientId: "PT-8832", status: "Rooming", providerName: "Dr. Chen", assignedMaName: "Sarah K.", alertLevel: "Green", safetyActive: true },
  { id: "r7", clinicId: "c2", clinicName: "Eastside Family Care", name: "Room 7", active: true, occupied: true, encounterId: "E-1056", patientId: "PT-7744", status: "CheckOut", providerName: "Dr. Martinez", alertLevel: "Green", safetyActive: false },
  { id: "r8", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 8", active: true, occupied: true, encounterId: "E-1057", patientId: "PT-5512", status: "Optimizing", providerName: "Dr. Chen", assignedMaName: "Mike T.", alertLevel: "Green", safetyActive: false },
  { id: "r9", clinicId: "c2", clinicName: "Eastside Family Care", name: "Room 9", active: true, occupied: false, safetyActive: false },
  { id: "r10", clinicId: "c1", clinicName: "Downtown Clinic", name: "Room 10", active: false, occupied: false, safetyActive: false },
];

export const revenueCycleRows: RevenueCycleRow[] = [
  { encounterId: "E-1050", patientId: "PT-9907", clinicName: "Downtown Clinic", clinicColor: "#6366f1", providerName: "Dr. Martinez", status: "ChargeCapturePending", assigneeName: null, dueAt: "2026-02-27T17:00:00Z", priority: 1, notes: null, holdReason: null, reviewedAt: null, optimizedAt: "2026-02-27T07:55:00Z", providerQueryOpenCount: 0 },
  { encounterId: "E-1051", patientId: "PT-4421", clinicName: "Downtown Clinic", clinicColor: "#6366f1", providerName: "Dr. Chen", status: "CodingInProgress", assigneeName: "Amy L.", dueAt: "2026-02-27T18:00:00Z", priority: 2, notes: "Needs modifier review", holdReason: null, reviewedAt: null, optimizedAt: "2026-02-27T08:05:00Z", providerQueryOpenCount: 1 },
  { encounterId: "E-1052", patientId: "PT-3310", clinicName: "Eastside Family Care", clinicColor: "#10b981", providerName: "Dr. Patel", status: "ProviderClarificationNeeded", assigneeName: "Amy L.", dueAt: "2026-02-27T16:00:00Z", priority: 1, notes: "Clarify E/M level", holdReason: null, reviewedAt: null, optimizedAt: "2026-02-27T08:10:00Z", providerQueryOpenCount: 2 },
];

export const closeoutRows: CloseoutRow[] = [
  { encounterId: "E-1045", patientId: "PT-7701", clinicName: "Downtown Clinic", clinicColor: "#6366f1", currentStatus: "Optimizing", version: 5, providerName: "Dr. Martinez", assignedMaName: "Mike T.", roomName: "Room 5", alertLevel: "Yellow", enteredStatusAt: "08:10", statusElapsedMs: 1200000, safetyActive: false },
];

export const statusLabels: Record<EncounterStatus, string> = {
  Incoming: "Incoming",
  Lobby: "Lobby",
  Rooming: "Rooming",
  ReadyForProvider: "Ready for Provider",
  Optimizing: "Optimizing",
  CheckOut: "Check Out",
  Optimized: "Optimized",
};

export const statusColors: Record<EncounterStatus, string> = {
  Incoming: "#94a3b8",
  Lobby: "#6366f1",
  Rooming: "#8b5cf6",
  ReadyForProvider: "#f59e0b",
  Optimizing: "#a855f7",
  CheckOut: "#10b981",
  Optimized: "#06b6d4",
};

export const revenueCycleLabels: Record<RevenueCycleStatus, string> = {
  ChargeCapturePending: "Charge Capture Pending",
  CodingInProgress: "Coding In Progress",
  ProviderClarificationNeeded: "Provider Clarification",
  ReadyToSubmit: "Ready to Submit",
  Submitted: "Submitted",
  HoldException: "Hold / Exception",
};

export const revenueCycleColors: Record<RevenueCycleStatus, string> = {
  ChargeCapturePending: "#f59e0b",
  CodingInProgress: "#6366f1",
  ProviderClarificationNeeded: "#ef4444",
  ReadyToSubmit: "#10b981",
  Submitted: "#06b6d4",
  HoldException: "#dc2626",
};

export const safetyWords = ["ASSIST", "HARBOR", "SHIELD", "GUARDIAN", "ANCHOR"];

// ── Mock MA Tasks ──

export interface MATask {
  id: string;
  encounterId: string;
  patientId: string;
  taskType: "rooming" | "vitals" | "prep" | "service_capture" | "followup" | "alert_ack" | "reassignment";
  description: string;
  assignedMA: string;
  priority: 1 | 2 | 3; // 1 = urgent, 2 = normal, 3 = low
  blocking: boolean;
  status: "pending" | "in_progress" | "done";
  createdAt: string;
}

export const maTasks: MATask[] = [
  { id: "T-001", encounterId: "E-1042", patientId: "PT-8821", taskType: "rooming", description: "Pull patient from Lobby → Room", assignedMA: "Sarah K.", priority: 1, blocking: true, status: "pending", createdAt: "08:12" },
  { id: "T-002", encounterId: "E-1043", patientId: "PT-4419", taskType: "vitals", description: "Complete vitals — Annual Physical template", assignedMA: "Mike T.", priority: 1, blocking: true, status: "in_progress", createdAt: "08:20" },
  { id: "T-003", encounterId: "E-1054", patientId: "PT-8832", taskType: "vitals", description: "Complete vitals — New Patient template", assignedMA: "Sarah K.", priority: 1, blocking: true, status: "in_progress", createdAt: "08:18" },
  { id: "T-004", encounterId: "E-1047", patientId: "PT-5590", taskType: "rooming", description: "Pull walk-in from Lobby → Room", assignedMA: "Lisa R.", priority: 2, blocking: true, status: "pending", createdAt: "08:20" },
  { id: "T-005", encounterId: "E-1049", patientId: "PT-6654", taskType: "vitals", description: "Complete vitals — Sick Visit template", assignedMA: "Lisa R.", priority: 1, blocking: true, status: "in_progress", createdAt: "08:22" },
  { id: "T-006", encounterId: "E-1042", patientId: "PT-8821", taskType: "alert_ack", description: "Acknowledge Yellow alert — 18 min in Lobby", assignedMA: "Sarah K.", priority: 1, blocking: false, status: "pending", createdAt: "08:27" },
  { id: "T-007", encounterId: "E-1053", patientId: "PT-1199", taskType: "rooming", description: "Pull patient from Lobby → Room", assignedMA: "Mike T.", priority: 2, blocking: true, status: "pending", createdAt: "08:25" },
  { id: "T-008", encounterId: "E-1045", patientId: "PT-7701", taskType: "followup", description: "Prep follow-up orders per clinician note", assignedMA: "Mike T.", priority: 3, blocking: false, status: "pending", createdAt: "08:28" },
];

// ── Alert thresholds (default per-status, can be clinic-overridden) ──

export interface AlertThreshold {
  status: EncounterStatus;
  yellowMinutes: number;
  redMinutes: number;
}

export const defaultThresholds: AlertThreshold[] = [
  { status: "Lobby", yellowMinutes: 15, redMinutes: 25 },
  { status: "Rooming", yellowMinutes: 12, redMinutes: 20 },
  { status: "ReadyForProvider", yellowMinutes: 10, redMinutes: 18 },
  { status: "Optimizing", yellowMinutes: 25, redMinutes: 40 },
  { status: "CheckOut", yellowMinutes: 8, redMinutes: 15 },
];
