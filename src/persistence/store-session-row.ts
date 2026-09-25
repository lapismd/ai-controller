export interface AuthSessionRow {
  id: string;
  principalId: string;
  applicationId: string;
  credentialFingerprint: string;
  scopes: string[];
  providers: string[];
  workspaces: string[];
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}
