import type { ClientMapPoint } from './client-map-types';
export type PortfolioAction = { rule: string; title: string; facts: string[]; nextStep: string; signalId?: string };
export type PortfolioRow = {
  id: string; inn: string; name: string; gosb: string;
  offers: number; income: number | null; missingIncome: number; amount: number | null; missingAmount: number;
  duplicateOffers: number; ambiguousOffers: number; products: string[]; stages: string[]; managers: string[];
  point: ClientMapPoint | null; locationReason: string; scopes: string[];
  payroll: { march: number | null; july: number | null }; meetings: (number | null)[]; plans: number;
  stalled: number; actions: PortfolioAction[];
};
export type PortfolioSummary = {
  organizations: number; uniqueInns: number; offerClients: number; offers: number;
  income: number | null; missingIncome: number; amount: number | null; missingAmount: number;
  located: number; unlocated: number; duplicateOffers: number; ambiguousOffers: number;
  payrollMarch: number | null; payrollJuly: number | null; payrollComparableClients: number; payrollGrowth: number | null;
  meetingCounts: (number | null)[]; meetingKnown: number[]; plannedClients: number; plannedStops: number;
};
export type PortfolioData = { rows: PortfolioRow[]; available: boolean; offersAvailable: boolean; sourceLabel: string; notes: string[]; summary: PortfolioSummary };
