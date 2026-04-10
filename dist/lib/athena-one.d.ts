type AthenaAuthType = "none" | "api_key" | "basic" | "oauth2";
export type AthenaConnectorConfig = {
    baseUrl: string;
    practiceId: string;
    departmentIds: string[];
    authType: AthenaAuthType;
    username: string;
    password: string;
    apiKey: string;
    apiKeyHeader: string;
    apiKeyPrefix: string;
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    timeoutMs: number;
    retryCount: number;
    retryBackoffMs: number;
    testPath: string;
    previewPath: string;
    headers: Record<string, string>;
};
export type AthenaConnectorConfigWithSecrets = AthenaConnectorConfig & {
    secretsConfigured: {
        password: boolean;
        apiKey: boolean;
        clientSecret: boolean;
        accessToken: boolean;
        refreshToken: boolean;
    };
};
export declare function normalizeAthenaConnectorConfig(input: unknown): AthenaConnectorConfig;
export declare function mergeAthenaConnectorConfig(existingInput: unknown, incomingInput: unknown): AthenaConnectorConfig;
export declare function redactAthenaConnectorConfig(input: unknown): AthenaConnectorConfigWithSecrets;
export declare function testAthenaConnectorConfig(input: unknown): Promise<{
    ok: boolean;
    status: string;
    message: string;
    testedAt: string;
    detail: {
        attempts: number;
        durationMs: number;
        statusCode: any;
        responsePreview?: undefined;
    };
} | {
    ok: boolean;
    status: string;
    message: string;
    testedAt: string;
    detail: {
        attempts: number;
        durationMs: number;
        statusCode: number;
        responsePreview: string;
    };
}>;
export declare function previewAthenaSchedule(params: {
    config: unknown;
    mapping?: Record<string, string> | unknown;
    dateOfService: string;
    clinicId?: string;
    maxRows?: number;
}): Promise<{
    ok: boolean;
    status: string;
    rowCount: number;
    rows: any[];
    message: string;
    detail: {
        attempts: number;
        durationMs: number;
        statusCode: number;
        responsePreview: string;
    };
} | {
    ok: boolean;
    status: string;
    rowCount: number;
    rows: {
        index: number;
        clinic: string;
        patientId: string;
        appointmentTime: string;
        providerLastName: string;
        reasonForVisit: string;
        raw: Record<string, unknown>;
    }[];
    message: string;
    detail: {
        attempts: number;
        durationMs: number;
        statusCode: number;
        responsePreview?: undefined;
    };
}>;
export {};
