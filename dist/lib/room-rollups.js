import { RoomEventType, RoomIssueStatus, RoomIssueType, RoomOperationalStatus } from "@prisma/client";
import { DateTime } from "luxon";
import { MAX_HISTORY_DAYS, listDateKeys } from "./office-manager-rollups.js";
export { MAX_HISTORY_DAYS, listDateKeys };
const roomStatuses = Object.values(RoomOperationalStatus);
const issueTypes = Object.values(RoomIssueType);
function emptyStatusMinutes() {
    return Object.fromEntries(roomStatuses.map((status) => [status, 0]));
}
function emptyIssueAccumulator() {
    return Object.fromEntries(issueTypes.map((issueType) => [
        issueType,
        {
            issueType,
            count: 0,
            openCount: 0,
            resolvedCount: 0,
            resolutionTotalMins: 0,
            resolutionSamples: 0
        }
    ]));
}
function readNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}
function averageMinutes(total, samples) {
    if (samples <= 0)
        return 0;
    return Math.round(total / samples);
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function parseStatusMinutes(value) {
    const minutes = emptyStatusMinutes();
    const raw = asRecord(value);
    if (!raw)
        return minutes;
    roomStatuses.forEach((status) => {
        minutes[status] = readNumber(raw[status]);
    });
    return minutes;
}
function parseRoomRollups(value) {
    return asArray(value).map((entry) => {
        const row = entry;
        return {
            roomId: String(row.roomId || ""),
            roomName: String(row.roomName || "Room"),
            roomNumber: row.roomNumber === null || row.roomNumber === undefined ? null : readNumber(row.roomNumber),
            statusMinutes: parseStatusMinutes(row.statusMinutes),
            occupiedMinutes: readNumber(row.occupiedMinutes),
            turnoverMinutes: readNumber(row.turnoverMinutes),
            holdMinutes: readNumber(row.holdMinutes),
            notReadyMinutes: readNumber(row.notReadyMinutes),
            turnoverCount: readNumber(row.turnoverCount),
            holdCount: readNumber(row.holdCount),
            issueCount: readNumber(row.issueCount),
            dayStartCompleted: Boolean(row.dayStartCompleted),
            dayEndCompleted: Boolean(row.dayEndCompleted)
        };
    });
}
function parseIssueRollups(value) {
    return asArray(value)
        .map((entry) => {
        const row = entry;
        const issueType = row.issueType;
        if (!issueTypes.includes(issueType))
            return null;
        return {
            issueType,
            count: readNumber(row.count),
            openCount: readNumber(row.openCount),
            resolvedCount: readNumber(row.resolvedCount),
            resolutionTotalMins: readNumber(row.resolutionTotalMins),
            resolutionSamples: readNumber(row.resolutionSamples)
        };
    })
        .filter(Boolean);
}
function dayBounds(dateKey, timezone) {
    const start = DateTime.fromISO(dateKey, { zone: timezone }).startOf("day");
    if (!start.isValid) {
        throw new Error(`Invalid date: ${dateKey}`);
    }
    const end = start.plus({ days: 1 });
    const todayKey = DateTime.now().setZone(timezone).toISODate();
    const referenceEnd = dateKey === todayKey ? DateTime.now().setZone(timezone) : end;
    return {
        startUtc: start.toUTC().toJSDate(),
        endUtc: end.toUTC().toJSDate(),
        referenceEndUtc: referenceEnd.toUTC().toJSDate()
    };
}
function addStatusMinutes(target, status, minutes) {
    if (minutes <= 0)
        return;
    target[status] += minutes;
}
function minutesBetween(start, end) {
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}
export async function computeRoomDailyRollup(prisma, clinic, dateKey) {
    const clinicRow = await prisma.clinic.findUnique({
        where: { id: clinic.id },
        select: { id: true, timezone: true, facilityId: true }
    });
    if (!clinicRow) {
        throw new Error(`Clinic '${clinic.id}' was not found.`);
    }
    const timezone = clinic.timezone || clinicRow.timezone || "America/New_York";
    const { startUtc, endUtc, referenceEndUtc } = dayBounds(dateKey, timezone);
    const assignments = await prisma.clinicRoomAssignment.findMany({
        where: {
            clinicId: clinic.id,
            active: true,
            room: { status: "active" }
        },
        select: {
            roomId: true,
            room: {
                select: {
                    id: true,
                    name: true,
                    roomNumber: true,
                    facilityId: true,
                    operationalState: { select: { currentStatus: true, statusSinceAt: true } }
                }
            }
        },
        orderBy: [{ room: { roomNumber: "asc" } }, { room: { name: "asc" } }]
    });
    const roomRows = Array.from(new Map(assignments.map((assignment) => [assignment.roomId, assignment.room])).values());
    const roomIds = roomRows.map((room) => room.id);
    const facilityId = clinic.facilityId || clinicRow.facilityId || roomRows[0]?.facilityId;
    if (!facilityId) {
        throw new Error(`Clinic '${clinic.id}' does not have a facility for room rollups.`);
    }
    const roomRollups = new Map();
    roomRows.forEach((room) => {
        roomRollups.set(room.id, {
            roomId: room.id,
            roomName: room.name,
            roomNumber: room.roomNumber,
            statusMinutes: emptyStatusMinutes(),
            occupiedMinutes: 0,
            turnoverMinutes: 0,
            holdMinutes: 0,
            notReadyMinutes: 0,
            turnoverCount: 0,
            holdCount: 0,
            issueCount: 0,
            dayStartCompleted: false,
            dayEndCompleted: false
        });
    });
    const statusMinutes = emptyStatusMinutes();
    const issueAccumulator = emptyIssueAccumulator();
    if (roomIds.length === 0) {
        return {
            facilityId,
            clinicId: clinic.id,
            dateKey,
            roomCount: 0,
            dayStartCompletedCount: 0,
            dayEndCompletedCount: 0,
            turnoverCount: 0,
            holdCount: 0,
            issueCount: 0,
            resolvedIssueCount: 0,
            occupiedTotalMins: 0,
            occupiedSamples: 0,
            turnoverTotalMins: 0,
            turnoverSamples: 0,
            statusMinutes,
            roomRollups: [],
            issueRollups: Object.values(issueAccumulator)
        };
    }
    const [events, checklistRuns, issues] = await Promise.all([
        prisma.roomOperationalEvent.findMany({
            where: {
                roomId: { in: roomIds },
                occurredAt: { lt: endUtc }
            },
            select: {
                roomId: true,
                eventType: true,
                fromStatus: true,
                toStatus: true,
                occurredAt: true
            },
            orderBy: [{ roomId: "asc" }, { occurredAt: "asc" }]
        }),
        prisma.roomChecklistRun.findMany({
            where: {
                clinicId: clinic.id,
                dateKey,
                completed: true,
                roomId: { in: roomIds }
            },
            select: { roomId: true, kind: true }
        }),
        prisma.roomIssue.findMany({
            where: {
                clinicId: clinic.id,
                OR: [
                    { createdAt: { gte: startUtc, lt: endUtc } },
                    { resolvedAt: { gte: startUtc, lt: endUtc } }
                ]
            },
            select: {
                roomId: true,
                issueType: true,
                status: true,
                createdAt: true,
                resolvedAt: true
            }
        })
    ]);
    checklistRuns.forEach((run) => {
        const room = roomRollups.get(run.roomId);
        if (!room)
            return;
        if (run.kind === "DayStart")
            room.dayStartCompleted = true;
        if (run.kind === "DayEnd")
            room.dayEndCompleted = true;
    });
    let turnoverCount = 0;
    let holdCount = 0;
    let occupiedTotalMins = 0;
    let occupiedSamples = 0;
    let turnoverTotalMins = 0;
    let turnoverSamples = 0;
    roomRows.forEach((room) => {
        const roomRollup = roomRollups.get(room.id);
        if (!roomRollup)
            return;
        const roomEvents = events.filter((event) => event.roomId === room.id);
        const eventsInDay = roomEvents.filter((event) => event.occurredAt >= startUtc && event.occurredAt < endUtc);
        eventsInDay.forEach((event) => {
            if (event.eventType === RoomEventType.PatientLeftForCheckout || event.toStatus === RoomOperationalStatus.NeedsTurnover) {
                turnoverCount += 1;
                roomRollup.turnoverCount += 1;
            }
            if (event.eventType === RoomEventType.HoldPlaced || event.toStatus === RoomOperationalStatus.Hold) {
                holdCount += 1;
                roomRollup.holdCount += 1;
            }
        });
        if (roomEvents.length === 0)
            return;
        let cursor = startUtc;
        let currentStatus = roomEvents.find((event) => event.occurredAt >= startUtc)?.fromStatus ||
            [...roomEvents].reverse().find((event) => event.occurredAt < startUtc)?.toStatus ||
            room.operationalState?.currentStatus ||
            RoomOperationalStatus.Ready;
        const recordInterval = (from, to, status) => {
            if (!status)
                return;
            const boundedFrom = from < startUtc ? startUtc : from;
            const boundedTo = to > referenceEndUtc ? referenceEndUtc : to;
            const minutes = minutesBetween(boundedFrom, boundedTo);
            if (minutes <= 0)
                return;
            addStatusMinutes(statusMinutes, status, minutes);
            addStatusMinutes(roomRollup.statusMinutes, status, minutes);
            if (status === RoomOperationalStatus.Occupied) {
                occupiedTotalMins += minutes;
                occupiedSamples += 1;
                roomRollup.occupiedMinutes += minutes;
            }
            if (status === RoomOperationalStatus.NeedsTurnover) {
                turnoverTotalMins += minutes;
                turnoverSamples += 1;
                roomRollup.turnoverMinutes += minutes;
            }
            if (status === RoomOperationalStatus.Hold) {
                roomRollup.holdMinutes += minutes;
            }
            if (status === RoomOperationalStatus.NotReady) {
                roomRollup.notReadyMinutes += minutes;
            }
        };
        roomEvents
            .filter((event) => event.occurredAt >= startUtc && event.occurredAt < referenceEndUtc)
            .forEach((event) => {
            recordInterval(cursor, event.occurredAt, currentStatus);
            currentStatus = event.toStatus || currentStatus;
            cursor = event.occurredAt;
        });
        recordInterval(cursor, referenceEndUtc, currentStatus);
    });
    issues.forEach((issue) => {
        const wasCreatedInDay = issue.createdAt >= startUtc && issue.createdAt < endUtc;
        const wasResolvedInDay = Boolean(issue.resolvedAt && issue.resolvedAt >= startUtc && issue.resolvedAt < endUtc);
        const issueTotals = issueAccumulator[issue.issueType];
        if (wasCreatedInDay) {
            issueTotals.count += 1;
            if (issue.status === RoomIssueStatus.Resolved) {
                issueTotals.resolvedCount += 1;
            }
            else {
                issueTotals.openCount += 1;
            }
            const room = roomRollups.get(issue.roomId);
            if (room)
                room.issueCount += 1;
        }
        if (wasResolvedInDay && issue.resolvedAt) {
            issueTotals.resolvedCount += wasCreatedInDay && issue.status === RoomIssueStatus.Resolved ? 0 : 1;
            issueTotals.resolutionTotalMins += minutesBetween(issue.createdAt, issue.resolvedAt);
            issueTotals.resolutionSamples += 1;
        }
    });
    const issueRollups = Object.values(issueAccumulator);
    return {
        facilityId,
        clinicId: clinic.id,
        dateKey,
        roomCount: roomRows.length,
        dayStartCompletedCount: Array.from(roomRollups.values()).filter((room) => room.dayStartCompleted).length,
        dayEndCompletedCount: Array.from(roomRollups.values()).filter((room) => room.dayEndCompleted).length,
        turnoverCount,
        holdCount,
        issueCount: issueRollups.reduce((sum, issue) => sum + issue.count, 0),
        resolvedIssueCount: issueRollups.reduce((sum, issue) => sum + issue.resolvedCount, 0),
        occupiedTotalMins,
        occupiedSamples,
        turnoverTotalMins,
        turnoverSamples,
        statusMinutes,
        roomRollups: Array.from(roomRollups.values()),
        issueRollups
    };
}
export async function upsertRoomDailyRollup(prisma, rollup) {
    await prisma.roomDailyRollup.upsert({
        where: {
            clinicId_dateKey: {
                clinicId: rollup.clinicId,
                dateKey: rollup.dateKey
            }
        },
        create: {
            facilityId: rollup.facilityId,
            clinicId: rollup.clinicId,
            dateKey: rollup.dateKey,
            roomCount: rollup.roomCount,
            dayStartCompletedCount: rollup.dayStartCompletedCount,
            dayEndCompletedCount: rollup.dayEndCompletedCount,
            turnoverCount: rollup.turnoverCount,
            holdCount: rollup.holdCount,
            issueCount: rollup.issueCount,
            resolvedIssueCount: rollup.resolvedIssueCount,
            occupiedTotalMins: rollup.occupiedTotalMins,
            occupiedSamples: rollup.occupiedSamples,
            turnoverTotalMins: rollup.turnoverTotalMins,
            turnoverSamples: rollup.turnoverSamples,
            statusMinutesJson: rollup.statusMinutes,
            roomRollupsJson: rollup.roomRollups,
            issueRollupsJson: rollup.issueRollups
        },
        update: {
            facilityId: rollup.facilityId,
            roomCount: rollup.roomCount,
            dayStartCompletedCount: rollup.dayStartCompletedCount,
            dayEndCompletedCount: rollup.dayEndCompletedCount,
            turnoverCount: rollup.turnoverCount,
            holdCount: rollup.holdCount,
            issueCount: rollup.issueCount,
            resolvedIssueCount: rollup.resolvedIssueCount,
            occupiedTotalMins: rollup.occupiedTotalMins,
            occupiedSamples: rollup.occupiedSamples,
            turnoverTotalMins: rollup.turnoverTotalMins,
            turnoverSamples: rollup.turnoverSamples,
            statusMinutesJson: rollup.statusMinutes,
            roomRollupsJson: rollup.roomRollups,
            issueRollupsJson: rollup.issueRollups,
            computedAt: new Date()
        }
    });
}
function parseStoredRoomRollup(row) {
    return {
        facilityId: row.facilityId,
        clinicId: row.clinicId,
        dateKey: row.dateKey,
        roomCount: row.roomCount,
        dayStartCompletedCount: row.dayStartCompletedCount,
        dayEndCompletedCount: row.dayEndCompletedCount,
        turnoverCount: row.turnoverCount,
        holdCount: row.holdCount,
        issueCount: row.issueCount,
        resolvedIssueCount: row.resolvedIssueCount,
        occupiedTotalMins: row.occupiedTotalMins,
        occupiedSamples: row.occupiedSamples,
        turnoverTotalMins: row.turnoverTotalMins,
        turnoverSamples: row.turnoverSamples,
        statusMinutes: parseStatusMinutes(row.statusMinutesJson),
        roomRollups: parseRoomRollups(row.roomRollupsJson),
        issueRollups: parseIssueRollups(row.issueRollupsJson)
    };
}
function mergeRoomRollups(dateKey, rows) {
    const statusMinutes = emptyStatusMinutes();
    const issues = emptyIssueAccumulator();
    const rooms = new Map();
    let roomCount = 0;
    let dayStartCompletedCount = 0;
    let dayEndCompletedCount = 0;
    let turnoverCount = 0;
    let holdCount = 0;
    let issueCount = 0;
    let resolvedIssueCount = 0;
    let occupiedTotalMins = 0;
    let occupiedSamples = 0;
    let turnoverTotalMins = 0;
    let turnoverSamples = 0;
    rows.forEach((row) => {
        roomCount += row.roomCount;
        dayStartCompletedCount += row.dayStartCompletedCount;
        dayEndCompletedCount += row.dayEndCompletedCount;
        turnoverCount += row.turnoverCount;
        holdCount += row.holdCount;
        issueCount += row.issueCount;
        resolvedIssueCount += row.resolvedIssueCount;
        occupiedTotalMins += row.occupiedTotalMins;
        occupiedSamples += row.occupiedSamples;
        turnoverTotalMins += row.turnoverTotalMins;
        turnoverSamples += row.turnoverSamples;
        roomStatuses.forEach((status) => {
            statusMinutes[status] += row.statusMinutes[status] || 0;
        });
        row.issueRollups.forEach((issue) => {
            issues[issue.issueType].count += issue.count;
            issues[issue.issueType].openCount += issue.openCount;
            issues[issue.issueType].resolvedCount += issue.resolvedCount;
            issues[issue.issueType].resolutionTotalMins += issue.resolutionTotalMins;
            issues[issue.issueType].resolutionSamples += issue.resolutionSamples;
        });
        row.roomRollups.forEach((room) => {
            const key = `${row.clinicId}:${room.roomId}`;
            rooms.set(key, room);
        });
    });
    return {
        date: dateKey,
        roomCount,
        dayStartCompletedCount,
        dayEndCompletedCount,
        turnoverCount,
        holdCount,
        issueCount,
        resolvedIssueCount,
        avgOccupiedMins: averageMinutes(occupiedTotalMins, occupiedSamples),
        avgTurnoverMins: averageMinutes(turnoverTotalMins, turnoverSamples),
        statusMinutes,
        issueRollups: Object.values(issues).map((issue) => ({
            issueType: issue.issueType,
            count: issue.count,
            openCount: issue.openCount,
            resolvedCount: issue.resolvedCount,
            avgResolutionMins: averageMinutes(issue.resolutionTotalMins, issue.resolutionSamples)
        })),
        roomRollups: Array.from(rooms.values())
            .map((room) => ({
            ...room,
            avgOccupiedMins: room.occupiedMinutes > 0 ? room.occupiedMinutes : 0,
            avgTurnoverMins: room.turnoverMinutes > 0 ? room.turnoverMinutes : 0
        }))
            .sort((a, b) => b.turnoverCount - a.turnoverCount || b.issueCount - a.issueCount || a.roomName.localeCompare(b.roomName))
    };
}
export async function getRoomDailyHistoryRollups(prisma, clinics, dateKeys, options = {}) {
    const persist = options.persist ?? true;
    const forceRecompute = options.forceRecompute ?? false;
    const byClinicDate = new Map();
    const buildKey = (clinicId, dateKey) => `${clinicId}::${dateKey}`;
    if (!forceRecompute) {
        const existing = await prisma.roomDailyRollup.findMany({
            where: {
                clinicId: { in: clinics.map((clinic) => clinic.id) },
                dateKey: { in: dateKeys }
            }
        });
        existing.forEach((row) => {
            byClinicDate.set(buildKey(row.clinicId, row.dateKey), parseStoredRoomRollup(row));
        });
    }
    await Promise.all(dateKeys.flatMap((dateKey) => clinics.map(async (clinic) => {
        const key = buildKey(clinic.id, dateKey);
        if (!forceRecompute && byClinicDate.has(key))
            return;
        const computed = await computeRoomDailyRollup(prisma, clinic, dateKey);
        byClinicDate.set(key, computed);
        if (persist) {
            await upsertRoomDailyRollup(prisma, computed);
        }
    })));
    return dateKeys.map((dateKey) => {
        const rows = clinics.map((clinic) => byClinicDate.get(buildKey(clinic.id, dateKey))).filter(Boolean);
        return mergeRoomRollups(dateKey, rows);
    });
}
//# sourceMappingURL=room-rollups.js.map