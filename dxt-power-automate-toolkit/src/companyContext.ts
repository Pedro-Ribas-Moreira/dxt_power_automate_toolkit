import * as fs from 'fs';
import * as path from 'path';

export interface Brand {
  name: string;
  prefix: string;          // e.g. "PPP", "YE"
  description: string;
  products: string[];
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
  const brandLines = ctx.brands.map(b =>
    `  - ${b.name} (prefix: ${b.prefix}): ${b.description}. Products: ${b.products.join(', ')}.`
  ).join('\n');
  return `Company: ${ctx.group}\nBrands:\n${brandLines}`;
}

export function getDefaultContext(): CompanyContext {
  return {
    group: 'Yuno Energy Group',
    brands: [
      {
        name: 'PrepayPower',
        prefix: 'PPP',
        description: 'Prepaid energy services for Irish households',
        products: ['Prepaid Electricity', 'Prepaid Gas', 'Oil', 'Broadband'],
      },
      {
        name: 'Yuno Energy',
        prefix: 'YE',
        description: 'Billpay energy with flexible tariffs',
        products: ['Billpay Electricity', 'Billpay Gas', 'Tariffs'],
      },
      {
        name: 'Yuno Energy Heat',
        prefix: 'YEH',
        description: 'Renewable heating solutions',
        products: ['Heat Pumps', 'Home Heating'],
      },
      {
        name: 'Firmus',
        prefix: 'FIR',
        description: 'Natural gas distribution in Northern Ireland',
        products: ['Natural Gas'],
      },
    ],
  };
}

export function writeDefaultContext(workspaceRoot: string): string {
  const filePath = path.join(workspaceRoot, CONTEXT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(getDefaultContext(), null, 2), 'utf8');
  return filePath;
}
