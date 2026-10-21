import { StrKey } from '@stellar/stellar-sdk';

/**
 * Ledger Entry Ownership Audit Inspector
 *
 * Read-only diagnostic that inspects the ownership and lifecycle implications of
 * Stellar ledger entries associated with an account. Produces a categorized
 * inventory of observable account-associated resources and explicitly reports
 * where the available information is insufficient to establish complete
 * ownership or lifecycle behavior.
 *
 * This inspector does NOT delete, migrate, or modify ledger entries.
 */

export type ResourceCategory =
  | 'trustline'
  | 'offer'
  | 'claimable_balance'
  | 'data_entry'
  | 'sponsorship'
  | 'signer'
  | 'account';

export type RelationshipType =
  | 'directly_associated'
  | 'sponsored'
  | 'sponsoring'
  | 'referenced_by_operation'
  | 'unknown';

export type AuditStatus = 'complete' | 'partial' | 'failed';

export interface ResourceIdentifier {
  /** Stable identifier for the resource (e.g. asset code, offer id, balance id). */
  id: string;
  /** Optional human-readable label. */
  label?: string;
}

export interface AuditedResource {
  category: ResourceCategory;
  relationship: RelationshipType;
  identifier: ResourceIdentifier;
  /** Ownership / relationship fields observed from API or SDK data. */
  ownership: Record<string, unknown>;
  /** True when the resource could not be fully enumerated. */
  incomplete?: boolean;
  /** Reason the resource is incomplete, if applicable. */
  incompleteReason?: string;
}

export interface UnsupportedResourceCategory {
  category: string;
  reason: string;
}

export interface RetrievalIssue {
  category: ResourceCategory | 'account';
  message: string;
  /** True when pagination was detected as incomplete. */
  paginationIncomplete?: boolean;
}

export interface LedgerEntryOwnershipAuditResult {
  accountId: string;
  status: AuditStatus;
  /** Categorized inventory of observable resources. */
  resources: AuditedResource[];
  /** Resource categories that cannot be completely enumerated via available endpoints. */
  unsupportedCategories: UnsupportedResourceCategory[];
  /** Retrieval failures and incomplete pagination. */
  retrievalIssues: RetrievalIssue[];
  /** Notes explaining which resources may require separate review. */
  reviewNotes: string[];
  /** Explicit disclaimer about inventory completeness. */
  completenessDisclaimer: string;
  /** Timestamp of the audit. */
  generatedAt: string;
}

/**
 * Minimal shape of the service this inspector wraps. The service is responsible
 * for performing the actual Horizon/SDK retrieval. The inspector validates input
 * and formats output.
 */
export interface LedgerEntryOwnershipAuditService {
  audit(accountId: string): Promise<LedgerEntryOwnershipAuditResult>;
}

export class InvalidAccountIdError extends Error {
  constructor(accountId: string) {
    super(`Invalid Stellar account ID: ${accountId}`);
    this.name = 'InvalidAccountIdError';
  }
}

export class LedgerEntryOwnershipAuditInspector {
  private readonly service: LedgerEntryOwnershipAuditService;

  constructor(service: LedgerEntryOwnershipAuditService) {
    if (!service || typeof service.audit !== 'function') {
      throw new Error('LedgerEntryOwnershipAuditInspector requires a service with an audit() method');
    }
    this.service = service;
  }

  /**
   * Validate the account ID and run the read-only audit.
   */
  async audit(accountId: string): Promise<LedgerEntryOwnershipAuditResult> {
    if (!this.isValidAccountId(accountId)) {
      throw new InvalidAccountIdError(accountId);
    }
    return this.service.audit(accountId);
  }

  /**
   * Validate a Stellar account ID (ed25519 public key, G...).
   */
  isValidAccountId(accountId: string): boolean {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return false;
    }
    try {
      return StrKey.isValidEd25519PublicKey(accountId);
    } catch {
      return false;
    }
  }

  /**
   * Format the audit result as a human-readable report.
   */
  formatReport(result: LedgerEntryOwnershipAuditResult): string {
    const lines: string[] = [];

    lines.push('Ledger Entry Ownership Audit');
    lines.push('============================');
    lines.push(`Account: ${result.accountId}`);
    lines.push(`Status:  ${result.status.toUpperCase()}`);
    lines.push(`Generated: ${result.generatedAt}`);
    lines.push('');

    lines.push(result.completenessDisclaimer);
    lines.push('');

    // Group resources by category, then relationship.
    const grouped = this.groupResources(result.resources);

    lines.push('Resource Inventory');
    lines.push('------------------');
    if (result.resources.length === 0) {
      lines.push('  (no discoverable account-associated resources)');
    } else {
      for (const category of Object.keys(grouped).sort() as ResourceCategory[]) {
        const byRelationship = grouped[category] ?? {};
        lines.push(`  ${category}:`);
        for (const relationship of Object.keys(byRelationship).sort() as RelationshipType[]) {
          const items = byRelationship[relationship] ?? [];
          lines.push(`    ${relationship} (${items.length}):`);
          for (const item of items) {
            const label = item.identifier.label ? ` (${item.identifier.label})` : '';
            const incomplete = item.incomplete ? ' [INCOMPLETE]' : '';
            lines.push(`      - ${item.identifier.id}${label}${incomplete}`);
            if (item.incomplete && item.incompleteReason) {
              lines.push(`          reason: ${item.incompleteReason}`);
            }
            const ownershipKeys = Object.keys(item.ownership || {});
            if (ownershipKeys.length > 0) {
              const ownershipStr = ownershipKeys
                .map((k) => `${k}=${this.safeStringify(item.ownership[k])}`)
                .join(', ');
              lines.push(`          ownership: ${ownershipStr}`);
            }
          }
        }
      }
    }
    lines.push('');

    lines.push('Unsupported / Non-Enumerable Categories');
    lines.push('---------------------------------------');
    if (result.unsupportedCategories.length === 0) {
      lines.push('  (none reported)');
    } else {
      for (const unsupported of result.unsupportedCategories) {
        lines.push(`  - ${unsupported.category}: ${unsupported.reason}`);
      }
    }
    lines.push('');

    lines.push('Retrieval Issues');
    lines.push('----------------');
    if (result.retrievalIssues.length === 0) {
      lines.push('  (none reported)');
    } else {
      for (const issue of result.retrievalIssues) {
        const pagination = issue.paginationIncomplete ? ' [pagination incomplete]' : '';
        lines.push(`  - ${issue.category}: ${issue.message}${pagination}`);
      }
    }
    lines.push('');

    lines.push('Review Notes');
    lines.push('------------');
    if (result.reviewNotes.length === 0) {
      lines.push('  (none)');
    } else {
      for (const note of result.reviewNotes) {
        lines.push(`  - ${note}`);
      }
    }
    lines.push('');

    lines.push('Note: This audit is read-only and does not modify ledger entries.');

    return lines.join('\n');
  }

  private groupResources(
    resources: AuditedResource[],
  ): Partial<Record<ResourceCategory, Partial<Record<RelationshipType, AuditedResource[]>>>> {
    const grouped: Partial<
      Record<ResourceCategory, Partial<Record<RelationshipType, AuditedResource[]>>>
    > = {};
    for (const resource of resources) {
      if (!grouped[resource.category]) {
        grouped[resource.category] = {};
      }
      const byRelationship = grouped[resource.category]!;
      if (!byRelationship[resource.relationship]) {
        byRelationship[resource.relationship] = [];
      }
      byRelationship[resource.relationship]!.push(resource);
    }
    return grouped;
  }

  private safeStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return String(value);
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
}

export default LedgerEntryOwnershipAuditInspector;