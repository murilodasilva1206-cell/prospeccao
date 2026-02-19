# LGPD Data Classification — Prospeccao

## Overview

This document classifies all personal data processed by the application under the
Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).

## Data Inventory

| Field | Category (LGPD) | Legal Basis | Retention | Masking Rule | Notes |
|-------|----------------|-------------|-----------|--------------|-------|
| `nome` (name) | Personal Data | Legitimate interest (Art. 7, IX) | 5 years | First name only in logs | B2B prospecting context |
| `empresa` (company) | Business Data | Contract / Legitimate interest | Indefinite | Safe to log | Company = legal entity |
| `cargo` (title) | Personal Data | Legitimate interest | 5 years | Safe to log | Public professional info |
| `cidade` (city) | Personal Data | Legitimate interest | 5 years | Safe to log | Not precise location |
| `estado` (state) | Personal Data | Legitimate interest | 5 years | Safe to log | General region |
| `setor` (industry) | Business Data | Legitimate interest | Indefinite | Safe to log | Industry classification |
| `email` | Personal Data (sensitive for context) | Explicit consent required | 5 years | **Never log raw** — hash for debugging | Not exposed in public API |
| `phone` | Personal Data | Explicit consent required | 5 years | **Never log raw** | Not exposed in public API |
| `cpf` | Sensitive Personal Data (Art. 11) | Not collected in MVP | N/A | Never store | CPF = Brazilian tax ID |
| Agent logs (user prompts) | Transient Personal Data | Legitimate interest (operational) | **90 days max** | Strip PII before log | User's search intent |
| OpenRouter API calls | Transient | Not stored | **Not persisted** | Never store prompts | Ephemeral per-request |

## Data Subject Rights (LGPD Art. 18)

| Right | Implementation Status | Notes |
|-------|----------------------|-------|
| Right to access | Manual for MVP | Contact DPO |
| Right to rectification | Manual for MVP | Contact DPO |
| Right to erasure | Manual for MVP | Contact DPO |
| Right to portability | CSV export available | /api/export endpoint |
| Right to information | This document + privacy policy | |
| Right to object | Manual opt-out | Contact DPO |

## Data Flows

```
User prompt → /api/agente → OpenRouter (ephemeral, not stored)
                         → /api/busca → PostgreSQL contacts table
                                      → Response (masked fields only)
Contact data → PostgreSQL → /api/busca response → maskContact() → 8 public fields
Contact data → PostgreSQL → /api/export CSV → sanitizeCsvCell() → CSV file
```

## Retention Policy

- **Contact data**: 5 years from collection date. Implement `DELETE FROM contacts WHERE criado_em < NOW() - INTERVAL '5 years'` as a scheduled job.
- **Agent/search logs**: 90 days. Implement log rotation or TTL-based deletion.
- **DB audit logs**: 1 year (pg_audit extension recommended for production).

## DPO Contact

Data Protection Officer: [to be designated before production launch]
Email: [dpo@prospeccao.app — to be configured]
