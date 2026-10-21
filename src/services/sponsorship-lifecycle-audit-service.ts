export type SponsorshipAuditStatus =
  | 'healthy'
  | 'inconclusive'
  | 'warning'
  | 'blocked';

export interface SponsorshipRelationship {
  direction: 'sponsoring' | 'sponsored' | 'unresolved';
  sponsoringAccount?: string | null;
  sponsoredAccount?: string | null;
  entryType?: string | null;
  entryId?: string | null;
}

export interface SponsorshipEvent {
  type: 'start' | 'end';
  entryType?: string | null;
  entryId?: string | null;
  counterparty?: string | null;
  ledger?: number | null;
  createdAt?: string | null;
}

export interface SponsorshipLimitation {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface SponsorshipLifecycleAuditResult {
  status: SponsorshipAuditStatus;
  numSponsoring: number | null;
  numSponsored: number | null;
  relationships: SponsorshipRelationship[];
  events: SponsorshipEvent[];
  limitations: SponsorshipLimitation[];
  notes: string[];
  reserveEstimate?: {
    available: boolean;
    estimatedSponsoringReserveXlm: number | null;
    estimatedSponsoredReserveXlm: number | null;
    assumptions: string[];
  };
}

export class SponsorshipLifecycleAuditService {
  public async audit(
    accountId: string,
    _options: Record<string, unknown> = {},
  ): Promise<SponsorshipLifecycleAuditResult> {
    void accountId;
    return {
      status: 'inconclusive',
      numSponsoring: null,
      numSponsored: null,
      relationships: [],
      events: [],
      limitations: [],
      notes: [
        'Sponsorship lifecycle inspection is unavailable in this environment; no Horizon query was executed.',
      ],
      reserveEstimate: {
        available: false,
        estimatedSponsoringReserveXlm: null,
        estimatedSponsoredReserveXlm: null,
        assumptions: ['Reserve estimate unavailable because no network parameters were supplied.'],
      },
    };
  }
}
