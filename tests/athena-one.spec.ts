import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeAthenaConnectorConfig,
  normalizeAthenaConnectorConfig,
  previewAthenaRevenueMonitoring,
  previewAthenaSchedule,
  redactAthenaConnectorConfig,
  testAthenaConnectorConfig
} from "../src/lib/athena-one.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AthenaOne connector helpers", () => {
  it("normalizes connector defaults and trims department ids", () => {
    const normalized = normalizeAthenaConnectorConfig({
      baseUrl: "https://example-athena.test/",
      practiceId: " practice-1 ",
      departmentIds: " 100, 200 , ,300 ",
      authType: "apikey",
      timeoutMs: 100,
      retryCount: -1,
      retryBackoffMs: -5
    });

    expect(normalized.baseUrl).toBe("https://example-athena.test");
    expect(normalized.practiceId).toBe("practice-1");
    expect(normalized.departmentIds).toEqual(["100", "200", "300"]);
    expect(normalized.authType).toBe("api_key");
    expect(normalized.timeoutMs).toBeGreaterThanOrEqual(500);
    expect(normalized.retryCount).toBeGreaterThanOrEqual(0);
    expect(normalized.retryBackoffMs).toBeGreaterThan(0);
  });

  it("preserves stored secrets when partial updates omit them and redacts them for reads", () => {
    const merged = mergeAthenaConnectorConfig(
      {
        baseUrl: "https://example-athena.test",
        practiceId: "practice-1",
        authType: "basic",
        username: "athena-user",
        password: "secret-pass",
        apiKey: "secret-key",
        clientSecret: "secret-client"
      },
      {
        baseUrl: "https://updated-athena.test",
        practiceId: "practice-1",
        authType: "basic",
        username: "updated-user"
      }
    );

    expect(merged.baseUrl).toBe("https://updated-athena.test");
    expect(merged.username).toBe("updated-user");
    expect(merged.password).toBe("secret-pass");
    expect(merged.apiKey).toBe("secret-key");
    expect(merged.clientSecret).toBe("secret-client");

    const redacted = redactAthenaConnectorConfig(merged);
    expect(redacted.password).toBe("");
    expect(redacted.apiKey).toBe("");
    expect(redacted.clientSecret).toBe("");
    expect(redacted.secretsConfigured.password).toBe(true);
    expect(redacted.secretsConfigured.apiKey).toBe(true);
    expect(redacted.secretsConfigured.clientSecret).toBe(true);
  });

  it("returns explicit validation failures before remote calls when required connector fields are missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const testResult = await testAthenaConnectorConfig({
      baseUrl: "",
      practiceId: ""
    });
    const previewResult = await previewAthenaSchedule({
      config: {
        baseUrl: "",
        practiceId: ""
      },
      dateOfService: "2026-03-05"
    });

    expect(testResult.ok).toBe(false);
    expect(testResult.message).toContain("baseUrl and practiceId are required");
    expect(previewResult.ok).toBe(false);
    expect(previewResult.message).toContain("baseUrl and practiceId");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps preview rows using configured source column aliases", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          appointments: [
            {
              deptid: "DEPT-10",
              mrn: "PT-100",
              appttime: "09:15",
              renderingprovider: "Nguyen",
              appointmentreason: "Follow-up"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const preview = await previewAthenaSchedule({
      config: {
        baseUrl: "https://example-athena.test",
        practiceId: "practice-1",
        previewPath: "/appointments/preview"
      },
      mapping: {
        clinicId: "deptid",
        patientId: "mrn",
        appointmentTime: "appttime",
        providerLastName: "renderingprovider",
        reasonForVisit: "appointmentreason"
      },
      dateOfService: "2026-03-05"
    });

    expect(preview.ok).toBe(true);
    expect(preview.rowCount).toBe(1);
    expect(preview.rows[0]).toMatchObject({
      clinic: "DEPT-10",
      patientId: "PT-100",
      appointmentTime: "09:15",
      providerLastName: "Nguyen",
      reasonForVisit: "Follow-up"
    });
  });

  it("maps Athena revenue monitoring rows with downstream metric aliases", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          appointments: [
            {
              encounter_id: "ENC-200",
              mrn: "PT-200",
              dos: "2026-04-17",
              charge_entry_date: "2026-04-18T09:30:00Z",
              claim_submission_date: "2026-04-20",
              days_to_submit: "3",
              days_in_ar: 11,
              claim_status: "submitted",
              patient_balance: "42.50",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const preview = await previewAthenaRevenueMonitoring({
      config: {
        baseUrl: "https://example-athena.test",
        practiceId: "practice-1",
        revenuePath: "/billing/monitoring",
      },
      mapping: {
        revenueEncounterId: "encounter_id",
        patientId: "mrn",
        dateOfService: "dos",
        revenueChargeEnteredAt: "charge_entry_date",
        revenueClaimSubmittedAt: "claim_submission_date",
        revenueDaysToSubmit: "days_to_submit",
        revenueDaysInAR: "days_in_ar",
        revenueClaimStatus: "claim_status",
        patientBalance: "patient_balance",
      },
      dateOfService: "2026-04-17",
    });

    expect(preview.ok).toBe(true);
    expect(preview.rows[0]).toMatchObject({
      encounterId: "ENC-200",
      patientId: "PT-200",
      dateOfService: "2026-04-17",
      daysToSubmit: 3,
      daysInAR: 11,
      claimStatus: "submitted",
      patientBalanceCents: 4250,
    });
    expect(preview.rows[0]?.chargeEnteredAt).toContain("2026-04-18");
    expect(preview.rows[0]?.claimSubmittedAt).toContain("2026-04-20");
  });
});
