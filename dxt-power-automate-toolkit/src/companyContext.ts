import * as fs from 'fs';
import * as path from 'path';

export interface Brand {
  name: string;
  prefix: string;
  website?: string;
  description: string;
  targetCustomers?: string[];
  products: string[];
  keyTerms?: Record<string, string>;
  keyProcesses?: string[];
}

export interface CompanyContext {
  group: string;
  brands: Brand[];
}

const CONTEXT_FILE = 'company-context.json';

export function loadCompanyContext(workspaceRoot: string): CompanyContext | null {
  const filePath = path.join(workspaceRoot, CONTEXT_FILE);
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CompanyContext;
  } catch {
    return null;
  }
}

export function buildAiContextBlock(ctx: CompanyContext): string {
  const lines: string[] = [`Company Group: ${ctx.group}`, ''];
  for (const b of ctx.brands) {
    lines.push(`Brand: ${b.name} (prefix: ${b.prefix})${b.website ? ` — ${b.website}` : ''}`);
    lines.push(`  Description: ${b.description}`);
    if (b.targetCustomers?.length) {
      lines.push(`  Target customers: ${b.targetCustomers.join('; ')}`);
    }
    if (b.products.length) {
      lines.push(`  Products/services: ${b.products.join(', ')}`);
    }
    if (b.keyTerms && Object.keys(b.keyTerms).length) {
      lines.push('  Key domain terms:');
      for (const [term, def] of Object.entries(b.keyTerms)) {
        lines.push(`    - ${term}: ${def}`);
      }
    }
    if (b.keyProcesses?.length) {
      lines.push('  Key business processes:');
      for (const p of b.keyProcesses) {
        lines.push(`    - ${p}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function getDefaultContext(): CompanyContext {
  return {
    group: 'Yuno Energy Group',
    brands: [
      {
        name: 'PrepayPower',
        prefix: 'PPP',
        website: 'https://www.prepaypower.ie',
        description: "Ireland's leading pay-as-you-go energy supplier serving ~180,000 households. Offers prepaid electricity, gas, dual fuel, and broadband — no traditional bills. Customers top up via app, website, or Payzone outlets nationwide.",
        targetCustomers: [
          'Irish households seeking budget control over energy spend',
          'Renters and people who prefer pay-as-you-go over monthly bills',
          'Property professionals: landlords, letting agents, Approved Housing Bodies, Local Authorities, PRS developments',
        ],
        products: [
          'Prepaid Electricity (Classic Pay & Smart Pay meters)',
          'Prepaid Gas',
          'Dual Fuel (Electricity + Gas bundle)',
          'PrepayBroadband (unlimited, charges daily to electricity meter)',
          'Property Professionals (landlord portal, bulk smart metering for rental properties)',
        ],
        keyTerms: {
          'PowerCode': 'Unique top-up code used to add credit to an electricity meter',
          'Classic Pay Meter': 'Traditional prepaid electricity meter requiring manual PowerCode entry',
          'Smart Pay Meter': 'Smart prepaid electricity meter with app integration and hourly usage updates',
          'Payzone': 'Nationwide network of retail outlets where customers can top up with cash',
          'PSO Levy': 'Public Service Obligation levy — government charge on all Irish electricity accounts (currently €19.10/account) funding renewables and indigenous fuels',
          'Prepayment Service Charge': 'Daily charge (currently 45.04c/day) to maintain the PAYG infrastructure',
          'Standing Charge': 'Fixed daily charge regardless of usage; varies by meter type and urban/rural tariff',
          'Unit Rate': 'Price per kWh of electricity or gas consumed',
          'NightSaver': 'Electricity tariff with cheaper off-peak night rates for customers with a NightSaver meter',
          'Emergency Credit': 'Short-term credit auto-activated when balance hits zero to prevent power loss',
          'Friendly Credit': 'Out-of-hours credit ensuring customers are not cut off during evenings/weekends',
          'GPRN': 'Gas Point Reference Number — unique identifier for a gas connection, required for gas switching',
          'Eircode': 'Irish postcode used when setting up broadband service',
          'Dual Fuel': 'Combined electricity and gas supply under a single account',
          'ESB Energisation': 'Process of connecting a new property to the ESB electricity network, tracked from construction stage',
        },
        keyProcesses: [
          'Customer switching (electricity, gas, broadband) — PrepayPower manages changeover with previous supplier',
          'Meter installation — Smart Pay or Classic Pay meter fitted at customer premises',
          'Top-up — via PrepayPower app, website (/topping/top-now), or Payzone retail network',
          'Moving home — customer registers new address, meter type determined at new property',
          'Referral — existing customer refers friend, both receive bonus credit after successful meter installation',
          'Property professional onboarding — landlord portal setup, bulk meter management, ESG reporting',
        ],
      },
      {
        name: 'Yuno Energy',
        prefix: 'YE',
        website: 'https://www.yunoenergy.ie',
        description: 'Billpay energy brand within Yuno Energy Group offering flexible electricity and gas tariffs for Irish households',
        targetCustomers: ['Irish households preferring traditional monthly billing'],
        products: ['Billpay Electricity', 'Billpay Gas', 'Dual Fuel'],
        keyTerms: {},
        keyProcesses: [],
      },
      {
        name: 'Yuno Energy Heat',
        prefix: 'YEH',
        website: 'https://www.yunoenergyheat.ie',
        description: 'Renewable heating solutions including heat pumps and home heating services for Irish homes',
        targetCustomers: ['Irish homeowners seeking renewable heating alternatives'],
        products: ['Heat Pumps', 'Home Heating'],
        keyTerms: {},
        keyProcesses: [],
      },
      {
        name: 'Firmus',
        prefix: 'FIR',
        website: 'https://www.firmusenergy.co.uk',
        description: 'Natural gas distribution and supply network in Northern Ireland',
        targetCustomers: ['Households and businesses in Northern Ireland'],
        products: ['Natural Gas Supply', 'Gas Network Connections'],
        keyTerms: {},
        keyProcesses: [],
      },
    ],
  };
}

export function writeDefaultContext(workspaceRoot: string): string {
  const filePath = path.join(workspaceRoot, CONTEXT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(getDefaultContext(), null, 2), 'utf8');
  return filePath;
}
