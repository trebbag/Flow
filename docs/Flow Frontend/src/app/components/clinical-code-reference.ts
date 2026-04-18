export type CodeReferenceKind = "diagnosis" | "procedure";

export type ClinicalCodeReference = {
  code: string;
  label: string;
  keywords: string[];
  kind: CodeReferenceKind;
};

const DIAGNOSIS_CODES: ClinicalCodeReference[] = [
  { code: "I10", label: "Essential primary hypertension", keywords: ["hypertension", "htn", "high blood pressure"], kind: "diagnosis" },
  { code: "E11.9", label: "Type 2 diabetes mellitus without complications", keywords: ["diabetes", "dm2", "type 2 diabetes"], kind: "diagnosis" },
  { code: "E78.5", label: "Hyperlipidemia, unspecified", keywords: ["hyperlipidemia", "lipids", "cholesterol"], kind: "diagnosis" },
  { code: "J01.90", label: "Acute sinusitis, unspecified", keywords: ["sinusitis", "sinus infection", "acute sinusitis"], kind: "diagnosis" },
  { code: "J06.9", label: "Acute upper respiratory infection, unspecified", keywords: ["uri", "upper respiratory", "cold"], kind: "diagnosis" },
  { code: "J02.9", label: "Acute pharyngitis, unspecified", keywords: ["pharyngitis", "sore throat"], kind: "diagnosis" },
  { code: "R05.9", label: "Cough, unspecified", keywords: ["cough"], kind: "diagnosis" },
  { code: "N39.0", label: "Urinary tract infection, site not specified", keywords: ["uti", "urinary tract infection"], kind: "diagnosis" },
  { code: "Z00.00", label: "General adult medical examination without abnormal findings", keywords: ["annual", "physical", "well visit"], kind: "diagnosis" },
  { code: "M54.50", label: "Low back pain, unspecified", keywords: ["low back pain", "back pain", "lumbago"], kind: "diagnosis" },
  { code: "J45.909", label: "Unspecified asthma, uncomplicated", keywords: ["asthma", "reactive airway"], kind: "diagnosis" },
  { code: "R07.9", label: "Chest pain, unspecified", keywords: ["chest pain"], kind: "diagnosis" },
  { code: "R53.83", label: "Other fatigue", keywords: ["fatigue", "tired"], kind: "diagnosis" },
  { code: "Z23", label: "Encounter for immunization", keywords: ["vaccine", "vaccination", "immunization"], kind: "diagnosis" },
  { code: "L03.90", label: "Cellulitis, unspecified", keywords: ["cellulitis", "skin infection"], kind: "diagnosis" },
  { code: "M25.561", label: "Pain in right knee", keywords: ["right knee pain", "knee pain"], kind: "diagnosis" },
  { code: "M25.562", label: "Pain in left knee", keywords: ["left knee pain", "knee pain"], kind: "diagnosis" },
  { code: "R73.03", label: "Prediabetes", keywords: ["prediabetes", "elevated glucose"], kind: "diagnosis" },
  { code: "F41.9", label: "Anxiety disorder, unspecified", keywords: ["anxiety"], kind: "diagnosis" },
  { code: "F32.A", label: "Depression, unspecified", keywords: ["depression"], kind: "diagnosis" },
];

const PROCEDURE_CODES: ClinicalCodeReference[] = [
  { code: "99211", label: "Established patient office visit, minimal", keywords: ["office visit", "e&m", "minimal"], kind: "procedure" },
  { code: "99212", label: "Established patient office visit, straightforward", keywords: ["office visit", "e&m", "straightforward"], kind: "procedure" },
  { code: "99213", label: "Established patient office visit, low complexity", keywords: ["office visit", "e&m", "follow-up"], kind: "procedure" },
  { code: "99214", label: "Established patient office visit, moderate complexity", keywords: ["office visit", "e&m", "moderate"], kind: "procedure" },
  { code: "99215", label: "Established patient office visit, high complexity", keywords: ["office visit", "e&m", "high complexity"], kind: "procedure" },
  { code: "99202", label: "New patient office visit, straightforward", keywords: ["new patient", "e&m"], kind: "procedure" },
  { code: "99203", label: "New patient office visit, low complexity", keywords: ["new patient", "e&m"], kind: "procedure" },
  { code: "99204", label: "New patient office visit, moderate complexity", keywords: ["new patient", "e&m"], kind: "procedure" },
  { code: "99205", label: "New patient office visit, high complexity", keywords: ["new patient", "e&m"], kind: "procedure" },
  { code: "36415", label: "Venipuncture", keywords: ["venipuncture", "blood draw"], kind: "procedure" },
  { code: "93000", label: "Electrocardiogram", keywords: ["ekg", "ecg", "electrocardiogram"], kind: "procedure" },
  { code: "96372", label: "Therapeutic injection administration", keywords: ["injection", "administration", "shot"], kind: "procedure" },
  { code: "81002", label: "Urinalysis, dip stick or tablet reagent", keywords: ["urinalysis", "ua", "urine dip"], kind: "procedure" },
  { code: "87880", label: "Rapid streptococcus antigen detection", keywords: ["rapid strep", "strep test"], kind: "procedure" },
  { code: "87635", label: "SARS-CoV-2 amplified probe technique", keywords: ["covid pcr", "covid test", "sars-cov-2"], kind: "procedure" },
  { code: "94640", label: "Inhalation treatment", keywords: ["nebulizer", "breathing treatment"], kind: "procedure" },
  { code: "94010", label: "Spirometry", keywords: ["spirometry", "lung function"], kind: "procedure" },
  { code: "12001", label: "Simple repair superficial wounds", keywords: ["laceration repair", "wound repair", "stitches"], kind: "procedure" },
  { code: "90471", label: "Immunization administration", keywords: ["vaccine administration", "immunization"], kind: "procedure" },
  { code: "J1100", label: "Dexamethasone sodium phosphate, 1 mg", keywords: ["dexamethasone", "medication"], kind: "procedure" },
  { code: "99000", label: "Handling and conveyance of specimen", keywords: ["specimen handling", "lab transport"], kind: "procedure" },
];

function scoreReference(entry: ClinicalCodeReference, normalizedQuery: string) {
  const lower = normalizedQuery.toLowerCase();
  const code = entry.code.toLowerCase();
  const label = entry.label.toLowerCase();
  const keywords = entry.keywords.map((item) => item.toLowerCase());

  if (code === lower) return 100;
  if (code.startsWith(lower)) return 90;
  if (label.startsWith(lower)) return 80;
  if (keywords.some((item) => item.startsWith(lower))) return 70;
  if (label.includes(lower)) return 60;
  if (keywords.some((item) => item.includes(lower))) return 50;
  if (code.includes(lower)) return 40;
  return 0;
}

export function searchClinicalCodes(kind: CodeReferenceKind, query: string, limit = 8) {
  const normalized = query.trim();
  if (!normalized) return [];

  const source = kind === "diagnosis" ? DIAGNOSIS_CODES : PROCEDURE_CODES;
  return source
    .map((entry) => ({ entry, score: scoreReference(entry, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code))
    .slice(0, limit)
    .map((entry) => entry.entry);
}

export function getClinicalCodeReference(kind: CodeReferenceKind, code: string) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const source = kind === "diagnosis" ? DIAGNOSIS_CODES : PROCEDURE_CODES;
  return source.find((entry) => entry.code === normalized) || null;
}
