export type CodeReferenceKind = "diagnosis" | "procedure";

export type ClinicalCodeReference = string;

const DIAGNOSIS_CODES = "I10,E11.9,E78.5,J01.90,J06.9,J02.9,R05.9,N39.0,Z00.00".split(",");
const PROCEDURE_CODES = "99211,99212,99213,99214,99215,36415,93000,96372,81002,87880,J1100".split(",");

export function searchClinicalCodes(kind: CodeReferenceKind, query: string, limit = 8) {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return [];

  const source = kind === "diagnosis" ? DIAGNOSIS_CODES : PROCEDURE_CODES;
  const startsWith = source.filter((code) => code.startsWith(normalized));
  if (startsWith.length >= limit) return startsWith.slice(0, limit);
  const contains = source.filter((code) => !code.startsWith(normalized) && code.includes(normalized));
  return [...startsWith, ...contains].slice(0, limit);
}
