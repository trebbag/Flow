import { DateTime } from "luxon";
import { Prisma, type PrismaClient } from "@prisma/client";
import { asInputJson, parseGenericObjectJsonInput, parseStringArrayJsonInput } from "./persisted-json.js";
import { encryptPhi, encryptPhiDate, isPhiEncryptionEnabled } from "./phi-encryption.js";
import { env } from "./env.js";
import { runWithFacilityScope } from "./facility-scope.js";

function buildPhiCipherUpdates(params: {
  displayName?: string | null;
  dateOfBirth?: Date | null;
}): {
  displayNameCipher?: string | null;
  dateOfBirthCipher?: string | null;
  cipherKeyId?: string | null;
} {
  if (!isPhiEncryptionEnabled()) return {};
  const result: {
    displayNameCipher?: string | null;
    dateOfBirthCipher?: string | null;
    cipherKeyId?: string | null;
  } = {};
  if (params.displayName !== undefined) {
    result.displayNameCipher = params.displayName ? encryptPhi(params.displayName) : null;
  }
  if (params.dateOfBirth !== undefined) {
    result.dateOfBirthCipher = params.dateOfBirth ? encryptPhiDate(params.dateOfBirth) : null;
  }
  if (Object.keys(result).length > 0) {
    result.cipherKeyId = env.PHI_ENCRYPTION_KEY_ID;
  }
  return result;
}

type DbClient = PrismaClient | Prisma.TransactionClient;
type PatientIdentityReasonCode =
  | "AMBIGUOUS_ALIAS_MATCH"
  | "CONFLICTING_DATE_OF_BIRTH"
  | "CONFLICTING_DISPLAY_NAME"
  | "BACKFILL_SOURCE_MISSING";

const PATIENT_ALIAS_TYPE_SOURCE = "source_patient_id";
const PATIENT_ALIAS_TYPE_DISPLAY_NAME = "display_name";

const NAME_PREFIXES = new Set(["mr", "mrs", "ms", "miss", "dr"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const GIVEN_NAME_ALIASES: Record<string, string> = {
  andy: "andrew",
  beth: "elizabeth",
  bill: "william",
  billy: "william",
  bob: "robert",
  bobby: "robert",
  cathy: "catherine",
  dave: "david",
  jim: "james",
  jimmy: "james",
  joe: "joseph",
  joey: "joseph",
  kathy: "katherine",
  katie: "katherine",
  kate: "katherine",
  liz: "elizabeth",
  lizzy: "elizabeth",
  mike: "michael",
  mikey: "michael",
  patty: "patricia",
  rob: "robert",
  robbie: "robert",
  robby: "robert",
  steve: "steven",
  susie: "susan",
  sue: "susan",
  tom: "thomas",
  tommy: "thomas",
  will: "william",
  willie: "william",
};

function normalizeSourcePatientId(sourcePatientId: string) {
  const compact = sourcePatientId
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase()
    .trim();
  if (compact) {
    return compact;
  }
  return sourcePatientId.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDisplayName(displayName: string) {
  const compact = displayName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  if (!compact) {
    return null;
  }

  const tokens = compact
    .split(" ")
    .filter(Boolean)
    .filter((token) => !NAME_PREFIXES.has(token) && !NAME_SUFFIXES.has(token));

  if (tokens.length === 0) {
    return compact;
  }

  const canonicalTokens = tokens.map((token, index) => {
    if (index === 0) {
      return GIVEN_NAME_ALIASES[token] || token;
    }
    return token;
  });

  return canonicalTokens.join(" ");
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readStringCandidate(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFirstString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readStringCandidate(source[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function parseDateCandidate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return DateTime.fromJSDate(value, { zone: "utc" }).startOf("day").toJSDate();
  }

  const raw = readStringCandidate(value);
  if (!raw) return null;

  const candidates = [
    DateTime.fromISO(raw, { zone: "utc" }),
    DateTime.fromFormat(raw, "M/d/yyyy", { zone: "utc" }),
    DateTime.fromFormat(raw, "M-d-yyyy", { zone: "utc" }),
    DateTime.fromFormat(raw, "MM/dd/yyyy", { zone: "utc" }),
    DateTime.fromFormat(raw, "MM-dd-yyyy", { zone: "utc" }),
    DateTime.fromFormat(raw, "yyyyMMdd", { zone: "utc" }),
  ];

  const match = candidates.find((entry) => entry.isValid);
  return match ? match.startOf("day").toJSDate() : null;
}

function sameBirthDate(left: Date | null | undefined, right: Date | null | undefined) {
  if (!left || !right) return false;
  return DateTime.fromJSDate(left, { zone: "utc" }).toISODate() === DateTime.fromJSDate(right, { zone: "utc" }).toISODate();
}

async function persistPatientAlias(
  db: DbClient,
  params: {
    patientId: string;
    facilityId: string;
    aliasType: string;
    aliasValue?: string | null;
    normalizedAliasValue?: string | null;
  },
) {
  const aliasValue = params.aliasValue?.trim() || null;
  const normalizedAliasValue = params.normalizedAliasValue?.trim() || null;
  if (!aliasValue || !normalizedAliasValue) {
    return;
  }

  await db.patientAlias.upsert({
    where: {
      patientId_aliasType_normalizedAliasValue: {
        patientId: params.patientId,
        aliasType: params.aliasType,
        normalizedAliasValue,
      },
    },
    create: {
      patientId: params.patientId,
      facilityId: params.facilityId,
      aliasType: params.aliasType,
      aliasValue,
      normalizedAliasValue,
    },
    update: {
      aliasValue,
    },
  });
}

async function findPatientsByAlias(
  db: DbClient,
  params: {
    facilityId: string;
    aliasType: string;
    normalizedAliasValue?: string | null;
  },
) {
  const normalizedAliasValue = params.normalizedAliasValue?.trim() || null;
  if (!normalizedAliasValue) {
    return [] as Array<{
      id: string;
      displayName: string | null;
      dateOfBirth: Date | null;
    }>;
  }

  const rows = await db.patientAlias.findMany({
    where: {
      facilityId: params.facilityId,
      aliasType: params.aliasType,
      normalizedAliasValue,
    },
    select: {
      patient: {
        select: {
          id: true,
          displayName: true,
          dateOfBirth: true,
        },
      },
    },
  });

  return rows
    .map((row) => row.patient)
    .filter((patient): patient is NonNullable<typeof patient> => Boolean(patient));
}

async function recordPatientIdentityReview(
  db: DbClient,
  params: {
    facilityId: string;
    patientId?: string | null;
    sourcePatientId: string;
    normalizedSourcePatientId: string;
    displayName?: string | null;
    normalizedDisplayName?: string | null;
    dateOfBirth?: Date | null;
    reasonCode: PatientIdentityReasonCode;
    matchedPatientIds?: string[];
    context?: Record<string, unknown>;
  },
) {
  const existing = await db.patientIdentityReview.findFirst({
    where: {
      facilityId: params.facilityId,
      normalizedSourcePatientId: params.normalizedSourcePatientId,
      reasonCode: params.reasonCode,
      status: "open",
    },
    select: { id: true },
  });

  const data = {
    patientId: params.patientId || null,
    sourcePatientId: params.sourcePatientId,
    normalizedSourcePatientId: params.normalizedSourcePatientId,
    displayName: params.displayName || null,
    normalizedDisplayName: params.normalizedDisplayName || null,
    dateOfBirth: params.dateOfBirth || null,
    matchedPatientIdsJson: params.matchedPatientIds
      ? asInputJson(parseStringArrayJsonInput(params.matchedPatientIds, "patientIdentityReviewMatchedPatientIdsJson"))
      : Prisma.JsonNull,
    contextJson: params.context
      ? asInputJson(parseGenericObjectJsonInput(params.context, "patientIdentityReviewContextJson"))
      : Prisma.JsonNull,
  };

  if (existing) {
    await db.patientIdentityReview.update({
      where: { id: existing.id },
      data,
    });
    return existing.id;
  }

  const created = await db.patientIdentityReview.create({
    data: {
      facilityId: params.facilityId,
      reasonCode: params.reasonCode,
      ...data,
    },
    select: { id: true },
  });
  return created.id;
}

async function applyPatientIdentityUpdates(
  db: DbClient,
  params: {
    patientId: string;
    facilityId: string;
    sourcePatientId: string;
    normalizedSourcePatientId: string;
    displayName?: string | null;
    normalizedDisplayName?: string | null;
    dateOfBirth?: Date | null;
    existingDisplayName?: string | null;
    existingDateOfBirth?: Date | null;
  },
) {
  const updates: Prisma.PatientUpdateInput = {};

  if (!params.existingDisplayName && params.displayName) {
    updates.displayName = params.displayName;
  } else if (
    params.displayName &&
    params.existingDisplayName &&
    normalizeDisplayName(params.existingDisplayName) !== params.normalizedDisplayName
  ) {
    await recordPatientIdentityReview(db, {
      facilityId: params.facilityId,
      patientId: params.patientId,
      sourcePatientId: params.sourcePatientId,
      normalizedSourcePatientId: params.normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName: params.normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
      reasonCode: "CONFLICTING_DISPLAY_NAME",
      context: {
        existingDisplayName: params.existingDisplayName,
      },
    });
  }

  if (!params.existingDateOfBirth && params.dateOfBirth) {
    updates.dateOfBirth = params.dateOfBirth;
  } else if (params.dateOfBirth && params.existingDateOfBirth && !sameBirthDate(params.dateOfBirth, params.existingDateOfBirth)) {
    await recordPatientIdentityReview(db, {
      facilityId: params.facilityId,
      patientId: params.patientId,
      sourcePatientId: params.sourcePatientId,
      normalizedSourcePatientId: params.normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName: params.normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
      reasonCode: "CONFLICTING_DATE_OF_BIRTH",
      context: {
        existingDateOfBirth: params.existingDateOfBirth.toISOString(),
      },
    });
  }

  if (Object.keys(updates).length > 0) {
    const cipherUpdates = buildPhiCipherUpdates({
      displayName: (updates.displayName as string | null | undefined) ?? undefined,
      dateOfBirth: (updates.dateOfBirth as Date | null | undefined) ?? undefined,
    });
    await db.patient.update({
      where: { id: params.patientId },
      data: { ...updates, ...cipherUpdates },
    });
  }

  await persistPatientAlias(db, {
    patientId: params.patientId,
    facilityId: params.facilityId,
    aliasType: PATIENT_ALIAS_TYPE_SOURCE,
    aliasValue: params.sourcePatientId,
    normalizedAliasValue: params.normalizedSourcePatientId,
  });
  await persistPatientAlias(db, {
    patientId: params.patientId,
    facilityId: params.facilityId,
    aliasType: PATIENT_ALIAS_TYPE_DISPLAY_NAME,
    aliasValue: params.displayName,
    normalizedAliasValue: params.normalizedDisplayName,
  });
}

async function createPatientRecord(
  db: DbClient,
  params: {
    facilityId: string;
    sourcePatientId: string;
    normalizedSourcePatientId: string;
    displayName?: string | null;
    normalizedDisplayName?: string | null;
    dateOfBirth?: Date | null;
  },
) {
  const createCipher = buildPhiCipherUpdates({
    displayName: params.displayName ?? null,
    dateOfBirth: params.dateOfBirth ?? null,
  });
  const updateCipher = buildPhiCipherUpdates({
    displayName: params.displayName === undefined ? undefined : params.displayName,
    dateOfBirth: params.dateOfBirth === undefined ? undefined : params.dateOfBirth,
  });
  const created = await db.patient.upsert({
    where: {
      facilityId_normalizedSourcePatientId: {
        facilityId: params.facilityId,
        normalizedSourcePatientId: params.normalizedSourcePatientId,
      },
    },
    create: {
      facilityId: params.facilityId,
      sourcePatientId: params.sourcePatientId,
      normalizedSourcePatientId: params.normalizedSourcePatientId,
      displayName: params.displayName || null,
      dateOfBirth: params.dateOfBirth || null,
      ...createCipher,
    },
    update: {
      sourcePatientId: params.sourcePatientId,
      displayName: params.displayName === undefined ? undefined : params.displayName,
      dateOfBirth: params.dateOfBirth === undefined ? undefined : params.dateOfBirth,
      ...updateCipher,
    },
    select: {
      id: true,
      displayName: true,
      dateOfBirth: true,
    },
  });

  await applyPatientIdentityUpdates(db, {
    patientId: created.id,
    facilityId: params.facilityId,
    sourcePatientId: params.sourcePatientId,
    normalizedSourcePatientId: params.normalizedSourcePatientId,
    displayName: params.displayName,
    normalizedDisplayName: params.normalizedDisplayName,
    dateOfBirth: params.dateOfBirth,
    existingDisplayName: created.displayName,
    existingDateOfBirth: created.dateOfBirth,
  });

  return { id: created.id };
}

async function reconcileExistingPatientRecord(
  db: DbClient,
  params: {
    patientId: string;
    facilityId: string;
    sourcePatientId: string;
    normalizedSourcePatientId: string;
    displayName?: string | null;
    normalizedDisplayName?: string | null;
    dateOfBirth?: Date | null;
  },
) {
  const existing = await db.patient.findUnique({
    where: { id: params.patientId },
    select: {
      id: true,
      facilityId: true,
      displayName: true,
      dateOfBirth: true,
    },
  });

  if (!existing || existing.facilityId !== params.facilityId) {
    await recordPatientIdentityReview(db, {
      facilityId: params.facilityId,
      sourcePatientId: params.sourcePatientId,
      normalizedSourcePatientId: params.normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName: params.normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
      reasonCode: "BACKFILL_SOURCE_MISSING",
      context: {
        requestedPatientId: params.patientId,
        requestedFacilityId: params.facilityId,
      },
    });
    return null;
  }

  await applyPatientIdentityUpdates(db, {
    patientId: existing.id,
    facilityId: params.facilityId,
    sourcePatientId: params.sourcePatientId,
    normalizedSourcePatientId: params.normalizedSourcePatientId,
    displayName: params.displayName,
    normalizedDisplayName: params.normalizedDisplayName,
    dateOfBirth: params.dateOfBirth,
    existingDisplayName: existing.displayName,
    existingDateOfBirth: existing.dateOfBirth,
  });
  return { id: existing.id };
}

export function extractPatientIdentityHints(...sources: Array<unknown>) {
  let displayName: string | null = null;
  let dateOfBirth: Date | null = null;

  const searchQueue: Record<string, unknown>[] = [];
  for (const source of sources) {
    const record = toRecord(source);
    if (Object.keys(record).length === 0) continue;
    searchQueue.push(record);
    for (const nestedKey of ["patient", "patientDemographics", "demographics", "subscriber", "member"]) {
      const nested = toRecord(record[nestedKey]);
      if (Object.keys(nested).length > 0) {
        searchQueue.push(nested);
      }
    }
  }

  for (const record of searchQueue) {
    if (!displayName) {
      const fullName =
        readFirstString(record, ["patientName", "patient_name", "fullName", "full_name", "name", "displayName", "display_name"]) ||
        [readFirstString(record, ["firstName", "first_name", "givenName", "given_name"]), readFirstString(record, ["lastName", "last_name", "familyName", "family_name"])]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        null;
      if (fullName) {
        displayName = fullName;
      }
    }

    if (!dateOfBirth) {
      dateOfBirth =
        parseDateCandidate(record.dateOfBirth) ||
        parseDateCandidate(record.date_of_birth) ||
        parseDateCandidate(record.birthDate) ||
        parseDateCandidate(record.birth_date) ||
        parseDateCandidate(record.dob);
    }

    if (displayName && dateOfBirth) {
      break;
    }
  }

  return {
    displayName,
    dateOfBirth,
  };
}

export async function ensurePatientRecord(
  db: DbClient,
  params: {
    facilityId: string;
    sourcePatientId: string;
    displayName?: string | null;
    dateOfBirth?: Date | null;
  },
) {
  const sourcePatientId = params.sourcePatientId.trim();
  const normalizedSourcePatientId = normalizeSourcePatientId(sourcePatientId);
  const normalizedDisplayName = params.displayName ? normalizeDisplayName(params.displayName) : null;

  const existingBySource = await db.patient.findUnique({
    where: {
      facilityId_normalizedSourcePatientId: {
        facilityId: params.facilityId,
        normalizedSourcePatientId,
      },
    },
    select: {
      id: true,
      displayName: true,
      dateOfBirth: true,
    },
  });

  if (existingBySource) {
    await applyPatientIdentityUpdates(db, {
      patientId: existingBySource.id,
      facilityId: params.facilityId,
      sourcePatientId,
      normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
      existingDisplayName: existingBySource.displayName,
      existingDateOfBirth: existingBySource.dateOfBirth,
    });
    return { id: existingBySource.id };
  }

  const sourceAliasMatches = await findPatientsByAlias(db, {
    facilityId: params.facilityId,
    aliasType: PATIENT_ALIAS_TYPE_SOURCE,
    normalizedAliasValue: normalizedSourcePatientId,
  });
  if (sourceAliasMatches.length === 1) {
    const matched = sourceAliasMatches[0]!;
    await applyPatientIdentityUpdates(db, {
      patientId: matched.id,
      facilityId: params.facilityId,
      sourcePatientId,
      normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
      existingDisplayName: matched.displayName,
      existingDateOfBirth: matched.dateOfBirth,
    });
    return { id: matched.id };
  }
  if (sourceAliasMatches.length > 1) {
    await recordPatientIdentityReview(db, {
      facilityId: params.facilityId,
      sourcePatientId,
      normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
      reasonCode: "AMBIGUOUS_ALIAS_MATCH",
      matchedPatientIds: sourceAliasMatches.map((patient) => patient.id),
      context: {
        aliasType: PATIENT_ALIAS_TYPE_SOURCE,
        matchCount: sourceAliasMatches.length,
      },
    });
    return createPatientRecord(db, {
      facilityId: params.facilityId,
      sourcePatientId,
      normalizedSourcePatientId,
      displayName: params.displayName,
      normalizedDisplayName,
      dateOfBirth: params.dateOfBirth,
    });
  }

  if (normalizedDisplayName && params.dateOfBirth) {
    const directCandidates = await db.patient.findMany({
      where: {
        facilityId: params.facilityId,
        dateOfBirth: params.dateOfBirth,
      },
      select: {
        id: true,
        displayName: true,
        dateOfBirth: true,
      },
    });
    const displayAliasCandidates = await findPatientsByAlias(db, {
      facilityId: params.facilityId,
      aliasType: PATIENT_ALIAS_TYPE_DISPLAY_NAME,
      normalizedAliasValue: normalizedDisplayName,
    });
    const aliasCandidates = Array.from(
      new Map(
        [...directCandidates, ...displayAliasCandidates].map((candidate) => [candidate.id, candidate]),
      ).values(),
    );

    const matchingCandidates = aliasCandidates.filter((candidate) => {
      if (!candidate.displayName || !sameBirthDate(candidate.dateOfBirth, params.dateOfBirth)) {
        return false;
      }
      return normalizeDisplayName(candidate.displayName) === normalizedDisplayName;
    });

    if (matchingCandidates.length === 1) {
      const matched = matchingCandidates[0];
      await applyPatientIdentityUpdates(db, {
        patientId: matched.id,
        facilityId: params.facilityId,
        sourcePatientId,
        normalizedSourcePatientId,
        displayName: params.displayName,
        normalizedDisplayName,
        dateOfBirth: params.dateOfBirth,
        existingDisplayName: matched.displayName,
        existingDateOfBirth: matched.dateOfBirth,
      });
      return { id: matched.id };
    }

    if (matchingCandidates.length > 1) {
      await recordPatientIdentityReview(db, {
        facilityId: params.facilityId,
        sourcePatientId,
        normalizedSourcePatientId,
        displayName: params.displayName,
        normalizedDisplayName,
        dateOfBirth: params.dateOfBirth,
        reasonCode: "AMBIGUOUS_ALIAS_MATCH",
        matchedPatientIds: matchingCandidates.map((patient) => patient.id),
        context: {
          aliasType: PATIENT_ALIAS_TYPE_DISPLAY_NAME,
          matchCount: matchingCandidates.length,
        },
      });
      return createPatientRecord(db, {
        facilityId: params.facilityId,
        sourcePatientId,
        normalizedSourcePatientId,
        displayName: params.displayName,
        normalizedDisplayName,
        dateOfBirth: params.dateOfBirth,
      });
    }
  }

  return createPatientRecord(db, {
    facilityId: params.facilityId,
    sourcePatientId,
    normalizedSourcePatientId,
    displayName: params.displayName,
    normalizedDisplayName,
    dateOfBirth: params.dateOfBirth,
  });
}

export async function backfillCanonicalPatients(db: DbClient) {
  const facilities = await db.facility.findMany({ select: { id: true } });
  for (const facility of facilities) {
    await runWithFacilityScope(facility.id, async () => {
      const clinics = await db.clinic.findMany({
        where: { facilityId: facility.id },
        select: { id: true, facilityId: true },
      });
      const facilitiesByClinicId = new Map<string, string>();
      clinics.forEach((clinic) => {
        if (clinic.facilityId) {
          facilitiesByClinicId.set(clinic.id, clinic.facilityId);
        }
      });

      const incomingRows = await db.incomingSchedule.findMany({
        where: {
          patientId: { not: "" },
          clinic: { facilityId: facility.id },
        },
        select: { id: true, clinicId: true, patientId: true, patientRecordId: true, rawPayloadJson: true, intakeData: true },
      });
      for (const row of incomingRows) {
        const facilityId = facilitiesByClinicId.get(row.clinicId);
        if (!facilityId || !row.patientId?.trim()) continue;
        const hints = extractPatientIdentityHints(row.rawPayloadJson, row.intakeData);
        const normalizedSourcePatientId = normalizeSourcePatientId(row.patientId);
        const normalizedDisplayName = hints.displayName ? normalizeDisplayName(hints.displayName) : null;
        const patient =
          (row.patientRecordId
            ? await reconcileExistingPatientRecord(db, {
                patientId: row.patientRecordId,
                facilityId,
                sourcePatientId: row.patientId,
                normalizedSourcePatientId,
                displayName: hints.displayName,
                normalizedDisplayName,
                dateOfBirth: hints.dateOfBirth,
              })
            : null) ||
          (await ensurePatientRecord(db, {
            facilityId,
            sourcePatientId: row.patientId,
            displayName: hints.displayName,
            dateOfBirth: hints.dateOfBirth,
          }));
        if (row.patientRecordId !== patient.id) {
          await db.incomingSchedule.update({
            where: { id: row.id },
            data: { patientRecordId: patient.id },
          });
        }
      }

      const encounters = await db.encounter.findMany({
        where: {
          patientId: { not: "" },
          clinic: { facilityId: facility.id },
        },
        select: { id: true, clinicId: true, patientId: true, patientRecordId: true, intakeData: true },
      });
      for (const encounter of encounters) {
        const facilityId = facilitiesByClinicId.get(encounter.clinicId);
        if (!facilityId || !encounter.patientId?.trim()) continue;
        const hints = extractPatientIdentityHints(encounter.intakeData);
        const normalizedSourcePatientId = normalizeSourcePatientId(encounter.patientId);
        const normalizedDisplayName = hints.displayName ? normalizeDisplayName(hints.displayName) : null;
        const patient =
          (encounter.patientRecordId
            ? await reconcileExistingPatientRecord(db, {
                patientId: encounter.patientRecordId,
                facilityId,
                sourcePatientId: encounter.patientId,
                normalizedSourcePatientId,
                displayName: hints.displayName,
                normalizedDisplayName,
                dateOfBirth: hints.dateOfBirth,
              })
            : null) ||
          (await ensurePatientRecord(db, {
            facilityId,
            sourcePatientId: encounter.patientId,
            displayName: hints.displayName,
            dateOfBirth: hints.dateOfBirth,
          }));
        if (encounter.patientRecordId !== patient.id) {
          await db.encounter.update({
            where: { id: encounter.id },
            data: { patientRecordId: patient.id },
          });
        }
      }

      const revenueCases = await db.revenueCase.findMany({
        where: {
          patientId: { not: "" },
          facilityId: facility.id,
        },
        select: { id: true, facilityId: true, patientId: true, patientRecordId: true },
      });
      for (const revenueCase of revenueCases) {
        if (!revenueCase.facilityId || !revenueCase.patientId?.trim()) continue;
        const normalizedSourcePatientId = normalizeSourcePatientId(revenueCase.patientId);
        const patient =
          (revenueCase.patientRecordId
            ? await reconcileExistingPatientRecord(db, {
                patientId: revenueCase.patientRecordId,
                facilityId: revenueCase.facilityId,
                sourcePatientId: revenueCase.patientId,
                normalizedSourcePatientId,
              })
            : null) ||
          (await ensurePatientRecord(db, {
            facilityId: revenueCase.facilityId,
            sourcePatientId: revenueCase.patientId,
          }));
        if (revenueCase.patientRecordId !== patient.id) {
          await db.revenueCase.update({
            where: { id: revenueCase.id },
            data: { patientRecordId: patient.id, version: { increment: 1 } },
          });
        }
      }
    });
  }
}
