import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const getTokenMock = vi.fn();

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({
    getToken: getTokenMock
  }))
}));

describe("Entra directory lookup fallbacks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ENTRA_TENANT_ID", "test-entra-tenant");
    vi.stubEnv("ENTRA_GRAPH_API_BASE_URL", "https://graph.microsoft.com/v1.0");
    vi.stubEnv("ENTRA_GRAPH_SCOPE", "https://graph.microsoft.com/.default");
    getTokenMock.mockReset();
    getTokenMock.mockResolvedValue({ token: "graph-token" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back to stored principal identifiers when lookup by object id returns 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: async () => "not found"
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          value: [
            {
              id: "entra-user-oid",
              displayName: "ClinicOS Admin",
              mail: "admin@ClinicOS1.onmicrosoft.com",
              userPrincipalName: "admin@ClinicOS1.onmicrosoft.com",
              accountEnabled: true,
              userType: "Member"
            }
          ]
        })
      });

    vi.stubGlobal("fetch", fetchMock);

    const { getEntraDirectoryUserByObjectId } = await import("../src/lib/entra-directory.js");
    const user = await getEntraDirectoryUserByObjectId("entra-user-oid", {
      email: "admin@clinicos1.onmicrosoft.com",
      userPrincipalName: "admin@clinicos1.onmicrosoft.com"
    });

    expect(user).toMatchObject({
      objectId: "entra-user-oid",
      displayName: "ClinicOS Admin",
      email: "admin@clinicos1.onmicrosoft.com",
      userPrincipalName: "admin@clinicos1.onmicrosoft.com",
      directoryStatus: "active",
      tenantId: "test-entra-tenant"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0] || "")).toContain("/users?");
    expect(String(fetchMock.mock.calls[1]?.[0] || "")).toContain("userPrincipalName");
  });
});
