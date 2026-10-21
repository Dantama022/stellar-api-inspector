export type Sep10ChallengeAuditStatus = 'valid' | 'invalid' | 'unknown';

export interface Sep10ChallengeAuditResult {
  status: Sep10ChallengeAuditStatus;
  message: string;
}

export class Sep10ChallengeAuditService {
  public async audit(_challengeXdr: string): Promise<Sep10ChallengeAuditResult> {
    return {
      status: 'unknown',
      message: 'SEP-10 challenge audit is not implemented in this environment.',
    };
  }
}
