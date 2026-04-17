export type CodeReferenceKind = "diagnosis" | "procedure";

export type ClinicalCodeReference = {
  code: string;
  label: string;
  kind: CodeReferenceKind;
};

const DIAGNOSIS_DATA = `
I10|Essential hypertension
E11.9|Type 2 diabetes without complications
E78.5|Hyperlipidemia
J01.90|Acute sinusitis
J06.9|Acute URI
J02.9|Acute pharyngitis
R05.9|Cough
M54.50|Low back pain
N39.0|Urinary tract infection
K21.9|GERD
F41.9|Anxiety disorder
F32.A|Depression
Z00.00|Adult exam without abnormal findings
Z00.01|Adult exam with abnormal findings
Z79.899|Long term drug therapy
`.trim();

const PROCEDURE_DATA = `
99202|New patient visit straightforward
99203|New patient visit low complexity
99204|New patient visit moderate complexity
99205|New patient visit high complexity
99211|Established visit minimal
99212|Established visit straightforward
99213|Established visit low complexity
99214|Established visit moderate complexity
99215|Established visit high complexity
36415|Venipuncture
93000|ECG with interpretation
96372|Injection administration
94640|Inhalation treatment
94010|Spirometry
81002|Urinalysis dipstick
87880|Rapid strep test
87635|COVID amplified probe
J1100|Dexamethasone 1 mg
`.trim();

function parseDataset(source: string, kind: CodeReferenceKind): ClinicalCodeReference[] {
  return source.split("\n").map((row) => {
    const [code, label] = row.split("|");
    return { code, label, kind };
  });
}

const DIAGNOSIS_CODES = parseDataset(DIAGNOSIS_DATA, "diagnosis");
const PROCEDURE_CODES = parseDataset(PROCEDURE_DATA, "procedure");

function scoreMatch(query: string, entry: ClinicalCodeReference) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;

  const code = entry.code.toLowerCase();
  const label = entry.label.toLowerCase();

  if (code === normalized) return 100;
  if (code.startsWith(normalized)) return 80;
  if (label.includes(normalized)) return 60;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  const haystack = `${code} ${label}`;
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched > 0 ? 10 + matched : 0;
}

export function getCommonCodeReference(kind: CodeReferenceKind) {
  return kind === "diagnosis" ? DIAGNOSIS_CODES : PROCEDURE_CODES;
}

export function searchClinicalCodes(kind: CodeReferenceKind, query: string, limit = 8) {
  const source = getCommonCodeReference(kind);
  const normalized = query.trim();
  if (!normalized) return [];

  return source
    .map((entry) => ({ entry, score: scoreMatch(normalized, entry) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code))
    .slice(0, limit)
    .map((row) => row.entry);
}
