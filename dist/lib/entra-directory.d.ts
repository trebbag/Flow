export type EntraDirectoryUser = {
    objectId: string;
    displayName: string;
    email: string;
    userPrincipalName: string;
    accountEnabled: boolean;
    userType: string;
    tenantId: string;
    identityProvider: "entra";
    directoryStatus: "active" | "disabled" | "guest" | "deleted";
};
export declare function searchEntraDirectoryUsers(query: string): Promise<EntraDirectoryUser[]>;
export declare function getEntraDirectoryUserByObjectId(objectId: string): Promise<EntraDirectoryUser>;
