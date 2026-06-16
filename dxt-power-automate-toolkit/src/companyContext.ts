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

export interface InternalSystem {
  name: string;
  description: string;
}

export interface CompanyContext {
  group: string;
  brands: Brand[];
  internalSystems?: InternalSystem[];
  crossBrandTerms?: Record<string, string>;
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

  if (ctx.crossBrandTerms && Object.keys(ctx.crossBrandTerms).length) {
    lines.push('Cross-brand internal terminology:');
    for (const [term, def] of Object.entries(ctx.crossBrandTerms)) {
      lines.push(`  - ${term}: ${def}`);
    }
    lines.push('');
  }

  if (ctx.internalSystems?.length) {
    lines.push('Internal systems (used in Power Automate flows):');
    for (const sys of ctx.internalSystems) {
      lines.push(`  - ${sys.name}: ${sys.description}`);
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
        website: 'https://yunoenergy.ie',
        description: "Ireland's newest billpay electricity and gas provider. Digital-first, app-managed energy with competitive fixed and variable tariffs. No prepay — all plans are traditional billpay with a 12-month initial period. Paperless billing. Supports microgeneration (solar export tariff).",
        targetCustomers: [
          'Irish households preferring monthly billing over pay-as-you-go',
          'Tech-comfortable customers who want app-based energy management',
          'Homeowners with solar panels / microgeneration',
          'Price-conscious switchers looking for competitive fixed rates',
        ],
        products: [
          'Yuno Fixed — fixed-rate electricity plan, cheapest option for new customers',
          'Yuno Variable Discount Plan — variable rate with discount applied',
          'Yuno Smart Day/Night/Peak Plan — time-of-use tariff for smart meter customers (cheaper off-peak rates)',
          'Yuno Smart Dual Fuel Plan — combined electricity + gas, paperless, requires Yuno app',
          'Gas Supply — standard variable gas tariff',
        ],
        keyTerms: {
          'Yuno App': 'Mobile app (required for some plans) for usage tracking, bill management, payments and top-ups',
          'Fixed Plan': 'Electricity plan with a locked unit rate for the contract term — protects against price rises',
          'Variable Plan': 'Electricity or gas plan where the unit rate can change with market conditions',
          'Day/Night/Peak (Smart TOU)': 'Time-of-use tariff splitting usage into day, night and peak rates — cheaper at off-peak times; requires a smart meter',
          'Dual Fuel': 'Combined electricity and gas supply under a single Yuno Energy account',
          'Microgeneration / Clean Export Tariff': 'Payment to customers who export unused solar-generated electricity back to the grid (currently 15.89c/kWh, rising to 17.16c/kWh from July 2026)',
          'EAB (Estimated Annual Bill)': 'Standardised estimate based on CRU typical annual consumption figures, used for plan comparison',
          'Carbon Tax': 'Government levy on gas consumption (currently €0.0125 incl. VAT per kWh); same rate across all Irish suppliers',
          'Unit Rate': 'Price per kWh of electricity or gas consumed',
          'Standing Charge': 'Fixed daily charge applied regardless of usage',
          'PSO Levy': 'Public Service Obligation levy applied to all Irish electricity accounts to fund renewables',
          'Smart Meter': 'Advanced electricity meter enabling time-of-use tariffs and real-time consumption data; required for Day/Night/Peak plan',
          'Paperless Billing': 'Bills delivered digitally via app/email — required for Smart Dual Fuel Plan',
          'CRU': 'Commission for Regulation of Utilities — Irish energy regulator; sets standard consumption figures used in EAB calculations',
        },
        keyProcesses: [
          'Customer switching — Yuno Energy handles changeover from previous electricity/gas supplier',
          'Plan sign-up — online or via app; 12-month initial period with termination fee if exiting early',
          'Smart meter onboarding — customer requests smart meter from ESB Networks, then upgrades to Day/Night/Peak plan',
          'Microgeneration registration — customer registers solar/generation system to receive clean export tariff payments',
          'Direct debit billing — monthly bill generated from meter reads; paid by direct debit',
          'App-based account management — usage, bills, payments and plan changes via Yuno app',
        ],
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
    crossBrandTerms: {
      'CRN': 'Customer Reference Number — primary key for all customer records across all brands',
      'MPRN': 'Meter Point Reference Number — unique ID for an electricity meter connection point',
      'GPRN': 'Gas Point Reference Number — unique ID for a gas connection point',
      'MM (Market Message)': 'Automated messages exchanged with ESB Networks or GNI, e.g. MM110 (debt), MM011 (COT), G206N (gas), G201RQ (gas read request)',
      'COT': 'Change of Tenancy — process when a new tenant takes over a property, or Change of Tariff',
      'POA': 'Power of Attorney — customer account authority request',
      'DPA': 'Data Protection Act — compliance context for breach notifications and data handling',
      'SAR': 'Subject Access Request — customer data request under GDPR',
      'VC': 'Vulnerable Customer — customers on a protected list requiring special handling',
      'L1E': 'Low Income Electricity — customers processed via Liberty for vends/advance credit (MABs, NGOs)',
      'NPS': 'Net Promoter Score — customer satisfaction survey sent after interactions',
      'IVR': 'Interactive Voice Response — automated phone menu system built in 8x8',
      'DND': 'Do Not Disconnect — list of accounts exempted from disconnection during a period',
      'RREL': 'Meter read status code for a large estimated read — triggers proactive billing comms',
      'SVOD': 'State/Volume of Day — end-of-day CX reporting format',
      'MABs': 'Money Advice and Budgeting Service — NGO that requests vends/advance credit for low-income customers',
      'RAF': 'Refer a Friend — referral scheme across PPP and Yuno Energy',
      'Pipeline': 'Dev → Test → Prod deployment process for Power Automate solutions',
      'EV Tariff': 'Electric Vehicle energy tariff — time-of-use rate for EV owners',
    },
    internalSystems: [
      { name: '8x8', description: 'Cloud contact centre platform for voice, email, SMS, chat, IVR and agent workspace. Used across PPP, Yuno, and Firmus tenants. Migrated from In2tel.' },
      { name: 'Cognigy', description: 'Agent-assist chat bot platform. PPP Bot and Yuno Bot handle agent requests — HappyFox tickets, meter changes, vend requests, etc.' },
      { name: 'Max Power', description: 'Main CRM/customer management system for PPP and Yuno accounts, meter status, call dispositions and dropdowns.' },
      { name: 'Liberty', description: 'Account management system for L1E (low-income electricity) customers. Used for vend processing via RPA.' },
      { name: 'Genio', description: 'Pricing and usage check system for PrepayPower.' },
      { name: 'HappyFox', description: 'Helpdesk ticketing system. Agents create/update tickets via the bot or PA flows. Queues managed by Desktop Support.' },
      { name: 'SharePoint', description: 'Primary data store for almost all DT processes — lists for meter changes, vulnerable customers, COT, POA, market messaging, retention, etc.' },
      { name: 'Power BI', description: 'Reporting and dashboards — NPS, IVR calls, COP dashboard, retention, VC audit.' },
      { name: 'SQL Server (ppp-prod-sqlr01)', description: 'Main reports/BI database. Key tables: PPPGas.dbo.PPPMarketMessages, Yuno Reporting, RAF URLs.' },
      { name: 'Knack', description: 'Third-party platform used by Broadband Retention for tracking customer call statuses.' },
      { name: 'ESB Networks (ESBN)', description: 'Irish electricity distribution network. Sends/receives market messages (MM110, MM011, etc.) that trigger PA flows.' },
      { name: 'GNI (Gas Networks Ireland)', description: 'Irish gas distribution network. Sends market messages (G206N, G201RQ) processed by PA flows.' },
      { name: 'Enet', description: 'Broadband infrastructure provider. Sends outage alerts and invoices; de-energised accounts with active BB are tracked against Enet charges.' },
      { name: 'Zapier', description: 'Legacy automation platform — flows being migrated to Power Automate.' },
      { name: 'Shelf', description: 'Knowledge base platform used by CX agents. DT team documents flows and processes there.' },
      { name: 'Creovai', description: 'Agent Assist AI tool (in trial) for real-time call guidance.' },
    ],
  };
}

export function writeDefaultContext(workspaceRoot: string): string {
  const filePath = path.join(workspaceRoot, CONTEXT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(getDefaultContext(), null, 2), 'utf8');
  return filePath;
}
